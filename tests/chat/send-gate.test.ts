// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  createSendGate,
  type CreateSendGateDeps,
  SUBTITLE_FETCH_FAILED_NOTICE,
  SUBTITLE_READ_FAILED_NOTICE,
  SUBTITLE_RETRYING_NOTICE,
  SUBTITLE_RETRY_READY_NOTICE,
  ASR_TRANSCRIBING_NOTICE
} from "../../extension/chat/send-gate.js";
import { chatSessionState, chatSessionStateForTests, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import type { ChatSessionContextSnapshot } from "../../extension/chat/chat-state.js";
import { createReaderContextPayload } from "../../extension/core/context-payload.js";
import { buildAsrNoSubtitleMessage } from "../../extension/core/asr-failure-notice.js";
import type { ClipState } from "../../extension/core/state.js";

function clip(overrides: Record<string, unknown> = {}): ClipState {
  return {
    bvid: "BV1",
    subtitleBody: [],
    subtitleFetchState: "idle",
    ...overrides
  } as unknown as ClipState;
}

function readyClip(): ClipState {
  return clip({ subtitleBody: [{ from: 0, to: 1, content: "line" }], subtitleFetchState: "ready" });
}

function snapshotFromClip(state: ClipState): ChatSessionContextSnapshot {
  const payload = createReaderContextPayload({
    clip: state,
    settings: { includeTimestampInBody: true },
    url: "https://www.bilibili.com/video/BV1/"
  });
  return { ...payload, isVideoContext: true, signature: "" } as unknown as ChatSessionContextSnapshot;
}

interface Harness {
  deps: CreateSendGateDeps;
  mocks: {
    loadContextState: Mock;
    hydratePinned: Mock;
    showInputNotice: Mock;
    clearInputNotice: Mock;
    startSubtitleFetch: Mock;
  };
  gate: ReturnType<typeof createSendGate>;
  state: { listener: ((phase: string) => void) | null; unsubscribed: boolean };
  firePhase: (phase: string) => void;
}

function makeHarness(overrides: Partial<CreateSendGateDeps> = {}): Harness {
  const state: Harness["state"] = { listener: null, unsubscribed: false };
  const inputNotice = overrides.inputNotice ?? {
    show: vi.fn(),
    clear: vi.fn()
  };
  const deps = {
    loadContextState: vi.fn(async () => true),
    hydratePinned: vi.fn(async () => true),
    inputNotice,
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
      showInputNotice: inputNotice.show as unknown as Mock,
      clearInputNotice: inputNotice.clear as unknown as Mock,
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
    chatSessionStateForTests.contextData = snapshotFromClip(readyClip());
  });

  describe("G1 pinned 分流", () => {
    it("pinned 会话走静默补水 + hydratePinned，放行且保留输入", async () => {
      Object.assign(chatSessionStateForTests, {
        currentConversationMeta: {
          id: "c1",
          contextUrl: "https://www.bilibili.com/video/BV1/",
          pinnedContext: true
        } as never
      });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.loadContextState).toHaveBeenCalledWith({ forceRefresh: false, silent: true, preserveInput: true });
      expect(h.mocks.hydratePinned).toHaveBeenCalledTimes(1);
      expect(h.mocks.hydratePinned).toHaveBeenCalledWith({ preserveInput: true });
    });

    it("pinned 时 hydratePinned 的 false → read-failed + 输入区重试通知", async () => {
      Object.assign(chatSessionStateForTests, { currentConversationMeta: { pinnedContext: true } as never });
      const h = makeHarness({ hydratePinned: vi.fn(async () => false) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
    });

    it("pinnedContext 为真值非 true 时不走 pinned 分流（全仓统一严格判定）", async () => {
      Object.assign(chatSessionStateForTests, { currentConversationMeta: { pinnedContext: 1 } as never });
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.hydratePinned).not.toHaveBeenCalled();
    });
  });

  describe("G2 读取失败闸", () => {
    it("loadContextState false → read-failed + 输入区重试通知", async () => {
      const h = makeHarness({ loadContextState: vi.fn(async () => false) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        SUBTITLE_READ_FAILED_NOTICE,
        0,
        expect.objectContaining({ action: expect.objectContaining({ label: "重试读取" }) })
      );
    });

    it("读取成功但 contextData 为空 → 同一路径拦截", async () => {
      chatSessionStateForTests.contextData = null;
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        SUBTITLE_READ_FAILED_NOTICE,
        0,
        expect.objectContaining({ action: expect.objectContaining({ label: "重试读取" }) })
      );
    });
  });

  describe("G3 主动起跑字幕抓取", () => {
    it("clip 与页同 BV 且已有字幕体 → 不起跑，直接进等待闸", async () => {
      const h = makeHarness({ clip: () => clip({ subtitleBody: ["x"] }) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).not.toHaveBeenCalled();
    });

    it("抓取已在跑（loading）→ 不起跑", async () => {
      const h = makeHarness({ clip: () => clip({ subtitleFetchState: "loading" }) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).not.toHaveBeenCalled();
    });

    it("上一轮失败（error）且无字幕体 → 重试起跑一次", async () => {
      const h = makeHarness({ clip: () => clip({ subtitleFetchState: "error" }) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).toHaveBeenCalledTimes(1);
    });

    it("非 BV 页（pageBvid null）→ 不起跑", async () => {
      const h = makeHarness({ pageBvid: () => null });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).not.toHaveBeenCalled();
    });

    it("idle 且无字幕体 → 起跑；起跑失败 → read-failed + 输入区重试通知", async () => {
      const h = makeHarness({ startSubtitleFetch: vi.fn(async () => false) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.startSubtitleFetch).toHaveBeenCalledTimes(1);
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        SUBTITLE_READ_FAILED_NOTICE,
        0,
        expect.objectContaining({ action: expect.objectContaining({ label: "重试读取" }) })
      );
    });

    it.each(["no-asr-config", "asr-disabled", "asr-auth", "bili-login-required"] as const)(
      "可恢复无字幕收尾（%s）→ 重新起跑一轮抓取；仍无字幕时照旧拦截，不虚构用户消息",
      async (reason) => {
        const emptyClip = clip({ subtitleFetchState: "empty", noSubtitleReason: reason });
        chatSessionStateForTests.contextData = snapshotFromClip(emptyClip);
        const h = makeHarness({ clip: () => emptyClip });
        await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
        expect(h.mocks.startSubtitleFetch).toHaveBeenCalledTimes(1);
      }
    );

    it.each(["asr-empty", "asr-media", "asr-quota", "upower-exclusive", null] as const)(
      "非配置类 / 未归类无字幕收尾（%s）→ 按原规则拦截，不重抓",
      async (reason) => {
        const emptyClip = clip({ subtitleFetchState: "empty", noSubtitleReason: reason });
        chatSessionStateForTests.contextData = snapshotFromClip(emptyClip);
        const h = makeHarness({ clip: () => emptyClip });
        await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
        expect(h.mocks.startSubtitleFetch).not.toHaveBeenCalled();
      }
    );

    it("等待闸在配置类 empty 重抓的字幕就绪后继续放行（已有等待意图不被截断）", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleFetchState: "empty", noSubtitleReason: "no-asr-config" })
      );
      let polls = 0;
      const emptyClip = clip({ subtitleFetchState: "empty", noSubtitleReason: "no-asr-config" });
      const h = makeHarness({
        clip: () => emptyClip,
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls === 2) {
            chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
          }
          if (polls >= 3) {
            const ready = snapshotFromClip(readyClip());
            chatSessionStateForTests.liveContextData = ready;
            chatSessionStateForTests.contextData = ready;
          }
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.startSubtitleFetch).toHaveBeenCalledTimes(1);
      expect(polls).toBeGreaterThanOrEqual(3);
    });
  });

  describe("G4 等待闸", () => {
    it("真实 pending 才进入等待 UI，就绪后成对复位且不发消息区等待通知", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let polls = 0;
      const waitingCalls: boolean[] = [];
      const h = makeHarness({
        onWaitingChange: (waiting) => waitingCalls.push(waiting),
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          }
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(polls).toBeGreaterThanOrEqual(3);
      expect(waitingCalls).toEqual([true, false]);
      expect(h.mocks.showInputNotice).not.toHaveBeenCalled();
      expect(h.mocks.clearInputNotice).toHaveBeenCalled();
    });

    it("首轮读取尚未确认 pending 时不闪等待态，确认 pending 后才开启", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let polls = 0;
      let releasePoll: () => void = () => {};
      const waitingCalls: boolean[] = [];
      const h = makeHarness({
        clip: () => clip({ subtitleFetchState: "loading" }),
        onWaitingChange: (waiting) => waitingCalls.push(waiting),
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls === 2) {
            await new Promise<void>((resolve) => {
              releasePoll = resolve;
            });
          }
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          }
          return true;
        })
      });
      const promise = h.gate.ensureContextForSend();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(polls).toBe(2);
      expect(waitingCalls).toEqual([]);

      releasePoll();
      await expect(promise).resolves.toEqual({ pass: true });
      expect(waitingCalls).toEqual([true, false]);
    });

    it("cancel() 立即取消在飞轮询并返回 cancelled，迟到结果不得放行或误报读取失败", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let releasePoll!: () => void;
      const h = makeHarness({
        clip: () => clip({ subtitleFetchState: "loading" }),
        loadContextState: vi.fn(async () => {
          if (h.mocks.loadContextState.mock.calls.length === 2) {
            await new Promise<void>((resolve) => {
              releasePoll = resolve;
            });
            chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          }
          return true;
        })
      });
      const pending = h.gate.ensureContextForSend();
      await vi.waitFor(() => expect(releasePoll).toBeDefined());

      h.gate.cancel();

      await expect(pending).resolves.toEqual({ pass: false, kind: "cancelled" });
      releasePoll();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.mocks.loadContextState).toHaveBeenCalledTimes(2);
      expect(h.mocks.showInputNotice).not.toHaveBeenCalled();
    });

    it("等待 UI 已显示时 cancel() 返回 cancelled 并成对复位", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      const waitingCalls: boolean[] = [];
      const h = makeHarness({
        clip: () => clip({ subtitleFetchState: "loading" }),
        onWaitingChange: (waiting) => waitingCalls.push(waiting)
      });
      const pending = h.gate.ensureContextForSend();
      await vi.waitFor(() => expect(waitingCalls).toEqual([true]));

      h.gate.cancel();

      await expect(pending).resolves.toEqual({ pass: false, kind: "cancelled" });
      expect(waitingCalls).toEqual([true, false]);
      expect(h.mocks.showInputNotice).not.toHaveBeenCalled();
    });

    it("clip 已就绪（字幕体非空）→ 不即时出抓取通知（不闪一条又立刻撤）", async () => {
      const h = makeHarness({ clip: () => clip({ subtitleBody: ["x"], subtitleFetchState: "ready" }) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.showInputNotice).not.toHaveBeenCalled();
    });

    it("等待闸兑现 false（读取失败）→ read-failed + 输入区重试通知", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      const h = makeHarness({
        loadContextState: vi.fn(async () => {
          chatSessionStateForTests.liveContextData = null;
          chatSessionStateForTests.contextData = null;
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        SUBTITLE_READ_FAILED_NOTICE,
        0,
        expect.objectContaining({ action: expect.objectContaining({ label: "重试读取" }) })
      );
    });
  });

  describe("G5 放行前重取快照", () => {
    it("最终快照无字幕收尾（G6）→ {pass:false, kind:'no-subtitle'} + 对应 notice，不重置视图", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleFetchState: "empty", noSubtitleReason: "asr-disabled" })
      );
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        expect.stringContaining("语音转写开关已关闭"),
        0,
        expect.objectContaining({
          openSettingsAction: true,
          settingsTarget: "asr",
          action: expect.objectContaining({ label: "重新抓取" })
        })
      );
    });

    it("鉴权失败（asr-auth）：文案走单一真源，附「前往设置」链接", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleFetchState: "empty", noSubtitleReason: "asr-auth" })
      );
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        buildAsrNoSubtitleMessage("sidepanel", "asr-auth"),
        0,
        expect.objectContaining({
          openSettingsAction: true,
          settingsTarget: "asr",
          action: expect.objectContaining({ label: "重新抓取" })
        })
      );
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        expect.stringContaining("当前视频没有字幕，无法总结。"),
        0,
        expect.anything()
      );
    });

    it("额度不足（asr-quota）：不附设置入口（补救是充值 / 稍后重试）", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleFetchState: "empty", noSubtitleReason: "asr-quota" })
      );
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        buildAsrNoSubtitleMessage("sidepanel", "asr-quota"),
        0,
        expect.objectContaining({
          openSettingsAction: false,
          action: expect.objectContaining({ label: "重新抓取" })
        })
      );
    });

    it("未知原因（null）：通用文案 + 通用补救句", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleFetchState: "empty", noSubtitleReason: null })
      );
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        buildAsrNoSubtitleMessage("sidepanel", null),
        0,
        expect.objectContaining({
          openSettingsAction: true,
          settingsTarget: "asr",
          action: expect.objectContaining({ label: "重新抓取" })
        })
      );
    });

    it("无字幕卡的重新抓取强制刷新并在抓取中/成功后更新反馈（无待续发时不自动发送）", async () => {
      const emptyClip = clip({ subtitleFetchState: "empty", noSubtitleReason: "asr-quota" });
      chatSessionStateForTests.contextData = snapshotFromClip(emptyClip);
      const startSubtitleFetch = vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) {
          chatSessionStateForTests.contextData = snapshotFromClip(readyClip());
        }
        return true;
      });
      const h = makeHarness({ clip: () => emptyClip, startSubtitleFetch });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      const options = h.mocks.showInputNotice.mock.calls[0][2];
      h.mocks.showInputNotice.mockClear();
      h.mocks.clearInputNotice.mockClear();

      options.action.onClick();

      expect(h.mocks.showInputNotice).toHaveBeenNthCalledWith(1, SUBTITLE_RETRYING_NOTICE, 0, {
        spinner: true
      });
      await vi.waitFor(() => expect(h.mocks.clearInputNotice).toHaveBeenCalledTimes(1));
      expect(startSubtitleFetch).toHaveBeenCalledWith({ forceRefresh: true, awaitRefresh: true });
      expect(h.mocks.showInputNotice).toHaveBeenNthCalledWith(2, SUBTITLE_RETRY_READY_NOTICE, 3000, {
        tone: "success"
      });
    });

    it("无字幕卡的重新抓取成功后若 onRetrySubtitleReady 续发成功，清提示且不再弹成功条", async () => {
      const emptyClip = clip({ subtitleFetchState: "empty", noSubtitleReason: "youtube-captions-unavailable" });
      chatSessionStateForTests.contextData = snapshotFromClip(emptyClip);
      const onRetrySubtitleReady = vi.fn(async () => true);
      const startSubtitleFetch = vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) {
          chatSessionStateForTests.contextData = snapshotFromClip(readyClip());
        }
        return true;
      });
      const h = makeHarness({ clip: () => emptyClip, startSubtitleFetch, onRetrySubtitleReady });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      const options = h.mocks.showInputNotice.mock.calls[0][2];
      h.mocks.showInputNotice.mockClear();
      h.mocks.clearInputNotice.mockClear();

      options.action.onClick();

      await vi.waitFor(() => expect(onRetrySubtitleReady).toHaveBeenCalledTimes(1));
      expect(h.mocks.clearInputNotice).toHaveBeenCalledTimes(1);
      expect(h.mocks.showInputNotice).toHaveBeenCalledTimes(1);
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(SUBTITLE_RETRYING_NOTICE, 0, {
        spinner: true
      });
    });

    it("无字幕卡的重新抓取后仍无字幕：恢复无字幕提示与重新抓取入口", async () => {
      const emptyClip = clip({ subtitleFetchState: "empty", noSubtitleReason: "youtube-captions-unavailable" });
      chatSessionStateForTests.contextData = snapshotFromClip(emptyClip);
      const h = makeHarness({ clip: () => emptyClip });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      const options = h.mocks.showInputNotice.mock.calls[0][2];
      h.mocks.showInputNotice.mockClear();

      options.action.onClick();

      await vi.waitFor(() => expect(h.mocks.showInputNotice).toHaveBeenCalledTimes(2));
      expect(h.mocks.showInputNotice).toHaveBeenNthCalledWith(
        2,
        buildAsrNoSubtitleMessage("sidepanel", "youtube-captions-unavailable"),
        0,
        expect.objectContaining({
          action: expect.objectContaining({ label: "重新抓取" })
        })
      );
    });

    it("外部 subtitle-ready 相位到达时清除过期的输入槽无字幕提示", async () => {
      const emptyClip = clip({ subtitleFetchState: "empty", noSubtitleReason: "youtube-captions-unavailable" });
      chatSessionStateForTests.contextData = snapshotFromClip(emptyClip);
      const h = makeHarness({ clip: () => emptyClip });
      h.gate.bindStatusBus();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      h.mocks.clearInputNotice.mockClear();

      h.firePhase("subtitle-ready");

      expect(h.mocks.clearInputNotice).toHaveBeenCalledTimes(1);
      expect(h.gate.isNoSubtitleBlocked()).toBe(false);
    });

    it("读取失败卡的重试读取强制刷新，成功后清旧提示", async () => {
      const loadContextState = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      const h = makeHarness({ loadContextState });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      const options = h.mocks.showInputNotice.mock.calls[0][2];

      options.action.onClick();

      await vi.waitFor(() => expect(h.mocks.clearInputNotice).toHaveBeenCalled());
      expect(loadContextState).toHaveBeenLastCalledWith({ forceRefresh: true, silent: true, preserveInput: true });
    });

    it("抓取失败收尾（error 且字幕体为空）→ {pass:false, kind:'fetch-error'} + 重试文案，不重置视图", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "error" }));
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "fetch-error" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        SUBTITLE_FETCH_FAILED_NOTICE,
        0,
        expect.objectContaining({ action: expect.objectContaining({ label: "重试读取" }) })
      );
    });

    it("error 但字幕体非空 → 放行（失败前落账的完整字幕照样能总结）", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleBody: [{ from: 0, to: 1, content: "line" }], subtitleFetchState: "error" })
      );
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.showInputNotice).not.toHaveBeenCalled();
    });
  });

  describe("G4/G5/G6 相对顺序（事件序）", () => {
    it("无字幕拦截路径：G4 落定后 G5 重取，重取之后才 G6 拦截", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "empty" }));
      const events: string[] = [];
      const h = makeHarness({
        loadContextState: vi.fn(async () => {
          events.push("load");
          return true;
        }),
        startSubtitleFetch: vi.fn(async () => {
          events.push("fetch");
          return true;
        }),
        inputNotice: {
          show: vi.fn(() => {
            events.push("notice");
          }),
          clear: vi.fn()
        },
        onWaitingChange: (waiting) => {
          events.push(waiting ? "wait:enter" : "wait:exit");
        },
        replayInFlight: () => {
          events.push("replay");
          return null;
        }
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(events).toEqual(["load", "fetch", "load", "load", "notice"]);
    });

    it("放行路径：G4 的每轮轮询都先于 G5 重取，重取是等待落定后唯一那次读", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      const events: string[] = [];
      let polls = 0;
      const h = makeHarness({
        loadContextState: vi.fn(async () => {
          events.push("load");
          polls += 1;
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          }
          return true;
        }),
        startSubtitleFetch: vi.fn(async () => {
          events.push("fetch");
          return true;
        }),
        onWaitingChange: (waiting) => {
          events.push(waiting ? "wait:enter" : "wait:exit");
        },
        replayInFlight: () => {
          events.push("replay");
          return null;
        }
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(events).toEqual(["load", "fetch", "load", "wait:enter", "load", "wait:exit", "load", "replay"]);
    });
  });

  describe("等待区间通知（onWaitingChange）", () => {
    it("首轮确认 pending 后发 true，等待落定复位 false", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let polls = 0;
      const events: Array<{ waiting: boolean; polls: number }> = [];
      const h = makeHarness({
        onWaitingChange: (waiting) => events.push({ waiting, polls }),
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          }
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(events[0]).toEqual({ waiting: true, polls: 2 });
      expect(events).toHaveLength(2);
      expect(events[1].waiting).toBe(false);
    });

    it("等待中的读取失败成对复位；非 pending 的拦截从不开启等待态", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let polls = 0;
      const readFailedCalls: boolean[] = [];
      const readFailed = makeHarness({
        onWaitingChange: (waiting) => readFailedCalls.push(waiting),
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = null;
            chatSessionStateForTests.contextData = null;
          }
          return true;
        })
      });
      await expect(readFailed.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(readFailedCalls).toEqual([true, false]);

      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "empty" }));
      const noSubtitleCalls: boolean[] = [];
      const noSubtitle = makeHarness({ onWaitingChange: (waiting) => noSubtitleCalls.push(waiting) });
      await expect(noSubtitle.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(noSubtitleCalls).toEqual([]);

      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "error" }));
      const fetchErrorCalls: boolean[] = [];
      const fetchError = makeHarness({ onWaitingChange: (waiting) => fetchErrorCalls.push(waiting) });
      await expect(fetchError.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "fetch-error" });
      expect(fetchErrorCalls).toEqual([]);
    });

    it("pinned 分支（G1 提前返回）不进等待区间：一次都不调", async () => {
      Object.assign(chatSessionStateForTests, {
        currentConversationMeta: { id: "c1", pinnedContext: true } as never
      });
      const calls: boolean[] = [];
      const h = makeHarness({ onWaitingChange: (waiting) => calls.push(waiting) });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(calls).toEqual([]);
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
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "empty" }));
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
      expect(h.mocks.clearInputNotice).toHaveBeenCalled();
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

    it("subtitle-ready 相位（字幕落账）→ kick 等待闸：立即补一轮 pollContext，不等轮询定时器", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let polls = 0;
      const h = makeHarness({
        pollIntervalMs: 60000,
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          }
          return true;
        })
      });
      h.gate.bindStatusBus();
      const promise = h.gate.ensureContextForSend();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(polls).toBe(2);

      h.firePhase("subtitle-ready");
      await expect(promise).resolves.toEqual({ pass: true });
      expect(polls).toBeGreaterThanOrEqual(3);
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
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      const h = makeHarness({
        asrNotice,
        isReaderTranscribing: () => true,
        loadContextState: vi.fn(async () => {
          chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(asrNotice.hidden).toBe(false);
      expect(h.mocks.showInputNotice).not.toHaveBeenCalled();
    });
  });

  describe("会话关闭闸", () => {
    it("pollContext 在 sessionClosed 后立即兑现 false（ok:false），等待中的发送提前失败", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let closed = false;
      const h = makeHarness({
        isSessionClosed: () => closed,
        loadContextState: vi.fn(async () => {
          closed = true;
          return true;
        })
      });
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "read-failed" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        SUBTITLE_READ_FAILED_NOTICE,
        0,
        expect.objectContaining({ action: expect.objectContaining({ label: "重试读取" }) })
      );
    });
  });

  describe("kickSubtitleWait", () => {
    it("无在途等待时 kick 为无害 no-op", () => {
      const h = makeHarness();
      expect(() => h.gate.kickSubtitleWait()).not.toThrow();
    });

    it("轮询进行中重复 kick 去重，不并发多轮 poll", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let releasePoll!: () => void;
      let polls = 0;
      const h = makeHarness({
        pollIntervalMs: 60000,
        clip: () => clip({ subtitleFetchState: "loading" }),
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls === 2) {
            await new Promise<void>((resolve) => {
              releasePoll = resolve;
            });
          }
          if (polls >= 3) {
            chatSessionStateForTests.liveContextData = snapshotFromClip(readyClip());
          }
          return true;
        })
      });
      const pending = h.gate.ensureContextForSend();
      await vi.waitFor(() => expect(releasePoll).toBeDefined());
      expect(polls).toBe(2);

      h.gate.kickSubtitleWait();
      h.gate.kickSubtitleWait();
      h.gate.kickSubtitleWait();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(polls).toBe(2);

      releasePoll();
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.gate.kickSubtitleWait();
      await expect(pending).resolves.toEqual({ pass: true });
      expect(polls).toBeGreaterThanOrEqual(3);
    });

    it("重入 ensureContextForSend 时使旧等待失效且不泄漏定时器", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "loading" }));
      let polls = 0;
      const h = makeHarness({
        pollIntervalMs: 60000,
        clip: () => clip({ subtitleFetchState: "loading" }),
        loadContextState: vi.fn(async () => {
          polls += 1;
          if (polls >= 4) {
            const ready = snapshotFromClip(readyClip());
            chatSessionStateForTests.liveContextData = ready;
            chatSessionStateForTests.contextData = ready;
          }
          return true;
        })
      });
      const first = h.gate.ensureContextForSend();
      await vi.waitFor(() => expect(polls).toBe(2));

      const second = h.gate.ensureContextForSend();
      await expect(first).resolves.toEqual({ pass: false, kind: "read-failed" });
      await expect(second).resolves.toEqual({ pass: true });
    });
  });

  describe("字幕就绪容错与无字幕提示映射（经 createSendGate 边界验证）", () => {
    it("快照 idle 但转写广播活跃时继续等待，asr-done 后放行", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(clip({ subtitleFetchState: "idle" }));
      const waitingCalls: boolean[] = [];
      const h = makeHarness({
        pollIntervalMs: 60000,
        clip: () => clip({ subtitleFetchState: "ready" }),
        onWaitingChange: (waiting) => waitingCalls.push(waiting)
      });
      h.gate.bindStatusBus();
      h.firePhase("asr-transcribing");

      const pending = h.gate.ensureContextForSend();
      await vi.waitFor(() => expect(waitingCalls).toEqual([true]));

      const ready = snapshotFromClip(readyClip());
      chatSessionStateForTests.liveContextData = ready;
      chatSessionStateForTests.contextData = ready;
      h.firePhase("asr-done");

      await expect(pending).resolves.toEqual({ pass: true });
      expect(waitingCalls).toEqual([true, false]);
    });

    it("脏 subtitleFetchState 折算为 idle；非数组 subtitleBody 折算为空体", async () => {
      const dirtyClip = clip({ subtitleFetchState: "junk", subtitleBody: "not-an-array" });
      chatSessionStateForTests.contextData = {
        ...snapshotFromClip(clip({ subtitleFetchState: "empty" })),
        subtitleBody: "not-an-array" as never
      };
      const h = makeHarness({ clip: () => dirtyClip });

      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.startSubtitleFetch).toHaveBeenCalledTimes(1);
    });

    it("字幕体非空优先于 empty/loading 状态，直接放行", async () => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleBody: [{ from: 0, to: 1, content: "ok" }], subtitleFetchState: "empty" })
      );
      const h = makeHarness();
      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: true });
      expect(h.mocks.showInputNotice).not.toHaveBeenCalled();
    });

    it.each([
      ["no-asr-config", true],
      ["asr-disabled", true],
      ["asr-auth", true],
      ["upower-exclusive", false],
      ["bili-login-required", false],
      ["asr-ratelimit", false],
      ["asr-network", false],
      ["asr-media", false],
      ["asr-server", false],
      ["asr-unknown", false],
      ["asr-empty", false],
      ["something-else", false]
    ] as const)("无字幕原因 %s 映射 openSettingsAction=%s 且不泄露错误详情行", async (reason, expectedOpenSettings) => {
      chatSessionStateForTests.contextData = snapshotFromClip(
        clip({ subtitleFetchState: "empty", noSubtitleReason: reason })
      );
      const h = makeHarness({ clip: () => clip({ subtitleFetchState: "ready" }) });

      await expect(h.gate.ensureContextForSend()).resolves.toEqual({ pass: false, kind: "no-subtitle" });
      expect(h.mocks.showInputNotice).toHaveBeenCalledWith(
        buildAsrNoSubtitleMessage("sidepanel", reason as never),
        0,
        expect.objectContaining({
          openSettingsAction: expectedOpenSettings,
          settingsTarget: "asr"
        })
      );
      const shownMessage = h.mocks.showInputNotice.mock.calls[0][0] as string;
      expect(shownMessage).not.toContain("错误详情");
    });
  });
});
