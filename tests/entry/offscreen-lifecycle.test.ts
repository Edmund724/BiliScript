// createOffscreenLifetime (offscreen document lease tracking & ASR-terminal close arbitration) tests.

import { describe, expect, it, vi } from "vitest";
import {
  createOffscreenLifetime,
  shouldCloseAfterAsrTask,
  type LifetimePort
} from "../../extension/entry/offscreen-lifecycle.js";

function makePort() {
  const disconnectListeners: Array<() => void> = [];
  const port: LifetimePort = {
    onDisconnect: {
      addListener: (listener) => {
        disconnectListeners.push(listener);
      }
    }
  };
  return {
    port,
    fireDisconnect: () => {
      disconnectListeners.forEach((listener) => listener());
    }
  };
}

function setup() {
  const closeSelf = vi.fn();
  return { closeSelf, lifetime: createOffscreenLifetime({ closeSelf }) };
}

const CHANNEL_SIZES = [0, 1, 2];

describe("三条件穷举：只有活跃端口、其他解码端口与在飞任务全空才关文档", () => {
  const combos = CHANNEL_SIZES.flatMap((activePorts) =>
    CHANNEL_SIZES.map((otherAsrPorts) => ({ activePorts, otherAsrPorts }))
  );

  it.each(combos)(
    "活跃端口 $activePorts / 其他解码 $otherAsrPorts",
    ({ activePorts, otherAsrPorts }) => {
      const { closeSelf, lifetime } = setup();
      Array.from({ length: activePorts }).forEach(() => lifetime.trackPort(makePort().port));
      Array.from({ length: otherAsrPorts }).forEach(() => lifetime.trackAsrPort(makePort().port));

      const self = makePort();
      lifetime.trackAsrPort(self.port);
      lifetime.noteAsrTerminal(self.port);

      const expectedClose = activePorts === 0 && otherAsrPorts === 0;
      expect(closeSelf).toHaveBeenCalledTimes(expectedClose ? 1 : 0);
    }
  );
});

describe("通道释放：任一保留条件消失后，计数回到全空即关", () => {
  it("活跃端口断连出集后再来终态 → 关", () => {
    const { closeSelf, lifetime } = setup();
    const port = makePort();
    lifetime.trackPort(port.port);

    const first = makePort();
    lifetime.trackAsrPort(first.port);
    lifetime.noteAsrTerminal(first.port);
    expect(closeSelf).not.toHaveBeenCalled();

    port.fireDisconnect();

    const second = makePort();
    lifetime.trackAsrPort(second.port);
    lifetime.noteAsrTerminal(second.port);
    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  it("其他解码端口逐个到达终态：最后一个才关", () => {
    const { closeSelf, lifetime } = setup();
    const other = makePort();
    const self = makePort();
    lifetime.trackAsrPort(other.port);
    lifetime.trackAsrPort(self.port);

    lifetime.noteAsrTerminal(self.port);
    expect(closeSelf).not.toHaveBeenCalled();

    lifetime.noteAsrTerminal(other.port);
    expect(closeSelf).toHaveBeenCalledTimes(1);
  });
});

describe("自身的终态端口：判定前先移出集合，两种时序都正确", () => {
  it("done/error 时序：端口还连着也关（自身端口不构成保留条件）", () => {
    const { closeSelf, lifetime } = setup();
    const self = makePort();
    lifetime.trackAsrPort(self.port);

    lifetime.noteAsrTerminal(self.port);

    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  it("断连取消时序：端口已被断连监听移出，第二次 delete 幂等，仍关一次", () => {
    const { closeSelf, lifetime } = setup();
    const self = makePort();
    lifetime.trackAsrPort(self.port);

    self.fireDisconnect();
    lifetime.noteAsrTerminal(self.port);

    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  it("终态后端口才断连：出集幂等，不重复触发关闭判决", () => {
    const { closeSelf, lifetime } = setup();
    const self = makePort();
    lifetime.trackAsrPort(self.port);

    lifetime.noteAsrTerminal(self.port);
    self.fireDisconnect();

    expect(closeSelf).toHaveBeenCalledTimes(1);
  });
});

describe("withTask 非端口异步任务租约与自关竞态保护", () => {
  it("任务在飞期间 ASR 终态不关闭文档；最后一个任务结束后补触发关闭", async () => {
    const { closeSelf, lifetime } = setup();
    let resolveTask1!: () => void;
    let resolveTask2!: () => void;

    const task1 = lifetime.withTask(() => new Promise<string>((resolve) => {
      resolveTask1 = () => resolve("t1");
    }));
    const task2 = lifetime.withTask(() => new Promise<string>((resolve) => {
      resolveTask2 = () => resolve("t2");
    }));

    const asr = makePort();
    lifetime.trackAsrPort(asr.port);
    lifetime.noteAsrTerminal(asr.port);
    expect(closeSelf).not.toHaveBeenCalled();

    resolveTask1();
    await expect(task1).resolves.toBe("t1");
    expect(closeSelf).not.toHaveBeenCalled();

    resolveTask2();
    await expect(task2).resolves.toBe("t2");
    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  it("任务抛错仍递减计数并执行待决自关，且原样透传错误", async () => {
    const { closeSelf, lifetime } = setup();
    let rejectTask!: (error: Error) => void;

    const task = lifetime.withTask(() => new Promise<never>((_resolve, reject) => {
      rejectTask = reject;
    }));

    const asr = makePort();
    lifetime.trackAsrPort(asr.port);
    lifetime.noteAsrTerminal(asr.port);
    expect(closeSelf).not.toHaveBeenCalled();

    rejectTask(new Error("frame capture timeout"));
    await expect(task).rejects.toThrow("frame capture timeout");
    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  it("无 ASR 终态待决时，withTask 结束不会自行关闭文档", async () => {
    const { closeSelf, lifetime } = setup();
    await expect(lifetime.withTask(async () => "done")).resolves.toBe("done");
    expect(closeSelf).not.toHaveBeenCalled();
  });

  it("任务期间新连入常规端口或新 ASR 端口时，任务结束不再触发待决关闭", async () => {
    const { closeSelf, lifetime } = setup();
    let resolveTask!: () => void;

    const task = lifetime.withTask(() => new Promise<void>((resolve) => {
      resolveTask = resolve;
    }));

    const asr1 = makePort();
    lifetime.trackAsrPort(asr1.port);
    lifetime.noteAsrTerminal(asr1.port);
    expect(closeSelf).not.toHaveBeenCalled();

    const chat = makePort();
    lifetime.trackPort(chat.port);

    resolveTask();
    await task;
    expect(closeSelf).not.toHaveBeenCalled();

    chat.fireDisconnect();
    expect(closeSelf).not.toHaveBeenCalled();

    let resolveTask2!: () => void;
    const task2 = lifetime.withTask(() => new Promise<void>((resolve) => {
      resolveTask2 = resolve;
    }));
    const asr2 = makePort();
    lifetime.trackAsrPort(asr2.port);
    lifetime.noteAsrTerminal(asr2.port);

    const asr3 = makePort();
    lifetime.trackAsrPort(asr3.port);

    resolveTask2();
    await task2;
    expect(closeSelf).not.toHaveBeenCalled();

    lifetime.noteAsrTerminal(asr3.port);
    expect(closeSelf).toHaveBeenCalledTimes(1);
  });
});

describe("判定叶 shouldCloseAfterAsrTask：计数异常保守保留", () => {
  it("活跃端口与任务计数都为 0 → 关", () => {
    expect(shouldCloseAfterAsrTask(0, 0)).toBe(true);
  });

  it("任一条件非零 → 保留", () => {
    expect(shouldCloseAfterAsrTask(1, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(3, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, 1)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, 2)).toBe(false);
  });

  it.each([NaN, undefined])("计数异常（%s）→ 保守保留文档", (bad) => {
    expect(shouldCloseAfterAsrTask(bad, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, bad)).toBe(false);
    expect(shouldCloseAfterAsrTask(bad, bad)).toBe(false);
  });
});
