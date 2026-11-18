// ui/settings-panel.ts 独立模型选择器直测：
// - 设置页移除所有「默认」按钮、行内模型副行与跟随提示；
// - #aiDefaultModel（概览与解释）与 #subtitleTranslateModel（字幕翻译）各自独立选择、不含「跟随 AI 默认平台」；
// - 跨端 storage.onChanged 同步刷新两个下拉框，且对话 tab 本地选择不影响设置页。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage } from "../helpers/settings-panel-bus.js";

type ProvidersReply = { ok: boolean; providers?: Record<string, unknown>[]; error?: string };

const SELECTED_KEY = "biliscript_ai_selected_provider";

let aiProvidersReply: ProvidersReply = { ok: true, providers: [] };
let settingsReply: Record<string, unknown> = {};
let saveSettingsHook: ((msg: BusMessage) => Record<string, unknown>) | null = null;

function installBus() {
  return installSettingsPanelBus<BusMessage>({
    "get-settings": () => ({ ok: true, settings: settingsReply }),
    "save-settings": (msg: BusMessage) => (saveSettingsHook ? saveSettingsHook(msg) : { ok: true }),
    "ai-providers-list": () => aiProvidersReply
  });
}

async function mountPanel(): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="biliscript-reading-view"><div id="biliscript-reading-settings-host"></div></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  return document.getElementById("biliscript-reading-settings-host")!;
}

function defaultModelSelect(host: HTMLElement): HTMLSelectElement {
  return host.querySelector<HTMLSelectElement>("#aiDefaultModel")!;
}

function subtitleModelSelect(host: HTMLElement): HTMLSelectElement {
  return host.querySelector<HTMLSelectElement>("#subtitleTranslateModel")!;
}

function captureOnChangedListeners(): Array<(changes: Record<string, unknown>, areaName: string) => void> {
  const listeners: Array<(changes: Record<string, unknown>, areaName: string) => void> = [];
  vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((fn) => {
    listeners.push(fn as (changes: Record<string, unknown>, areaName: string) => void);
  });
  return listeners;
}

function fireChanged(listeners: Array<(changes: Record<string, unknown>, areaName: string) => void>, key: string): void {
  for (const listener of listeners) {
    listener({ [key]: { newValue: true } }, key === SELECTED_KEY ? "local" : "sync");
  }
}

const TWO_PROVIDERS = [
  { id: "p1", name: "DeepSeek 官方", enabled: true, hasSavedKey: true, models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "p2", name: "硅基流动", enabled: true, hasSavedKey: true, models: ["Qwen3-8B"] }
];

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  aiProvidersReply = { ok: true, providers: [] };
  settingsReply = {};
  saveSettingsHook = null;
});

describe("设置面板独立模型选择器（无默认按钮/提示）", () => {
  it("AI 行不渲染「设为默认」与行内模型副行，两个下拉框各自独立水合且不含默认提示", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = {
      defaultModel: "p1",
      defaultAiModel: "deepseek-reasoner",
      subtitleTranslateProviderId: "p2",
      subtitleTranslateModel: "Qwen3-8B"
    };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-reasoner`);
    });

    expect(subtitleModelSelect(host).value).toBe(`p2${String.fromCharCode(1)}Qwen3-8B`);
    expect(Array.from(defaultModelSelect(host).options).some((opt) => opt.value === "")).toBe(false);
    expect(Array.from(subtitleModelSelect(host).options).some((opt) => opt.value === "")).toBe(false);
    expect(host.querySelector(".ai-provider-default-btn")).toBeNull();
    expect(host.querySelector(".ai-provider-row .provider-row-model")).toBeNull();
    expect(host.querySelector(".ai-provider-row .provider-row-badge")).toBeNull();
    expect(host.querySelector("#aiActiveDefaultSummary")).toBeNull();
    expect(host.querySelector("#aiChatSelectionSummary")).toBeNull();
    expect(host.querySelector("#subtitleTranslateFollowHint")).toBeNull();
  });

  it("两个下拉框各自独立持久化，互不改写对方设置", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = {
      defaultModel: "p1",
      defaultAiModel: "deepseek-chat",
      subtitleTranslateProviderId: "p1",
      subtitleTranslateModel: "deepseek-chat"
    };
    const sent: BusMessage[] = [];
    saveSettingsHook = (msg) => {
      sent.push(msg);
      settingsReply = { ...settingsReply, ...(msg.settings as Record<string, unknown>) };
      return { ok: true };
    };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);
    });

    const overviewSelect = defaultModelSelect(host);
    overviewSelect.value = `p2${String.fromCharCode(1)}Qwen3-8B`;
    overviewSelect.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.settings).toEqual({ defaultModel: "p2", defaultAiModel: "Qwen3-8B" });
    expect(subtitleModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);

    const subSelect = subtitleModelSelect(host);
    subSelect.value = `p1${String.fromCharCode(1)}deepseek-reasoner`;
    subSelect.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]?.settings).toEqual({
      subtitleTranslateProviderId: "p1",
      subtitleTranslateModel: "deepseek-reasoner"
    });
    expect(overviewSelect.value).toBe(`p2${String.fromCharCode(1)}Qwen3-8B`);
  });

  it("无自定义平台时通用模型下拉禁用并显示「暂无可用模型」，字幕翻译仍默认启用 Index-Translate", async () => {
    aiProvidersReply = { ok: true, providers: [] };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).disabled).toBe(true);
    });
    expect(defaultModelSelect(host).options[0]?.textContent).toBe("暂无可用模型");
    expect(host.querySelector<HTMLSelectElement>("#subtitleTranslateSource")!.value).toBe("bilibili-index-translate");
    expect(subtitleModelSelect(host).disabled).toBe(false);
    expect(Array.from(subtitleModelSelect(host).options).map((o) => o.textContent)).toEqual([
      "Index-Translate-35B-A3B",
      "Index-Translate-9B",
      "Index-Translate-2B"
    ]);
    expect(subtitleModelSelect(host).value).toBe(`bilibili-index-translate${String.fromCharCode(1)}Index-Translate-35B-A3B`);
  });

  it("对话选中变化（local）不影响设置页两个下拉框", async () => {
    const listeners = captureOnChangedListeners();
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = {
      defaultModel: "p1",
      defaultAiModel: "deepseek-chat",
      subtitleTranslateProviderId: "p2",
      subtitleTranslateModel: "Qwen3-8B"
    };
    await chrome.storage.local.set({ [SELECTED_KEY]: `p1${String.fromCharCode(1)}deepseek-reasoner` });
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);
    });

    fireChanged(listeners, SELECTED_KEY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);
    expect(subtitleModelSelect(host).value).toBe(`p2${String.fromCharCode(1)}Qwen3-8B`);
  });

  it("storage.onChanged：他端改动 defaultAiModel / subtitleTranslateModel / aiProviders 驱动下拉刷新", async () => {
    const listeners = captureOnChangedListeners();
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = {
      defaultModel: "p1",
      defaultAiModel: "deepseek-chat",
      subtitleTranslateProviderId: "p1",
      subtitleTranslateModel: "deepseek-chat"
    };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);
    });

    settingsReply = {
      ...settingsReply,
      defaultAiModel: "deepseek-reasoner",
      subtitleTranslateProviderId: "p2",
      subtitleTranslateModel: "Qwen3-8B"
    };
    fireChanged(listeners, "defaultAiModel");

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-reasoner`);
      expect(subtitleModelSelect(host).value).toBe(`p2${String.fromCharCode(1)}Qwen3-8B`);
    });

    aiProvidersReply = { ok: true, providers: [TWO_PROVIDERS[1]] };
    fireChanged(listeners, "aiProviders");

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).value).toBe(`p2${String.fromCharCode(1)}Qwen3-8B`);
    });
  });
});
