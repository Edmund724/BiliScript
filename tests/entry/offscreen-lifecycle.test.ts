// createOffscreenLifetime (offscreen document tiered idle reclaim & lease tracking) tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOffscreenLifetime,
  DEFAULT_ASR_IDLE_GRACE_MS,
  DEFAULT_LIGHT_IDLE_MS,
  DEFAULT_LIGHT_TAB_CHECK_DELAY_MS,
  DEFAULT_MEDIA_IDLE_GRACE_MS,
  shouldCloseAfterAsrTask,
  type LifetimePort,
  type OffscreenCloseRequest
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

function setup(overrides?: Parameters<typeof createOffscreenLifetime>[0] extends infer O ? Partial<O> : never) {
  const closeSelf = vi.fn<(request: OffscreenCloseRequest) => void>();
  const lifetime = createOffscreenLifetime({
    closeSelf,
    ...overrides
  });
  return { closeSelf, lifetime };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const CHANNEL_SIZES = [0, 1, 2];

describe("三条件穷举：只有活跃端口、其他解码端口与在飞任务全空才在 ASR 宽限后关文档", () => {
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

      // ASR 宽限期内尚未关闭
      vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS - 1);
      expect(closeSelf).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      const expectedClose = activePorts === 0 && otherAsrPorts === 0;
      expect(closeSelf).toHaveBeenCalledTimes(expectedClose ? 1 : 0);
      if (expectedClose) {
        expect(closeSelf).toHaveBeenCalledWith({ reason: "asr-idle" });
      }
    }
  );
});

describe("轻量通道（对话 / 概览代发）：长空闲兜底 + 关站校验", () => {
  it("轻量端口归零后不立即关闭；短延迟发关站校验，彻底闲置满 10 分钟才无条件回收", () => {
    const { closeSelf, lifetime } = setup();
    const chat = makePort();
    lifetime.trackPort(chat.port);

    chat.fireDisconnect();
    expect(closeSelf).not.toHaveBeenCalled();

    // 1.5s 后请求 SW 校验是否仍有打开的 B 站标签页（若仍有标签页则 SW 跳过关闭）
    vi.advanceTimersByTime(DEFAULT_LIGHT_TAB_CHECK_DELAY_MS - 1);
    expect(closeSelf).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenLastCalledWith({
      reason: "no-bilibili-tabs",
      onlyIfNoBilibiliTabs: true
    });

    // 模拟 SW 因仍有 B 站标签页跳过关闭：刷视频 9 分钟内不再触发关闭
    vi.advanceTimersByTime(DEFAULT_LIGHT_IDLE_MS - DEFAULT_LIGHT_TAB_CHECK_DELAY_MS - 1);
    expect(closeSelf).toHaveBeenCalledTimes(1);

    // 彻底闲置满 10 分钟：触发长空闲兜底无条件回收
    vi.advanceTimersByTime(1);
    expect(closeSelf).toHaveBeenCalledTimes(2);
    expect(closeSelf).toHaveBeenLastCalledWith({ reason: "light-idle" });
  });

  it("轻量长空闲宽限期内新连接进入立即取消计时器，保证刷视频期间零冷启动", () => {
    const { closeSelf, lifetime } = setup();
    const chat1 = makePort();
    lifetime.trackPort(chat1.port);
    chat1.fireDisconnect();

    // 9 分钟后再次打开对话
    vi.advanceTimersByTime(9 * 60_000);
    expect(closeSelf).toHaveBeenCalledTimes(1); // 仅 1.5s 时的一次条件校验
    expect(closeSelf).toHaveBeenLastCalledWith({
      reason: "no-bilibili-tabs",
      onlyIfNoBilibiliTabs: true
    });

    const chat2 = makePort();
    lifetime.trackPort(chat2.port);

    // 持续连接超过原 10 分钟窗口，不会触发关闭
    vi.advanceTimersByTime(5 * 60_000);
    expect(closeSelf).toHaveBeenCalledTimes(1);

    // 新连接断开后重新计时 10 分钟
    chat2.fireDisconnect();
    vi.advanceTimersByTime(DEFAULT_LIGHT_IDLE_MS - 1);
    expect(closeSelf).toHaveBeenCalledTimes(2); // 1.5s 条件校验

    vi.advanceTimersByTime(1);
    expect(closeSelf).toHaveBeenCalledTimes(3);
    expect(closeSelf).toHaveBeenLastCalledWith({ reason: "light-idle" });
  });

  it("notifyAllBilibiliTabsClosed 在空闲时立即触发关站回收；有活跃端口或任务时忽略", async () => {
    const { closeSelf, lifetime } = setup();
    const chat = makePort();
    lifetime.trackPort(chat.port);

    // 活跃连接在飞时忽略关站通知
    lifetime.notifyAllBilibiliTabsClosed();
    expect(closeSelf).not.toHaveBeenCalled();

    // 断开后在短延迟前收到关站通知，立即触发且不再重复发短延迟校验
    chat.fireDisconnect();
    lifetime.notifyAllBilibiliTabsClosed();
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenLastCalledWith({
      reason: "no-bilibili-tabs",
      onlyIfNoBilibiliTabs: true
    });

    vi.advanceTimersByTime(DEFAULT_LIGHT_TAB_CHECK_DELAY_MS);
    expect(closeSelf).toHaveBeenCalledTimes(1);

    // 有在飞异步任务时同样忽略关站通知
    let resolveTask!: () => void;
    const task = lifetime.withTask(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        })
    );
    lifetime.notifyAllBilibiliTabsClosed();
    expect(closeSelf).toHaveBeenCalledTimes(1);

    resolveTask();
    await task;
  });
});

describe("重型音视频通道（ASR / 实时伴看 / 视频截帧）：短宽限回收与打断恢复", () => {
  it("ASR 终态后在 4s 宽限期满触发回收；终态后端口迟到断连不重置计时器", () => {
    const { closeSelf, lifetime } = setup();
    const asr = makePort();
    lifetime.trackAsrPort(asr.port);

    lifetime.noteAsrTerminal(asr.port);
    vi.advanceTimersByTime(2_000);
    expect(closeSelf).not.toHaveBeenCalled();

    // 终态后 2s 端口才断连：已移出集合，不得重置倒计时
    asr.fireDisconnect();
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS - 2_000);
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenCalledWith({ reason: "asr-idle" });
  });

  it("断连取消时序：ASR 端口先断连后 noteAsrTerminal，幂等且只回收一次", () => {
    const { closeSelf, lifetime } = setup();
    const asr = makePort();
    lifetime.trackAsrPort(asr.port);

    asr.fireDisconnect();
    lifetime.noteAsrTerminal(asr.port);

    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS);
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenCalledWith({ reason: "asr-idle" });
  });

  it("实时伴看媒体端口（trackMediaPort）归零后采用 45s 短宽限回收", () => {
    const { closeSelf, lifetime } = setup();
    const live = makePort();
    lifetime.trackMediaPort(live.port);

    live.fireDisconnect();
    vi.advanceTimersByTime(DEFAULT_MEDIA_IDLE_GRACE_MS - 1);
    expect(closeSelf).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenCalledWith({ reason: "media-idle" });
  });

  it("视频截帧重型任务（withTask heavy:true）正常结束或抛错后均按 45s 短宽限回收", async () => {
    const { closeSelf, lifetime } = setup();
    await expect(lifetime.withTask(async () => "frames", { heavy: true })).resolves.toBe("frames");

    vi.advanceTimersByTime(DEFAULT_MEDIA_IDLE_GRACE_MS - 1);
    expect(closeSelf).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenLastCalledWith({ reason: "media-idle" });

    // 抛错路径同样递减计数并按重型宽限回收，原样透传错误
    const second = setup();
    await expect(
      second.lifetime.withTask(
        async () => {
          throw new Error("frame capture timeout");
        },
        { heavy: true }
      )
    ).rejects.toThrow("frame capture timeout");

    vi.advanceTimersByTime(DEFAULT_MEDIA_IDLE_GRACE_MS);
    expect(second.closeSelf).toHaveBeenCalledTimes(1);
    expect(second.closeSelf).toHaveBeenCalledWith({ reason: "media-idle" });
  });

  it("重型宽限期内新连接或新任务进入立即取消关闭计时器；全部归零后仍按重型短窗口回收", async () => {
    const { closeSelf, lifetime } = setup();
    const asr = makePort();
    lifetime.trackAsrPort(asr.port);
    lifetime.noteAsrTerminal(asr.port);

    // 宽限期走到一半时进入新轻量对话连接：必须取消关闭计时器
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS / 2);
    const chat = makePort();
    lifetime.trackPort(chat.port);

    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS * 2);
    expect(closeSelf).not.toHaveBeenCalled();

    // 对话断开归零后，因为本次会话使用过 ASR 高内存能力，仍按 ASR 短窗口回收
    chat.fireDisconnect();
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS - 1);
    expect(closeSelf).not.toHaveBeenCalled();

    // 再次被异步任务打断
    let resolveTask!: () => void;
    const task = lifetime.withTask(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        })
    );
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS * 2);
    expect(closeSelf).not.toHaveBeenCalled();

    resolveTask();
    await task;
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS);
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenCalledWith({ reason: "asr-idle" });
  });

  it("多个任务与 ASR 并发在飞时，仅当全部任务和端口归零才启动宽限倒计时", async () => {
    const { closeSelf, lifetime } = setup();
    let resolveTask1!: () => void;
    let resolveTask2!: () => void;

    const task1 = lifetime.withTask(
      () =>
        new Promise<string>((resolve) => {
          resolveTask1 = () => resolve("t1");
        }),
      { heavy: true }
    );
    const task2 = lifetime.withTask(
      () =>
        new Promise<string>((resolve) => {
          resolveTask2 = () => resolve("t2");
        }),
      { heavy: true }
    );

    const asr = makePort();
    lifetime.trackAsrPort(asr.port);
    lifetime.noteAsrTerminal(asr.port);
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS * 2);
    expect(closeSelf).not.toHaveBeenCalled();

    resolveTask1();
    await expect(task1).resolves.toBe("t1");
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS * 2);
    expect(closeSelf).not.toHaveBeenCalled();

    resolveTask2();
    await expect(task2).resolves.toBe("t2");
    vi.advanceTimersByTime(DEFAULT_ASR_IDLE_GRACE_MS - 1);
    expect(closeSelf).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(closeSelf).toHaveBeenCalledWith({ reason: "asr-idle" });
  });

  it("dispose 清理挂起计时器后不再触发关闭", () => {
    const { closeSelf, lifetime } = setup();
    const asr = makePort();
    lifetime.trackAsrPort(asr.port);
    lifetime.noteAsrTerminal(asr.port);

    lifetime.dispose();
    vi.advanceTimersByTime(DEFAULT_LIGHT_IDLE_MS);
    expect(closeSelf).not.toHaveBeenCalled();
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
