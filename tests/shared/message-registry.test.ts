// SW 消息注册表（一条消息一处登记）——注册表值与派生面的运行期对账。
//
// 背景：SW 消息的声明、响应类型、形状判据、回包口径与来源登记都收在本注册表一处，
// 回包口径（return true 异步持有 / return false 同步已答）不再散在 30 个 handler
// 体里。本文件是那条「一处登记」的事实锚点：
//   1. 注册表键集 = 全部 SW 消息（漏消息 / 多登记都要红）；
//   2. 回包口径逐条与处理器实际口径对账（记反的后果是调用方空等或通道提前关闭，
//      故期望值独立手写，不复用注册表自身）；
//   3. 回包口径三态的入口 boolean 语义（resolveReplyKeepOpen 纯函数；branch 档的
//      判定取值 = MessageReplyDecision，"hold" 持有 / "answered" 已答）；
//   4. offscreen 来源名单由注册表逐条的 sender 标签派生（顺序稳定）；
//   5. payload 最小 schema 判据：登记项恰好是协议约定的五条，且逐条拒非法、放合法。
//
// 这里只测协议层事实（判据本身）；守卫对判据的消费与拒绝文案在
// tests/core/message-router.test.ts。

import { describe, expect, it } from "vitest";
import {
  BACKGROUND_MESSAGE_REGISTRY,
  OFFSCREEN_ONLY_MESSAGE_TYPES,
  resolveReplyKeepOpen,
  type BackgroundMessageType,
  type MessageReplyMode
} from "../../extension/shared/messaging-protocol.js";

// ===== 期望固件：改动注册表必须显式过这里的逐条断言 =====

// 回包口径的独立手写期望（事实来源 = 各处理器当下的返回路径，非注册表自身）。
const REPLY_MODE_SPEC: Record<BackgroundMessageType, MessageReplyMode> = {
  // async：处理器持有回包通道（可能同步也可能异步回包），入口恒返回 true
  "get-settings": "async",
  "save-settings": "async",
  "check-provider-origin": "async",
  "ensure-offscreen-chat": "async",
  "ai-providers-list": "async",
  "ai-providers-save": "async",
  "ai-providers-delete": "async",
  "provider-http": "async",
  "resolve-ai-provider": "async",
  "asr-providers-list": "async",
  "asr-providers-save": "async",
  "asr-providers-delete": "async",
  "get-asr-runtime-config": "async",
  "search-providers-list": "async",
  "search-providers-save": "async",
  "search-providers-delete": "async",
  "resolve-search-provider": "async",
  "search-cache": "async",
  "search-health": "async",
  "segment-cache": "async",
  "offscreen-request-close": "async",
  "get-debug-log-gate": "async",
  // sync：处理器返回前已同步回包，通道不持有
  "ai-presets-list": "sync",
  "asr-presets-list": "sync",
  // branch：口径逐分支而定（同步预检失败即答 / 通过后转异步），handler 自持判定
  "request-provider-origins": "branch",
  "player-ai-quick-action": "branch",
  "fetch-json": "branch",
  "get-ai-provider-key": "branch",
  "offload-task": "branch"
};

// payload 最小 schema 的登记面（协议约定：save-settings 的对象形状、三家
// providers-save 的数组形状、player-ai-quick-action 的 tabId 有限数）。
const SHAPE_REGISTERED_TYPES = [
  "ai-providers-save",
  "asr-providers-save",
  "player-ai-quick-action",
  "save-settings",
  "search-providers-save"
];

const registryKeys = Object.keys(BACKGROUND_MESSAGE_REGISTRY) as BackgroundMessageType[];

function shapeOf(type: BackgroundMessageType): (message: unknown) => boolean {
  const shape = BACKGROUND_MESSAGE_REGISTRY[type].shape;
  if (typeof shape !== "function") {
    throw new Error(`${type} 未登记形状判据`);
  }
  return shape;
}

describe("SW 消息注册表：键集与回包口径", () => {
  it("键集 = 已登记的消息全集（漏消息 / 多登记都红）", () => {
    expect([...registryKeys].sort()).toEqual(Object.keys(REPLY_MODE_SPEC).sort());
  });

  it("回包口径逐条对账：登记值与处理器实际口径一致（记反即空等 / 通道提前关闭）", () => {
    for (const [type, mode] of Object.entries(REPLY_MODE_SPEC)) {
      expect(BACKGROUND_MESSAGE_REGISTRY[type as BackgroundMessageType].reply, type).toBe(mode);
    }
  });

  it("回包口径三态语义：async 恒持有 / sync 恒已答 / branch 处理器自持判定", () => {
    // async：处理器自持的返回值不参与判定（缺 baseUrl 也同步回包的条目仍是 async）
    expect(resolveReplyKeepOpen("async", "hold")).toBe(true);
    expect(resolveReplyKeepOpen("async", "answered")).toBe(true);
    // sync：已同步回包，通道一律不持有
    expect(resolveReplyKeepOpen("sync", "hold")).toBe(false);
    expect(resolveReplyKeepOpen("sync", "answered")).toBe(false);
    // branch：处理器返回的判定即口径（未返回判定与 "answered" 同义，对齐 onMessage 语义）
    expect(resolveReplyKeepOpen("branch", "hold")).toBe(true);
    expect(resolveReplyKeepOpen("branch", "answered")).toBe(false);
    expect(resolveReplyKeepOpen("branch", undefined)).toBe(false);
  });
});

describe("SW 消息注册表：来源登记与 offscreen 名单派生", () => {
  it("offscreen 专属名单由注册表派生：恰为协议约定的两项、顺序稳定", () => {
    // 期望值取自协议契约本身（offscreen 专属族 = 这两个 type 字面量），
    // 不复用注册表的过滤结果，避免等于自身的同义断言。
    expect([...OFFSCREEN_ONLY_MESSAGE_TYPES]).toEqual(["segment-cache", "offscreen-request-close"]);
  });

  it("名单 ⇄ sender 标签登记双向一致（无未登记进名单项、无漏登记项）", () => {
    const registered = registryKeys.filter(
      (type) => BACKGROUND_MESSAGE_REGISTRY[type].sender !== undefined
    );
    expect(registered).toEqual([...OFFSCREEN_ONLY_MESSAGE_TYPES]);
  });
});

describe("SW 消息注册表：payload 最小 schema 判据", () => {
  it("形状判据恰好登记五条（漏登记即静默缺检）", () => {
    const withShape = registryKeys
      .filter((type) => typeof BACKGROUND_MESSAGE_REGISTRY[type].shape === "function")
      .sort();
    expect(withShape).toEqual(SHAPE_REGISTERED_TYPES);
  });

  it("save-settings：settings 缺省 / null / 非数组对象合法，字符串与数组非法", () => {
    const shape = shapeOf("save-settings");
    expect(shape({ type: "save-settings", settings: { enableDebugLogs: true } })).toBe(true);
    expect(shape({ type: "save-settings", settings: null })).toBe(true);
    expect(shape({ type: "save-settings" })).toBe(true);
    expect(shape({ type: "save-settings", settings: "junk" })).toBe(false);
    expect(shape({ type: "save-settings", settings: [1, 2] })).toBe(false);
  });

  it("三家 providers-save：providers 缺省 / 数组合法，字符串与 null 非法", () => {
    for (const type of ["ai-providers-save", "asr-providers-save", "search-providers-save"] as const) {
      const shape = shapeOf(type);
      expect(shape({ type, providers: [{ id: "p" }] }), type).toBe(true);
      expect(shape({ type }), type).toBe(true);
      expect(shape({ type, providers: "x" }), type).toBe(false);
      expect(shape({ type, providers: null }), type).toBe(false);
    }
  });

  it("player-ai-quick-action：tabId 缺省 / 有限数合法，字符串非法", () => {
    const shape = shapeOf("player-ai-quick-action");
    expect(shape({ type: "player-ai-quick-action", tabId: 7 })).toBe(true);
    expect(shape({ type: "player-ai-quick-action" })).toBe(true);
    expect(shape({ type: "player-ai-quick-action", tabId: "7" })).toBe(false);
  });
});
