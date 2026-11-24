// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";
import { DEFAULT_SETTINGS, type Settings } from "../../extension/core/defaults.js";
let playerAiState: (typeof import("../../extension/ai/player-ai-state.js"))["playerAiState"];
async function getPlayerAiState() {
  playerAiState = (await import("../../extension/ai/player-ai-state.js")).playerAiState;
  return playerAiState;
}

vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(() => new Promise(() => {}))
}));
vi.mock("../../extension/reader/lazy-reader-presentation.js", () => ({
  hydrateReaderStateFromSettings: vi.fn(() => new Promise(() => {})),
  applyReadingViewPresentation: vi.fn(() => new Promise(() => {}))
}));

import { ensureUiReady } from "../../extension/ui/lazy-ui.js";
import {
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation
} from "../../extension/reader/lazy-reader-presentation.js";

const storageChangeListeners = new Set();
let activeSettingsRef!: { current: Partial<Settings> };

function stubChrome(settings: Partial<Settings>) {
  activeSettingsRef = { current: { ...settings } };
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      lastError: null,
      sendMessage: vi.fn((message, callback) => {
        if (message?.type === "get-settings") {
          callback?.({
            ok: true,
            settings: { ...DEFAULT_SETTINGS, ...activeSettingsRef.current }
          });
        } else {
          callback?.({ ok: true });
        }
        return undefined;
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) }
    },
    storage: {
      sync: {
        get: vi.fn(async () => ({ ...activeSettingsRef.current })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: {
        addListener: vi.fn((listener) => storageChangeListeners.add(listener)),
        removeListener: vi.fn((listener) => storageChangeListeners.delete(listener))
      }
    }
  });
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  storageChangeListeners.clear();
  resetModuleState();
  vi.mocked(ensureUiReady).mockClear();
  vi.mocked(hydrateReaderStateFromSettings).mockClear();
  vi.mocked(applyReadingViewPresentation).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("player-ai 快路径与惰性装载解耦", () => {
  it("普通页 + 开关开启：observer/layout 启动，不触发 UI 壳 / reader 呈现层装载", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome({ enablePlayerAiQuickAction: true });

    await import("../../extension/entry/content.js");
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await loadPlayerAi();
    await flushMicrotasks();
    const state = (await import("../../extension/core/state.js")).state;
    await getPlayerAiState();

    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);

    expect(ensureUiReady).not.toHaveBeenCalled();
    expect(hydrateReaderStateFromSettings).not.toHaveBeenCalled();
    expect(applyReadingViewPresentation).not.toHaveBeenCalled();
  });

  it("storage.onChanged false→true：同样不触发惰性 UI / reader 装载", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome({ enablePlayerAiQuickAction: false });

    await import("../../extension/entry/content.js");
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await flushMicrotasks();

    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    activeSettingsRef.current = { ...activeSettingsRef.current, enablePlayerAiQuickAction: true };
    listener({ enablePlayerAiQuickAction: { newValue: true } }, "sync");

    await loadPlayerAi();
    await flushMicrotasks(40);
    const state = (await import("../../extension/core/state.js")).state;
    await getPlayerAiState();

    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);

    expect(ensureUiReady).not.toHaveBeenCalled();
    expect(hydrateReaderStateFromSettings).not.toHaveBeenCalled();
    expect(applyReadingViewPresentation).not.toHaveBeenCalled();
  });
});
