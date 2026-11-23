import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import { callbackStyleSendMessage } from "../helpers/chrome-runtime-host.js";
import { createMemoryStorageArea, type ChromeHostStorageArea } from "../helpers/memory-storage-area.js";
import type { TestState } from "./reader-test-env.js";

const { gatewayMock, gatewayCoreMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(() => 0),
    fetchHotComments: vi.fn(async () => [])
  },
  gatewayCoreMock: {
    bgFetchJson: vi.fn(),
    isBiliUrl: vi.fn(() => true)
  }
}));

vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

const HINT_LOW_FALLBACK = "当前模型不支持关闭思考，已使用最低档位";

const HINT_CLAMP_HIGH_TO_MEDIUM = "当前模型不支持思考强度 high，已使用 medium";
const HINT_CLAMP_LOW_TO_HIGH = "当前模型不支持思考强度 low，已使用 high";

const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";

interface StubProvider {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  presetId?: string;
}

function provider(overrides: Partial<StubProvider> & { id: string; model: string }): StubProvider {
  return { name: overrides.model, baseUrl: "", enabled: true, ...overrides };
}

let providersPayload: StubProvider[] = [];
let settingsPayload: Record<string, unknown> = {};

type SendStub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: SendStub; connect: SendStub };
    storage: {
      local: ChromeHostStorageArea;
      sync: { set: SendStub };
      onChanged: { addListener: SendStub; removeListener: SendStub };
    };
  };
  chromeStub.runtime.sendMessage = callbackStyleSendMessage({
    "ai-providers-list": () => ({ ok: true, providers: providersPayload }),
    "get-settings": () => ({ ok: true, settings: settingsPayload })
  });
  chromeStub.runtime.connect = vi.fn(() => ({
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (_fn: (msg: unknown) => void) => {} },
    onDisconnect: { addListener: (_fn: () => void) => {} }
  }));
  chromeStub.storage.local = createMemoryStorageArea();
  chromeStub.storage.sync.set = vi.fn(async () => {});
}

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");
let modelOptionValue: typeof import("../../extension/reader/chat-model-panel.js").buildModelOptionValue;
let THINKING_LEVEL_KEY: typeof import("../../extension/reader/chat-model-panel.js").THINKING_LEVEL_KEY;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;

async function loadShell() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  const modelPanelMod = await import("../../extension/reader/chat-model-panel.js");
  modelOptionValue = modelPanelMod.buildModelOptionValue;
  THINKING_LEVEL_KEY = modelPanelMod.THINKING_LEVEL_KEY;
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  const uiRenderer = await import("../../extension/ui/ui-renderer.js");
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
}

function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  providersPayload = [];
  settingsPayload = {};
  await loadShell();
  stubChromeByType();
  seedReadyContext();
  statusBus.publishSubtitleStatusPhase("idle");
});

async function activateChatTab() {
  const chat = await lazyChat.ensureReaderChatTab();
  await chat.ensureChatTabActivated();
  return chat;
}

function getHint(): HTMLElement {
  return document.getElementById(ids.readingChatThinkingHint) as HTMLElement;
}

function selectModel(providerId: string, model: string): void {
  const panel = document.getElementById(ids.readingChatModelPanel) as HTMLElement;
  if (panel.hidden) {
    click(document.getElementById(ids.readingChatModelChip) as HTMLButtonElement);
  }
  const value = modelOptionValue(providerId, model);
  const option = [...document.querySelectorAll<HTMLButtonElement>(`#${ids.readingChatModelList} .chat-model-option`)].find(
    (btn) => btn.getAttribute("data-value") === value
  );
  expect(option, `模型选项 ${value} 不存在`).toBeTruthy();
  click(option!);
}

function getThinkingBtn(level: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `#${ids.readingChatThinkingToggle} .chat-thinking-btn[data-level="${level}"]`
  );
}

function requireThinkingBtn(level: string): HTMLButtonElement {
  const btn = getThinkingBtn(level);
  expect(btn, `档位条目 ${level} 不存在`).not.toBe(null);
  return btn as HTMLButtonElement;
}

function renderedThinkingLevels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn`)].map(
    (btn) => btn.dataset.level || ""
  );
}

function renderedThinkingLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn-label`)].map(
    (node) => node.textContent || ""
  );
}

function effectiveThinkingLevels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn.is-active`)].map(
    (btn) => btn.dataset.level || ""
  );
}

function clickThinking(level: string): void {
  click(requireThinkingBtn(level));
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function thinkingRow(): HTMLButtonElement {
  return document.getElementById(ids.readingChatThinkingRow) as HTMLButtonElement;
}

function chipLevelText(): string {
  const node = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement | null;
  return node?.textContent || "";
}

function levelRowValueText(): string {
  const node = document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement | null;
  return node?.textContent || "";
}

describe("口径 ③/⑤ 统一：偏好 ≠ 实发档 → 一级行/chip/勾都落在实发档（走查 + 工件）", () => {
  it("clamp 格（qwen3.8-max）与 off 关不掉格（sensenova/glm-5.2）逐行对齐，偏好不迁移", async () => {
    providersPayload = [
      provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" }),
      provider({ id: "p2", model: "glm-5.2", baseUrl: SENSENOVA_BASE_URL, presetId: "sensenova" })
    ];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    const steps: string[] = [];
    function snap(label: string): void {
      steps.push(
        [
          label,
          `偏好=${chatSessionState.aiThinkingLevel}`,
          `条目=[${renderedThinkingLevels().join(",")}]`,
          `显示名=[${renderedThinkingLabels().join(",")}]`,
          `勾=[${effectiveThinkingLevels().join(",")}]`,
          `chip=${chipLevelText()}`,
          `一级行=${levelRowValueText()}`,
          `提示=${getHint().hidden ? "-" : getHint().textContent}`
        ].join(" | ")
      );
    }

    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "medium", "xhigh"]);
    expect(effectiveThinkingLevels()).toEqual(["medium"]);
    expect(chipLevelText()).toBe("Medium");
    expect(levelRowValueText()).toBe("Medium");
    expect(getHint().textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
    snap("1 qwen/qwen3.8-max（偏好 high → 实发 medium）");

    clickThinking("medium");
    expect(chatSessionState.aiThinkingLevel).toBe("medium");
    expect(chipLevelText()).toBe("Medium");
    expect(getHint().hidden).toBe(true);
    snap("2 qwen/qwen3.8-max（点勾住的 medium → 偏好落盘 medium）");

    clickThinking("off");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevelText()).toBe("Off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);
    snap("3 qwen/qwen3.8-max（偏好落盘 off）");

    selectModel("p2", "glm-5.2");
    expect(renderedThinkingLevels()).toEqual(["default", "high", "max"]);
    expect(effectiveThinkingLevels()).toEqual(["high"]);
    expect(chipLevelText()).toBe("High");
    expect(levelRowValueText()).toBe("High");
    expect(getHint().textContent).toBe(HINT_LOW_FALLBACK);
    snap("4 sensenova/glm-5.2（偏好 off → 实发 high）");

    selectModel("p1", "qwen3.8-max");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevelText()).toBe("Off");
    expect(getHint().hidden).toBe(true);
    snap("5 qwen/qwen3.8-max（偏好仍 off，未被 ④ 迁移）");

    selectModel("p2", "glm-5.2");
    clickThinking("high");
    expect(chatSessionState.aiThinkingLevel).toBe("high");
    expect(chipLevelText()).toBe("High");
    expect(effectiveThinkingLevels()).toEqual(["high"]);
    expect(getHint().hidden).toBe(true);
    snap("6 sensenova/glm-5.2（点勾住的 high → 偏好落盘 high，提示收起）");

    expect(steps).toHaveLength(6);

    const artifactDir = join(process.cwd(), ".scratch", "tickets", "chat-thinking-submenu", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "05-showing-effective-level.txt"),
      [
        "# 显示口径统一 + 勾语义走查工件（由 tests/reader/chat-tab-thinking-hint.test.ts 生成）",
        "# 用例：偏好 ≠ 实发档的两格（档位型 clamp / off 关不掉）逐行看 chip、一级行、列表的勾、提示，",
        "#       并各走一遍「点勾」语义（点勾住的实发档 = 把该档写成偏好，提示随之收起）",
        "# 判据：chip 与一级行写实发档（Medium / High）、勾也落在实发档（列 =「勾」）、",
        "#       提示句式同为「当前模型不支持思考强度 X，已使用 Y」、",
        "#       切模型不迁移偏好（换回原模型回落 off）、点勾住的实发档 → 偏好落盘该档 + 提示收起（2026-10-05 裁定 B）",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});

describe("档位 chip 集合：按模型可用集渲染（06 号票）", () => {
  const OLLAMA_URL = "http://localhost:11434/v1";
  const MINIMAX_URL = "https://api.minimaxi.com/v1";
  const OPENCODEGO_URL = "https://opencode.ai/zen/go/v1";
  const SENSENOVA_URL = "https://token.sensenova.cn/v1";
  const OPENROUTER_URL = "https://openrouter.ai/api/v1";

  it("激活前模板不给静态档位按钮：档位容器为空、思考强度区 hidden（显示名由组合根派生）", async () => {
    expect(renderedThinkingLevels()).toEqual([]);
    expect(thinkingRow().hidden).toBe(true);
  });

  it("上游逐模型词表：deepseek-v4-pro → {off, low, high, max}（不存在的档不现渲）", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high", "max"]);
    expect(getThinkingBtn("minimal")).toBe(null);
    expect(getThinkingBtn("medium")).toBe(null);
  });

  it("上游只有 toggle 的词表：zhipu/glm-4.6 → 收成 Off/On（非 off 域发的是同一个「开」写点）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "Off", "On"]);
  });

  it("minimax-m3：开关型（2026-10-05 登记形状后）→ 收成 Default/Off/On；偏好 off 不再报「关不掉」", async () => {
    providersPayload = [provider({ id: "p1", model: "MiniMax-M3", baseUrl: MINIMAX_URL, presetId: "minimax" })];
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "Off", "On"]);
    expect(getHint().hidden).toBe(true);
  });

  it("未登记词表且借不到（custom 自填端点）：不现渲任何档位，只保留「关不掉/不发参」说明", async () => {
    providersPayload = [provider({ id: "p1", model: "vendor-future-1", baseUrl: "https://api.example.com/v1", presetId: "custom" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default"]);
    expect(getHint().hidden).toBe(true);
  });

  it("无上游平台（ollama）：仍显示今日三档", async () => {
    providersPayload = [provider({ id: "p1", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high"]);
  });

  it("high/max 类（sensenova/glm-5.2）：条目 = {high,max}；偏好 low 向上落 high（提示逐字）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" })];
    settingsPayload = { aiThinkingLevel: "low" };

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "high", "max"]);
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe(HINT_CLAMP_LOW_TO_HIGH);
    expect(renderedThinkingLabels()).toEqual(["Default", "High", "Max"]);
    expect(getThinkingBtn("low")).toBe(null);
  });

  it("偏好 off 且关不掉（sensenova/glm-5.2 → 级联发 high）：一级行 High、勾在 high、长文案在场", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" }),
      provider({ id: "p2", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })
    ];
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    const chipLevel = () =>
      (document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement).textContent;
    expect(renderedThinkingLevels()).toEqual(["default", "high", "max"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "High", "Max"]);
    expect(effectiveThinkingLevels()).toEqual(["high"]);
    expect(chipLevel()).toBe("High");
    expect((document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement).textContent).toBe("High");
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe(HINT_LOW_FALLBACK);

    selectModel("p2", "deepseek-v4-pro");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevel()).toBe("Off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);

    selectModel("p1", "glm-5.2");
    expect(chipLevel()).toBe("High");
    clickThinking("high");
    expect(chatSessionState.aiThinkingLevel).toBe("high");
    expect(effectiveThinkingLevels()).toEqual(["high"]);
    expect(chipLevel()).toBe("High");
    expect(getHint().hidden).toBe(true);
  });

  it("18 号票：上游 none-high 的托管行仍可关思考（opencodego/hy4-preview：条目 = {off,high}，那一档叫 On）", async () => {
    providersPayload = [provider({ id: "p1", model: "hy4-preview", baseUrl: OPENCODEGO_URL, presetId: "opencodego" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "Off", "On"]);
    expect(getHint().hidden).toBe(true);
  });

  it("clamp 掉的偏好不做成禁用条目：qwen3.8-max + high → High 不存在（无 active、无 disabled），文案在场", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" })];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "medium", "xhigh"]);
    expect(getThinkingBtn("high")).toBe(null);
    expect(effectiveThinkingLevels()).toEqual(["medium"]);
    expect(getHint().textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
    expect(chipLevelText()).toBe("Medium");
  });

  it("模型切换即重渲条目：开关型（2 项）→ 三档模型 → 空集模型 → 切回", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" }),
      provider({ id: "p2", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" }),
      provider({ id: "p3", model: "anthropic/claude-haiku-4.5", baseUrl: OPENROUTER_URL, presetId: "openrouter" })
    ];

    await activateChatTab();
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);

    selectModel("p2", "llama3.2");
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high"]);

    selectModel("p3", "anthropic/claude-haiku-4.5");
    expect(renderedThinkingLevels()).toEqual(["default"]);
    expect(thinkingRow().hidden).toBe(false);

    selectModel("p1", "glm-4.6");
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);
    expect(thinkingRow().hidden).toBe(false);
  });

  it("点击条目仍走既有持久化链：切换档位后 chip 文案与 active 同步", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

    await activateChatTab();
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high", "max"]);

    clickThinking("max");

    expect(requireThinkingBtn("max").classList.contains("is-active")).toBe(true);
    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    expect(chipLevel.textContent).toBe("Max");
  });
});

describe("内联思考强度滑块端到端走查", () => {
  it("开面板 → 选档落盘 → 换模型保持打开并按新模型重算思考区", async () => {
    providersPayload = [
      provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" }),
      provider({ id: "p2", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" })
    ];

    await activateChatTab();

    const panel = document.getElementById(ids.readingChatModelPanel) as HTMLElement;
    const chip = document.getElementById(ids.readingChatModelChip) as HTMLButtonElement;
    const list = document.getElementById(ids.readingChatModelList) as HTMLElement;
    const row = thinkingRow();
    const hint = getHint();
    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    const storageSet = (window.chrome as unknown as { storage: { local: { set: SendStub } } }).storage.local.set;

    const steps: string[] = [];
    function snap(label: string): void {
      steps.push(
        [
          label,
          `面板=${panel.hidden ? "关" : "开"}`,
          `模型列表=${list.hidden ? "隐" : "显"}`,
          `思考区=${row.hidden ? "隐" : "显"}`,
          `条目=[${renderedThinkingLevels().join(",")}]`,
          `勾=[${effectiveThinkingLevels().join(",")}]`,
          `chip=${chipLevel.textContent}`,
          `偏好=${chatSessionState.aiThinkingLevel}`,
          `提示=${hint.hidden ? "-" : hint.textContent}`
        ].join(" | ")
      );
    }

    expect(panel.hidden).toBe(true);
    expect(chip.getAttribute("aria-haspopup")).toBe("true");
    expect(chip.getAttribute("aria-controls")).toBe(ids.readingChatModelPanel);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    snap("0 激活后");

    click(chip);
    expect(panel.hidden).toBe(false);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);
    expect(row.hidden).toBe(false);
    expect(document.activeElement).toBe(list.querySelector(".chat-model-option.is-selected"));
    snap("1 点 chip 开面板");

    storageSet.mockClear();
    clickThinking("max");
    expect(chatSessionState.aiThinkingLevel).toBe("max");
    expect(storageSet).toHaveBeenCalledWith({ [THINKING_LEVEL_KEY]: "max" });
    expect(chipLevel.textContent).toBe("Max");
    expect((document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement).textContent).toBe("Max");
    expect(panel.hidden).toBe(false);
    expect(requireThinkingBtn("max").classList.contains("is-active")).toBe(true);
    snap("2 点 Max 选档（面板保持打开）");

    const nextModelOption = list.querySelectorAll<HTMLButtonElement>(".chat-model-option")[1];
    click(nextModelOption);
    expect(panel.hidden).toBe(false);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chatSessionState.selectedModelValue).toBe(modelOptionValue("p2", "qwen3.8-max"));
    expect(document.activeElement).toBe(nextModelOption);
    expect(list.querySelector(".chat-model-option.is-selected")).toBe(nextModelOption);
    expect(chipLevel.textContent).toBe("Xhigh");
    expect((document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement).textContent).toBe("Xhigh");
    expect(effectiveThinkingLevels()).toEqual(["xhigh"]);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("当前模型不支持思考强度 max，已使用 xhigh");
    snap("3 换模型（保持打开并 clamp 到 xhigh）");

    expect(steps).toHaveLength(4);
  });
});

describe("D1=A2 本仓补声明端到端走查（glm-5.2 的 Off 由平台形状决定）", () => {
  const OPENROUTER_URL = "https://openrouter.ai/api/v1";
  const OPENCODEGO_URL = "https://opencode.ai/zen/go/v1";
  const SENSENOVA_URL = "https://token.sensenova.cn/v1";

  it("zhipu / qwen 真多出 Off 且能落盘；未登记开关形状的三家逐字节不变；glm-5.2-air 与目录内同出口", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-5.2", baseUrl: GLM_BASE_URL, presetId: "zhipu" }),
      provider({ id: "p2", model: "glm-5.2", baseUrl: QWEN_BASE_URL, presetId: "qwen" }),
      provider({ id: "p3", model: "z-ai/glm-5.2", baseUrl: OPENROUTER_URL, presetId: "openrouter" }),
      provider({ id: "p4", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" }),
      provider({ id: "p5", model: "glm-5.2", baseUrl: OPENCODEGO_URL, presetId: "opencodego" }),
      provider({ id: "p6", model: "glm-5.2-air", baseUrl: GLM_BASE_URL, presetId: "zhipu" })
    ];
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    const steps: string[] = [];
    function snap(label: string): void {
      steps.push(
        [
          label,
          `条目=[${renderedThinkingLevels().join(",")}]`,
          `显示名=[${renderedThinkingLabels().join(",")}]`,
          `勾=[${effectiveThinkingLevels().join(",")}]`,
          `chip=${chipLevel.textContent}`,
          `提示=${getHint().hidden ? "-" : getHint().textContent}`
        ].join(" | ")
      );
    }

    expect(renderedThinkingLevels()).toEqual(["default", "off", "high", "max"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "Off", "High", "Max"]);
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);
    snap("1 zhipu/glm-5.2（目录内·原生）");

    clickThinking("max");
    expect(effectiveThinkingLevels()).toEqual(["max"]);
    expect(chatSessionState.aiThinkingLevel).toBe("max");
    expect(chipLevel.textContent).toBe("Max");
    clickThinking("off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevel.textContent).toBe("Off");

    selectModel("p2", "glm-5.2");
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high", "max"]);
    expect(getHint().hidden).toBe(true);
    snap("2 qwen/glm-5.2（托管·借词）");

    const unregistered: ReadonlyArray<[providerId: string, label: string, model: string]> = [
      ["p3", "openrouter/z-ai/glm-5.2", "z-ai/glm-5.2"],
      ["p4", "sensenova/glm-5.2", "glm-5.2"],
      ["p5", "opencodego/glm-5.2", "glm-5.2"]
    ];
    for (const [index, [providerId, label, model]] of unregistered.entries()) {
      selectModel(providerId, model);
      expect(renderedThinkingLevels(), label).toEqual(["default", "high", "max"]);
      expect(effectiveThinkingLevels(), label).toEqual(["high"]);
      expect(chipLevel.textContent, label).toBe("High");
      expect(getHint().hidden, label).toBe(false);
      expect(getHint().textContent, label).toBe(HINT_LOW_FALLBACK);
      snap(`${3 + index} ${label}（平台形状未登记）`);
    }

    selectModel("p6", "glm-5.2-air");
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high"]);
    expect(getHint().hidden).toBe(true);
    expect(chipLevel.textContent).toBe("Off");
    snap("6 zhipu/glm-5.2-air（目录外兜底）");

    expect(steps).toHaveLength(6);

    const artifactDir = join(process.cwd(), ".scratch", "tickets", "upstream-glm52-toggle", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "05-e2e-glm52-off.txt"),
      [
        "# D1=A2 端到端走查工件（由 tests/reader/chat-tab-thinking-hint.test.ts 生成）",
        "# 用例：6 行本地 glm-5.2（5 行目录内 + glm-5.2-air 兜底），偏好 off，逐行看档位条目与提示",
        "# 判据：zhipu / qwen 多出 Off（静默）；openrouter / sensenova / opencodego 的条目与提示不变（长版提示），",
        "#       一级行/chip/勾按口径 ③/⑤（2026-10-05 复审 + 裁定 B）都落在实发档 High——线上发 high，界面不再写 Off",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});

describe("default（不干预）档端到端走查：出厂默认与零档行", () => {
  const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
  const ZERO_TIER_MODEL = "anthropic/claude-haiku-4.5";

  it("出厂默认 = Default（chip/一级行/打勾），点 Off 落到 off、点回 Default 复位；零档行只剩 Default 也能主动选", async () => {
    providersPayload = [
      provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" }),
      provider({ id: "p2", model: ZERO_TIER_MODEL, baseUrl: OPENROUTER_BASE_URL, presetId: "openrouter" })
    ];
    settingsPayload = {};

    await activateChatTab();

    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    const thinkingRowValue = document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement;
    const steps: string[] = [];
    function snap(label: string): void {
      steps.push(
        [
          label,
          `偏好=${chatSessionState.aiThinkingLevel}`,
          `条目=[${renderedThinkingLevels().join(",")}]`,
          `勾=[${effectiveThinkingLevels().join(",")}]`,
          `chip=${chipLevel.textContent}`,
          `一级行=${thinkingRowValue.textContent}`,
          `提示=${getHint().hidden ? "-" : getHint().textContent}`
        ].join(" | ")
      );
    }

    expect(chatSessionState.aiThinkingLevel).toBe("default");
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high", "max"]);
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(chipLevel.textContent).toBe("Default");
    expect(thinkingRowValue.textContent).toBe("Default");
    expect(getHint().hidden).toBe(true);
    snap("1 deepseek/deepseek-v4-pro（出厂默认 = Default）");

    clickThinking("off");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(chipLevel.textContent).toBe("Off");
    snap("2 点 Off（显式关思考）");

    clickThinking("default");
    expect(chatSessionState.aiThinkingLevel).toBe("default");
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(chipLevel.textContent).toBe("Default");
    snap("3 点回 Default（不干预）");

    selectModel("p2", ZERO_TIER_MODEL);
    expect(renderedThinkingLevels()).toEqual(["default"]);
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(thinkingRow().hidden).toBe(false);
    expect(chipLevel.textContent).toBe("Default");
    expect(getHint().hidden).toBe(true);
    snap(`4 openrouter/${ZERO_TIER_MODEL}（零档行，偏好 default）`);

    selectModel("p1", "deepseek-v4-pro");
    clickThinking("high");
    expect(chatSessionState.aiThinkingLevel).toBe("high");
    selectModel("p2", ZERO_TIER_MODEL);
    expect(chipLevel.textContent).toBe("Default");
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe("当前模型不支持思考强度 high，已使用 default");
    snap(`5 openrouter/${ZERO_TIER_MODEL}（零档行，偏好 high）`);

    const artifactDir = join(process.cwd(), ".scratch", "tickets", "thinking-default-level", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "02-e2e-default-level.txt"),
      [
        "# default（不干预）档端到端走查工件（由 tests/reader/chat-tab-thinking-hint.test.ts 生成）",
        "# 用例：出厂默认（无 aiThinkingLevel 落盘）→ 点 Off → 点回 Default；再切到零档行模型（budget-only 的 openrouter 行）",
        "# 判据：一级行/chip 写实发档（default 时写 Default）；列表的勾 = 实发档（口径 ⑤，2026-10-05 裁定 B：",
        "#       零档行 + 强度档偏好时勾落在 Default）；",
        "#       零档行只剩 Default 一项且一级行照旧显示（用户裁定「破例 = 能主动选」）；",
        "#       零档行 + 强度档偏好 → 实发 default + 提示「当前模型不支持思考强度 high，已使用 default」",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});
