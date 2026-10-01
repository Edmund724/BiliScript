// tests/chat/send-gate.test.ts — 发送闸（chat/send-gate.ts，CONTEXT.md 词条
// 「发送闸」）的聚焦单测：G1-G7 各闸口、字幕等待轮询、转写相位写、
// 主动起跑字幕抓取的判定门。987 行集成夹具（tests/reader/chat-tab.test.ts）
// 保证组合根侧字节级等价，本文件只锁闸内契约。
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  createSendGate,
  type CreateSendGateDeps,
  SUBTITLE_FETCHING_NOTICE,
  ASR_TRANSCRIBING_NOTICE
} from "../../extension/chat/send-gate.js";
import { chatSessionState, chatSessionStateForTests, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import { CONTEXT_READ_FAILED_MESSAGE } from "../../extension/chat/context-policy.js";
import { buildAsrNoSubtitleMessage } from "../../extension/core/asr-failure-notice.js";
import type { AiContext } from "../../extension/ai/types.js";
import type { ClipState } from "../../extension/core/state.js";

function ctx(overrides: Partial<AiContext> = {}): AiContext {
  return {
    url: "https://www.bilibili.com/video/BV1/",
    bvid: "BV1",
    isVideoContext: true,
    subtitleBody: ["line"],
    subtitleFetchState: "ready",
    ...overrides
  } as AiContext;
}

function clip(overrides: Record<string, unknown> = {}): ClipState {
  return {
    bvid: "BV1",
    subtitleBody: [],
    subtitleFetchState: "idle",
    ...overrides
  } as unknown as ClipState;
}

interface Harness {
  deps: CreateSendGateDeps;
  mocks: {
    loadContextState: Mock;
    hydratePinned: Mock;
    resetView: Mock;
    showContextNotice: Mock;
    removeContextNotice: Mock;
    startSubtitleFetch: Mock;
  };
  gate: ReturnType<typeof createSendGate>;
  state: { listener: ((phase: string) => void) | null; unsubscribed: boolean };
  firePhase: (phase: string) => void;
}

function makeHarness(overrides: Partial<CreateSendGateDeps> = {}): Harness {
  const state: Harness["state"] = { listener: null, unsubscribed: false };
  const deps = {
    loadContextState: vi.fn(async () => true),
    hydratePinned: vi.fn(async () => true),
    resetView: vi.fn(),
    showContextNotice: vi.fn(),
    removeContextNotice: vi.fn(),
    replayInFlight: () => null,
    isSessionClosed: () => false,
    isReaderTranscribing: () => false,
    asrNotice: null,
    pageBvid: () => "BV1",
    clip: () => clip(),
    startSubtitleFetch: vi.fn(async () => true),
    subscribeStatusPhase: (cb: (phase: string) => void) => {
      state.listener = cb;
      return () => {
        state.unsubscribed = true;
      };
    },
    pollIntervalMs: 5,
    ...overrides
  };
  const typedDeps = deps as unknown as CreateSendGateDeps;
  return {
    deps: typedDeps,
    mocks: {
      loadContextState: deps.loadContextState as unknown as Mock,
      hydratePinned: deps.hydratePinned as unknown as Mock,
      resetView: deps.resetView as unknown as Mock,
      showContextNotice: deps.showContextNotice as unknown as Mock,
      removeContextNotice: deps.removeContextNotice as unknown as Mock,
      startSubtitleFetch: deps.startSubtitleFetch as unknown as Mock
    },
    gate: createSendGate(typedDeps),
    state,
    firePhase: (phase) => state.listener?.(phase)
  };
}

describe("发送闸 createSendGate", () => {
  beforeEach(() => {
    resetChatSessionStateForTests();
    // 默认有一份就绪的当前上下文（G2 之后的闸口都建立在读取成功之上）。
    chatSessionStateForTests.contextData = ctx();
  });

  describe("G1 pinned 分流", () => {
    it("pinned 会话走静默补水 + hydratePinned，放行 GateOutcome {pass:true}，不碰 resetView", async () => {
      Object.assign(chatSessionStateForTests, {
        currentConversationMeta: {
          id: "c1",
          contextUrl: "https://www.bilibili.com/video/BV1/",
          pinnedContext: true
        } as never
      });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.loadContextState).toHaveBeenCalledWith({ forceRefresh: false, silent: true });
      expect(h.mocks.hydratePinned).toHaveBeenCalledTimes(1);
      expect(h.mocks.resetView).not.toHaveBeenCalled();
    });

    it("pinned 时 hydratePinned 的 false → {pass:false, kind:'read-failed'}（闸不重置视图）", async () => {
      Object.assign(chatSessionStateForTests, { currentConversationMeta: { pinnedContext: true } as never });
      const h = makeHarness({ hydratePinned: vi.fn(async () => false) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.resetView).not.toHaveBeenCalled();
    });

    it("pinnedContext 为真值非 true 时不走 pinned 分流（全仓统一严格判定）", async () => {
      Object.assign(chatSessionStateForTests, { currentConversationMeta: { pinnedContext: 1 } as never });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.hydratePinned).not.toHaveBeenCalled();
    });
  });

  describe("G2 读取失败闸", () => {
    it("loadContextState false → resetView(CONTEXT_READ_FAILED_MESSAGE) + {pass:false, kind:'read-failed'}", async () => {
      const h = makeHarness({ loadContextState: vi.fn(async () => false) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.resetView).toHaveBeenCalledWith(CONTEXT_READ_FAILED_MESSAGE);
    });

    it("读取成功但 contextData 为空 → 同一路径拦截", async () => {
      chatSessionStateForTests.contextData = null;
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.resetView).toHaveBeenCalledWith(CONTEXT_READ_FAILED_MESSAGE);
    });
  });

  describe("G3 主动起跑字幕抓取", () => {
    it("clip 与页同 BV 且已有字幕体 → 不起跑，直接进等待闸", async () => {
      const h = makeHarness({ clip: () => clip({ subtitleBody: ["x"] }) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).not.toHaveBeenCalled();
    });

    it("抓取已在跑（非 idle）→ 不起跑", async () => {
      const h = makeHarness({ clip: () => clip({ subtitleFetchState: "loading" }) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).not.toHaveBeenCalled();
    });

    it("非 BV 页（pageBvid null）→ 不起跑", async () => {
      const h = makeHarness({ pageBvid: () => null });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).not.toHaveBeenCalled();
    });

    it("idle 且无字幕体 → 起跑；起跑失败 → resetView + read-failed", async () => {
      const h = makeHarness({ startSubtitleFetch: vi.fn(async () => false) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.startSubtitleFetch).toHaveBeenCalledTimes(1);
      expect(h.mocks.resetView).toHaveBeenCalledWith(CONTEXT_READ_FAILED_MESSAGE);
    });
  });

  describe("G4 等待闸", () => {
    it("抓取中（loading 且字幕体空）→ 等待，就绪后放行 {pass:true}", async () => {
      chatSessionStateForTests.contextData = ctx({ subtitleBody: [], subtitleFetchState: "loading" });
      let polls = 0;
      const h = makeHarness({
        loadContextState: vi.fn(async () => {
          polls += 1;
          // 第 1 次是 ensure 的 G2 读，第 2 次是等待闸首轮（须见 pending），
          // 第 3 次起字幕才就绪。
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = ctx();
          }
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(polls).toBeGreaterThanOrEqual(2);
      // 等待期间展示过抓取文案 notice，结束时清理。
      expect(h.mocks.showContextNotice).toHaveBeenCalledWith(SUBTITLE_FETCHING_NOTICE, 0);
      expect(h.mocks.removeContextNotice).toHaveBeenCalled();
    });

    it("等待闸兑现 false（读取失败）→ resetView + read-failed", async () => {
      chatSessionStateForTests.contextData = ctx({ subtitleBody: [], subtitleFetchState: "loading" });
      const h = makeHarness({
        loadContextState: vi.fn(async () => {
          chatSessionStateForTests.liveContextData = null;
          chatSessionStateForTests.contextData = null;
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.resetView).toHaveBeenCalledWith(CONTEXT_READ_FAILED_MESSAGE);
    });
  });

  describe("G5 放行前重取快照", () => {
    it("最终快照无字幕收尾（G6）→ {pass:false, kind:'no-subtitle'} + 对应 notice，不重置视图", async () => {
      chatSessionStateForTests.contextData = ctx({ subtitleBody: [], subtitleFetchState: "empty", noSubtitleReason: "asr-disabled" });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showContextNotice).toHaveBeenCalledWith(
        expect.stringContaining("语音转写开关已关闭"),
        0,
        { openSettingsAction: true }
      );
      expect(h.mocks.resetView).not.toHaveBeenCalled();
    });

    it("鉴权失败（asr-auth）：文案走单一真源，附「前往设置」链接", async () => {
      chatSessionStateForTests.contextData = ctx({
        subtitleBody: [],
        subtitleFetchState: "empty",
        noSubtitleReason: "asr-auth"
      });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      // 文案逐字来自 core 的单一真源（sidepanel 面），不再由 chat 侧自写分支表
      expect(h.mocks.showContextNotice).toHaveBeenCalledWith(
        buildAsrNoSubtitleMessage("sidepanel", "asr-auth"),
        0,
        { openSettingsAction: true }
      );
      expect(h.mocks.showContextNotice).toHaveBeenCalledWith(
        expect.stringContaining("当前视频没有字幕，无法总结。"),
        0,
        expect.anything()
      );
    });

    it("额度不足（asr-quota）：不附设置入口（补救是充值 / 稍后重试）", async () => {
      chatSessionStateForTests.contextData = ctx({
        subtitleBody: [],
        subtitleFetchState: "empty",
        noSubtitleReason: "asr-quota"
      });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showContextNotice).toHaveBeenCalledWith(
        buildAsrNoSubtitleMessage("sidepanel", "asr-quota"),
        0,
        { openSettingsAction: false }
      );
    });

    it("未知原因（null）：通用文案 + 通用补救句", async () => {
      chatSessionStateForTests.contextData = ctx({
        subtitleBody: [],
        subtitleFetchState: "empty",
        noSubtitleReason: null
      });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showContextNotice).toHaveBeenCalledWith(
        buildAsrNoSubtitleMessage("sidepanel", null),
        0,
        { openSettingsAction: true }
      );
    });
  });

  describe("G7 回放让位", () => {
    it("直通放行路径返回前 await replayInFlight（防新消息插进回放中间）", async () => {
      let replaySettled = false;
      const h = makeHarness({
        replayInFlight: () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              replaySettled = true;
              resolve();
            }, 5);
          })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(replaySettled).toBe(true);
    });

    // G1（pinned）路径同样必须等待：该分支的提前返回绕开了直通路径的等待点，
    // 而在途回放确实可能与本路径并存——applyById（历史项点击）经
    // emitChange({resetView:true}) → renderInitialState → replay.render() 起跑回放，
    // hydratePinned 自身三支都不触发回放（见 send-gate.ts 头注查证）。
    it("pinned 放行（G1 提前返回）路径也 await replayInFlight", async () => {
      Object.assign(chatSessionStateForTests, {
        currentConversationMeta: { id: "c1", pinnedContext: true } as never
      });
      let replaySettled = false;
      const h = makeHarness({
        replayInFlight: () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              replaySettled = true;
              resolve();
            }, 5);
          })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.hydratePinned).toHaveBeenCalledTimes(1);
      expect(replaySettled).toBe(true);
    });

    it("拦截（G6 无字幕）不等待回放：拦截后无消息可插", async () => {
      chatSessionStateForTests.contextData = ctx({ subtitleBody: [], subtitleFetchState: "empty" });
      let replayRequested = 0;
      const h = makeHarness({
        replayInFlight: () => {
          replayRequested += 1;
          return null;
        }
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(replayRequested).toBe(0);
    });
  });

  describe("转写相位订阅（状态总线）", () => {
    it("asr-transcribing → asrTranscribingActive=true 并清消息区通知；asr-done → false 并 kick", async () => {
      const h = makeHarness();
      h.gate.bindStatusBus();
      h.firePhase("asr-transcribing");
      expect(chatSessionState.asrTranscribingActive).toBe(true);
      expect(h.mocks.removeContextNotice).toHaveBeenCalled();
      h.firePhase("asr-done");
      expect(chatSessionState.asrTranscribingActive).toBe(false);
    });

    it("重复 bind 幂等（不重复订阅），unbind 退订", () => {
      const h = makeHarness();
      h.gate.bindStatusBus();
      h.gate.bindStatusBus();
      h.gate.unbindStatusBus();
      expect(h.state.unsubscribed).toBe(true);
    });

    it("asr-failed 相位（转写失败终态广播）同样置 false", () => {
      const h = makeHarness();
      h.gate.bindStatusBus();
      h.firePhase("asr-transcribing");
      h.firePhase("asr-failed");
      expect(chatSessionState.asrTranscribingActive).toBe(false);
    });
  });

  describe("转写状态行（updateAsrNotice）", () => {
    it("非转写且非等待 → 状态行隐藏", () => {
      const asrNotice = document.createElement("div");
      const h = makeHarness({ asrNotice });
      h.gate.refreshAsrNotice();
      expect(asrNotice.hidden).toBe(true);
    });

    it("转写中 → 状态行显示转写句；等待中 → 等待句", () => {
      const asrNotice = document.createElement("div");
      const h = makeHarness({ asrNotice, isReaderTranscribing: () => true });
      h.gate.refreshAsrNotice();
      expect(asrNotice.hidden).toBe(false);
      expect(asrNotice.textContent).toBe(ASR_TRANSCRIBING_NOTICE);
    });

    it("等待提示路由：转写中时等待并入状态行，不走消息区抓取文案", async () => {
      const asrNotice = document.createElement("div");
      chatSessionStateForTests.contextData = ctx({ subtitleBody: [], subtitleFetchState: "loading" });
      const h = makeHarness({
        asrNotice,
        isReaderTranscribing: () => true,
        loadContextState: vi.fn(async () => {
          chatSessionStateForTests.liveContextData = ctx();
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      // 状态行可见且呈转写/等待语义；消息区从未收到抓取文案 notice。
      expect(asrNotice.hidden).toBe(false);
      expect(
        h.mocks.showContextNotice.mock.calls.every(
          (call) => call[0] !== SUBTITLE_FETCHING_NOTICE
        )
      ).toBe(true);
    });
  });

  describe("会话关闭闸", () => {
    it("pollContext 在 sessionClosed 后立即兑现 false（ok:false），等待中的发送提前失败", async () => {
      chatSessionStateForTests.contextData = ctx({ subtitleBody: [], subtitleFetchState: "loading" });
      let closed = false;
      const h = makeHarness({
        isSessionClosed: () => closed,
        loadContextState: vi.fn(async () => {
          closed = true;
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.resetView).toHaveBeenCalledWith(CONTEXT_READ_FAILED_MESSAGE);
    });
  });

  describe("kickSubtitleWait", () => {
    it("无在途等待时 kick 为无害 no-op", () => {
      const h = makeHarness();
      expect(() => h.gate.kickSubtitleWait()).not.toThrow();
    });
  });
});
