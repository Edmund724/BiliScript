// tests/chat/chat-state-primitives.test.ts — B 档散字段写方归并（ADR-0005 重开
// 条件的落地件之一）：发送闸/新会话事务迁出的 4 个意图原语的单测。
import { describe, it, expect, beforeEach } from "vitest";
import {
  chatSessionState,
  resetChatSessionStateForTests,
  applyLiveContextToMain,
  rebuildCurrentContextKeyFromContext,
  noteDefaultModelChoice,
  setAsrTranscribingActive,
  applyContextToMain,
  applyContextSnapshot,
  pinCurrentContextKey,
  clearMainContext
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

  describe("applyContextToMain（第二轮写方归并：落地 + key 重算的整组意图）", () => {
    it("按引用落地（不拷贝——拷贝语义由调用方决定，逐字保持各写点原状）", () => {
      const resolved = liveContext({ bvid: "BVV" });
      applyContextToMain(resolved, "video:BVV|");
      expect(chatSessionState.contextData).toBe(resolved);
      expect(chatSessionState.currentContextKey).toBe("video:BVV|");
    });

    it("preferredKey 缺省/为空串时回退 buildContextKey(next)", () => {
      applyContextToMain(liveContext(), "");
      expect(chatSessionState.currentContextKey).toBe("video:BV1live|");
    });

    it("next 为 null 且无 key → 主上下文与 key 一并清空", () => {
      chatSessionState.contextData = liveContext();
      chatSessionState.currentContextKey = "video:stale|";
      applyContextToMain(null);
      expect(chatSessionState.contextData).toBeNull();
      expect(chatSessionState.currentContextKey).toBe("");
    });
  });

  describe("applyContextSnapshot（context-load 的 applyContextPayload 写入半）", () => {
    it("key 变化时返回 true 并落地新快照", () => {
      chatSessionState.currentContextKey = "video:OLD|";
      const changed = applyContextSnapshot(liveContext());
      expect(changed).toBe(true);
      expect(chatSessionState.contextData?.bvid).toBe("BV1live");
      expect(chatSessionState.currentContextKey).toBe("video:BV1live|");
    });

    it("key 未变（或旧 key 为空）时返回 false，但仍落地", () => {
      chatSessionState.currentContextKey = "video:BV1live|";
      const changed = applyContextSnapshot(liveContext());
      expect(changed).toBe(false);
      expect(chatSessionState.currentContextKey).toBe("video:BV1live|");
      // 旧 key 为空串：首载不算变化（与迁移前 contextChanged 判定逐字一致）。
      chatSessionState.currentContextKey = "";
      expect(applyContextSnapshot(liveContext())).toBe(false);
    });

    it("payload 为 null → 清空主上下文，返回 false", () => {
      chatSessionState.currentContextKey = "video:OLD|";
      chatSessionState.contextData = liveContext();
      const changed = applyContextSnapshot(null);
      expect(changed).toBe(false);
      expect(chatSessionState.contextData).toBeNull();
      expect(chatSessionState.currentContextKey).toBe("");
    });
  });

  describe("pinCurrentContextKey（hydratePinned 复读分支的只写 key）", () => {
    it("只钉 key，contextData 不动", () => {
      const kept = liveContext();
      chatSessionState.contextData = kept;
      pinCurrentContextKey("video:PIN|");
      expect(chatSessionState.currentContextKey).toBe("video:PIN|");
      expect(chatSessionState.contextData).toBe(kept);
    });
  });

  describe("clearMainContext（no-tab/error 计划的清上下文分支）", () => {
    it("contextData 置 null、currentContextKey 置空串", () => {
      chatSessionState.contextData = liveContext();
      chatSessionState.currentContextKey = "video:stale|";
      clearMainContext();
      expect(chatSessionState.contextData).toBeNull();
      expect(chatSessionState.currentContextKey).toBe("");
    });
  });
});
