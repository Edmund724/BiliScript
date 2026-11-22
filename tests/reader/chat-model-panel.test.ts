import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ThinkingView } from "../../extension/chat/thinking-picker.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

let createReaderChatModelPanel: typeof import("../../extension/reader/chat-model-panel.js").createReaderChatModelPanel;
let buildModelOptionValue: typeof import("../../extension/reader/chat-model-panel.js").buildModelOptionValue;
let parseModelOptionValue: typeof import("../../extension/reader/chat-model-panel.js").parseModelOptionValue;
let SELECTED_PROVIDER_KEY: typeof import("../../extension/reader/chat-model-panel.js").SELECTED_PROVIDER_KEY;
let THINKING_LEVEL_KEY: typeof import("../../extension/reader/chat-model-panel.js").THINKING_LEVEL_KEY;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let thinkingPickerEntries: typeof import("../../extension/chat/thinking-picker.js").thinkingPickerEntries;

beforeEach(async () => {
  resetModuleState();
  sendRuntimeMessageMock.mockReset();
  sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true }));
  const panelMod = await import("../../extension/reader/chat-model-panel.js");
  createReaderChatModelPanel = panelMod.createReaderChatModelPanel;
  buildModelOptionValue = panelMod.buildModelOptionValue;
  parseModelOptionValue = panelMod.parseModelOptionValue;
  SELECTED_PROVIDER_KEY = panelMod.SELECTED_PROVIDER_KEY;
  THINKING_LEVEL_KEY = panelMod.THINKING_LEVEL_KEY;
  const stateMod = await import("../../extension/chat/chat-state.js");
  chatSessionState = stateMod.chatSessionState;
  chatSessionStateForTests = stateMod.chatSessionStateForTests;
  thinkingPickerEntries = (await import("../../extension/chat/thinking-picker.js")).thinkingPickerEntries;
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SEP = String.fromCharCode(1);

function makeStorageFake(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.entries(items).forEach(([k, v]) => {
        data.set(k, v);
      });
    })
  };
}

function seedDefaultProviders(): void {
  chatSessionStateForTests.providers = [
    { id: "p1", name: "平台一", models: ["m1a", "m1b"], enabled: true },
    { id: "p2", name: "平台二", models: ["m2"], enabled: true }
  ];
}

function view(over: Pick<ThinkingView, "label" | "entries"> & Partial<ThinkingView>): ThinkingView {
  return { hint: null, ...over };
}

function mockRuntimeReplies(options: {
  providers?: Record<string, unknown>;
  settings?: () => Promise<Record<string, unknown>>;
}): void {
  const routes: Record<string, () => Promise<unknown>> = {
    "ai-providers-list": async () => options.providers ?? { providers: [] },
    "get-settings": options.settings ?? (async () => ({ ok: true, settings: {} }))
  };
  sendRuntimeMessageMock.mockImplementation(async (message) => {
    const handler = routes[String(message.type)];
    return handler ? await handler() : { ok: true };
  });
}

type HintMode = "element" | "null" | "omitted";

function makeHarness(options: {
  seedProviders?: boolean;
  hintMode?: HintMode;
  storage?: ReturnType<typeof makeStorageFake>;
  withWebSearchPill?: boolean;
  withInputBar?: boolean;
} = {}) {
  const {
    seedProviders = true,
    hintMode = "element",
    storage = makeStorageFake(),
    withWebSearchPill = false,
    withInputBar = false
  } = options;
  void (seedProviders && seedDefaultProviders());
  const select = document.createElement("select");
  const chip = document.createElement("button");
  const chipModel = document.createElement("span");
  const chipLevel = document.createElement("span");
  chip.append(chipModel, chipLevel);
  const panelList = document.createElement("div");
  const panel = document.createElement("div");
  const thinkingToggle = document.createElement("div");
  const thinkingRow = document.createElement("div");
  const thinkingRowValue = document.createElement("span");
  thinkingRow.append(thinkingRowValue, thinkingToggle);
  const panelFoot = document.createElement("div");
  const thinkingHint = document.createElement("div");
  thinkingHint.hidden = true;
  panelFoot.append(thinkingRow, thinkingHint);
  panel.append(panelList, panelFoot);
  const webSearchPill = withWebSearchPill ? document.createElement("button") : null;
  const inputBar = withInputBar ? document.createElement("div") : null;
  void (inputBar && ((inputBar.className = "chat-input-bar"), inputBar.append(chip)));
  document.body.append(...[select, inputBar ?? chip, panel, ...(webSearchPill ? [webSearchPill] : [])]);
  const hidePanel = vi.fn();
  const openSettings = vi.fn();
  const pickLevel = vi.fn();
  const modelPanel = createReaderChatModelPanel({
    modelSelect: select,
    chip,
    chipModel,
    chipLevel,
    panelList,
    panel,
    thinkingToggle,
    thinkingRow,
    thinkingRowValue,
    ...(hintMode === "element" ? { thinkingHint } : hintMode === "null" ? { thinkingHint: null } : {}),
    ...(webSearchPill ? { webSearchPill } : {}),
    storage,
    hidePanel,
    openSettings,
    pickLevel
  });
  return {
    select,
    chip,
    chipModel,
    chipLevel,
    inputBar,
    panelList,
    panel,
    thinkingToggle,
    thinkingRow,
    thinkingRowValue,
    thinkingHint: hintMode === "element" ? thinkingHint : null,
    webSearchPill,
    storage,
    hidePanel,
    openSettings,
    pickLevel,
    modelPanel
  };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function buttons(toggle: HTMLElement): HTMLButtonElement[] {
  return [...toggle.querySelectorAll<HTMLButtonElement>(".chat-thinking-btn")];
}

function renderedLevels(toggle: HTMLElement): string[] {
  return buttons(toggle).map((btn) => btn.dataset.level || "");
}

function renderedLabels(toggle: HTMLElement): string[] {
  return buttons(toggle).map((btn) => (btn.querySelector(".chat-thinking-btn-label") as HTMLElement).textContent || "");
}

function stubNoCanvas() {
  vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}

describe("reload 与持久化状态水合", () => {
  it("双消息并行拉取 + storage 读取，enabled 过滤后写 chatSessionState 并同步隐藏 select 与 chip", async () => {
    mockRuntimeReplies({
      providers: {
        providers: [
          { id: "p1", name: "平台一", enabled: true },
          { id: "p2", name: "平台二", enabled: false },
          { id: "p3", model: "模型三", enabled: true }
        ]
      },
      settings: async () => ({
        ok: true,
        settings: {
          aiSystemPrompt: "  系统提示  ",
          aiInitialQuickPrompts: ["快速一"],
          defaultModel: "p3",
          aiThinkingLevel: "low"
        }
      })
    });
    const { select, chipModel, chipLevel, storage, modelPanel } = makeHarness({ seedProviders: false });

    await modelPanel.reload();

    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-list" });
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "get-settings" });
    expect(storage.get).toHaveBeenCalledWith([SELECTED_PROVIDER_KEY, THINKING_LEVEL_KEY]);
    expect(chatSessionState.providers.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(chatSessionState.aiPrefs).toEqual({
      aiSystemPrompt: "系统提示",
      aiInitialQuickPrompts: ["快速一"],
      defaultModel: "p3",
      defaultAiModel: ""
    });
    expect(chatSessionState.aiThinkingLevel).toBe("low");
    expect(select.value).toBe(buildModelOptionValue("p3", "模型三"));
    expect(select.disabled).toBe(false);
    expect(chipModel.textContent).toBe("模型三·模型三");
    expect(chipLevel.textContent).toBe("Low");
  });

  it("get-settings 失败不阻断：aiPrefs 与 aiThinkingLevel 走默认兜底", async () => {
    mockRuntimeReplies({
      providers: { providers: [{ id: "p1", enabled: true }] },
      settings: async () => {
        throw new Error("settings 通道断开");
      }
    });
    const { modelPanel } = makeHarness({ seedProviders: false });

    await expect(modelPanel.reload()).resolves.toBeUndefined();

    expect(chatSessionState.aiPrefs.aiSystemPrompt).toBe("");
    expect(chatSessionState.aiThinkingLevel).toBe("default");
  });

  it("aiThinkingLevel 兜底读 chrome.storage（settings 缺省时）", async () => {
    const storage = makeStorageFake({ [THINKING_LEVEL_KEY]: "high" });
    mockRuntimeReplies({ providers: { providers: [{ id: "p1", enabled: true }] } });
    const { modelPanel } = makeHarness({ seedProviders: false, storage });

    await modelPanel.reload();

    expect(chatSessionState.aiThinkingLevel).toBe("high");
  });

  it.each(["off", "low", "high"] as const)("旧存储值 %s 原样读回，不被迁移或改写", async (legacy) => {
    const storage = makeStorageFake({ [THINKING_LEVEL_KEY]: legacy });
    mockRuntimeReplies({ providers: { providers: [{ id: "p1", enabled: true }] } });
    const { modelPanel } = makeHarness({ seedProviders: false, storage });

    await modelPanel.reload();

    expect(chatSessionState.aiThinkingLevel).toBe(legacy);
    expect(storage.data.get(THINKING_LEVEL_KEY)).toBe(legacy);
  });

  it.each(["minimal", "medium", "xhigh", "max"] as const)("settings 档位 %s 原样读回", async (level) => {
    mockRuntimeReplies({
      providers: { providers: [{ id: "p1", enabled: true }] },
      settings: async () => ({ ok: true, settings: { aiThinkingLevel: level } })
    });
    const { modelPanel } = makeHarness({ seedProviders: false });

    await modelPanel.reload();

    expect(chatSessionState.aiThinkingLevel).toBe(level);
  });

  it("选中回落优先级：preferredProviderId > storage 复合值 > defaultModel > 首项；复合值编解码往返", async () => {
    expect(parseModelOptionValue(buildModelOptionValue("p1", "gpt-4o-mini"))).toEqual({
      providerId: "p1",
      model: "gpt-4o-mini"
    });
    expect(parseModelOptionValue("p1")).toEqual({ providerId: "p1", model: "" });

    mockRuntimeReplies({
      providers: {
        providers: [
          { id: "p1", name: "平台一", models: ["m1", "m1b"], enabled: true },
          { id: "p2", name: "平台二", models: ["m2"], enabled: true }
        ]
      },
      settings: async () => ({ ok: true, settings: { defaultModel: "p1" } })
    });

    const prefStorage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: "p2" });
    const h1 = makeHarness({ seedProviders: false, storage: prefStorage });
    await h1.modelPanel.reload({ preferredProviderId: "p1" });
    expect(h1.select.value).toBe(buildModelOptionValue("p1", "m1"));

    const exactStorage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: buildModelOptionValue("p1", "m1b") });
    const h2 = makeHarness({ seedProviders: false, storage: exactStorage });
    await h2.modelPanel.reload();
    expect(h2.select.value).toBe(buildModelOptionValue("p1", "m1b"));

    const staleStorage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: buildModelOptionValue("p9", "m9") });
    const h3 = makeHarness({ seedProviders: false, storage: staleStorage });
    await h3.modelPanel.reload();
    expect(h3.select.value).toBe(buildModelOptionValue("p1", "m1"));

    mockRuntimeReplies({
      providers: {
        providers: [
          { id: "p1", name: "平台一", models: ["m1"], enabled: true },
          { id: "p2", name: "平台二", models: ["m2"], enabled: true }
        ]
      },
      settings: async () => ({ ok: true, settings: { defaultModel: "" } })
    });
    const legacyStorage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: "p2" });
    const h4 = makeHarness({ seedProviders: false, storage: legacyStorage });
    await h4.modelPanel.reload();
    expect(h4.select.value).toBe(buildModelOptionValue("p2", "m2"));
  });

  it("零模型平台不进选择器，并经 hasSelectableModels / resolveSetupTarget 区分无平台与缺模型", async () => {
    const h1 = makeHarness({ seedProviders: false });
    chatSessionStateForTests.providers = [];
    h1.modelPanel.renderChip();
    expect(h1.modelPanel.hasSelectableModels()).toBe(false);
    expect(h1.modelPanel.resolveSetupTarget()).toEqual({ errorClass: "no-provider", providerId: "" });
    expect(h1.select.disabled).toBe(true);
    expect(h1.select.innerHTML).toContain("未配置平台");

    mockRuntimeReplies({
      providers: { providers: [{ id: "p-empty", name: "空目录平台", models: [], enabled: true }] },
      settings: async () => ({ ok: true, settings: { defaultModel: "p-empty" } })
    });
    await h1.modelPanel.reload();
    expect(h1.modelPanel.hasSelectableModels()).toBe(false);
    expect(h1.modelPanel.resolveSetupTarget()).toEqual({ errorClass: "no-model", providerId: "p-empty" });
    expect(h1.select.disabled).toBe(true);
    expect(h1.select.innerHTML).toContain("未配置模型");
  });
});

describe("setThinkingLevel 与 webSearchPill 联网开关", () => {
  it("setThinkingLevel 归一化非法值并同步状态、storage、save-settings 与 chip", async () => {
    const { chipLevel, storage, modelPanel } = makeHarness();

    await modelPanel.setThinkingLevel("high");
    expect(chatSessionState.aiThinkingLevel).toBe("high");
    expect(storage.set).toHaveBeenCalledWith({ [THINKING_LEVEL_KEY]: "high" });
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
      type: "save-settings",
      settings: { aiThinkingLevel: "high" }
    });
    expect(chipLevel.textContent).toBe("High");

    await modelPanel.setThinkingLevel("ultra");
    expect(chatSessionState.aiThinkingLevel).toBe("default");

    await modelPanel.setThinkingLevel("none");
    expect(chatSessionState.aiThinkingLevel).toBe("default");
  });

  it.each(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "8 档可选值 %s 状态/storage/save-settings 三处同值",
    async (level) => {
      sendRuntimeMessageMock.mockClear();
      const { storage, modelPanel } = makeHarness();

      await modelPanel.setThinkingLevel(level);

      expect(chatSessionState.aiThinkingLevel).toBe(level);
      expect(storage.data.get(THINKING_LEVEL_KEY)).toBe(level);
      expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
        type: "save-settings",
        settings: { aiThinkingLevel: level }
      });
    }
  );

  it("webSearchPill：水合首帧不转，点击切换发持久化并驱动旋转类与 animationend 清理", async () => {
    mockRuntimeReplies({
      providers: { ok: true, providers: [] },
      settings: async () => ({ ok: true, settings: { aiThinkingLevel: "off", webSearchEnabled: true } })
    });
    const { webSearchPill, modelPanel } = makeHarness({ seedProviders: false, withWebSearchPill: true });
    const pill = webSearchPill!;

    await modelPanel.reload();
    expect(chatSessionState.webSearchEnabled).toBe(true);
    expect(pill.classList.contains("is-active")).toBe(true);
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.classList.contains("is-spinning-on")).toBe(false);
    expect(pill.classList.contains("is-spinning-off")).toBe(false);

    click(pill);
    await vi.waitFor(() => expect(chatSessionState.webSearchEnabled).toBe(false));
    expect(pill.classList.contains("is-active")).toBe(false);
    expect(pill.classList.contains("is-spinning-off")).toBe(true);
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
      type: "save-settings",
      settings: { webSearchEnabled: false }
    });

    const animEnd = new Event("animationend", { bubbles: true });
    Object.defineProperty(animEnd, "animationName", { value: "biliscript-web-search-meridian-off" });
    pill.dispatchEvent(animEnd);
    expect(pill.classList.contains("is-spinning-off")).toBe(false);

    await modelPanel.setWebSearchEnabled(true);
    expect(pill.classList.contains("is-active")).toBe(true);
    expect(pill.classList.contains("is-spinning-on")).toBe(true);
  });
});

describe("renderChip", () => {
  it("模型名带平台名前缀（中点分隔）与档位分写两个 span（默认 off → Off）", () => {
    chatSessionStateForTests.aiThinkingLevel = "off";
    const { chip, chipModel, chipLevel, modelPanel } = makeHarness();

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("平台一·m1a");
    expect(chipLevel.textContent).toBe("Off");
    expect(chip.disabled).toBe(false);
  });

  it("平台无名称时只显示模型名，不拼前缀", () => {
    const { chipModel, modelPanel } = makeHarness({ seedProviders: false });
    chatSessionStateForTests.providers = [{ id: "p1", name: "", models: ["solo-model"], enabled: true }];

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("solo-model");
  });

  it("档位 span 随 chatSessionState.aiThinkingLevel（high → High），模型名不动", () => {
    chatSessionStateForTests.aiThinkingLevel = "high";
    const { chipModel, chipLevel, modelPanel } = makeHarness();

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("平台一·m1a");
    expect(chipLevel.textContent).toBe("High");
  });

  it.each([
    ["off", "Off"],
    ["minimal", "Minimal"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Xhigh"],
    ["max", "Max"]
  ] as const)("7 档标签表：%s → %s", (level, label) => {
    chatSessionStateForTests.aiThinkingLevel = level;
    const { chipLevel, modelPanel } = makeHarness();
    modelPanel.renderChip();
    expect(chipLevel.textContent).toBe(label);
  });

  it("档位条派生过显示名：chip 用它（开关型模型显示 On）", () => {
    chatSessionStateForTests.aiThinkingLevel = "low";
    const { chipLevel, thinkingToggle, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(
      view({
        label: "On",
        entries: thinkingPickerEntries({
          availableLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          switchOnly: true,
          requestedLevel: "low",
          effectiveLevel: null
        })
      })
    );

    expect(renderedLabels(thinkingToggle)).toEqual(["Default", "Off", "On"]);
    expect(chipLevel.textContent).toBe("On");
  });

  it("无可用平台时 chip 仍可打开空态，模型名回落占位、档位清空", () => {
    const { chip, chipModel, chipLevel, modelPanel } = makeHarness({ seedProviders: false });
    chatSessionStateForTests.providers = [];

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("未配置平台");
    expect(chipLevel.textContent).toBe("");
    expect(chip.disabled).toBe(false);
  });
});

describe("renderPanel", () => {
  it("按平台分组渲染，当前选中项 is-selected、带 ✓ 并接管焦点", () => {
    const { select, panelList, modelPanel } = makeHarness();
    modelPanel.renderChip();
    select.value = `p1${SEP}m1b`;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    modelPanel.renderPanel();

    const groups = panelList.querySelectorAll(".chat-model-group");
    expect([...groups].map((node) => node.textContent)).toEqual(["平台一", "平台二"]);
    const options = panelList.querySelectorAll(".chat-model-option");
    expect(options).toHaveLength(3);
    const selected = panelList.querySelectorAll(".chat-model-option.is-selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-value")).toBe(`p1${SEP}m1b`);
    expect(selected[0].getAttribute("aria-current")).toBe("true");
    expect(selected[0].querySelector(".chat-model-check")).not.toBe(null);
    expect(document.activeElement).toBe(selected[0]);
  });

  it("点击选项：直接同步 select.value 并持久化（不派发合成冒泡 change），原位换勾且焦点与面板保持稳定", () => {
    const { select, chipModel, panelList, storage, hidePanel, modelPanel } = makeHarness();
    const onBubbledChange = vi.fn();
    select.addEventListener("change", onBubbledChange);

    modelPanel.renderPanel();
    const target = panelList.querySelector<HTMLButtonElement>(`.chat-model-option[data-value="p2${SEP}m2"]`)!;
    click(target);

    expect(select.value).toBe(`p2${SEP}m2`);
    expect(onBubbledChange).not.toHaveBeenCalled();
    expect(chipModel.textContent).toBe("平台二·m2");
    expect(storage.set).toHaveBeenCalledWith({ [SELECTED_PROVIDER_KEY]: `p2${SEP}m2` });
    expect(sendRuntimeMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "save-settings" })
    );
    expect(hidePanel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
    expect(panelList.querySelector(".chat-model-option.is-selected")).toBe(target);
    expect(target.querySelector(".chat-model-check")).not.toBe(null);
    expect(panelList.querySelectorAll(".chat-model-check")).toHaveLength(1);
  });

  it("点击当前已选项：不重复持久化，不关面板", () => {
    const { select, panelList, storage, hidePanel, modelPanel } = makeHarness();

    modelPanel.renderPanel();
    sendRuntimeMessageMock.mockClear();
    storage.set.mockClear();
    const current = panelList.querySelector<HTMLButtonElement>(`.chat-model-option[data-value="p1${SEP}m1a"]`)!;
    click(current);

    expect(select.value).toBe(`p1${SEP}m1a`);
    expect(storage.set).not.toHaveBeenCalled();
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();
    expect(hidePanel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(current);
  });

  it("方向键/Home/End 移动焦点，Enter/Space 选中且不重建当前行", () => {
    const { select, panelList, hidePanel, modelPanel } = makeHarness();
    modelPanel.renderPanel();
    const options = Array.from(panelList.querySelectorAll<HTMLButtonElement>(".chat-model-option"));
    const key = (value: string) => (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })
    );

    expect(document.activeElement).toBe(options[0]);
    key("ArrowDown");
    expect(document.activeElement).toBe(options[1]);
    key("End");
    expect(document.activeElement).toBe(options[2]);
    key("Home");
    expect(document.activeElement).toBe(options[0]);
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    expect(select.value).toBe(`p2${SEP}m2`);
    expect(document.activeElement).toBe(options[2]);
    key("ArrowUp");
    key(" ");
    expect(select.value).toBe(`p1${SEP}m1b`);
    expect(document.activeElement).toBe(options[1]);
    expect(hidePanel).not.toHaveBeenCalled();
  });

  it("无平台空态提供前往设置并隐藏思考强度行", () => {
    const { panelList, thinkingRow, hidePanel, openSettings, modelPanel } = makeHarness({ seedProviders: false });
    chatSessionStateForTests.providers = [];

    modelPanel.renderPanel();

    const settingsBtn = panelList.querySelector<HTMLButtonElement>(".chat-model-empty-settings");
    expect(panelList.querySelector(".chat-model-empty")).not.toBe(null);
    expect(panelList.querySelectorAll(".chat-model-option")).toHaveLength(0);
    expect(thinkingRow.hidden).toBe(true);
    expect(document.activeElement).toBe(settingsBtn);
    click(settingsBtn as HTMLButtonElement);
    expect(hidePanel).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("已有启用平台但 models 为空：chip 与面板显示缺模型文案并可触发前往设置", () => {
    const { chipModel, panelList, openSettings, hidePanel, modelPanel } = makeHarness({ seedProviders: false });
    chatSessionStateForTests.providers = [{ id: "p1", name: "空模型平台", models: [], enabled: true }];

    modelPanel.renderChip();
    expect(chipModel.textContent).toBe("未配置模型");

    modelPanel.renderPanel();
    expect(panelList.querySelector(".chat-model-empty span")?.textContent).toBe("当前平台未配置可用模型");
    const settingsBtn = panelList.querySelector<HTMLButtonElement>(".chat-model-empty-settings")!;
    click(settingsBtn);
    expect(hidePanel).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

describe("chip 宽度度量、面板宽度与 resize rAF 合帧", () => {
  it("canvas 降级下按模型名 + 档位测宽并夹取 [92, 420] 与 .chat-input-bar 60% 上限", () => {
    stubNoCanvas();

    chatSessionStateForTests.providers = [{ id: "p1", name: "", models: ["AI"], enabled: true }];
    chatSessionStateForTests.aiThinkingLevel = "off";
    const shortH = makeHarness({ seedProviders: false });
    shortH.modelPanel.renderChip();
    expect(shortH.chip.style.width).toBe("92px");

    chatSessionStateForTests.providers = [{ id: "p1", name: "", models: ["MODEL"], enabled: true }];
    const hugH = makeHarness({ seedProviders: false });
    hugH.modelPanel.renderChip();
    expect(hugH.chip.style.width).toBe("108px");

    chatSessionStateForTests.providers = [];
    const emptyH = makeHarness({ seedProviders: false });
    emptyH.modelPanel.renderChip();
    expect(emptyH.chip.style.width).toBe("92px");

    chatSessionStateForTests.providers = [{ id: "p1", name: "", models: ["x".repeat(60)], enabled: true }];
    const longH = makeHarness({ seedProviders: false });
    longH.modelPanel.renderChip();
    expect(longH.chip.style.width).toBe("420px");

    const barH = makeHarness({ seedProviders: false, withInputBar: true });
    Object.defineProperty(barH.inputBar!, "clientWidth", { value: 500, configurable: true });
    barH.modelPanel.renderChip();
    expect(barH.chip.style.width).toBe("300px");
  });

  it("面板宽度：打开时按 chip 可见宽夹在 [240, 320]，可见宽为 0 时回落内容度量宽，打开期间不抖动", () => {
    stubNoCanvas();
    const { chip, panel, modelPanel } = makeHarness();

    chip.getBoundingClientRect = () => ({ width: 252.4 } as DOMRect);
    modelPanel.renderPanel();
    expect(panel.style.width).toBe("253px");

    chip.getBoundingClientRect = () => ({ width: 300 } as DOMRect);
    modelPanel.renderThinkingPicker(view({ label: "High", entries: [] }));
    expect(panel.style.width).toBe("253px");

    modelPanel.renderPanel();
    expect(panel.style.width).toBe("300px");

    chip.getBoundingClientRect = () => ({ width: 150 } as DOMRect);
    modelPanel.renderPanel();
    expect(panel.style.width).toBe("240px");

    chip.getBoundingClientRect = () => ({ width: 500 } as DOMRect);
    modelPanel.renderPanel();
    expect(panel.style.width).toBe("320px");

    chip.getBoundingClientRect = () => ({ width: 0 } as DOMRect);
    modelPanel.renderPanel();
    expect(panel.style.width).toBe("240px");
  });

  it("window resize：一帧内多次触发只排一帧 rAF，帧回调才写 chip 宽度", () => {
    stubNoCanvas();
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      nextId += 1;
      pending.set(nextId, cb);
      return nextId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      pending.delete(id);
    });

    chatSessionStateForTests.providers = [{ id: "p1", name: "", models: ["AI"], enabled: true }];
    chatSessionStateForTests.aiThinkingLevel = "off";
    const { chip, modelPanel } = makeHarness({ seedProviders: false });
    modelPanel.renderChip();
    chip.style.width = "";

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));

    expect(pending.size).toBe(1);
    expect(chip.style.width).toBe("");

    [...pending.entries()].forEach(([id, cb]) => {
      pending.delete(id);
      cb(0);
    });
    expect(chip.style.width).toBe("92px");
  });
});

describe("renderThinkingPicker（内联思考强度滑块与 Default ↻ 重置键）", () => {
  const FOUR_LEVELS = {
    availableLevels: ["off", "low", "high", "max"],
    switchOnly: false,
    requestedLevel: "high",
    effectiveLevel: "high"
  } as const;

  it("逐条现渲：首项为 ↻ 重置键（Default），其余为滑轨刻度，只有实发档带 is-active + aria-current", () => {
    const { thinkingToggle, thinkingRowValue, thinkingRow, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] })
      })
    );

    expect(renderedLevels(thinkingToggle)).toEqual(["default", "off", "low", "high", "max"]);
    expect(renderedLabels(thinkingToggle)).toEqual(["Default", "Off", "Low", "High", "Max"]);
    buttons(thinkingToggle).forEach((btn) => {
      const effective = btn.dataset.level === "high";
      expect(btn.classList.contains("is-active"), btn.dataset.level).toBe(effective);
      expect(btn.getAttribute("aria-current"), btn.dataset.level).toBe(effective ? "true" : "false");
      expect(btn.dataset.effective, btn.dataset.level).toBe(effective ? "true" : "false");
      expect(btn.dataset.writes, btn.dataset.level).toBe(effective ? "false" : "true");
    });
    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track");
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb");
    expect(track).not.toBe(null);
    expect(track?.classList.contains("is-sparkle")).toBe(true);
    expect(track?.classList.contains("is-max")).toBe(false);
    expect(thumb?.hidden).toBe(false);
    expect(thinkingRowValue.textContent).toBe("High");
    expect(thinkingRow.hidden).toBe(false);
  });

  it("点非选中项：pickLevel(该档)，面板保持打开（hidePanel 不调用）", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({ label: "High", entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] }) })
    );

    click(buttons(thinkingToggle)[2]);

    expect(pickLevel).toHaveBeenCalledWith("low");
    expect(hidePanel).not.toHaveBeenCalled();
  });

  it("点已经是自己偏好的那一项：不重写偏好（pickLevel 不调用），面板保持打开", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({ label: "High", entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] }) })
    );

    click(buttons(thinkingToggle)[3]);

    expect(pickLevel).not.toHaveBeenCalled();
    expect(hidePanel).not.toHaveBeenCalled();
  });

  it("点生效的实发档而偏好 ≠ 实发：写偏好 + 面板保持打开", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "high" })
      })
    );

    const active = buttons(thinkingToggle).find((btn) => btn.classList.contains("is-active"));
    expect(active?.dataset.level).toBe("high");
    click(active as HTMLButtonElement);

    expect(pickLevel).toHaveBeenCalledWith("high");
    expect(hidePanel).not.toHaveBeenCalled();
  });

  it("三态分支：Default 隐藏滑块圆点；单档渲染胶囊 pill；零档行只剩 Default ↻ 且不渲染滑轨", () => {
    const { thinkingToggle, thinkingRow, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(
      view({
        label: "Default",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "default", effectiveLevel: "default" })
      })
    );
    expect(thinkingToggle.querySelector(".chat-thinking-track")).not.toBe(null);
    expect(thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")?.hidden).toBe(true);
    expect(thinkingToggle.querySelector<HTMLElement>(".chat-thinking-fill")?.style.width).toBe("0px");

    modelPanel.renderThinkingPicker(
      view({
        label: "On",
        entries: thinkingPickerEntries({ availableLevels: ["high"], switchOnly: false, requestedLevel: "high", effectiveLevel: "high" })
      })
    );
    expect(thinkingToggle.querySelector(".chat-thinking-single")).not.toBe(null);
    expect(thinkingToggle.querySelector(".chat-thinking-track")).toBe(null);
    expect(renderedLabels(thinkingToggle)).toEqual(["Default", "On"]);

    modelPanel.renderThinkingPicker(
      view({
        label: "Default",
        entries: thinkingPickerEntries({ availableLevels: [], switchOnly: false, requestedLevel: "default", effectiveLevel: "default" })
      })
    );
    expect(thinkingRow.hidden).toBe(false);
    expect(renderedLevels(thinkingToggle)).toEqual(["default"]);
    expect(thinkingToggle.querySelector(".chat-thinking-track")).toBe(null);
    expect(thinkingToggle.querySelector(".chat-thinking-single")).toBe(null);
  });

  it("星点与最高档渐变：所有非零档（index > 0）带 is-sparkle，仅档位数 ≥ 3 的最右端带 is-max", () => {
    const { thinkingToggle, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(
      view({
        label: "On",
        entries: thinkingPickerEntries({ availableLevels: ["off", "high"], switchOnly: true, requestedLevel: "high", effectiveLevel: "high" })
      })
    );
    const twoTierTrack = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    expect(twoTierTrack.classList.contains("is-sparkle")).toBe(true);
    expect(twoTierTrack.classList.contains("is-max")).toBe(false);

    modelPanel.renderThinkingPicker(
      view({
        label: "Max",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "max", effectiveLevel: "max" })
      })
    );
    const fourTierTrack = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    expect(fourTierTrack.classList.contains("is-sparkle")).toBe(true);
    expect(fourTierTrack.classList.contains("is-max")).toBe(true);
    expect(fourTierTrack.classList.contains("is-ultra-burst")).toBe(true);
  });

  it("Default：aria-valuetext 不冒充实发档，重置键原生 disabled，刻度不进 Tab 顺序", () => {
    const { thinkingToggle, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Default",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "default", effectiveLevel: "default" })
      })
    );

    const reset = thinkingToggle.querySelector<HTMLButtonElement>(".chat-thinking-reset")!;
    expect(reset.disabled).toBe(true);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    expect(thinkingToggle.querySelector(".chat-thinking-track")?.getAttribute("aria-valuetext")).toBe("Default");
    thinkingToggle.querySelectorAll<HTMLButtonElement>(".chat-thinking-tick").forEach((tick) => {
      expect(tick.tabIndex).toBe(-1);
      expect(tick.getAttribute("aria-hidden")).toBe("true");
    });
    click(reset);
    expect(pickLevel).not.toHaveBeenCalled();

    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "high", effectiveLevel: "high" })
      })
    );
    expect(reset.disabled).toBe(false);
  });

  it("滑轨支持指针拖拽与键盘方向键，普通滚轮不改档位", () => {
    const { thinkingToggle, thinkingRowValue, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );

    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    track.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, button: 0, pointerId: 1 }));
    expect(track.hasPointerCapture(1)).toBe(true);
    track.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, pointerId: 1 }));
    expect(thinkingRowValue.textContent).toBe("High");
    track.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 200, pointerId: 1 }));
    expect(pickLevel).toHaveBeenLastCalledWith("high");

    pickLevel.mockClear();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    track.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(pickLevel).not.toHaveBeenCalled();

    track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }));
    expect(pickLevel).toHaveBeenCalledWith("low");
    track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" }));
    expect(pickLevel).toHaveBeenCalledTimes(1);
    track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "End" }));
    expect(pickLevel).toHaveBeenLastCalledWith("max");
  });

  it("pointercancel 回最后提交值：预览文案、滑块、填充与拖拽态都恢复且不落盘", () => {
    const { thinkingToggle, thinkingRowValue, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );
    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")!;
    const fill = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-fill")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    track.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, button: 0, pointerId: 1 }));
    track.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, pointerId: 1 }));
    expect(thinkingRowValue.textContent).toBe("High");
    track.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, clientX: 200, pointerId: 1 }));

    expect(pickLevel).not.toHaveBeenCalled();
    expect(thinkingRowValue.textContent).toBe("Off");
    expect(thumb.style.left).toBe("0%");
    expect(fill.style.width).toBe("0px");
    expect(track.classList.contains("is-dragging")).toBe(false);
  });

  it("空条目：一个按钮都不渲染", () => {
    const { thinkingToggle, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(view({ label: "Off", entries: [] }));

    expect(buttons(thinkingToggle)).toEqual([]);
  });

  it("setPointerCapture 仅吞 NotFoundError / InvalidStateError，非预期异常正常冒泡", () => {
    const { thinkingToggle, thinkingRowValue, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );
    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    for (const name of ["NotFoundError", "InvalidStateError"]) {
      track.setPointerCapture = () => {
        throw new DOMException("expected", name);
      };
      track.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, button: 0, pointerId: 1 }));
      track.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, pointerId: 1 }));
      track.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 100, pointerId: 1 }));
      expect(thinkingRowValue.textContent).toBe("Low");
      expect(pickLevel).toHaveBeenCalledWith("low");
    }

    const errors: unknown[] = [];
    const onWindowError = (event: ErrorEvent) => {
      event.preventDefault();
      errors.push(event.error);
    };
    window.addEventListener("error", onWindowError);
    try {
      track.setPointerCapture = () => {
        throw new TypeError("unexpected capture failure");
      };
      track.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, button: 0, pointerId: 1 }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(TypeError);

      track.setPointerCapture = () => {
        throw new DOMException("wrong dom error", "SecurityError");
      };
      track.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, button: 0, pointerId: 1 }));
      expect(errors).toHaveLength(2);
      expect(errors[1]).toBeInstanceOf(DOMException);
    } finally {
      window.removeEventListener("error", onWindowError);
    }
  });
});

describe("renderThinkingPicker 的底部提示行", () => {
  const HINT_UNAVAILABLE = "当前模型不支持关闭思考";

  it("hint 有文案：显示并写进提示行；同一次调用里档位、思考强度行与 chip 一起落定", () => {
    const { thinkingHint, thinkingToggle, thinkingRowValue, chipLevel, modelPanel } = makeHarness();

    expect(thinkingHint?.hidden).toBe(true);

    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "high" }),
        hint: "当前模型不支持关闭思考，已使用最低档位"
      })
    );

    expect(thinkingHint).not.toBe(null);
    expect(thinkingHint?.hidden).toBe(false);
    expect(thinkingHint?.textContent).toBe("当前模型不支持关闭思考，已使用最低档位");
    expect(renderedLevels(thinkingToggle)).toEqual(["default", "high", "max"]);
    expect(thinkingRowValue.textContent).toBe("High");
    expect(chipLevel.textContent).toBe("High");
  });

  it("hint = null：隐藏并清空上一次的文案", () => {
    const { thinkingHint, modelPanel } = makeHarness();
    const entries = thinkingPickerEntries({ availableLevels: ["off", "low", "high"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" });

    modelPanel.renderThinkingPicker(view({ label: "Off", entries, hint: HINT_UNAVAILABLE }));
    expect(thinkingHint?.hidden).toBe(false);

    modelPanel.renderThinkingPicker(view({ label: "Off", entries }));

    expect(thinkingHint?.hidden).toBe(true);
    expect(thinkingHint?.textContent).toBe("");
  });

  it.each(["omitted", "null"] as const)("不注入提示行元素（%s）：档位与 chip 照画，不抛", (hintMode) => {
    const { thinkingHint, thinkingToggle, thinkingRowValue, chipLevel, modelPanel } = makeHarness({ hintMode });

    expect(thinkingHint).toBe(null);
    expect(() =>
      modelPanel.renderThinkingPicker(
        view({
          label: "Medium",
          entries: thinkingPickerEntries({ availableLevels: ["off", "medium"], switchOnly: false, requestedLevel: "medium", effectiveLevel: "medium" }),
          hint: HINT_UNAVAILABLE
        })
      )
    ).not.toThrow();

    expect(renderedLevels(thinkingToggle)).toEqual(["default", "off", "medium"]);
    expect(thinkingRowValue.textContent).toBe("Medium");
    expect(chipLevel.textContent).toBe("Medium");
  });
});

describe("模型名显示：集合站的 org 前缀只在显示层剥掉", () => {
  function seedNamespacedProviders(): void {
    chatSessionStateForTests.providers = [
      { id: "modelscope", name: "ModelScope", models: ["deepseek-ai/DeepSeek-V4.1-Flash", "Qwen/Qwen3-32B"], enabled: true },
      { id: "siliconflow", name: "硅基流动", models: ["glm-4.6", "org/"], enabled: true }
    ];
  }

  function optionNames(panelList: HTMLElement): string[] {
    return [...panelList.querySelectorAll<HTMLElement>(".chat-model-option-name")].map(
      (node) => node.textContent || ""
    );
  }

  it("chip：命名空间 id 只显示裸名（平台名·裸名，不再带 org/）", () => {
    const { chipModel, modelPanel } = makeHarness({ seedProviders: false });
    seedNamespacedProviders();

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("ModelScope·DeepSeek-V4.1-Flash");
  });

  it("chip：无斜杠裸名与尾斜杠 id 原样显示（不误伤、不剥成空串）", () => {
    const { select, chipModel, modelPanel } = makeHarness({ seedProviders: false });
    seedNamespacedProviders();
    modelPanel.renderChip();

    select.value = `siliconflow${SEP}glm-4.6`;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chipModel.textContent).toBe("硅基流动·glm-4.6");

    select.value = `siliconflow${SEP}org/`;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chipModel.textContent).toBe("硅基流动·org/");
  });

  it("弹层列表条目同样剥前缀，data-value 仍是完整复合值", () => {
    const { panelList, modelPanel } = makeHarness({ seedProviders: false });
    seedNamespacedProviders();

    modelPanel.renderPanel();

    expect(optionNames(panelList)).toEqual(["DeepSeek-V4.1-Flash", "Qwen3-32B", "glm-4.6", "org/"]);
    expect(
      [...panelList.querySelectorAll(".chat-model-option")].map((btn) => btn.getAttribute("data-value"))
    ).toEqual([
      `modelscope${SEP}deepseek-ai/DeepSeek-V4.1-Flash`,
      `modelscope${SEP}Qwen/Qwen3-32B`,
      `siliconflow${SEP}glm-4.6`,
      `siliconflow${SEP}org/`
    ]);
  });

  it("点被剥名的条目：值源与持久化落完整复合值（剥前缀不渗进落盘值）", () => {
    const { select, panelList, storage, modelPanel } = makeHarness({ seedProviders: false });
    seedNamespacedProviders();
    modelPanel.renderPanel();

    const qwen = panelList.querySelector<HTMLButtonElement>(
      `.chat-model-option[data-value="modelscope${SEP}Qwen/Qwen3-32B"]`
    )!;
    click(qwen);

    expect(select.value).toBe(`modelscope${SEP}Qwen/Qwen3-32B`);
    expect(storage.data.get(SELECTED_PROVIDER_KEY)).toBe(`modelscope${SEP}Qwen/Qwen3-32B`);
  });
});
