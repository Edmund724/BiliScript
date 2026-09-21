// tests/chat/providers.test.ts
// createProviderPrefs（AI 平台加载渲染 + 思考档位）行为契约（候选5 拆分直测；
// PR5 自 tests/sidepanel/sidepanel-providers.test.ts 随迁并适配持久化通道改造：
// localStorage → chrome.storage.local，通道断言随改造更新，渲染/归一化断言不变）。
//
// 覆盖：
// - loadProvidersAndPrefs：双消息（ai-providers-list + get-settings）+ storage
//   读取并行、enabled 过滤、aiPrefs 归一化落 chatSessionState、空预设回落
//   DEFAULT_PRESET_PROMPTS 并触发持久化、渲染回调（modelSelect/思考档位/预设
//   列表）；
// - renderModelSelect：无平台 → disabled +「未配置平台」；有平台 → 按优先级
//   preferredProviderId > chrome.storage 选中（复合值，精确到模型）>
//   aiPrefs.defaultModel（裸平台 id，只解析到平台首个模型）；
// - setThinkingLevel：归一化 + 渲染 + chrome.storage 写 + save-settings 单键。
//
// 模板同 tests/chat/presets.test.ts：vi.hoisted mock shared/messaging；
// resetModules 切纪元后同纪元 import chat-state 单例；storage fake 注入 deps。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
const THINKING_LEVEL_KEY = "boc_ai_thinking_level";

let createProviderPrefs;
let chatSessionState;
let buildModelOptionValue;
let parseModelOptionValue;

async function importModule() {
  const module = await import("../../extension/chat/providers.js");
  const state = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  createProviderPrefs = module.createProviderPrefs;
  chatSessionState = state;
  buildModelOptionValue = module.buildModelOptionValue;
  parseModelOptionValue = module.parseModelOptionValue;
}

// chrome.storage.local fake（conversation-store 测试同款手法：Map 底座 + 记录
// 调用的 get/set）
function makeStorageFake(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (keys) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn(async (items) => {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, v);
      }
    })
  };
}

function makeHarness(storage = makeStorageFake()) {
  const modelSelect = document.createElement("select");
  document.body.appendChild(modelSelect);
  const thinkingBtns = ["off", "low", "high"].map((level) => {
    const btn = document.createElement("button");
    btn.dataset.level = level;
    document.body.appendChild(btn);
    return btn;
  });
  const deps = {
    modelSelect,
    thinkingBtns,
    widthEls: { modelSelect },
    renderPresetPrompts: vi.fn(),
    persistAiPresetPrompts: vi.fn(async () => {}),
    storage
  };
  const providerPrefs = createProviderPrefs(deps);
  return { modelSelect, thinkingBtns, deps, providerPrefs, storage };
}

beforeEach(async () => {
  resetModuleState();
  sendRuntimeMessageMock.mockReset();
  sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true }));
  await importModule();
});

describe("loadProvidersAndPrefs", () => {
  it("双消息并行拉取 + storage 读取，enabled 过滤后写 chatSessionState，并触发三路渲染", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [
          { id: "p1", name: "平台一", enabled: true },
          { id: "p2", name: "平台二", enabled: false },
          { id: "p3", model: "模型三", enabled: true }
        ] };
      }
      return { ok: true, settings: {
        aiSystemPrompt: "  系统提示  ",
        aiInitialQuickPrompts: ["快速一"],
        aiPresetPrompts: ["预设一"],
        defaultModel: "p3",
        aiThinkingLevel: "low"
      } };
    });
    const { deps, providerPrefs, storage } = makeHarness();

    await providerPrefs.loadProvidersAndPrefs();

    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-list" });
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "get-settings" });
    expect(storage.get).toHaveBeenCalledWith([SELECTED_PROVIDER_KEY, THINKING_LEVEL_KEY]);
    expect(chatSessionState.providers.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(chatSessionState.aiPrefs).toEqual({
      aiSystemPrompt: "系统提示",
      aiInitialQuickPrompts: ["快速一"],
      aiPresetPrompts: ["预设一"],
      defaultModel: "p3"
    });
    expect(chatSessionState.aiThinkingLevel).toBe("low");
    expect(deps.renderPresetPrompts).toHaveBeenCalledTimes(1);
    expect(deps.persistAiPresetPrompts).not.toHaveBeenCalled();
    // 默认选中 defaultModel 对应平台：裸平台 id 回落该平台首个模型（复合值）
    expect(deps.modelSelect.value).toBe(buildModelOptionValue("p3", "模型三"));
    expect(deps.modelSelect.disabled).toBe(false);
    // 思考档位高亮 low
    expect(deps.thinkingBtns.map((btn) => btn.classList.contains("is-active"))).toEqual([false, true, false]);
  });

  it("空预设回落 DEFAULT_PRESET_PROMPTS 并触发持久化", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      return { ok: true, settings: {} };
    });
    const { deps, providerPrefs } = makeHarness();

    await providerPrefs.loadProvidersAndPrefs();

    expect(chatSessionState.aiPrefs.aiPresetPrompts.length).toBeGreaterThan(0);
    expect(deps.persistAiPresetPrompts).toHaveBeenCalledTimes(1);
  });

  it("get-settings 失败不阻断：aiPrefs 全走默认兜底", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      throw new Error("settings 通道断开");
    });
    const { providerPrefs } = makeHarness();

    await expect(providerPrefs.loadProvidersAndPrefs()).resolves.toBeUndefined();

    expect(chatSessionState.aiPrefs.aiSystemPrompt).toBe("");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
  });

  it("aiThinkingLevel 兜底读 chrome.storage（settings 缺省时）", async () => {
    const storage = makeStorageFake({ [THINKING_LEVEL_KEY]: "high" });
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      return { ok: true, settings: {} };
    });
    const { providerPrefs } = makeHarness(storage);

    await providerPrefs.loadProvidersAndPrefs();

    expect(chatSessionState.aiThinkingLevel).toBe("high");
  });
});

describe("renderModelSelect", () => {
  it("无平台：disabled + 「未配置平台」占位", () => {
    chatSessionState.providers = [];
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    expect(modelSelect.disabled).toBe(true);
    expect(modelSelect.innerHTML).toContain("未配置平台");
  });

  it("按平台 optgroup 分组、一模型一选项；零模型平台不进选择器；value 为「平台 id+模型 id」复合值", () => {
    chatSessionState.providers = [
      { id: "p1", name: "DeepSeek", model: "deepseek-v4-flash", enabled: true },
      { id: "p2", name: "无模型平台", enabled: true },
      { id: "p3", model: "裸模型", enabled: true }
    ];
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    // 组标题 = 平台名（缺名回落模型名）；零模型平台 p2 无选项
    expect(Array.from(modelSelect.querySelectorAll("optgroup")).map((g) => g.label)).toEqual([
      "DeepSeek",
      "裸模型"
    ]);
    expect(Array.from(modelSelect.options).map((opt) => opt.textContent)).toEqual([
      "deepseek-v4-flash",
      "裸模型"
    ]);
    // value = 复合值（选模型即隐式选定平台）；同名模型由组标题区分
    expect(Array.from(modelSelect.options).map((opt) => opt.value)).toEqual([
      buildModelOptionValue("p1", "deepseek-v4-flash"),
      buildModelOptionValue("p3", "裸模型")
    ]);
  });

  it("多模型平台渲染为同组多选项（models 载荷）", () => {
    chatSessionState.providers = [
      { id: "p1", name: "DeepSeek", models: ["deepseek-v4-flash", "deepseek-v4-pro"], enabled: true }
    ];
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    const group = modelSelect.querySelector("optgroup");
    expect(group.label).toBe("DeepSeek");
    expect(Array.from(group.querySelectorAll("option")).map((opt) => opt.value)).toEqual([
      buildModelOptionValue("p1", "deepseek-v4-flash"),
      buildModelOptionValue("p1", "deepseek-v4-pro")
    ]);
  });

  it("全部平台零模型：等同未配置（disabled + 占位）", () => {
    chatSessionState.providers = [
      { id: "p1", name: "空目录平台", models: [], enabled: true }
    ];
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    expect(modelSelect.disabled).toBe(true);
    expect(modelSelect.innerHTML).toContain("未配置平台");
  });

  it("复合值编解码往返", () => {
    const value = buildModelOptionValue("p1", "gpt-4o-mini");
    expect(parseModelOptionValue(value)).toEqual({ providerId: "p1", model: "gpt-4o-mini" });
    // 旧裸平台 id：模型段为空（消费端回落平台记录）
    expect(parseModelOptionValue("p1")).toEqual({ providerId: "p1", model: "" });
  });

  it("preferredProviderId 优先于 aiPrefs.defaultModel 与 chrome.storage 选中", () => {
    chatSessionState.providers = [
      { id: "p1", name: "平台一", models: ["m1"], enabled: true },
      { id: "p2", name: "平台二", models: ["m2"], enabled: true }
    ];
    chatSessionState.aiPrefs.defaultModel = "p2";
    const storage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: "p2" });
    const { modelSelect, providerPrefs } = makeHarness(storage);

    providerPrefs.renderModelSelect("p1");

    expect(modelSelect.value).toBe(buildModelOptionValue("p1", "m1"));
  });

  it("无 preferred：回落 defaultModel，再回落 chrome.storage 选中（经 load 预取的闭包缓存）", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [
          { id: "p1", name: "平台一", models: ["m1"], enabled: true },
          { id: "p2", name: "平台二", models: ["m2"], enabled: true }
        ] };
      }
      return { ok: true, settings: { defaultModel: "" } };
    });
    const storage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: "p2" });
    const { modelSelect, providerPrefs } = makeHarness(storage);

    await providerPrefs.loadProvidersAndPrefs();

    // storage 里的旧裸平台 id 向前兼容：回落该平台首个模型的复合值
    expect(modelSelect.value).toBe(buildModelOptionValue("p2", "m2"));
  });

  it("storage 复合选中值直接命中（精确到模型）", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [
          { id: "p1", name: "平台一", models: ["m1", "m1b"], enabled: true }
        ] };
      }
      return { ok: true, settings: { defaultModel: "" } };
    });
    const storage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: buildModelOptionValue("p1", "m1b") });
    const { modelSelect, providerPrefs } = makeHarness(storage);

    await providerPrefs.loadProvidersAndPrefs();

    expect(modelSelect.value).toBe(buildModelOptionValue("p1", "m1b"));
  });

  it("storage 复合选中值优先于 defaultModel（同平台换到非首个模型后新页面不丢）", async () => {
    // 复现工单场景：切换模型监听同趟写入 local 复合值与 sync defaultModel
    //（裸平台 id）。defaultModel 只能解析到平台首个模型，若排在复合值之前，
    // 新开页面会回落首个模型、丢失精确选择。
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [
          { id: "p1", name: "平台一", models: ["m1", "m1b"], enabled: true }
        ] };
      }
      return { ok: true, settings: { defaultModel: "p1" } };
    });
    const storage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: buildModelOptionValue("p1", "m1b") });
    const { modelSelect, providerPrefs } = makeHarness(storage);

    await providerPrefs.loadProvidersAndPrefs();

    expect(modelSelect.value).toBe(buildModelOptionValue("p1", "m1b"));
  });

  it("storage 选中值失效（平台已删）时继续回落 defaultModel", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [
          { id: "p1", name: "平台一", models: ["m1"], enabled: true },
          { id: "p2", name: "平台二", models: ["m2"], enabled: true }
        ] };
      }
      return { ok: true, settings: { defaultModel: "p2" } };
    });
    const storage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: buildModelOptionValue("p9", "m9") });
    const { modelSelect, providerPrefs } = makeHarness(storage);

    await providerPrefs.loadProvidersAndPrefs();

    expect(modelSelect.value).toBe(buildModelOptionValue("p2", "m2"));
  });

  it("闭包缓存未预取（未经过 loadProvidersAndPrefs）时回退到首个平台首个模型", () => {
    chatSessionState.providers = [
      { id: "p1", name: "平台一", models: ["m1"], enabled: true },
      { id: "p2", name: "平台二", models: ["m2"], enabled: true }
    ];
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    expect(modelSelect.value).toBe(buildModelOptionValue("p1", "m1"));
  });
});

describe("setThinkingLevel", () => {
  it("归一化 + 渲染 + chrome.storage 写 + save-settings 单键", async () => {
    const { thinkingBtns, providerPrefs, storage } = makeHarness();

    await providerPrefs.setThinkingLevel("high");

    expect(chatSessionState.aiThinkingLevel).toBe("high");
    expect(storage.set).toHaveBeenCalledWith({ [THINKING_LEVEL_KEY]: "high" });
    expect(storage.data.get(THINKING_LEVEL_KEY)).toBe("high");
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
      type: "save-settings",
      settings: { aiThinkingLevel: "high" }
    });
    expect(thinkingBtns.map((btn) => btn.classList.contains("is-active"))).toEqual([false, false, true]);
    expect(thinkingBtns.map((btn) => btn.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  });

  it("非法档位归一化为 off", async () => {
    const { providerPrefs } = makeHarness();

    await providerPrefs.setThinkingLevel("ultra");

    expect(chatSessionState.aiThinkingLevel).toBe("off");
  });
});

describe("setSelectedProvider / getStoredSelectedProviderId", () => {
  it("写入 chrome.storage.local 并同步更新闭包缓存", () => {
    const { providerPrefs, storage } = makeHarness();

    providerPrefs.setSelectedProvider("p9");

    expect(storage.set).toHaveBeenCalledWith({ [SELECTED_PROVIDER_KEY]: "p9" });
    expect(storage.data.get(SELECTED_PROVIDER_KEY)).toBe("p9");
    expect(providerPrefs.getStoredSelectedProviderId()).toBe("p9");
  });
});

describe("webSearchEnabled 联网开关（spec §2.1/§4）", () => {
  function makePillHarness(storage) {
    const pill = document.createElement("button");
    document.body.appendChild(pill);
    const harness = makeHarness(storage);
    // pill 是可选注入：直接挂 deps 重建实例
    const providerPrefs = createProviderPrefs({ ...harness.deps, webSearchPill: pill });
    return { ...harness, providerPrefs, pill };
  }

  it("loadProvidersAndPrefs 水合 settings.webSearchEnabled，pill 开启态渲染", async () => {
    sendRuntimeMessageMock.mockImplementation(async (msg) => {
      if (msg.type === "get-settings") {
        return { ok: true, settings: { aiThinkingLevel: "off", webSearchEnabled: true } };
      }
      return { ok: true, providers: [] };
    });
    const { providerPrefs, pill } = makePillHarness();

    await providerPrefs.loadProvidersAndPrefs();

    expect(chatSessionState.webSearchEnabled).toBe(true);
    expect(pill.classList.contains("is-active")).toBe(true);
    expect(pill.getAttribute("aria-pressed")).toBe("true");
  });

  it("settings 缺省：默认关", async () => {
    sendRuntimeMessageMock.mockImplementation(async (msg) => {
      if (msg.type === "get-settings") {
        return { ok: true, settings: {} };
      }
      return { ok: true, providers: [] };
    });
    const { providerPrefs, pill } = makePillHarness();

    await providerPrefs.loadProvidersAndPrefs();

    expect(chatSessionState.webSearchEnabled).toBe(false);
    expect(pill.classList.contains("is-active")).toBe(false);
  });

  it("setWebSearchEnabled：写 chatSessionState + 渲染 + save-settings 单键持久化", async () => {
    const { providerPrefs, pill } = makePillHarness();

    await providerPrefs.setWebSearchEnabled(true);

    expect(chatSessionState.webSearchEnabled).toBe(true);
    expect(pill.classList.contains("is-active")).toBe(true);
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
      type: "save-settings",
      settings: { webSearchEnabled: true }
    });

    await providerPrefs.setWebSearchEnabled(false);
    expect(pill.classList.contains("is-active")).toBe(false);
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
      type: "save-settings",
      settings: { webSearchEnabled: false }
    });
  });
});
