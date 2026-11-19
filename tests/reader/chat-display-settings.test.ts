// 对话排版（文摘排版）与对话朗读音量单源偏好模块接口测试。
// 孤立失败方式：
// 1. 越界/非法输入未按单源规格归一，或未同步写入 state 与 CSS 变量；
// 2. 同页两处滑块（设置抽屉 vs 对话更多菜单）拖动/重置后未即时联动；
// 3. 跨标签页 storage.onChanged 变更未归一、未更新排版 CSS 变量，或退订后仍触发；
// 4. 持久化失败抛出未捕获异常而非返回 { ok: false, error }；
// 5. Firefox 缺少 speechSynthesis 时未隐藏朗读音量行，具备时误隐藏。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { state } from "../../extension/core/state.js";
import {
  CHAT_DISPLAY_SLIDER_SPECS,
  applyChatDisplaySettings,
  bindChatDisplaySliders,
  isChatDisplaySliderAvailable,
  persistChatDisplaySettings,
  watchChatDisplaySettings,
  type ChatDisplaySettingKey,
  type ChatDisplaySliderSlots
} from "../../extension/reader/chat-display-settings.js";

function mountSliderSurface(): { root: HTMLElement; slots: ChatDisplaySliderSlots } {
  const root = document.createElement("div");
  const makeSlot = (key: ChatDisplaySettingKey) => {
    const spec = CHAT_DISPLAY_SLIDER_SPECS[key];
    const row = document.createElement("div");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.defaultValue);
    const badge = document.createElement("span");
    const resetBtn = document.createElement("button");
    row.append(input, badge, resetBtn);
    root.appendChild(row);
    return { row, input, badge, resetBtn };
  };
  const slots: ChatDisplaySliderSlots = {
    chatLineHeight: makeSlot("chatLineHeight"),
    chatParagraphSpacing: makeSlot("chatParagraphSpacing"),
    speechVoiceVolume: makeSlot("speechVoiceVolume")
  };
  document.body.appendChild(root);
  return { root, slots };
}

describe("reader/chat-display-settings 接口行为", () => {
  beforeEach(() => {
    resetModuleState();
    document.body.innerHTML = '<div id="biliscript-reading-view"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applyChatDisplaySettings 归一写入 state、按需更新排版 CSS 变量并通知同页订阅者", () => {
    const received: Array<Record<string, unknown>> = [];
    const unwatch = watchChatDisplaySettings((patch) => received.push({ ...patch }));

    const normalized = applyChatDisplaySettings({
      chatLineHeight: 999,
      chatParagraphSpacing: 1,
      speechVoiceVolume: -20
    });

    expect(normalized).toEqual({
      chatLineHeight: 200,
      chatParagraphSpacing: 4,
      speechVoiceVolume: 0
    });
    expect(state.settings).toMatchObject(normalized);
    const view = document.getElementById("biliscript-reading-view")!;
    expect(view.style.getPropertyValue("--biliscript-chat-line-height")).toBe("2");
    expect(view.style.getPropertyValue("--biliscript-chat-paragraph-spacing")).toBe("4px");
    expect(received).toEqual([normalized]);

    unwatch();
    applyChatDisplaySettings({ speechVoiceVolume: 65 });
    expect(received).toHaveLength(1);
  });

  it("persistChatDisplaySettings 写入 save-settings 并在通道失败时返回可读错误", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const runtime = globalThis.chrome.runtime as unknown as {
      sendMessage: (msg: Record<string, unknown>, cb?: (resp: unknown) => void) => void;
    };
    runtime.sendMessage = vi.fn((msg: Record<string, unknown>, cb?: (resp: unknown) => void) => {
      sent.push(msg);
      cb?.({ ok: true });
    });

    const okResp = await persistChatDisplaySettings({ chatLineHeight: 185 });
    expect(okResp).toEqual({ ok: true });
    expect(sent).toEqual([{ type: "save-settings", settings: { chatLineHeight: 185 } }]);

    runtime.sendMessage = vi.fn(() => {
      throw new Error("storage unavailable");
    });
    const errResp = await persistChatDisplaySettings({ speechVoiceVolume: 40 });
    expect(errResp).toEqual({ ok: false, error: "storage unavailable" });
  });

  it("跨标签页 sync storage 变更触发归一、排版预览与回调，退订后不再响应", () => {
    const storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
    vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((listener) => {
      storageListeners.push(listener);
    });
    const received: Array<Record<string, unknown>> = [];
    const unwatch = watchChatDisplaySettings((patch) => received.push({ ...patch }));

    for (const listener of storageListeners) {
      listener(
        {
          chatLineHeight: { oldValue: 160, newValue: 175 },
          speechVoiceVolume: { oldValue: 100, newValue: 55 }
        },
        "sync"
      );
    }

    expect(received).toEqual([{ chatLineHeight: 175, speechVoiceVolume: 55 }]);
    expect(state.settings).toMatchObject({ chatLineHeight: 175, speechVoiceVolume: 55 });
    expect(
      document.getElementById("biliscript-reading-view")!.style.getPropertyValue("--biliscript-chat-line-height")
    ).toBe("1.75");

    unwatch();
    for (const listener of storageListeners) {
      listener({ chatParagraphSpacing: { oldValue: 12, newValue: 20 } }, "sync");
    }
    expect(received).toHaveLength(1);
  });

  it("同页两处绑定滑块在拖动预览与单项重置时即时联动，且提交原键", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const runtime = globalThis.chrome.runtime as unknown as {
      sendMessage: (msg: Record<string, unknown>, cb?: (resp: unknown) => void) => void;
    };
    runtime.sendMessage = vi.fn((msg: Record<string, unknown>, cb?: (resp: unknown) => void) => {
      sent.push(msg);
      cb?.({ ok: true });
    });

    const menuSurface = mountSliderSurface();
    const drawerSurface = mountSliderSurface();
    const menuCtrl = bindChatDisplaySliders(menuSurface.slots);
    const drawerCtrl = bindChatDisplaySliders(drawerSurface.slots);
    const unwatchMenu = watchChatDisplaySettings((patch) => menuCtrl.syncPatch(patch));
    const unwatchDrawer = watchChatDisplaySettings((patch) => drawerCtrl.syncPatch(patch));

    menuSurface.slots.chatLineHeight.input!.value = "190";
    menuSurface.slots.chatLineHeight.input!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(drawerSurface.slots.chatLineHeight.input!.value).toBe("190");
    expect(drawerSurface.slots.chatLineHeight.badge!.textContent).toBe("190%");
    expect(drawerSurface.slots.chatLineHeight.resetBtn!.disabled).toBe(false);

    menuSurface.slots.chatLineHeight.input!.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { chatLineHeight: 190 } });
    });

    drawerSurface.slots.chatLineHeight.resetBtn!.click();
    expect(menuSurface.slots.chatLineHeight.input!.value).toBe(String(DEFAULT_SETTINGS.chatLineHeight));
    expect(menuSurface.slots.chatLineHeight.resetBtn!.disabled).toBe(true);
    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: "save-settings",
        settings: { chatLineHeight: DEFAULT_SETTINGS.chatLineHeight }
      });
    });

    unwatchMenu();
    unwatchDrawer();
  });

  it("TTS 能力门控在 Firefox 缺少 speechSynthesis 时隐藏朗读音量行，具备时展示", () => {
    const runtime = globalThis.chrome.runtime as unknown as { getURL: (path: string) => string };
    runtime.getURL = (path: string) => `moz-extension://test-uuid/${path}`;
    vi.stubGlobal("speechSynthesis", undefined);

    expect(isChatDisplaySliderAvailable("chatLineHeight")).toBe(true);
    expect(isChatDisplaySliderAvailable("speechVoiceVolume")).toBe(false);

    const surface = mountSliderSurface();
    const ctrl = bindChatDisplaySliders(surface.slots);
    expect(surface.slots.speechVoiceVolume.row!.hidden).toBe(true);

    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), getVoices: vi.fn(() => []) });
    expect(isChatDisplaySliderAvailable("speechVoiceVolume")).toBe(true);
    ctrl.syncVisibility();
    expect(surface.slots.speechVoiceVolume.row!.hidden).toBe(false);
  });
});
