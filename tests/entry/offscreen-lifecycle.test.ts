// createOffscreenLifetime（offscreen 文档寿命：三通道存活簿记 + asr 终态自关判决）
// 测试：
// - 三条件穷举（聊天端口 / 其他 asr-decode 端口 / 在飞概览代发端口）：三通道全空
//   才关文档，任一非空即保留；任一通道随后释放，计数回到全空后照常关；
// - 先删自身端口再判：终态端口还连着也关，已被断连移出也关（Set.delete 幂等）；
// - 计数异常（NaN/undefined）→ 保守保留（判定叶 shouldCloseAfterAsrTask）。
//
// 模块只认识端口的最小结构面（onDisconnect），用例用假端口驱动，不依赖 chrome。

import { describe, expect, it, vi } from "vitest";
import {
  createOffscreenLifetime,
  shouldCloseAfterAsrTask,
  type LifetimePort
} from "../../extension/entry/offscreen-lifecycle.js";

// 假端口：只提供模块用到的那一面，并暴露手动触发断连的入口
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
      for (const listener of disconnectListeners) listener();
    }
  };
}

function setup() {
  const closeSelf = vi.fn();
  return { closeSelf, lifetime: createOffscreenLifetime({ closeSelf }) };
}

const CHANNEL_SIZES = [0, 1, 2];

describe("三条件穷举：只有三条通道全空才关文档", () => {
  const combos = CHANNEL_SIZES.flatMap((chatPorts) =>
    CHANNEL_SIZES.flatMap((otherAsrPorts) =>
      CHANNEL_SIZES.map((providerPorts) => ({ chatPorts, otherAsrPorts, providerPorts }))
    )
  );

  it.each(combos)(
    "聊天 $chatPorts / 其他解码 $otherAsrPorts / 在飞代发 $providerPorts",
    ({ chatPorts, otherAsrPorts, providerPorts }) => {
      const { closeSelf, lifetime } = setup();
      for (let i = 0; i < chatPorts; i += 1) lifetime.trackChatPort(makePort().port);
      for (let i = 0; i < otherAsrPorts; i += 1) lifetime.trackAsrPort(makePort().port);
      for (let i = 0; i < providerPorts; i += 1) lifetime.trackProviderPort(makePort().port);

      const self = makePort();
      lifetime.trackAsrPort(self.port);
      lifetime.noteAsrTerminal(self.port);

      const expectedClose = chatPorts === 0 && otherAsrPorts === 0 && providerPorts === 0;
      expect(closeSelf).toHaveBeenCalledTimes(expectedClose ? 1 : 0);
    }
  );
});

describe("通道释放：任一保留条件消失后，计数回到全空即关", () => {
  it("聊天端口断连出集后再来终态 → 关", () => {
    const { closeSelf, lifetime } = setup();
    const chat = makePort();
    lifetime.trackChatPort(chat.port);

    const first = makePort();
    lifetime.trackAsrPort(first.port);
    lifetime.noteAsrTerminal(first.port);
    expect(closeSelf).not.toHaveBeenCalled();

    chat.fireDisconnect();

    const second = makePort();
    lifetime.trackAsrPort(second.port);
    lifetime.noteAsrTerminal(second.port);
    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  it("概览代发端口断连出集后再来终态 → 关", () => {
    const { closeSelf, lifetime } = setup();
    const relay = makePort();
    lifetime.trackProviderPort(relay.port);

    const first = makePort();
    lifetime.trackAsrPort(first.port);
    lifetime.noteAsrTerminal(first.port);
    expect(closeSelf).not.toHaveBeenCalled();

    relay.fireDisconnect();

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

describe("判定叶 shouldCloseAfterAsrTask：计数异常保守保留", () => {
  it("聊天计数与在飞代发都为 0 → 关", () => {
    expect(shouldCloseAfterAsrTask(0, 0)).toBe(true);
  });

  it("任一条件非零 → 保留", () => {
    expect(shouldCloseAfterAsrTask(1, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(3, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, 1)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, 2)).toBe(false);
  });

  it("计数异常（NaN/undefined）→ 保守保留文档", () => {
    for (const bad of [NaN, undefined]) {
      expect(shouldCloseAfterAsrTask(bad, 0)).toBe(false);
      expect(shouldCloseAfterAsrTask(0, bad)).toBe(false);
      expect(shouldCloseAfterAsrTask(bad, bad)).toBe(false);
    }
  });
});
