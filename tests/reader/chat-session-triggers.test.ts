// tests/reader/chat-session-triggers.test.ts
// createReaderChatSessionTriggers（会话级触发源对象）行为契约：每类触发源恰挂一次、
// 摘除是挂载的闭合逆操作（逆序）、重复 activate 幂等、deactivate 后可整体再挂。
//
// 不挂阅读壳：deps 全是本文件造的替身（每源一个「挂载 → 返回摘除器」），断言面只有
// 挂载 / 摘除的次序与在场判定——各触发源具体订阅了什么，由组合根与各模块自己的
// 契约负责。

import { describe, expect, it } from "vitest";
import {
  createReaderChatSessionTriggers,
  type ReaderChatSessionTriggersDeps
} from "../../extension/reader/chat-session-triggers.js";

// 会话级触发源的类别清单（顺序 = 声明顺序 = 挂载顺序；断言逆序摘除时按它翻过来）。
const SOURCES = [
  "statusBus",
  "urlChange",
  "clipSettle",
  "storageWatcher",
  "quickPrompts",
  "outsideClick",
  "escapeKey"
] as const;

// 每源一个替身，把挂载 / 摘除记成有序事件流（"+源名" / "-源名"）：一份事件流同时
// 能断言「每类恰一次」「逆序摘除」「不双挂」三件事。
function makeHarness() {
  const events: string[] = [];
  const sources = Object.fromEntries(
    SOURCES.map((source) => [
      source,
      () => {
        events.push(`+${source}`);
        return () => {
          events.push(`-${source}`);
        };
      }
    ])
  ) as unknown as ReaderChatSessionTriggersDeps;
  return { triggers: createReaderChatSessionTriggers(sources), events };
}

const ATTACHES = SOURCES.map((source) => `+${source}`);
const TEARDOWNS = [...SOURCES].reverse().map((source) => `-${source}`);

describe("会话级触发源对象：activate / deactivate / isActive", () => {
  it("activate：每类触发源恰挂一次，isActive 为真", () => {
    const { triggers, events } = makeHarness();

    expect(triggers.isActive()).toBe(false);
    triggers.activate();

    expect(events).toEqual(ATTACHES);
    expect(triggers.isActive()).toBe(true);
  });

  it("重复 activate 幂等：不双挂（各类触发源的挂载次数不变）", () => {
    const { triggers, events } = makeHarness();

    triggers.activate();
    triggers.activate();
    triggers.activate();

    expect(events).toEqual(ATTACHES);
    expect(triggers.isActive()).toBe(true);
  });

  it("deactivate：逆序摘除全部已挂载触发源，isActive 转假", () => {
    const { triggers, events } = makeHarness();

    triggers.activate();
    triggers.deactivate();

    expect(events).toEqual([...ATTACHES, ...TEARDOWNS]);
    expect(triggers.isActive()).toBe(false);
  });

  it("未激活时 deactivate 无操作；重复 deactivate 不重复摘", () => {
    const { triggers, events } = makeHarness();

    triggers.deactivate();
    expect(events).toEqual([]);

    triggers.activate();
    triggers.deactivate();
    triggers.deactivate();
    expect(events).toEqual([...ATTACHES, ...TEARDOWNS]);
  });

  it("deactivate 后再次 activate：重新挂满，摘除器只摘当前这一批", () => {
    const { triggers, events } = makeHarness();

    triggers.activate();
    triggers.deactivate();
    triggers.activate();

    expect(events).toEqual([...ATTACHES, ...TEARDOWNS, ...ATTACHES]);
    expect(triggers.isActive()).toBe(true);

    triggers.deactivate();
    expect(events).toEqual([...ATTACHES, ...TEARDOWNS, ...ATTACHES, ...TEARDOWNS]);
    expect(triggers.isActive()).toBe(false);
  });
});
