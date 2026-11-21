import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import { resetModuleState } from "../setup.js";

function stubRuntimeScheme(scheme: "moz-extension" | "chrome-extension"): void {
  const currentChrome = globalThis.chrome as unknown as Record<string, unknown>;
  const runtime = (currentChrome?.runtime ?? {}) as Record<string, unknown>;
  vi.stubGlobal("chrome", {
    ...currentChrome,
    runtime: {
      ...runtime,
      getURL: vi.fn((path = "") => `${scheme}://test-ext/${path}`)
    }
  });
}

async function mountSettingsPanelInScheme(
  scheme: "moz-extension" | "chrome-extension",
  sentMessages: unknown[] = [],
  settings: Record<string, unknown> = {}
): Promise<HTMLElement> {
  stubRuntimeScheme(scheme);
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>
  `;
  installSettingsPanelBus({
    "get-settings": () => ({ ok: true, settings }),
    "live-providers-list": (message: unknown) => {
      sentMessages.push(message);
      return { ok: true, providers: [] };
    }
  });
  const panel = await import("../../extension/ui/settings-panel.js");
  await panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(host.dataset.biliscriptSettingsRendered).toBe("1");
  });
  return host;
}

describe("平台能力判据纯函数（shared/runtime-capabilities）", () => {
  beforeEach(() => {
    resetModuleState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("moz-extension:// 判定为 Firefox 且按 speechSynthesis 决定 TTS 可用性、Live 禁用；chrome-extension:// 保持全量可用", async () => {
    const caps = await import("../../extension/shared/runtime-capabilities.js");

    stubRuntimeScheme("chrome-extension");
    expect(caps.isFirefoxRuntime()).toBe(false);
    expect(caps.supportsTtsSpeech()).toBe(true);
    expect(caps.supportsLiveCompanion()).toBe(true);
    expect(caps.getRuntimeCapabilities()).toEqual({
      isFirefox: false,
      supportsTts: true,
      supportsLiveCompanion: true
    });

    stubRuntimeScheme("moz-extension");
    expect(caps.isFirefoxRuntime()).toBe(true);
    expect(caps.supportsTtsSpeech()).toBe(false);
    expect(caps.supportsLiveCompanion()).toBe(false);
    expect(caps.getRuntimeCapabilities()).toEqual({
      isFirefox: true,
      supportsTts: false,
      supportsLiveCompanion: false
    });

    vi.stubGlobal("speechSynthesis", {
      speak: vi.fn(),
      getVoices: vi.fn(() => [])
    });
    expect(caps.hasWebSpeechApi()).toBe(true);
    expect(caps.supportsTtsSpeech()).toBe(true);
    expect(caps.supportsLiveCompanion()).toBe(false);
    expect(caps.getRuntimeCapabilities()).toEqual({
      isFirefox: true,
      supportsTts: true,
      supportsLiveCompanion: false
    });
  });

  it("hasChromeTtsApi 依据 chrome.tts.speak 能力位判断后台朗读可用性", async () => {
    const caps = await import("../../extension/shared/runtime-capabilities.js");
    expect(caps.hasChromeTtsApi()).toBe(false);

    vi.stubGlobal("chrome", {
      ...(globalThis.chrome as object),
      tts: { speak: vi.fn() }
    });
    expect(caps.hasChromeTtsApi()).toBe(true);
  });
});

describe("TTS 后台防御判空与界面门控", () => {
  beforeEach(() => {
    resetModuleState();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("chat-speech-bg 在 chrome.tts 缺失时返回 TTS_UNSUPPORTED 且 stop 不抛错", async () => {
    const currentChrome = globalThis.chrome as unknown as Record<string, unknown>;
    vi.stubGlobal("chrome", {
      ...currentChrome,
      tts: undefined
    });

    const { attachChatSpeechPort, TTS_UNSUPPORTED_ERROR } = await import("../../extension/chat/chat-speech-bg.js");
    const { CHAT_SPEECH_PORT_NAME } = await import("../../extension/chat/protocol.js");

    const messageListeners: Array<(msg: unknown) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const sent: unknown[] = [];
    const port = {
      name: CHAT_SPEECH_PORT_NAME,
      postMessage: vi.fn((msg: unknown) => sent.push(msg)),
      onMessage: { addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) }
    } as unknown as chrome.runtime.Port;

    expect(attachChatSpeechPort(port)).toBe(true);
    expect(() => messageListeners.forEach((fn) => fn({ type: "get-voices", requestId: 1 }))).not.toThrow();
    expect(() => messageListeners.forEach((fn) => fn({ type: "speak", requestId: 2, text: "hello" }))).not.toThrow();
    expect(() => messageListeners.forEach((fn) => fn({ type: "stop" }))).not.toThrow();
    expect(() => disconnectListeners.forEach((fn) => fn())).not.toThrow();

    expect(sent).toEqual([
      { type: "error", requestId: 1, message: TTS_UNSUPPORTED_ERROR },
      { type: "error", requestId: 2, message: TTS_UNSUPPORTED_ERROR }
    ]);
  });

  it("Firefox 缺少 speechSynthesis 时不挂载朗读按钮，具备 speechSynthesis 时与 Chromium 一样正常挂载", async () => {
    const createRenderer = async (scheme: "moz-extension" | "chrome-extension", withWebSpeech = false) => {
      resetModuleState();
      stubRuntimeScheme(scheme);
      if (withWebSpeech) {
        vi.stubGlobal("speechSynthesis", { speak: vi.fn(), getVoices: vi.fn(() => []) });
      }
      const messages = document.createElement("div");
      document.body.replaceChildren(messages);
      const { createChatStreamRenderer } = await import("../../extension/chat/chat-stream-render.js");
      const renderer = createChatStreamRenderer({
        messages,
        getTimestampNavDeps: () => ({}),
        onSpeak: vi.fn(),
        onRegenerate: vi.fn(),
        onExport: vi.fn(),
        onNotice: vi.fn()
      });
      const turn = renderer.messageArea.appendAssistantMessage({ source: "live" });
      turn.finish({ raw: "这是一段可供朗读的回答内容", historyIndex: 0 });
      return messages;
    };

    const firefoxMessages = await createRenderer("moz-extension", false);
    expect(firefoxMessages.querySelector(".chat-msg-speak-btn")).toBeNull();
    expect(firefoxMessages.querySelector(".chat-msg-regenerate-btn")).not.toBeNull();

    const firefoxWebSpeechMessages = await createRenderer("moz-extension", true);
    expect(firefoxWebSpeechMessages.querySelector(".chat-msg-speak-btn")).not.toBeNull();

    const chromeMessages = await createRenderer("chrome-extension", false);
    expect(chromeMessages.querySelector(".chat-msg-speak-btn")).not.toBeNull();
  });

  it("Firefox 缺少 speechSynthesis 时隐藏朗读音量控件，具备 speechSynthesis 时与 Chromium 一样展示", async () => {
    stubRuntimeScheme("moz-extension");
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    document.body.innerHTML = uiRenderer.buildUiHtml();
    expect(document.getElementById("biliscript-reading-chat-speech-volume")?.hidden).toBe(true);

    const ffSettingsHost = await mountSettingsPanelInScheme("moz-extension");
    expect(ffSettingsHost.querySelector("#speechVoiceVolume")?.closest<HTMLElement>(".biliscript-slider-row")?.hidden).toBe(true);
    expect(ffSettingsHost.querySelector("#chatPreferencesHeading")?.textContent).toBe("对话阅读");
    expect(ffSettingsHost.querySelector("#aiPromptSummary")?.textContent).not.toContain("朗读");

    resetModuleState();
    const ffMinimalHost = await mountSettingsPanelInScheme("moz-extension", [], {
      enablePlayerAiQuickAction: false,
      aiInitialQuickPrompts: []
    });
    expect(ffMinimalHost.querySelector("#aiPromptSummary")?.textContent).toBe("默认");

    resetModuleState();
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), getVoices: vi.fn(() => []) });
    stubRuntimeScheme("moz-extension");
    const uiRendererFfSpeech = await import("../../extension/ui/ui-renderer.js");
    document.body.innerHTML = uiRendererFfSpeech.buildUiHtml();
    expect(document.getElementById("biliscript-reading-chat-speech-volume")?.hidden).toBe(false);

    const ffSpeechSettingsHost = await mountSettingsPanelInScheme("moz-extension");
    expect(ffSpeechSettingsHost.querySelector("#speechVoiceVolume")?.closest<HTMLElement>(".biliscript-slider-row")?.hidden).toBe(false);
    expect(ffSpeechSettingsHost.querySelector("#chatPreferencesHeading")?.textContent).toBe("阅读与朗读");
    expect(ffSpeechSettingsHost.querySelector("#aiPromptSummary")?.textContent).toContain("朗读 100%");

    resetModuleState();
    vi.stubGlobal("speechSynthesis", undefined);
    stubRuntimeScheme("chrome-extension");
    const uiRendererChrome = await import("../../extension/ui/ui-renderer.js");
    document.body.innerHTML = uiRendererChrome.buildUiHtml();
    expect(document.getElementById("biliscript-reading-chat-speech-volume")?.hidden).toBe(false);

    const chromeSettingsHost = await mountSettingsPanelInScheme("chrome-extension");
    expect(chromeSettingsHost.querySelector("#speechVoiceVolume")?.closest<HTMLElement>(".biliscript-slider-row")?.hidden).toBe(false);
    expect(chromeSettingsHost.querySelector("#chatPreferencesHeading")?.textContent).toBe("阅读与朗读");
    expect(chromeSettingsHost.querySelector("#aiPromptSummary")?.textContent).toContain("朗读 100%");
  });
});

describe("Live 实时伴看门控隐藏与直播间短路", () => {
  beforeEach(() => {
    resetModuleState();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.doUnmock("../../extension/bilibili/video-id-shared.js");
    vi.doUnmock("../../extension/live/lazy-live-room.js");
    vi.doUnmock("../../extension/core/runtime.js");
    vi.doUnmock("../../extension/live/player-interpret.js");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Firefox 下播放器挂载 AI 与字幕按钮但隐藏实时伴看触发按钮，Chromium 正常挂载", async () => {
    const setupPlayer = async (scheme: "moz-extension" | "chrome-extension") => {
      resetModuleState();
      vi.useFakeTimers();
      stubRuntimeScheme(scheme);
      document.body.innerHTML = `
        <div class="bpx-player-container">
          <div class="bpx-player-control-wrap">
            <div class="bpx-player-control-bottom-right">
              <div class="bpx-player-ctrl-btn bpx-player-ctrl-volume"></div>
              <div class="bpx-player-ctrl-btn bpx-player-ctrl-quality">1080P</div>
            </div>
          </div>
        </div>
      `;
      vi.doMock("../../extension/live/player-interpret.js", () => ({
        closePlayerInterpretMenu: vi.fn(),
        syncPlayerInterpretQuickAction: vi.fn(),
        togglePlayerInterpretMenu: vi.fn()
      }));
      const { state } = await import("../../extension/core/state.js");
      state.setSettings({ enablePlayerAiQuickAction: true } as any);
      const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");
      schedulePlayerAiQuickActionSync(0);
      await vi.advanceTimersByTimeAsync(20);
      const snapshot = {
        ai: document.getElementById("biliscript-player-ai-quick-action"),
        interpret: document.getElementById("biliscript-player-interpret-quick-action"),
        live: document.getElementById("biliscript-player-live-quick-action"),
        liveWrap: document.getElementById("biliscript-player-live-quick-action-wrap")
      };
      stopPlayerAiQuickAction();
      vi.useRealTimers();
      return snapshot;
    };

    const ff = await setupPlayer("moz-extension");
    expect(ff.ai).not.toBeNull();
    expect(ff.interpret).not.toBeNull();
    expect(ff.live).toBeNull();
    expect(ff.liveWrap).toBeNull();

    const ch = await setupPlayer("chrome-extension");
    expect(ch.ai).not.toBeNull();
    expect(ch.interpret).not.toBeNull();
    expect(ch.live).not.toBeNull();
    expect(ch.liveWrap).not.toBeNull();
  });

  it("Firefox 下对话模板与激活态不显示实时伴看按钮，Chromium 正常显示", async () => {
    stubRuntimeScheme("moz-extension");
    const ffTemplate = await import("../../extension/reader/chat-template.js");
    document.body.innerHTML = ffTemplate.buildChatTabBodyHtml();
    const ffBtn = document.getElementById("biliscript-reading-chat-send-btn") as HTMLButtonElement;
    expect(ffBtn.classList.contains("is-live")).toBe(false);
    expect(ffBtn.getAttribute("aria-label")).toBe("发送");
    expect(ffBtn.disabled).toBe(true);

    resetModuleState();
    stubRuntimeScheme("chrome-extension");
    const chTemplate = await import("../../extension/reader/chat-template.js");
    document.body.innerHTML = chTemplate.buildChatTabBodyHtml();
    const chBtn = document.getElementById("biliscript-reading-chat-send-btn") as HTMLButtonElement;
    expect(chBtn.classList.contains("is-live")).toBe(true);
    expect(chBtn.getAttribute("aria-label")).toBe("开启实时伴看");
    expect(chBtn.disabled).toBe(false);
  });

  it("Firefox 下设置面板隐藏实时伴看入口与子页、不拉取 MOSS-LIVE 平台，Chromium 正常可进", async () => {
    const ffSent: unknown[] = [];
    const ffHost = await mountSettingsPanelInScheme("moz-extension", ffSent);
    const ffPanel = await import("../../extension/ui/settings-panel.js");
    const ffLiveEntry = ffHost.querySelector<HTMLButtonElement>("#openLiveSettingsBtn")!;
    const ffLivePage = ffHost.querySelector<HTMLElement>("#biliscriptSettingsSubpageLive")!;

    expect(ffLiveEntry.hidden).toBe(true);
    expect(ffLiveEntry.getAttribute("aria-hidden")).toBe("true");
    expect(ffLivePage.hidden).toBe(true);
    expect(ffSent).toEqual([]);

    await ffPanel.openLiveSettings("live");
    expect(ffLivePage.hidden).toBe(true);
    expect(ffHost.querySelector<HTMLElement>("#biliscriptSettingsRootView")?.hidden).toBe(false);

    resetModuleState();
    const chSent: unknown[] = [];
    const chHost = await mountSettingsPanelInScheme("chrome-extension", chSent);
    const chPanel = await import("../../extension/ui/settings-panel.js");
    const chLiveEntry = chHost.querySelector<HTMLButtonElement>("#openLiveSettingsBtn")!;
    const chLivePage = chHost.querySelector<HTMLElement>("#biliscriptSettingsSubpageLive")!;

    expect(chLiveEntry.hidden).toBe(false);
    expect(chSent).toHaveLength(1);
    await chPanel.openLiveSettings("live");
    expect(chLivePage.hidden).toBe(false);
  });

  it("Firefox 下 content.ts 直播间懒加载分支安全短路，Chromium 正常装载直播伴看", async () => {
    const runContentOnLiveRoom = async (scheme: "moz-extension" | "chrome-extension") => {
      resetModuleState();
      stubRuntimeScheme(scheme);
      const startLiveRoomCompanion = vi.fn(async () => {});
      const loadLiveRoom = vi.fn(async () => ({ startLiveRoomCompanion }));
      vi.doMock("../../extension/bilibili/video-id-shared.js", async () => {
        const actual = await vi.importActual<typeof import("../../extension/bilibili/video-id-shared.js")>(
          "../../extension/bilibili/video-id-shared.js"
        );
        return {
          ...actual,
          isLiveRoomPage: () => true
        };
      });
      vi.doMock("../../extension/live/lazy-live-room.js", () => ({
        loadLiveRoom
      }));
      await import("../../extension/entry/content.js");
      await Promise.resolve();
      return { loadLiveRoom, startLiveRoomCompanion };
    };

    const ff = await runContentOnLiveRoom("moz-extension");
    expect(ff.loadLiveRoom).not.toHaveBeenCalled();
    expect(ff.startLiveRoomCompanion).not.toHaveBeenCalled();

    const ch = await runContentOnLiveRoom("chrome-extension");
    expect(ch.loadLiveRoom).toHaveBeenCalledTimes(1);
    expect(ch.startLiveRoomCompanion).toHaveBeenCalledTimes(1);
  });

  it("Firefox 下清空历史确认弹窗仅在存在伴看记录时提及伴看，Chromium 保持完整文案", async () => {
    const runClearAllPrompt = async (
      scheme: "moz-extension" | "chrome-extension",
      history: Array<Record<string, unknown>>
    ): Promise<string> => {
      resetModuleState();
      stubRuntimeScheme(scheme);
      const { createConversationStore } = await import("../../extension/chat/conversation-store.js");
      const { setSavedConversations } = await import("../../extension/chat/chat-state.js");
      setSavedConversations(history as any);
      let seenMessage = "";
      const store = createConversationStore({
        loadContextState: async () => true,
        resolveAiConversationRef: async () => ({}),
        onConversationChanged: () => {},
        onStreamInterrupted: () => {},
        onContextNotice: () => {},
        confirmClearAll: (message) => {
          seenMessage = message;
          return false;
        }
      });
      await store.clearAll();
      return seenMessage;
    };

    const plainHistory = [{ id: "c1", title: "普通对话", messages: [{ role: "user", content: "hi" }] }];
    const liveHistory = [
      { id: "c2", title: "伴看会话", kind: "live-text-tool", messages: [], records: [] }
    ];

    expect(await runClearAllPrompt("moz-extension", plainHistory)).toBe("确定要清空全部历史记录吗？");
    expect(await runClearAllPrompt("moz-extension", liveHistory)).toBe(
      "确定要清空全部历史记录吗？普通对话和伴看记录都会删除。"
    );
    expect(await runClearAllPrompt("chrome-extension", plainHistory)).toBe(
      "确定要清空全部历史记录吗？普通对话和伴看记录都会删除。"
    );
  });
});
