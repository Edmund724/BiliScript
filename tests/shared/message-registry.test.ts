import { describe, expect, it } from "vitest";
import {
  BACKGROUND_MESSAGE_REGISTRY,
  OFFSCREEN_ONLY_MESSAGE_TYPES,
  resolveReplyKeepOpen,
  type BackgroundMessageType,
  type MessageReplyMode
} from "../../extension/shared/messaging-protocol.js";

const REPLY_MODE_SPEC: Record<BackgroundMessageType, MessageReplyMode> = {
  "get-settings": "async",
  "save-settings": "async",
  "agent-bridge-status": "async",
  "agent-bridge-connect": "async",
  "agent-bridge-test": "async",
  "check-provider-origin": "async",
  "revoke-provider-origin": "async",
  "ensure-offscreen-chat": "async",
  "ai-providers-list": "async",
  "ai-providers-save": "async",
  "ai-providers-delete": "async",
  "provider-http": "async",
  "resolve-ai-provider": "async",
  "resolve-subtitle-translate-provider": "async",
  "subtitle-translate-siliconflow-key-status": "async",
  "subtitle-translate-siliconflow-key-save": "async",
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
  "subtitle-cache": "async",
  "offscreen-request-close": "async",
  "get-debug-log-gate": "async",
  "open-onboarding": "async",
  "live-providers-list": "async",
  "live-providers-save": "async",
  "live-providers-delete": "async",
  "live-session-prepare": "async",
  "live-session-cleanup": "async",
  "ai-presets-list": "sync",
  "asr-presets-list": "sync",
  "permission-grant-result": "sync",
  "request-provider-origins": "branch",
  "player-ai-quick-action": "branch",
  "fetch-json": "branch",
  "get-ai-provider-key": "branch",
  "offload-task": "branch",
  "youtube-page-snapshot": "branch",
  "youtube-ensure-sabr-worker": "branch",
  "content-style-insert": "branch",
  "content-style-remove": "branch",
  "content-style-read": "branch",
  "content-chunk-load": "branch"
};

const SHAPE_REGISTERED_TYPES = [
  "ai-providers-save",
  "asr-providers-save",
  "content-chunk-load",
  "content-style-insert",
  "content-style-read",
  "content-style-remove",
  "live-providers-save",
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
    expect(resolveReplyKeepOpen("async", "hold")).toBe(true);
    expect(resolveReplyKeepOpen("async", "answered")).toBe(true);
    expect(resolveReplyKeepOpen("sync", "hold")).toBe(false);
    expect(resolveReplyKeepOpen("sync", "answered")).toBe(false);
    expect(resolveReplyKeepOpen("branch", "hold")).toBe(true);
    expect(resolveReplyKeepOpen("branch", "answered")).toBe(false);
    expect(resolveReplyKeepOpen("branch", undefined)).toBe(false);
  });
});

describe("SW 消息注册表：来源登记与 offscreen 名单派生", () => {
  it("offscreen 专属名单由注册表派生：恰为协议约定的两项、顺序稳定", () => {
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

  it("各家 providers-save：providers 缺省 / 数组合法，字符串与 null 非法", () => {
    for (const type of ["ai-providers-save", "asr-providers-save", "search-providers-save", "live-providers-save"] as const) {
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

  it("content-style-*：files 须为非空字符串数组", () => {
    for (const type of ["content-style-insert", "content-style-remove", "content-style-read"] as const) {
      const shape = shapeOf(type);
      expect(shape({ type, files: ["entry/styles/reader.css"] }), type).toBe(true);
      expect(shape({ type, files: [] }), type).toBe(false);
      expect(shape({ type, files: [123] }), type).toBe(false);
      expect(shape({ type }), type).toBe(false);
    }
  });

  it("content-chunk-load：chunkId 须为非空字符串", () => {
    const shape = shapeOf("content-chunk-load");
    expect(shape({ type: "content-chunk-load", chunkId: "g-app" })).toBe(true);
    expect(shape({ type: "content-chunk-load", chunkId: "" })).toBe(false);
    expect(shape({ type: "content-chunk-load", chunkId: "   " })).toBe(false);
    expect(shape({ type: "content-chunk-load", chunkId: 123 })).toBe(false);
    expect(shape({ type: "content-chunk-load" })).toBe(false);
  });
});
