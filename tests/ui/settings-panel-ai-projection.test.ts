// ui/settings-panel.ts 生效投影直测（票 05：AI 默认平台与模型生效投影）。
//
// 走真实模块 + DOM 仿真（settings-panel-save.test.ts 同款）：挂载面板后断言——
// - 默认平台行挂「默认」徽标与概览/解释模型行，分区摘要显示实际缺省选择；
// - 默认被禁用 / 删除（解析回落，isFallback 自报）时摘要显示真实回落目标；
// - 缺 Key / 无平台时摘要显示不可用状态，徽标摘除，不展示陈旧成功状态；
// - 对话另选平台 / 模型时显示对话选择及切换位置，默认摘要与徽标不变；
// - 字幕翻译「跟随 AI 默认平台」提示展示解析权威给出的真实跟随目标；
// - chrome.storage.onChanged（defaultModel / aiProviders / 对话选中键）驱动摘要同步刷新。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage } from "../helpers/settings-panel-bus.js";

type ProvidersReply = { ok: boolean; providers?: Record<string, unknown>[]; error?: string };
type ResolveAiReply = {
  ok: boolean;
  provider?: Record<string, unknown>;
  apiKey?: string;
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

function installBus() {
  return installSettingsPanelBus<BusMessage>({
    "get-settings": () => ({ ok: true, settings: settingsReply }),
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

function chatSummary(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#aiChatSelectionSummary")!;
}

function followHint(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#subtitleTranslateFollowHint")!;
}

function defaultBadge(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".ai-provider-row .provider-row-badge");
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
});

describe("设置面板 AI 生效投影（票 05）", () => {
  it("显式默认：默认行挂「默认」徽标与模型行，分区摘要显示概览与解释的实际缺省选择", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk"
    };
    resolveSubtitleReply = { ok: true, provider: { id: "p1", name: "DeepSeek 官方" }, model: "deepseek-chat", isFallback: false };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-chat");
    });

    const badge = defaultBadge(host);
    expect(badge?.textContent).toBe("默认");
    expect(badge?.closest(".ai-provider-row")?.getAttribute("data-provider-id")).toBe("p1");
    // AI 族行模板不渲染模型副行：默认行的模型行由投影挂出，且是解析出的生效模型
    const modelLine = host.querySelector<HTMLElement>(".ai-provider-row .provider-row-model");
    expect(modelLine?.textContent).toBe("deepseek-chat");
    // 无对话另选 → 对话行隐藏
    expect(chatSummary(host).hidden).toBe(true);
    // 字幕翻译跟随提示：解析权威给出的真实跟随目标
    expect(followHint(host).hidden).toBe(false);
    expect(followHint(host).textContent).toBe("当前 DeepSeek 官方 · deepseek-chat");
  });

  it("悬空默认回落（禁用 / 删除）：摘要显示真实回落目标并标注，徽标落在回落平台上", async () => {
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
    expect(defaultBadge(host)?.closest(".ai-provider-row")?.getAttribute("data-provider-id")).toBe("p2");
  });

  it("不可用（无平台 / 缺 Key）：摘要显示不可用状态，徽标摘除，不展示陈旧成功状态", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1" };
    resolveAiReply = { ok: false, error: "该平台 API Key 未配置" };
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释暂不可用：该平台 API Key 未配置");
    });
    expect(defaultBadge(host)).toBeNull();
    expect(chatSummary(host).hidden).toBe(true);
  });

  it("对话另选平台 / 模型：显示对话选择及切换位置，默认摘要与徽标不变", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk"
    };
    await chrome.storage.local.set({ [SELECTED_KEY]: `p2${String.fromCharCode(1)}Qwen3-8B` });
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(chatSummary(host).hidden).toBe(false);
    });
    expect(chatSummary(host).textContent).toBe(
      "对话当前使用 硅基流动 · Qwen3-8B（在视频页 AI 对话面板切换，不影响上方默认）"
    );
    // 默认投影不被对话另选改写
    expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-chat");
    expect(defaultBadge(host)?.closest(".ai-provider-row")?.getAttribute("data-provider-id")).toBe("p1");
  });

  it("对话选中与生效投影一致时不显示另选行", async () => {
    aiProvidersReply = { ok: true, providers: TWO_PROVIDERS };
    settingsReply = { defaultModel: "p1" };
    resolveAiReply = {
      ok: true,
      provider: { id: "p1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat", "deepseek-reasoner"] },
      apiKey: "sk"
    };
    // 对话选中默认平台的非首项模型：投影模型 = 选中模型 → 不算另选
    await chrome.storage.local.set({ [SELECTED_KEY]: `p1${String.fromCharCode(1)}deepseek-reasoner` });
    installBus();
    const host = await mountPanel();

    await vi.waitFor(() => {
      expect(summary(host).textContent).toBe("概览与解释将使用 DeepSeek 官方 · deepseek-reasoner");
    });
    expect(chatSummary(host).hidden).toBe(true);
  });

  it("storage.onChanged：defaultModel 变化驱动摘要同步刷新（跨端变化不展示陈旧状态）", async () => {
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
    expect(defaultBadge(host)?.closest(".ai-provider-row")?.getAttribute("data-provider-id")).toBe("p2");
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
    expect(defaultBadge(host)).toBeNull();
  });

  it("storage.onChanged：对话选中键变化（local）驱动另选行刷新", async () => {
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
    expect(chatSummary(host).hidden).toBe(true);

    await chrome.storage.local.set({ [SELECTED_KEY]: `p2${String.fromCharCode(1)}Qwen3-8B` });
    fireChanged(listeners, SELECTED_KEY);

    await vi.waitFor(() => {
      expect(chatSummary(host).hidden).toBe(false);
    });
    expect(chatSummary(host).textContent).toContain("对话当前使用 硅基流动 · Qwen3-8B");
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
