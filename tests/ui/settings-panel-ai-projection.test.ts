// ui/settings-panel.ts 生效投影与默认模型选择器直测。
//
// 走真实模块 + DOM 仿真：挂载面板后断言——
// - 生效平台行挂概览/解释模型行（不额外挂重复的「默认」徽标），分区摘要显示实际缺省选择；
// - #aiDefaultModel 下拉按平台分组展示可用模型，选中与行内「设为默认」双向联动；
// - 默认被禁用 / 删除（解析回落，isFallback 自报）时摘要显示真实回落目标，模型行落在回落行上；
// - 缺 Key / 无平台时摘要显示不可用状态，模型行摘除，不展示陈旧成功状态；
// - 设置面板不展示对话 tab 选模型提示，也不受 biliscript_ai_selected_provider 影响；
// - 字幕翻译「跟随 AI 默认平台」提示展示解析权威给出的真实跟随目标；
// - chrome.storage.onChanged（defaultModel / defaultAiModel / aiProviders）驱动摘要与下拉同步刷新。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage } from "../helpers/settings-panel-bus.js";

type ProvidersReply = { ok: boolean; providers?: Record<string, unknown>[]; error?: string };
type ResolveAiReply = {
  ok: boolean;
  provider?: Record<string, unknown>;
  apiKey?: string;
  model?: string;
  isFallback?: boolean;
  error?: string;
};
type ResolveSubtitleReply = {
  ok: boolean;
  provider?: Record<string, unknown>;
  apiKey?: string;
  model?: string;
  isFallback?: boolean;
  error?: string;
};

const SELECTED_KEY = "biliscript_ai_selected_provider";

// 可变异回包：用例改闭包值后触发 onChanged，模拟跨端 storage 变化后的重新解析
let aiProvidersReply: ProvidersReply = { ok: true, providers: [] };
let settingsReply: Record<string, unknown> = {};
let resolveAiReply: ResolveAiReply = { ok: false, error: "还没有配置 AI 平台，请先在插件设置中添加并启用。" };
let resolveSubtitleReply: ResolveSubtitleReply = { ok: false, error: "还没有配置 AI 平台" };
let saveSettingsHook: ((msg: BusMessage) => Record<string, unknown>) | null = null;

function installBus() {
  return installSettingsPanelBus<BusMessage>({
    "get-settings": () => ({ ok: true, settings: settingsReply }),
    "save-settings": (msg: BusMessage) => (saveSettingsHook ? saveSettingsHook(msg) : { ok: true }),
    "ai-providers-list": () => aiProvidersReply,
    "resolve-ai-provider": () => resolveAiReply,
    "resolve-subtitle-translate-provider": () => resolveSubtitleReply
  });
}

async function mountPanel(): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="biliscript-reading-view"><div id="biliscript-reading-settings-host"></div></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  return document.getElementById("biliscript-reading-settings-host")!;
}

function summary(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#aiActiveDefaultSummary")!;
}

function defaultModelSelect(host: HTMLElement): HTMLSelectElement {
  return host.querySelector<HTMLSelectElement>("#aiDefaultModel")!;
}

function followHint(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#subtitleTranslateFollowHint")!;
}

function activeModelLine(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".ai-provider-row .provider-row-model");
}

// 捕获真实注册的 onChanged 监听（watch-storage-keys 懒注册单条分发监听）
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
  resolveAiReply = { ok: false, error: "还没有配置 AI 平台，请先在插件设置中添加并启用。" };
  resolveSubtitleReply = { ok: false, error: "还没有配置 AI 平台" };
  saveSettingsHook = null;
});

describe("设置面板 AI 生效投影与默认模型选择", () => {
  it("显式默认：生效行挂模型行且不重复挂「默认」徽标，分区摘要与 #aiDefaultModel 同步", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1", defaultAiModel: "deepseek-reasoner" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk",
      model: "deepseek-reasoner"
    };
    resolveSubtitleReply = { ok: true, provider: { id: "p1", name: "DeepSeek 官方" }, model: "deepseek-reasoner", isFallback: false };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-reasoner");
    });

    expect(host.querySelector("#aiChatSelectionSummary")).toBeNull();
    expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-reasoner`);
    expect(host.querySelector(".ai-provider-row .provider-row-badge")).toBeNull();
    expect(
      host.querySelector('.ai-provider-row[data-provider-id="p1"] .ai-provider-default-btn')?.textContent
    ).toBe("默认");
    const modelLine = activeModelLine(host);
    expect(modelLine?.textContent).toBe("deepseek-reasoner");
    expect(modelLine?.closest(".ai-provider-row")?.getAttribute("data-provider-id")).toBe("p1");
    expect(followHint(host).hidden).toBe(false);
    expect(followHint(host).textContent).toBe("当前 DeepSeek 官方 · deepseek-reasoner");
  });

  it("切换 #aiDefaultModel 下拉：持久化 defaultModel + defaultAiModel，联动行内默认按钮并刷新投影", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1", defaultAiModel: "deepseek-chat" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk",
      model: "deepseek-chat"
    };
    resolveSubtitleReply = { ok: true, provider: { id: "p1", name: "DeepSeek 官方" }, model: "deepseek-chat", isFallback: false };
    const sent: BusMessage[] = [];
    saveSettingsHook = (msg) => {
      sent.push(msg);
      const patch = (msg.settings ?? {}) as Record<string, unknown>;
      settingsReply = { ...settingsReply, ...patch };
      const target = TWO_PROVIDERS.find((p) => p.id === settingsReply.defaultModel) || TWO_PROVIDERS[0];
      const nextModel = String(settingsReply.defaultAiModel || target.models[0]);
      resolveAiReply = { ok: true, provider: target, apiKey: "sk", model: nextModel };
      resolveSubtitleReply = { ok: true, provider: target, model: nextModel, isFallback: false };
      return { ok: true };
    };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);
    });

    const select = defaultModelSelect(host);
    select.value = `p2${String.fromCharCode(1)}Qwen3-8B`;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 硅基流动 · Qwen3-8B");
    });
    expect(
      sent.some((m) => {
        const s = m.settings as Record<string, unknown> | undefined;
        return m.type === "save-settings" && s?.defaultModel === "p2" && s?.defaultAiModel === "Qwen3-8B";
      })
    ).toBe(true);
    expect(host.querySelector('.ai-provider-row[data-provider-id="p2"] .ai-provider-default-btn')?.textContent).toBe("默认");
    expect(host.querySelector('.ai-provider-row[data-provider-id="p1"] .ai-provider-default-btn')?.textContent).toBe("设为默认");
    expect(followHint(host).textContent).toBe("当前 硅基流动 · Qwen3-8B");
  });

  it("悬空默认回落（禁用 / 删除）：摘要显示真实回落目标并标注，模型行落在回落平台上", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "ghost" };
    resolveAiReply = {
      ok: true,
      isFallback: true,
      provider: { id: "p2", name: "硅基流动", enabled: true, models: ["Qwen3-8B"] },
      apiKey: "sk"
    };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释已回落至 硅基流动 · Qwen3-8B（默认平台不可用）");
    });
    expect(summary(host).dataset.state).toBe("fallback");
    expect(activeModelLine(host)?.closest(".ai-provider-row")?.getAttribute("data-provider-id")).toBe("p2");
  });

  it("不可用（无平台 / 缺 Key）：摘要显示不可用状态，模型行摘除，不展示陈旧成功状态", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1" };
    resolveAiReply = { ok: false, error: "该平台 API Key 未配置" };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释暂不可用：该平台 API Key 未配置");
    });
    expect(summary(host).dataset.state).toBe("unavailable");
    expect(activeModelLine(host)).toBeNull();
    expect(host.querySelector("#aiChatSelectionSummary")).toBeNull();
  });

  it("对话选中不同平台/模型且发生 storage.local 变化时，设置页不显示对话提示且不影响默认模型", async () => {
    const listeners = captureOnChangedListeners();
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1", defaultAiModel: "deepseek-chat" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk",
      model: "deepseek-chat"
    };
    await chrome.storage.local.set({ [SELECTED_KEY]: `p2${String.fromCharCode(1)}Qwen3-8B` });
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-chat");
    });
    expect(host.querySelector("#aiChatSelectionSummary")).toBeNull();
    expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);
    expect(activeModelLine(host)?.textContent).toBe("deepseek-chat");

    await chrome.storage.local.set({ [SELECTED_KEY]: `p1${String.fromCharCode(1)}deepseek-reasoner` });
    fireChanged(listeners, SELECTED_KEY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-chat");
    expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-chat`);
  });

  it("storage.onChanged：defaultModel / defaultAiModel 变化驱动摘要与下拉同步刷新", async () => {
    const listeners = captureOnChangedListeners();
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1", defaultAiModel: "deepseek-chat" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk",
      model: "deepseek-chat"
    };
    installBus();
    const host = await mountPanel();
    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-chat");
    });

    settingsReply = { defaultModel: "p1", defaultAiModel: "deepseek-reasoner" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk",
      model: "deepseek-reasoner"
    };
    fireChanged(listeners, "defaultAiModel");

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-reasoner");
      expect(defaultModelSelect(host).value).toBe(`p1${String.fromCharCode(1)}deepseek-reasoner`);
    });

    // 他端把默认平台禁用 / 删除：重新解析结果为回落到 p2
    resolveAiReply = {
      ok: true,
      isFallback: true,
      provider: { id: "p2", name: "硅基流动", enabled: true, models: ["Qwen3-8B"] },
      apiKey: "sk"
    };
    fireChanged(listeners, "defaultModel");

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释已回落至 硅基流动 · Qwen3-8B（默认平台不可用）");
    });
    expect(activeModelLine(host)?.closest(".ai-provider-row")?.getAttribute("data-provider-id")).toBe("p2");
  });

  it("storage.onChanged：aiProviders 列表变化（他端增删启停）驱动摘要刷新", async () => {
    const listeners = captureOnChangedListeners();
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk"
    };
    installBus();
    const host = await mountPanel();
    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-chat");
    });

    // 他端删除了默认平台：解析不再可用
    resolveAiReply = { ok: false, error: "还没有配置 AI 平台，请先在插件设置中添加并启用。" };
    fireChanged(listeners, "aiProviders");

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释暂不可用：还没有配置 AI 平台，请先在插件设置中添加并启用。");
    });
    expect(activeModelLine(host)).toBeNull();
  });

  it("字幕翻译跟随提示如实标注专属配置回落（isFallback 自报）", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat"] },
      apiKey: "sk"
    };
    resolveSubtitleReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方" },
      model: "deepseek-chat",
      isFallback: true
    };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(followHint(host).textContent).toBe("专属模型已失效，当前 DeepSeek 官方 · deepseek-chat");
    });
  });

  it("选了专属字幕模型时不挂副行：控件值已说明目标，副行只服务「跟随默认」", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { subtitleTranslateProviderId: "p1", subtitleTranslateModel: "deepseek-chat" };
    resolveSubtitleReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方" },
      model: "deepseek-chat",
      isFallback: false
    };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(followHint(host).textContent).toBe("当前 DeepSeek 官方 · deepseek-chat");
    });
    expect(followHint(host).hidden).toBe(true);
  });
});
