// tests/chat/chat-state-primitives.test.ts — B 档散字段写方归并（ADR-0005 重开
// 条件的落地件之一）：发送闸/新会话事务迁出的 4 个意图原语的单测。
import { describe, it, expect, beforeEach } from "vitest";
import {
  chatSessionState,
  resetChatSessionStateForTests,
  applyLiveContextToMain,
  rebuildCurrentContextKeyFromContext,
  noteDefaultModelChoice,
  setAsrTranscribingActive
} from "../../extension/chat/chat-state.js";
import type { AiContext } from "../../extension/ai/types.js";

function liveContext(overrides: Partial<AiContext> = {}): AiContext {
  return {
    url: "https://www.bilibili.com/video/BV1live/",
    bvid: "BV1live",
    isVideoContext: true,
    subtitleBody: ["line"],
    subtitleFetchState: "ready"
  } as unknown as AiContext;
}

describe("chat-state 意图原语（发送闸/新会话写方归并）", () => {
  beforeEach(() => {
    resetChatSessionStateForTests();
  });

  describe("setAsrTranscribingActive", () => {
    it("置 true / false 往返写 asrTranscribingActive", () => {
      setAsrTranscribingActive(true);
      expect(chatSessionState.asrTranscribingActive).toBe(true);
      setAsrTranscribingActive(false);
      expect(chatSessionState.asrTranscribingActive).toBe(false);
    });
  });

  describe("noteDefaultModelChoice", () => {
    it("裸平台 id 直接落 aiPrefs.defaultModel", () => {
      noteDefaultModelChoice("openai");
      expect(chatSessionState.aiPrefs.defaultModel).toBe("openai");
      noteDefaultModelChoice("");
      expect(chatSessionState.aiPrefs.defaultModel).toBe("");
    });
  });

  describe("applyLiveContextToMain", () => {
    it("live 快照落地主上下文并优先用 liveContextKey", () => {
      (chatSessionState as { liveContextData: AiContext | null }).liveContextData = liveContext();
      (chatSessionState as { liveContextKey: string }).liveContextKey = "video:BV1live|";
      applyLiveContextToMain();
      expect(chatSessionState.contextData?.bvid).toBe("BV1live");
      expect(chatSessionState.currentContextKey).toBe("video:BV1live|");
    });

    it("liveContextKey 为空时回退 buildContextKey(liveContextData)", () => {
      (chatSessionState as { liveContextData: AiContext | null }).liveContextData = liveContext();
      (chatSessionState as { liveContextKey: string }).liveContextKey = "";
      applyLiveContextToMain();
      expect(chatSessionState.currentContextKey).toBe("video:BV1live|");
    });

    it("落地是浅拷贝（与迁移前 { ...live } 逐字一致）：顶层字段改动不回流", () => {
      const live = liveContext();
      (chatSessionState as { liveContextData: AiContext | null }).liveContextData = live;
      applyLiveContextToMain();
      live.bvid = "mutated";
      expect(chatSessionState.contextData?.bvid).toBe("BV1live");
    });

    it("liveContextData 为 null 时 no-op（不动主上下文）", () => {
      chatSessionState.contextData = liveContext();
      applyLiveContextToMain();
      expect(chatSessionState.contextData?.bvid).toBe("BV1live");
    });
  });

  describe("rebuildCurrentContextKeyFromContext", () => {
    it("按当前 contextData 重算 key（无 bvid 时走 url 归一化）", () => {
      chatSessionState.contextData = {
        url: "https://www.bilibili.com/read/cv123/?foo=1#frag"
      } as unknown as AiContext;
      rebuildCurrentContextKeyFromContext();
      // buildContextKey 的 url 归一化只取 origin+pathname，query/hash 都丢。
      expect(chatSessionState.currentContextKey).toBe("url:https://www.bilibili.com/read/cv123/");
    });

    it("contextData 为 null 时 key 清空", () => {
      chatSessionState.currentContextKey = "video:stale|";
      chatSessionState.contextData = null;
      rebuildCurrentContextKeyFromContext();
      expect(chatSessionState.currentContextKey).toBe("");
    });
  });
});
