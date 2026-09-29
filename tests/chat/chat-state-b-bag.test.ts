// tests/chat/chat-state-b-bag.test.ts — B 档只读面收口（ADR-0005）落地件：
// ① 新意图原语的行为锁（平台偏好整组落地 / live 快照与标签页三原语）；
// ② 只读面与既有链的咬合（live 快照落地 → applyLiveContextToMain）；
// ③ 源码守卫：可写把手不得流出 chat-state.ts。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildContextKey } from "../../extension/ai/conversation.js";
import {
  applyLiveContextSnapshot,
  applyLiveContextToMain,
  applyProviderPrefs,
  chatSessionState,
  chatSessionStateForTests,
  noteLiveTabUrl,
  resetChatSessionStateForTests,
  resetLiveContext,
  setAiThinkingLevel,
  setWebSearchEnabled
} from "../../extension/chat/chat-state.js";
import type { ChatSessionContextSnapshot } from "../../extension/chat/chat-state.js";

const ROOT = process.cwd();

function snapshot(overrides: Partial<ChatSessionContextSnapshot> = {}): ChatSessionContextSnapshot {
  return {
    url: "https://www.bilibili.com/video/BV1live/",
    bvid: "BV1live",
    isVideoContext: true,
    subtitleBody: ["line"],
    subtitleFetchState: "ready",
    ...overrides
  } as unknown as ChatSessionContextSnapshot;
}

describe("chat-state B 档意图原语", () => {
  beforeEach(() => {
    resetChatSessionStateForTests();
  });

  describe("applyProviderPrefs（loadProvidersAndPrefs 的整组落地）", () => {
    it("一次调用落地平台列表 / aiPrefs / 思考档位 / 联网开关四组字段", () => {
      applyProviderPrefs({
        providers: [{ id: "p1", name: "平台一", models: ["m1"] }],
        aiPrefs: { aiSystemPrompt: "你是助手", aiInitialQuickPrompts: ["总结"], defaultModel: "p1" },
        aiThinkingLevel: "high",
        webSearchEnabled: true
      });
      expect(chatSessionState.providers).toEqual([{ id: "p1", name: "平台一", models: ["m1"] }]);
      expect(chatSessionState.aiPrefs).toEqual({
        aiSystemPrompt: "你是助手",
        aiInitialQuickPrompts: ["总结"],
        defaultModel: "p1"
      });
      expect(chatSessionState.aiThinkingLevel).toBe("high");
      expect(chatSessionState.webSearchEnabled).toBe(true);
    });

    it("空列表 / 空偏好整组覆盖（defaultModel 一并清空，不留上次残值）", () => {
      applyProviderPrefs({
        providers: [],
        aiPrefs: { aiSystemPrompt: "", aiInitialQuickPrompts: [], defaultModel: "" },
        aiThinkingLevel: "off",
        webSearchEnabled: false
      });
      expect(chatSessionState.providers).toEqual([]);
      expect(chatSessionState.aiPrefs.defaultModel).toBe("");
      expect(chatSessionState.aiThinkingLevel).toBe("off");
      expect(chatSessionState.webSearchEnabled).toBe(false);
    });

    it("不触碰主上下文与 live 侧（只动四组偏好字段）", () => {
      const kept = snapshot();
      chatSessionStateForTests.contextData = kept;
      chatSessionStateForTests.currentContextKey = "video:BV1live|";
      applyProviderPrefs({
        providers: [{ id: "p1" }],
        aiPrefs: { aiSystemPrompt: "s", aiInitialQuickPrompts: [] },
        aiThinkingLevel: "low",
        webSearchEnabled: false
      });
      expect(chatSessionState.contextData).toBe(kept);
      expect(chatSessionState.currentContextKey).toBe("video:BV1live|");
      expect(chatSessionState.liveContextData).toBeNull();
    });
  });

  describe("setAiThinkingLevel / setWebSearchEnabled（单键切换）", () => {
    it("档位与开关各自单键写", () => {
      setAiThinkingLevel("low");
      expect(chatSessionState.aiThinkingLevel).toBe("low");
      setWebSearchEnabled(true);
      expect(chatSessionState.webSearchEnabled).toBe(true);
      setWebSearchEnabled(false);
      expect(chatSessionState.webSearchEnabled).toBe(false);
    });
  });

  describe("noteLiveTabUrl（往返结束后刷新 tab url）", () => {
    it("写入 url；空串照写（失败往返也刷新，与迁移前一致）", () => {
      noteLiveTabUrl("https://www.bilibili.com/video/BV1tab");
      expect(chatSessionState.liveTabUrl).toBe("https://www.bilibili.com/video/BV1tab");
      noteLiveTabUrl("");
      expect(chatSessionState.liveTabUrl).toBe("");
    });
  });

  describe("applyLiveContextSnapshot（成功前缀落地 / ERROR 分支失效）", () => {
    it("按引用落地快照，key 由 buildContextKey 派生", () => {
      const payload = snapshot();
      applyLiveContextSnapshot(payload);
      expect(chatSessionState.liveContextData).toBe(payload);
      expect(chatSessionState.liveContextKey).toBe(buildContextKey(payload));
    });

    it("null → 快照两键清空，liveTabUrl 保留（tab url 由 noteLiveTabUrl 单独维护）", () => {
      noteLiveTabUrl("https://www.bilibili.com/video/BV1tab");
      applyLiveContextSnapshot(snapshot());
      applyLiveContextSnapshot(null);
      expect(chatSessionState.liveContextData).toBeNull();
      expect(chatSessionState.liveContextKey).toBe("");
      expect(chatSessionState.liveTabUrl).toBe("https://www.bilibili.com/video/BV1tab");
    });

    it("与既有链咬合：落地后的 live 快照能被 applyLiveContextToMain 落进主上下文", () => {
      const payload = snapshot();
      applyLiveContextSnapshot(payload);
      applyLiveContextToMain();
      expect(chatSessionState.contextData?.bvid).toBe("BV1live");
      expect(chatSessionState.currentContextKey).toBe(buildContextKey(payload));
    });
  });

  describe("resetLiveContext（no-tab 分支：live 三键一并清空）", () => {
    it("快照两键与 tab url 全部清空", () => {
      applyLiveContextSnapshot(snapshot());
      noteLiveTabUrl("https://www.bilibili.com/video/BV1tab");
      resetLiveContext();
      expect(chatSessionState.liveContextData).toBeNull();
      expect(chatSessionState.liveContextKey).toBe("");
      expect(chatSessionState.liveTabUrl).toBe("");
    });
  });
});

describe("可写把手不外流（源码守卫）", () => {
  it("extension/ 下除 chat-state.ts 定义处外，没有任何文件引用 chatSessionStateForTests", () => {
    const offenders: string[] = [];
    walk(join(ROOT, "extension"), (file) => {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      if (rel === "extension/chat/chat-state.ts") return;
      if (!/\.(ts|js)$/.test(rel)) return;
      if (readFileSync(file, "utf8").includes("chatSessionStateForTests")) {
        offenders.push(rel);
      }
    });
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else {
      visit(full);
    }
  }
}
