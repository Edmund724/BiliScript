import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";
import { DEFAULT_SETTINGS, type Settings } from "../../extension/core/defaults.js";
let playerAiState: typeof import("../../extension/ai/player-ai-state.js").playerAiState;
async function getPlayerAiState() {
  playerAiState = (await import("../../extension/ai/player-ai-state.js")).playerAiState;
  return playerAiState;
}

type StorageChangeListener = (changes: Record<string, { newValue: unknown }>, area: string) => void;

const storageChangeListeners = new Set<StorageChangeListener>();

let rafQueue: FrameRequestCallback[] = [];
let rafHandle = 0;
function installRafQueue() {
  rafQueue = [];
  rafHandle = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafQueue.push(cb);
    rafHandle += 1;
    return rafHandle;
  });
}
function flushRafQueue() {
  const pending = rafQueue;
  rafQueue = [];
  pending.forEach((cb) => cb(0));
}

let activeSettingsRef: { current: Partial<Settings> };
let pendingGetSettingsCallback: ((response: unknown) => void) | null = null;

function stubChrome(settings: Partial<Settings>, { deferGetSettings = false }: { deferGetSettings?: boolean } = {}) {
  activeSettingsRef = { current: { ...settings } };
  pendingGetSettingsCallback = null;
  const runtime = {
    getURL: vi.fn((path) => `chrome-extension://test/${path}`),
    lastError: null,
    sendMessage: vi.fn((message, callback) => {
      if (message?.type === "get-settings") {
        if (deferGetSettings) {
          pendingGetSettingsCallback = callback;
          return undefined;
        }
        callback?.({
          ok: true,
          settings: { ...DEFAULT_SETTINGS, ...activeSettingsRef.current }
        });
      } else {
        callback?.({ ok: true });
      }
      return undefined;
    }),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false)
    }
  };
  vi.stubGlobal("chrome", { runtime, storage: {
      sync: {
        get: vi.fn(async () => ({ ...activeSettingsRef.current })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: {
        addListener: vi.fn((listener) => {
          storageChangeListeners.add(listener);
        }),
        removeListener: vi.fn((listener) => {
          storageChangeListeners.delete(listener);
        })
      }
    }
  });
  return { runtime };
}

function emitStorageChange(key: string, newValue: unknown) {
  activeSettingsRef.current = { ...activeSettingsRef.current, [key]: newValue };
  const changes = { [key]: { newValue } };
  for (const listener of [...storageChangeListeners]) {
    listener(changes, "sync");
  }
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function loadContentScript(settings: Partial<Settings>) {
  setLocationUrl(NORMAL_PAGE_URL);
  stubChrome(settings);
  await import("../../extension/entry/content.js");
  if (settings.enablePlayerAiQuickAction) {
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await loadPlayerAi();
  }
  const { loadScriptButton } = await import("../../extension/ui/lazy-script-button.js");
  await loadScriptButton();
  await flushMicrotasks();
  const aiState = await getPlayerAiState();
  return { state: (await import("../../extension/core/state.js")).state, playerAiState: aiState };
}

function makePlayerDom(): Element {
  document.body.innerHTML = `
    <div class="bpx-player-container">
      <button type="button" aria-label="字幕" title="字幕">CC</button>
    </div>`;
  return document.querySelector(".bpx-player-container")!;
}

beforeEach(() => {
  storageChangeListeners.clear();
  if (window.__biliscriptPlayerAiSyncRaf !== undefined) {
    window.cancelAnimationFrame(window.__biliscriptPlayerAiSyncRaf);
    delete window.__biliscriptPlayerAiSyncRaf;
  }
  resetModuleState();
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("player-ai 启停守卫", () => {
  it("定位完成前不提前显示已定位，完成回包后才反馈成功", async () => {
    makePlayerDom();
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    const button = document.getElementById("biliscript-player-ai-quick-action") as HTMLButtonElement;
    let finishQuickAction: (() => void) | undefined;
    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockImplementation((message, callback) => {
      if (message?.type === "player-ai-quick-action") {
        finishQuickAction = () => callback?.({ ok: true });
      } else {
        callback?.({ ok: true });
      }
    });

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(finishQuickAction).toBeDefined();
    expect(button.disabled).toBe(true);

    finishQuickAction!();
    await flushMicrotasks();
    expect(button.disabled).toBe(false);
  });

  it("进入前摘除按钮后失败：在原播放器宿主恢复入口并显示失败", async () => {
    makePlayerDom();
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    const button = document.getElementById("biliscript-player-ai-quick-action") as HTMLButtonElement;
    let failQuickAction: (() => void) | undefined;
    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockImplementation((message, callback) => {
      if (message?.type === "player-ai-quick-action") {
        failQuickAction = () => callback?.({ ok: false, error: "enter failed" });
      } else {
        callback?.({ ok: true });
      }
    });

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    button.parentElement?.remove();
    expect(button.isConnected).toBe(false);
    failQuickAction!();
    await flushMicrotasks();

    expect(button.isConnected).toBe(true);
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.classList.contains("is-error")).toBe(true);
    expect(button.title).toBe("AI 快捷操作失败：enter failed");
    expect(button.getAttribute("aria-label")).toBe("AI 快捷操作失败：enter failed");
    expect(button.disabled).toBe(false);

    sendMessage.mockImplementation((message, callback) => {
      callback?.({ ok: true });
    });
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(button.classList.contains("is-error")).toBe(false);
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.title).toBe("用 AI 分析这期视频");
    expect(button.getAttribute("aria-label")).toBe("用 AI 分析这期视频");
  });

  it("设置关闭 → 不挂 observer、不绑 window layout 监听", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: false });

    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
    expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();
  });

  it("设置开启 → observe 被调、layout 监听挂上", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const documentAddSpy = vi.spyOn(document, "addEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });

    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "pageshow")).toBe(true);
    expect(documentAddSpy.mock.calls.some(([type]) => type === "fullscreenchange")).toBe(true);
  });

  it("默认设置（storage 未存该键）→ AI 按钮随页面加载自动启动", async () => {
    expect(DEFAULT_SETTINGS.enablePlayerAiQuickAction).toBe(true);

    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const { state } = await loadContentScript({});
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await loadPlayerAi();
    await flushMicrotasks();

    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });

  it("start 幂等：重复调用不重复绑 observer 与监听", async () => {
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { startPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");
    const observerBefore = playerAiState.playerAiQuickActionObserver;
    const windowAddSpy = vi.spyOn(window, "addEventListener");

    startPlayerAiQuickAction();

    expect(playerAiState.playerAiQuickActionObserver).toBe(observerBefore);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
  });

  it("stop → 宿主上的游标监听按同一引用摘除、按钮移除、layout 监听解绑", async () => {
    const host = makePlayerDom();
    const hostAddSpy = vi.spyOn(host, "addEventListener");
    const hostRemoveSpy = vi.spyOn(host, "removeEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    vi.clearAllTimers();
    installRafQueue();
    schedulePlayerAiQuickActionSync(0);
    flushRafQueue();

    const button = document.getElementById("biliscript-player-ai-quick-action")!;
    expect(button).not.toBeNull();
    const wrap = button.closest(".biliscript-player-ai-wrap")!;
    host.dispatchEvent(new MouseEvent("mousemove"));
    expect(wrap.classList.contains("is-active")).toBe(true);

    const cursorTypes = ["mousemove", "mouseenter", "mouseleave"];
    const cursorBinds = hostAddSpy.mock.calls.filter(([type]) => cursorTypes.includes(type));
    expect(cursorBinds.length).toBe(3);

    stopPlayerAiQuickAction();

    expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();
    expect(document.querySelector(".biliscript-player-ai-wrap")).toBeNull();
    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);
    for (const [type, handler] of cursorBinds) {
      expect(hostRemoveSpy.mock.calls.some(([t, h]) => t === type && h === handler)).toBe(true);
    }
  });

  it("游标监听防重挂守卫：同一 host 不重复绑", async () => {
    const host = makePlayerDom();
    const hostAddSpy = vi.spyOn(host, "addEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const mousemoveBinds = hostAddSpy.mock.calls.filter(([type]) => type === "mousemove");
    expect(mousemoveBinds.length).toBe(1);
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
  });

  it("stop → retry 定时器清理，stop 后不再触发挂载", async () => {
    document.body.innerHTML = "";
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();
    expect(playerAiState.playerAiQuickActionSyncTimer).not.toBe(0);

    stopPlayerAiQuickAction();
    expect(playerAiState.playerAiQuickActionSyncTimer).toBe(0);

    await vi.advanceTimersByTimeAsync(3000);
    expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();
    expect(playerAiState.playerAiQuickActionSyncTimer).toBe(0);
  });

  it("get-settings 未回包（SW 冷启动）时，storage 快路径已启动 observer 与 layout 监听", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome({ enablePlayerAiQuickAction: true }, { deferGetSettings: true });
    await import("../../extension/entry/content.js");
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await loadPlayerAi();
    await flushMicrotasks();
    const state = (await import("../../extension/core/state.js")).state;
    await getPlayerAiState();

    expect(pendingGetSettingsCallback).not.toBeNull();
    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });

  it("body 回退观察器带 subtree：播放器深层挂载可发现", async () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    await loadContentScript({ enablePlayerAiQuickAction: true });

    const bodyObserveCall = observeSpy.mock.calls.find(
      ([target, options]) => target === document.body && options?.childList === true
    );
    expect(bodyObserveCall?.[1]).toMatchObject({ childList: true, subtree: true });
  });

  it("storage.onChanged：enablePlayerAiQuickAction true→false→true 正确启停", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: false });
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");

    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);

    emitStorageChange("enablePlayerAiQuickAction", true);
    await loadPlayerAi();
    await flushMicrotasks();
    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    const resizeBinds = windowAddSpy.mock.calls.filter(([type]) => type === "resize");
    expect(resizeBinds.length).toBe(1);

    emitStorageChange("enablePlayerAiQuickAction", false);
    await flushMicrotasks();
    expect(state.settings.enablePlayerAiQuickAction).toBe(false);
    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);
    const [, resizeHandler] = resizeBinds[0];
    expect(
      windowRemoveSpy.mock.calls.some(([type, handler]) => type === "resize" && handler === resizeHandler)
    ).toBe(true);

    emitStorageChange("enablePlayerAiQuickAction", true);
    await flushMicrotasks();
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.filter(([type]) => type === "resize").length).toBe(2);
  });
});

describe("player-ai 重试退避节奏与注入耗时观测（工单 button-injection-stability/01、03）", () => {
  it("首挂载走帧内快车道（rAF），不等 120ms 定时器", async () => {
    makePlayerDom();
    installRafQueue();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const { playerAiState: state } = await loadContentScript({ enablePlayerAiQuickAction: true });

    expect(rafQueue.length).toBeGreaterThan(0);
    expect(state.playerAiQuickActionSyncTimer).toBeLessThan(0);
    expect(setTimeoutSpy.mock.calls.find(([, ms]) => ms === 120)).toBeUndefined();

    flushRafQueue();
    await flushMicrotasks();
    expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();
  });

  it("retry 快车道：先逐帧重试，预算耗尽后回落 100ms 起步退避", async () => {
    installRafQueue();
    document.body.innerHTML = "";
    const { playerAiState: state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    vi.clearAllTimers();
    rafQueue = [];
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    let drained = 0;
    while (rafQueue.length > 0 && drained < 20) {
      flushRafQueue();
      drained += 1;
      expect(state.playerAiQuickActionSyncTimer).toBeLessThan(0);
    }
    expect(drained).toBe(20);
    expect(rafQueue.length).toBe(1);

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const lastBackoffMs = () => {
      const calls = setTimeoutSpy.mock.calls.filter(
        ([, ms]) => typeof ms === "number" && ms >= 100 && ms <= 1000 && ms % 100 === 0
      );
      return calls.at(-1)![1] as number;
    };
    flushRafQueue();
    expect(rafQueue.length).toBe(0);
    expect(lastBackoffMs()).toBe(100);

    const stepOnce = async () => {
      const ms = lastBackoffMs();
      for (let i = 0; i < 20; i += 1) {
        flushRafQueue();
      }
      await vi.advanceTimersByTimeAsync(ms);
      return ms;
    };
    const delays = [await stepOnce()];
    for (let i = 0; i < 12; i += 1) {
      delays.push(await stepOnce());
    }
    expect(delays.slice(0, 10)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(delays.slice(10)).toEqual([1000, 1000, 1000]);
  });

  it("首次挂载打注入耗时日志（默认开启）", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    makePlayerDom();
    await loadContentScript({ enablePlayerAiQuickAction: true });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(120);

    expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();
    const timingLog = infoSpy.mock.calls.find((args) => {
      const line = args.join(" ");
      return line.includes("player-ai") && line.includes("装载→挂载耗时");
    });
    expect(timingLog).toBeDefined();
  });
});

describe("player-ai 字幕控件门软化（工单 first-button-ux/01）", () => {
  it("只有容器、无字幕控件 → 宿主门过即挂载（硬门翻转为挂载成功）", async () => {
    document.body.innerHTML = `<div class="bpx-player-container"></div>`;
    const { playerAiState: state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();
    expect(state.playerAiQuickActionSyncTimer).toBeLessThanOrEqual(0);
  });

  it("字幕控件就绪后执行一次性位置复校，且只跑一次", async () => {
    document.body.innerHTML = `<div class="bpx-player-container"></div>`;
    await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    const wrap = document.querySelector<HTMLElement>(".biliscript-player-ai-wrap")!;
    expect(wrap).not.toBeNull();

    const setPropertySpy = vi.spyOn(wrap.style, "setProperty");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(setPropertySpy).not.toHaveBeenCalled();

    const control = document.createElement("button");
    control.setAttribute("aria-label", "字幕");
    control.setAttribute("title", "字幕");
    wrap.parentElement!.appendChild(control);
    await flushMicrotasks();
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(setPropertySpy).toHaveBeenCalled();
    expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();

    setPropertySpy.mockClear();
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(setPropertySpy).not.toHaveBeenCalled();
  });

  it("stop 后校准标志复位：换视频重新获得一次性复校", async () => {
    document.body.innerHTML = `<div class="bpx-player-container"></div>`;
    await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync, startPlayerAiQuickAction, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    vi.clearAllTimers();
    installRafQueue();
    schedulePlayerAiQuickActionSync(0);
    flushRafQueue();
    const firstWrap = document.querySelector<HTMLElement>(".biliscript-player-ai-wrap")!;
    expect(firstWrap).not.toBeNull();

    const control = document.createElement("button");
    control.setAttribute("aria-label", "字幕");
    control.setAttribute("title", "字幕");
    firstWrap.parentElement!.appendChild(control);
    await flushMicrotasks();
    schedulePlayerAiQuickActionSync(0);
    flushRafQueue();

    control.remove();
    stopPlayerAiQuickAction();
    startPlayerAiQuickAction();
    flushRafQueue();
    const wrap = document.querySelector<HTMLElement>(".biliscript-player-ai-wrap")!;
    expect(wrap).not.toBeNull();

    const setPropertySpy = vi.spyOn(wrap.style, "setProperty");
    schedulePlayerAiQuickActionSync(0);
    flushRafQueue();
    expect(setPropertySpy).not.toHaveBeenCalled();

    const newControl = document.createElement("button");
    newControl.setAttribute("aria-label", "字幕");
    newControl.setAttribute("title", "字幕");
    wrap.parentElement!.appendChild(newControl);
    await flushMicrotasks();
    schedulePlayerAiQuickActionSync(0);
    flushRafQueue();
    expect(setPropertySpy).toHaveBeenCalled();
  });

  it("按钮被 B 站重渲染冲掉后，observer + 帧内快车道自动重挂", async () => {
    makePlayerDom();
    await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();

    document.querySelector<HTMLElement>(".biliscript-player-ai-wrap")!.remove();
    expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();
  });
});
