import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { closeLiveRoomSettings, openLiveRoomSettings } from "../../extension/live/live-room-settings.js";

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalFullscreenElement = Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement");

const liveProviders = [
  { id: "live_moss", presetId: "moss-live", type: "moss-live", name: "MOSS", baseUrl: "https://api.mosi.cn", hasSavedKey: true },
  { id: "live_gemini", presetId: "gemini-live", type: "gemini-live", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com" }
];

function installDialogMethods() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    })
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    })
  });
}

function createDeps() {
  return {
    getState: vi.fn(() => "connected" as const),
    reconnect: vi.fn(async () => true)
  };
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  installDialogMethods();
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((message: any, callback?: (response: unknown) => void) => {
    const type = message?.type;
    if (type === "live-providers-list") callback?.({ ok: true, providers: liveProviders });
    else if (type === "ai-providers-list") callback?.({ ok: true, providers: [] });
    else if (type?.endsWith("-providers-list")) callback?.({ ok: true, providers: [] });
    else callback?.({ ok: true });
    return undefined;
  });
});

afterEach(() => {
  closeLiveRoomSettings();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  Reflect.deleteProperty(document, "fullscreenElement");
  if (originalFullscreenElement) {
    Object.defineProperty(Document.prototype, "fullscreenElement", originalFullscreenElement);
  } else {
    Reflect.deleteProperty(Document.prototype, "fullscreenElement");
  }
  if (originalShowModal) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  } else {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  }
  if (originalClose) {
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  } else {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});

describe("直播间伴看设置", () => {
  it("只渲染伴看平台，挂全屏宿主并在关闭后恢复触发点焦点", async () => {
    const host = document.createElement("div");
    const fullscreenHost = document.createElement("div");
    const trigger = document.createElement("button");
    host.appendChild(trigger);
    document.body.append(host, fullscreenHost);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: fullscreenHost });
    await chrome.storage.sync.set({ activeLiveProviderId: "live_moss" });
    trigger.focus();
    const deps = createDeps();

    await openLiveRoomSettings("live", () => host, deps);

    const dialog = fullscreenHost.querySelector<HTMLDialogElement>(".biliscript-live-room-settings");
    expect(dialog?.open).toBe(true);
    expect(dialog?.parentElement).toBe(fullscreenHost);
    expect(dialog?.querySelectorAll(".live-provider-row")).toHaveLength(2);
    expect(dialog?.querySelector(".biliscript-settings-nav")).toBeNull();
    expect(dialog?.querySelector("#biliscript-reading-chat")).toBeNull();
    expect(dialog?.querySelector("#biliscript-reading-tab-overview")).toBeNull();
    expect(deps.reconnect).not.toHaveBeenCalled();

    closeLiveRoomSettings();
    expect(fullscreenHost.querySelector(".biliscript-live-room-settings")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("激活平台落盘后保留旧连接，提供显式重连", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await chrome.storage.sync.set({ activeLiveProviderId: "live_moss" });
    const deps = createDeps();
    await openLiveRoomSettings("live", () => host, deps);
    const storageListener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)?.[0] as (
      changes: Record<string, { newValue: unknown }>,
      areaName: string
    ) => void;

    await chrome.storage.sync.set({ activeLiveProviderId: "live_gemini" });
    storageListener({ activeLiveProviderId: { newValue: "live_gemini" } }, "sync");
    await Promise.resolve();

    const reconnectBar = host.querySelector<HTMLElement>(".biliscript-live-room-settings-reconnect");
    expect(reconnectBar?.hidden).toBe(false);
    expect(reconnectBar?.textContent).toContain("当前连接保持不变");
    expect(deps.reconnect).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>(".biliscript-live-room-settings-reconnect-btn")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.reconnect).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".biliscript-live-room-settings")).toBeNull();
  });

  it("编辑器挂在弹层内，Esc 只关闭编辑器", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await chrome.storage.sync.set({ activeLiveProviderId: "live_moss" });
    const deps = createDeps();
    await openLiveRoomSettings("live", () => host, deps);

    host.querySelector<HTMLButtonElement>(".live-provider-row .provider-row-edit")?.click();
    const dialog = host.querySelector<HTMLDialogElement>(".biliscript-live-room-settings");
    const view = dialog?.querySelector<HTMLElement>("#biliscript-reading-view");
    await vi.waitFor(() => {
      expect(view?.querySelector(".provider-editor-dialog")).not.toBeNull();
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view?.querySelector(".provider-editor-dialog")).toBeNull();
    expect(dialog?.open).toBe(true);

    dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(host.querySelector(".biliscript-live-room-settings")).toBeNull();
  });

  it("添加平台保存成功后出现重连动作", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await chrome.storage.sync.set({ activeLiveProviderId: "live_moss" });
    const deps = createDeps();
    await openLiveRoomSettings("live", () => host, deps);
    host.querySelector<HTMLButtonElement>("#addLiveProviderBtn")?.click();
    const dialog = host.querySelector<HTMLDialogElement>(".biliscript-live-room-settings");
    await vi.waitFor(() => {
      expect(dialog?.querySelector(".provider-editor-dialog")).not.toBeNull();
    });
    const keyInput = dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey");
    if (!keyInput) throw new Error("缺少 API Key 输入框");
    keyInput.value = "sk-live-new";
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    dialog?.querySelector<HTMLButtonElement>(".provider-editor-save")?.click();

    await vi.waitFor(() => {
      const saveCall = vi.mocked(chrome.runtime.sendMessage).mock.calls.find(([message]) => {
        return (message as { type?: string }).type === "live-providers-save";
      });
      expect(saveCall).toBeDefined();
      expect((saveCall?.[0] as { providers?: Array<{ apiKey?: string }> }).providers?.at(-1)?.apiKey).toBe("sk-live-new");
      expect(dialog?.querySelector<HTMLElement>(".biliscript-live-room-settings-reconnect")?.hidden).toBe(false);
    });
    expect(dialog?.querySelector(".provider-editor-dialog")).toBeNull();
    expect(deps.reconnect).not.toHaveBeenCalled();
  });

  it("Gemini 凭据入口直接打开官方 Gemini AI 平台编辑器", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await openLiveRoomSettings("gemini-key", () => host, createDeps());
    const dialog = host.querySelector<HTMLDialogElement>(".biliscript-live-room-settings");
    await vi.waitFor(() => {
      expect(dialog?.querySelector(".provider-editor-dialog")).not.toBeNull();
    });
    expect(dialog?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value).toBe("gemini");
    expect(dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey")).not.toBeNull();
  });

  it("关闭后丢弃迟到的平台加载，不保留重连动作", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let resolveProviders!: (response: unknown) => void;
    const providersResponse = new Promise<unknown>((resolve) => {
      resolveProviders = resolve;
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message: any, callback?: (response: unknown) => void) => {
      if (message?.type === "live-providers-list") {
        void providersResponse.then(callback);
        return undefined;
      }
      callback?.({ ok: true, providers: [] });
      return undefined;
    });
    const deps = createDeps();

    const opening = openLiveRoomSettings("live", () => host, deps);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host.querySelector(".biliscript-live-room-settings")).not.toBeNull();
    closeLiveRoomSettings();
    resolveProviders?.({ ok: true, providers: liveProviders });
    await opening;

    expect(host.querySelector(".biliscript-live-room-settings")).toBeNull();
    expect(deps.reconnect).not.toHaveBeenCalled();
  });
});
