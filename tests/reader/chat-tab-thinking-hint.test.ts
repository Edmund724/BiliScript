// tests/reader/chat-tab-thinking-hint.test.ts
// 2026-10-05 由 `tests/reader/chat-thinking-hint.test.ts` 改名：被测函数是
// `extension/reader/chat-tab.ts` 的 `updateThinkingHint`，仓内没有
// `extension/reader/chat-thinking-hint.ts`（`chat-thinking-hint` 只是模板上的 CSS
// class，见 extension/reader/chat-template.ts:125）。原文件名沿用了票面里的一个
// 不存在的路径，是上游-模型-facts 审计 §10-3 的订正项。
//
// 工单 03「对话 Off 关不掉思考」提示行的 UI 回归测试（tests/reader/chat-tab.test.ts
// 的姊妹篇）：真实模板（ensureUiReady）+ 懒装载组合根，全部用真实 DOM 事件驱动
//（modelSelect change / 档位按钮 click），不直调组合根内部函数——「档位区只由
// chat-tab.ts 的 refreshThinkingUi 消费 resolver 判定结果驱动」正是本文件的
// 守护意图（激活前模板默认 hidden 即其黑盒佐证）；resolver 本体（识别优先级/
// 级联/offFallback 语义）是纯函数守护，已由 tests/ai/thinking-profiles.test.ts
// 锁定，本文件不重复。
//
// 覆盖（工单 AC）：
// - 档位 Off + 关不掉模型：级联落 low（glm-5.3）→ 长文案；
//   无 low 可落（kimi-k2.7-code，baseUrl 空）→ 短文案；两条文案与工单逐字一致；
// - 13 号票 canonical 优先：kimi-k3 的模型侧词表（canonical = moonshotai/kimi-k3）没有
//   toggle → off 关不掉 → 长文案（04 号票的「off 可用 → 静默」角色由 glm-4.6 承担）；
// - never 模型（kimi-k2-instruct / deepseek-chat）与 off 正常可用模型（glm-4.6）
//   选 Off 均静默无提示；
// - 实时刷新：模型 change 切回可关模型提示消失、切回再现；档位 Off→Low 收起、
//   回 Off（关不掉模型经可关模型转回）再现；
// - 05 号票：偏好档位被 clamp 时的说明文本（逐字）；
// - 06 号票：档位条目 = 模型可用集（只现渲存在的档位、不置灰；minimax-m3
//   一个条目都不显示；无上游平台仍三档；clamp 掉的偏好走说明文本）；
// - 2026-10-05 用户裁定（票据 chat-thinking-submenu）：档位区是二级菜单——底部
//   一行「思考强度 <当前值> ›」换页到档位列表，开关型模型（rule.on）收成 Off/On，
//   chip 与一级行显示同一个显示名；文件末的走查用例同时产出可复现工件。
// - 口径 ③（2026-10-05 复审裁定）：偏好 off 而该模型关不掉时，chip 与一级行显示**实发档**
//   （如 sensenova/glm-5.2 → High），不再显示线上没发的 Off；偏好本身不迁移。
//
// 模型选型依据（extension/ai/thinking-profiles.ts 表 + 02 产物指派表，勿凭记忆）：
// - kimi-k2.7-code → EXCEPTIONS kimi-always：always 且无 low/on → offUnavailable
//   + offFallback:null（短文案）；taxonomy 按模型名命中，baseUrl 刻意留空；
// - glm-5.3 → 04 号票翻转后走上游指派表（值集 low-high-max：有档位、关不掉）→
//   offUnavailable + offFallback:"low"（长文案）；baseUrl 取 GLM preset host
//   （core/presets.ts），顺带覆盖 resolver 的 host 推断识别路径。
//   04 号票之前这个角色由 kimi-k3 担任（旧手写结论 kimi-k3-effort：always + effort）；
//   04 号票翻转后 kimi-k3 的 off 可用了，长文案覆盖由 glm-5.3 接棒；13 号票的 canonical
//   优先又让 kimi-k3 回到「关不掉」（见下一条），两条用例各覆盖一个语义。
// - kimi-k3 → 13 号票 canonical 优先后走上游指派表（值集 low-high-max：无 toggle → 关不掉，
//   长文案）；baseUrl 取 Kimi preset host（host 推断路径不回归）。04 号票时它是
//   toggle+low-high-max（off 可用），该事实已被 canonical 覆盖。
// - kimi-k2-instruct → TAXONOMY kimi-instruct-never（"kimi-k2-" 前缀）、
//   deepseek-chat → TAXONOMY deepseek-chat-never：never → off 天然成立，静默；
// - glm-4.6 → 上游指派表（zhipuai，值集 toggle）：off 正常可用 → offUnavailable:false。
//
// 模块纪元注意（与 chat-tab.test.ts 同款）：chatSessionState 与组合根闭包都是
// 模块级单例，beforeEach resetModules 后同纪元导入；chrome.storage / runtime
// 消息按 type 路由 stub（ai-providers-list 载荷带 baseUrl/model——提示判定的
// 识别入参与 updateThinkingHint 读的 chatSessionState.providers 同源）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
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

// 热评/网络路径与本文件无关（提示判定不触网）：mock 保持确定性，防止 init 的
// 上下文链路意外走网络（与 chat-tab.test.ts 同款）。
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

// 文案逐字给定（工单 03，勿改写）——断言也逐字。
const HINT_LOW_FALLBACK = "当前模型不支持在本次请求中关闭思考，已使用最小思考档位";
const HINT_UNAVAILABLE = "当前模型没办法关掉思考";

// 05 号票（决策 #8）：偏好档位被模型词表 clamp 掉时的说明文本（源档 → 实发档）。
// 2026-10-05 复审裁定：句式与「关不掉思考」那句对齐，不附原因 → 断言也逐字。
const HINT_CLAMP_HIGH_TO_MEDIUM = "当前模型不支持思考强度 high，已使用 medium";
const HINT_CLAMP_XHIGH_TO_HIGH = "当前模型不支持思考强度 xhigh，已使用 high";
// 06 号票（2026-10-04 用户裁定：A' = 上游词表 ∩ 平台可表达）：平台声明里有 low、上游
// 词表没有 → 原因层是「模型词表」。13 号票 canonical 优先后 sensenova/glm-5.2 的模型侧
// 词表只剩 high（canonical = high-max），偏好 low 没有 ≤ low 的档 → 向上落最小可用档 high。
const HINT_CLAMP_LOW_TO_HIGH = "当前模型不支持思考强度 low，已使用 high";

// Kimi/GLM preset host（core/presets.ts）：resolver host 推断的输入形状。
const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";

// ai-providers-list 载荷条目（providers.ts 显式映射进 chatSessionState.providers
// 的形状：id 必填，model/baseUrl 走字符串收窄）。
interface StubProvider {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  // 平台识别主路径（06 号票 chip 用例：ollama 这类无上游平台靠它命中 PROVIDERS）；
  // providers.ts 的显式映射原样透传 presetId。
  presetId?: string;
}

// 平台载荷工厂：model/baseUrl 即 resolver 的识别入参；name 缺省取 model
//（providers.ts 渲染选项文案的同源回退）。
function provider(overrides: Partial<StubProvider> & { id: string; model: string }): StubProvider {
  return { name: overrides.model, baseUrl: "", enabled: true, ...overrides };
}

// 每用例替换的 ai-providers-list 载荷（stub 的 sendMessage 闭包按引用读取）。
let providersPayload: StubProvider[] = [];
// 每用例替换的 get-settings 载荷（05 号票：档位偏好由它进来；缺省 {} = off）。
let settingsPayload: Record<string, unknown> = {};

type SendStub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: SendStub; connect: SendStub };
    storage: {
      local: { get: SendStub; set: SendStub };
      sync: { set: SendStub };
      onChanged: { addListener: SendStub; removeListener: SendStub };
    };
  };
  chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
    const type = String(message?.type || "");
    if (type === "ai-providers-list") {
      callback?.({ ok: true, providers: providersPayload });
    } else if (type === "get-settings") {
      // 无设置回落：aiThinkingLevel 归一化到默认 off（档位测试的前置态）。
      callback?.({ ok: true, settings: settingsPayload });
    } else {
      callback?.({ ok: true });
    }
    return undefined;
  });
  chromeStub.runtime.connect = vi.fn(() => ({
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (_fn: (msg: unknown) => void) => {} },
    onDisconnect: { addListener: (_fn: () => void) => {} }
  }));
  chromeStub.storage.local.get = vi.fn(async () => ({}));
  chromeStub.storage.local.set = vi.fn(async () => {});
  chromeStub.storage.sync.set = vi.fn(async () => {});
}

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");
// 复合选项值编码单源（multi-model-catalog）：modelSelect 选项值为
// 「平台 id\u0001模型 id」，测试里切模型须用与渲染相同的编码。
let modelOptionValue: typeof import("../../extension/chat/providers.js").buildModelOptionValue;
// 档位偏好的 storage 键（写点断言用；单源在 providers.ts）。
let THINKING_LEVEL_KEY: typeof import("../../extension/chat/providers.js").THINKING_LEVEL_KEY;
// 全局偏好档位（chip 显示名与落盘状态的同一处读点）。
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;

async function loadShell() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  const providers = await import("../../extension/chat/providers.js");
  modelOptionValue = providers.buildModelOptionValue;
  THINKING_LEVEL_KEY = providers.THINKING_LEVEL_KEY;
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  const uiRenderer = await import("../../extension/ui/ui-renderer.js");
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
}

// 字幕就绪上下文：init 的 loadContextState 走进程内直读（不触网），提示判定
// 与上下文无关，但让 init 全链路按正常路径落定。
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

// 装载组合根并走完 init（loadProvidersAndPrefs 之后的 updateThinkingHint 首判
// 在此落定），之后所有显隐变化都由 DOM 事件驱动。
async function activateChatTab() {
  const chat = await lazyChat.ensureReaderChatTab();
  await chat.ensureChatTabActivated();
  return chat;
}

function getHint(): HTMLElement {
  return document.getElementById(ids.readingChatThinkingHint) as HTMLElement;
}

function getModelSelect(): HTMLSelectElement {
  return document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
}

// 档位条目（2026-10-05 起现渲：只存在可用集的条目，没有「隐藏的档位」这回事——
// 不存在即 null，这正是「只显示实际存在的档位」的机械证据）。
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

// 当前档位页里现渲的条目档位值（顺序即渲染顺序）。
function renderedThinkingLevels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn`)].map(
    (btn) => btn.dataset.level || ""
  );
}

// 条目显示名（开关型那一项是 On）。
function renderedThinkingLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn-label`)].map(
    (node) => node.textContent || ""
  );
}

function activeThinkingLevels(): string[] {
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

// chip 上的档位字与一级行右侧的值（口径 ③：两处同源显示，偏好 ≠ 实发时写实发档）。
function chipLevelText(): string {
  const node = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement | null;
  return node?.textContent || "";
}

function levelRowValueText(): string {
  const node = document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement | null;
  return node?.textContent || "";
}

describe("Off + 关不掉模型：resolver 判定 → 档位区提示（文案逐字）", () => {
  it("无 low 可落 → 短文案：baseUrl 空 + kimi-k2.7-code（激活前模板默认 hidden，提示只由组合根驱动）", async () => {
    providersPayload = [provider({ id: "p1", model: "kimi-k2.7-code" })];

    // 激活前：壳已建但组合根未装载，提示行保持模板默认 hidden + 空文案。
    expect(getHint().hidden).toBe(true);
    expect(getHint().textContent).toBe("");

    await activateChatTab();

    const hint = getHint();
    expect(hint.classList.contains("chat-thinking-hint")).toBe(true);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);
    // 该模型一个档位写点都没有（可用集空）→ 档位页一个条目都不现渲，一级行整行隐藏
    //（没有可选的东西）。原先模板那 7 个「隐藏但仍在」的静态 chip 已随二级菜单退役。
    expect(renderedThinkingLevels()).toEqual([]);
    expect(thinkingRow().hidden).toBe(true);
  });

  it("级联落 low → 长文案：GLM host 推断 + glm-5.3（04 号票翻转后 offFallback:\"low\"）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-5.3", baseUrl: GLM_BASE_URL })];

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);
  });

  it("13 号票 canonical 优先：kimi-k3 的模型侧词表无 toggle（off 关不掉）→ 选 Off 走长文案", async () => {
    providersPayload = [provider({ id: "p1", model: "kimi-k3", baseUrl: KIMI_BASE_URL })];

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);
  });
});

describe("静默分支：never 模型与 off 正常可用模型均无提示", () => {
  it("never（kimi-k2-instruct / deepseek-chat）与 off 可关（glm-4.6）选 Off 均保持 hidden", async () => {
    providersPayload = [
      provider({ id: "p1", model: "kimi-k2-instruct", baseUrl: KIMI_BASE_URL }),
      provider({ id: "p2", model: "deepseek-chat", baseUrl: DEEPSEEK_BASE_URL }),
      provider({ id: "p3", model: "glm-4.6", baseUrl: GLM_BASE_URL })
    ];

    await activateChatTab();

    const hint = getHint();
    // init 首判：never 模型 off 天然成立，不发参也不提示。
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");

    const select = getModelSelect();
    // 切到 deepseek-chat（同为 never）：仍静默。
    select.value = modelOptionValue("p2", "deepseek-chat");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
    // 切到 glm-4.6（off 正常可用）：不误报。
    select.value = modelOptionValue("p3", "glm-4.6");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
  });
});

describe("实时刷新：提示随模型切换与档位点击即时显隐", () => {
  it("模型 change：关不掉（kimi-k2.7-code）→ 可关（glm-4.6）提示消失，切回再现", async () => {
    providersPayload = [
      provider({ id: "p1", model: "kimi-k2.7-code" }),
      provider({ id: "p2", model: "glm-4.6", baseUrl: GLM_BASE_URL })
    ];

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);

    const select = getModelSelect();
    select.value = modelOptionValue("p2", "glm-4.6");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");

    select.value = modelOptionValue("p1", "kimi-k2.7-code");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);
  });

  it("档位 click：Off→Low 提示收起；经可关模型转回 Off（关不掉模型）提示再现且文案不变", async () => {
    // 模型 = glm-5.3（04 号票翻转后关不掉、级联落 low）；翻转前这个角色是 kimi-k3。
    // 2026-10-05 起关不掉的模型**没有 Off 条目**（列表 = 真实档位），故「回 Off」这条
    // 路径只能经可关模型点 Off 再切回来——也正是用户真实能走到的路径。
    providersPayload = [
      provider({ id: "p1", model: "glm-5.3", baseUrl: GLM_BASE_URL, presetId: "zhipu" }),
      provider({ id: "p2", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" })
    ];
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);
    // 关不掉 → 没有 Off 条目；条目就是上游词表的三档。
    expect(renderedThinkingLevels()).toEqual(["low", "high", "max"]);

    // Off→Low：档位切走即收提示（setThinkingLevel 同步写档位，紧随的重判读到新值）。
    clickThinking("low");
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
    expect(requireThinkingBtn("low").classList.contains("is-active")).toBe(true);

    // 经可关模型（glm-4.6 是开关型）点 Off：偏好回到 off（这条链上 chip 显示 Off）。
    const select = getModelSelect();
    select.value = modelOptionValue("p2", "glm-4.6");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLabels()).toEqual(["Off", "On"]);
    clickThinking("off");

    // 切回关不掉模型：偏好仍是 off → 长文案再现。
    select.value = modelOptionValue("p1", "glm-5.3");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);
  });
});

// 05 号票（决策 #8 + 裁定 A「clamp 落线 = 实发档位」）：偏好档位被模型词表 clamp 掉时，
// 提示行如实给出源档 → 实发档（2026-10-05 复审：句式与「关不掉」那句对齐、不附原因）。
// off 的既有判定与文案（上面两组）保持不变。
describe("档位 clamp：提示面给出「源档 → 实发档」（句式与关不掉提示对齐）", () => {
  it("模型词表没有该档：qwen3.8-max + 偏好 high → 实发 medium（提示逐字 + chip 同源）", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" })];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
    // 2026-10-05 复审：chip 与一级行显示实发档，不再显示被裁掉的偏好（High）。
    expect(chipLevelText()).toBe("Medium");
    expect(levelRowValueText()).toBe("Medium");
  });

  it("可用的档位不误报：qwen3.8-max + 偏好 low → 无提示", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL })];
    settingsPayload = { aiThinkingLevel: "low" };

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
  });

  it("上游未登记该模型（手写兜底）：deepseek-v4-pro-2026 + 偏好 xhigh → 实发 high", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro-2026", baseUrl: DEEPSEEK_BASE_URL })];
    settingsPayload = { aiThinkingLevel: "xhigh" };

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_CLAMP_XHIGH_TO_HIGH);
  });

  it("实时刷新：切到会把偏好 clamp 掉的模型即出现、切回原样可用的模型即收起", async () => {
    // 二级菜单下用户只能点「该模型真有」的条目，所以「被 clamp 的偏好」只可能由
    // 换模型或存储态带进来（旧用例点不可见的 high 条目是不可达路径）——这里走真实路径。
    providersPayload = [
      provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" }),
      provider({ id: "p2", model: "glm-5.2", baseUrl: SENSENOVA_BASE_URL, presetId: "sensenova" })
    ];
    settingsPayload = { aiThinkingLevel: "low" };

    await activateChatTab();

    const hint = getHint();
    // deepseek-v4-pro 词表里有 low：偏好原样可用 → 无提示。
    expect(renderedThinkingLevels()).toEqual(["off", "low", "high", "max"]);
    expect(hint.hidden).toBe(true);

    // 切到 sensenova/glm-5.2（A' = {high,max}，没有 ≤ low 的档）：向上落 high → 提示出现。
    const select = getModelSelect();
    select.value = modelOptionValue("p2", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_CLAMP_LOW_TO_HIGH);

    // 切回有 low 的模型：偏好没有被迁移（05 号票）→ 提示收起、原样可用。
    select.value = modelOptionValue("p1", "deepseek-v4-pro");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
  });

  it("off 的既有判定优先：qwen3.8-max + 偏好 off → off 可用，静默（不显示 clamp 文案）", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL })];
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
  });
});

// ============================================================
// 显示口径统一（2026-10-05 复审裁定，票据 chat-thinking-submenu/05）：偏好 ≠ 实发档时
// 一级行/chip 一律显示**实发档**，两格（档位型 clamp / off 关不掉）各有一处真相；列表
// 仍按偏好打勾（列表那一半是 05 号票未完成的部分，见票）。
// 走查同时写出可复现工件（.scratch/tickets/chat-thinking-submenu/artifacts/05-showing-effective-level.txt）。
// 先列可能失败的方式：① clamp 格 chip 仍写被裁掉的偏好；② 两格提示句式不一致（一个带原因）；
// ③ 列表替实发档打勾（点它不写偏好）；④ 偏好被迁移（换回原模型不回落）。
// ============================================================
describe("口径 ③ 统一：偏好 ≠ 实发档 → 一级行/chip 写实发档（走查 + 工件）", () => {
  it("clamp 格（qwen3.8-max）与 off 关不掉格（sensenova/glm-5.2）逐行对齐，偏好不迁移", async () => {
    providersPayload = [
      provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" }),
      provider({ id: "p2", model: "glm-5.2", baseUrl: SENSENOVA_BASE_URL, presetId: "sensenova" })
    ];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    const select = getModelSelect();
    const steps: string[] = [];
    function snap(label: string): void {
      steps.push(
        [
          label,
          `偏好=${chatSessionState.aiThinkingLevel}`,
          `条目=[${renderedThinkingLevels().join(",")}]`,
          `显示名=[${renderedThinkingLabels().join(",")}]`,
          `选中=[${activeThinkingLevels().join(",")}]`,
          `chip=${chipLevelText()}`,
          `一级行=${levelRowValueText()}`,
          `提示=${getHint().hidden ? "-" : getHint().textContent}`
        ].join(" | ")
      );
    }

    // ① 档位型 clamp：偏好 high 被裁到 medium → chip/一级行 Medium、列表无人打勾、提示两句式。
    expect(renderedThinkingLevels()).toEqual(["off", "low", "medium", "xhigh"]);
    expect(activeThinkingLevels()).toEqual([]);
    expect(chipLevelText()).toBe("Medium");
    expect(levelRowValueText()).toBe("Medium");
    expect(getHint().textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
    snap("1 qwen/qwen3.8-max（偏好 high → 实发 medium）");

    // ② 走真实持久化链把偏好改成 off：chip 照实发档回 Off、提示收起。
    clickThinking("off");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevelText()).toBe("Off");
    expect(getHint().hidden).toBe(true);
    snap("2 qwen/qwen3.8-max（偏好落盘 off）");

    // ③ off 关不掉：偏好 off 被级联到 high → chip/一级行 High、列表无人打勾、长版提示。
    select.value = modelOptionValue("p2", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["high", "max"]);
    expect(activeThinkingLevels()).toEqual([]);
    expect(chipLevelText()).toBe("High");
    expect(levelRowValueText()).toBe("High");
    expect(getHint().textContent).toBe(HINT_LOW_FALLBACK);
    snap("3 sensenova/glm-5.2（偏好 off → 实发 high）");

    // ④ 偏好不迁移：换回支持 off 的模型，偏好原样解析（仍是 off、不是被级联改写的 high）。
    select.value = modelOptionValue("p1", "qwen3.8-max");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevelText()).toBe("Off");
    expect(getHint().hidden).toBe(true);
    snap("4 qwen/qwen3.8-max（偏好仍 off，未被 ③ 迁移）");

    expect(steps).toHaveLength(4);

    const artifactDir = join(process.cwd(), ".scratch", "tickets", "chat-thinking-submenu", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "05-showing-effective-level.txt"),
      [
        "# 显示口径统一走查工件（由 tests/reader/chat-tab-thinking-hint.test.ts 生成）",
        "# 用例：偏好 ≠ 实发档的两格（档位型 clamp / off 关不掉）逐行看 chip、一级行、列表勾、提示",
        "# 判据：chip 与一级行写实发档（Medium / High）、列表按偏好打勾（两格都无人打勾）、",
        "#       提示句式同为「当前模型不支持思考强度 X，已使用 Y」、偏好不迁移（换回原模型回落 off）",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});

// 06 号票：面板档位 chip 按「该模型实际可用的档位」渲染（来源三层：上游逐模型
// 词表 / 借词类默认 / 回落今日三档）。只显示存在的档位、不置灰；被 05 clamp 掉的
// 偏好走既有说明文本，不做成禁用 chip；minimax-m3 一个 chip 都不显示（关不掉）。
describe("档位 chip 集合：按模型可用集渲染（06 号票）", () => {
  const OLLAMA_URL = "http://localhost:11434/v1";
  const MINIMAX_URL = "https://api.minimaxi.com/v1";
  const OPENCODEGO_URL = "https://opencode.ai/zen/go/v1";
  const SENSENOVA_URL = "https://token.sensenova.cn/v1";

  it("激活前模板不给静态档位按钮：档位页容器为空、一级行 hidden（显示名由组合根派生）", async () => {
    // 2026-10-05 用户裁定（票据 chat-thinking-submenu）：模板里的 7 个静态 chip 退役，
    // 条目改由 chat/thinking-picker 在组合根里现渲——激活前容器必须为空、一级行必须
    // 隐藏（壳静默空态，不放假数据）。标签表本身的键集/文案由
    // tests/chat/thinking-picker.test.ts 锁。
    expect(renderedThinkingLevels()).toEqual([]);
    expect(thinkingRow().hidden).toBe(true);
    expect(document.getElementById(ids.readingChatThinkingPage)?.hidden).toBe(true);
  });

  it("上游逐模型词表：deepseek-v4-pro → {off, low, high, max}（不存在的档不现渲）", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["off", "low", "high", "max"]);
    expect(getThinkingBtn("minimal")).toBe(null);
    expect(getThinkingBtn("medium")).toBe(null);
  });

  it("上游只有 toggle 的词表：zhipu/glm-4.6 → 收成 Off/On（非 off 域发的是同一个「开」写点）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["off", "high"]);
    expect(renderedThinkingLabels()).toEqual(["Off", "On"]);
  });

  it("minimax-m3：一个条目都不现渲（关不掉思考、无已登记档位），off 也不可用 → 短文案", async () => {
    providersPayload = [provider({ id: "p1", model: "MiniMax-M3", baseUrl: MINIMAX_URL, presetId: "minimax" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual([]);
    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);
  });

  it("未登记词表且借不到（custom 自填端点）：不现渲任何档位，只保留「关不掉/不发参」说明", async () => {
    providersPayload = [provider({ id: "p1", model: "vendor-future-1", baseUrl: "https://api.example.com/v1", presetId: "custom" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual([]);
    // 无结论（fail-closed）：off 既不「可用」也不算「关不掉」，静默（与请求不发一致）。
    expect(getHint().hidden).toBe(true);
  });

  it("无上游平台（ollama）：仍显示今日三档", async () => {
    providersPayload = [provider({ id: "p1", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["off", "low", "high"]);
  });

  // 2026-10-04 用户裁定（A' = 上游词表在平台可表达的部分）：托管平台也不再整域放宽。
  // 13 号票 canonical 优先：sensenova/glm-5.2 的 canonical（zhipuai/glm-5.2）是 high-max
  // → 模型侧无 off → A' = {high, max}（丢 off 照收；18 号票删平台声明后 max 也显示出来）。
  it("high/max 类（sensenova/glm-5.2）：条目 = {high,max}；偏好 low 向上落 high（提示逐字）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" })];
    settingsPayload = { aiThinkingLevel: "low" };

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["high", "max"]);
    // 偏好 low 保留在存储里（不迁移），本模型无 ≤ low 的档 → 落最小可用档 high。
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe(HINT_CLAMP_LOW_TO_HIGH);
    // 没有禁用态条目（被 clamp 掉的 low 是「不存在」而不是「灰色」）：
    // 条目只有两个，且高档位是上游词。
    expect(renderedThinkingLabels()).toEqual(["High", "Max"]);
    expect(getThinkingBtn("low")).toBe(null);
  });

  // 口径 ③（2026-10-05 复审裁定）：关不掉时一级行与 chip 显示**实发档**，不再显示线上
  // 没发的 Off；偏好本身不迁移（换到能关的模型仍按 off 解析），列表也不替实发档打勾
  // （打勾会把「点 High」变成重复选择——点了不写偏好）。
  it("偏好 off 且关不掉（sensenova/glm-5.2 → 级联发 high）：一级行 High、实发档条目可点、长文案在场", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" }),
      provider({ id: "p2", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })
    ];
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    const chipLevel = () =>
      (document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement).textContent;
    // A' = {high,max}：off 关不掉 → 级联落最小可用档 high（线上发 output_config.effort high）。
    expect(renderedThinkingLevels()).toEqual(["high", "max"]);
    expect(renderedThinkingLabels()).toEqual(["High", "Max"]);
    expect(activeThinkingLevels()).toEqual([]);
    expect(chipLevel()).toBe("High");
    expect((document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement).textContent).toBe("High");
    // 工单 03 的长文案不动：它说的是「已使用最小思考档位」，与一级行的 High 一致。
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe(HINT_LOW_FALLBACK);

    // 偏好没有被迁移：切到能关的模型仍按 off 解析（一级行回 Off、条目勾 off、提示收起）。
    const select = getModelSelect();
    select.value = modelOptionValue("p2", "deepseek-v4-pro");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevel()).toBe("Off");
    expect(activeThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);

    // 切回来点实发档那一项：偏好这才迁移成 high（打勾跟着落定，一级行仍是 High）。
    select.value = modelOptionValue("p1", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chipLevel()).toBe("High");
    clickThinking("high");
    expect(chatSessionState.aiThinkingLevel).toBe("high");
    expect(activeThinkingLevels()).toEqual(["high"]);
    expect(chipLevel()).toBe("High");
  });

  it("18 号票：上游 none-high 的托管行仍可关思考（opencodego/hy4-preview：条目 = {off,high}，那一档叫 On）", async () => {
    providersPayload = [provider({ id: "p1", model: "hy4-preview", baseUrl: OPENCODEGO_URL, presetId: "opencodego" })];

    await activateChatTab();

    // 上游值集含 effort none（与平台方言无关）→ off 有写点；18 号票前平台声明无 off 写点，
    // 曾落「关不掉」长文案，现在偏好 off 直接满足。
    expect(renderedThinkingLevels()).toEqual(["off", "high"]);
    // 非 off 只有一个真实档位 → 按用户裁定显示为 On（不是 High）。
    expect(renderedThinkingLabels()).toEqual(["Off", "On"]);
    expect(getHint().hidden).toBe(true);
  });

  it("clamp 掉的偏好不做成禁用条目：qwen3.8-max + high → High 不存在（无 active、无 disabled），文案在场", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" })];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    // 上游词表 toggle+low-medium-xhigh：High 不存在（不现渲、不置灰）。
    expect(renderedThinkingLevels()).toEqual(["off", "low", "medium", "xhigh"]);
    expect(getThinkingBtn("high")).toBe(null);
    // 偏好档位没有对应条目 → 没有 active 条目（档位页的语义 = 「这个模型有哪些档位」，
    // 偏好的偏差由说明文本承担），而 chip 与一级行按口径 ③ 显示**实发档** Medium。
    expect(activeThinkingLevels()).toEqual([]);
    expect(getHint().textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
    expect(chipLevelText()).toBe("Medium");
  });

  it("模型切换即重渲条目：开关型（2 项）→ 三档模型 → 空集模型 → 切回", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" }),
      provider({ id: "p2", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" }),
      provider({ id: "p3", model: "MiniMax-M3", baseUrl: MINIMAX_URL, presetId: "minimax" })
    ];

    await activateChatTab();
    expect(renderedThinkingLevels()).toEqual(["off", "high"]);

    const select = getModelSelect();
    select.value = modelOptionValue("p2", "llama3.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["off", "low", "high"]);

    select.value = modelOptionValue("p3", "MiniMax-M3");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual([]);
    expect(thinkingRow().hidden).toBe(true);

    // 切回开关型模型：条目全部回来、一级行也回来（渲染幂等，不是一次性改写）。
    select.value = modelOptionValue("p1", "glm-4.6");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["off", "high"]);
    expect(thinkingRow().hidden).toBe(false);
  });

  it("点击条目仍走既有持久化链：切换档位后 chip 文案与 active 同步", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

    await activateChatTab();
    expect(renderedThinkingLevels()).toEqual(["off", "low", "high", "max"]);

    clickThinking("max");

    expect(requireThinkingBtn("max").classList.contains("is-active")).toBe(true);
    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    expect(chipLevel.textContent).toBe("Max");
  });
});

// ============================================================
// 二级菜单端到端走查（票据 chat-thinking-submenu/04）：真实模板 + 真实组合根，
// 全链只走 DOM 事件——开面板（点 chip）→ 换页（点一级行）→ 选档（点条目）→
// 落盘 / chip 更新 / 关面板 → 重开回模型页。走查同时写出可复现工件
//（.scratch/tickets/chat-thinking-submenu/artifacts/04-e2e-walkthrough.txt）。
// 先列可能失败的方式：面板没关（hidePanel 链断）；重开没回到模型页（换页状态残留）；
// 选中条目没写偏好（只改 DOM）；chip 显示名与菜单不同源（选了 Max、chip 还写 Off）。
// ============================================================
describe("二级菜单端到端走查（04 号票）", () => {
  it("开面板 → 点「思考强度」行 → 换页 → 选档 → 落盘 + chip 更新 + 关面板 → 重开回模型页", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

    await activateChatTab();

    const panel = document.getElementById(ids.readingChatModelPanel) as HTMLElement;
    const chip = document.getElementById(ids.readingChatModelChip) as HTMLButtonElement;
    const list = document.getElementById(ids.readingChatModelList) as HTMLElement;
    const page = document.getElementById(ids.readingChatThinkingPage) as HTMLElement;
    const row = thinkingRow();
    const back = document.getElementById(ids.readingChatThinkingBack) as HTMLElement;
    const hint = getHint();
    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    const storageSet = (window.chrome as unknown as { storage: { local: { set: SendStub } } }).storage.local.set;

    const steps: string[] = [];
    function snap(label: string): void {
      steps.push(
        [
          label,
          `面板=${panel.hidden ? "关" : "开"}`,
          `模型页=${list.hidden ? "隐" : "显"}`,
          `档位页=${page.hidden ? "隐" : "显"}`,
          `一级行=${row.hidden ? "隐" : "显"}`,
          `条目=[${renderedThinkingLevels().join(",")}]`,
          `选中=[${activeThinkingLevels().join(",")}]`,
          `chip=${chipLevel.textContent}`,
          `偏好=${chatSessionState.aiThinkingLevel}`,
          `提示=${hint.hidden ? "-" : hint.textContent}`
        ].join(" | ")
      );
    }

    // 0. 激活后：面板关着，档位区已按模型现渲（off/low/high/max，选中 Off）。
    expect(panel.hidden).toBe(true);
    snap("0 激活后");

    // 1. 点 chip 开面板：模型页 + 一级行（当前值 Off）。
    click(chip);
    expect(panel.hidden).toBe(false);
    expect(list.hidden).toBe(false);
    expect(page.hidden).toBe(true);
    expect(row.hidden).toBe(false);
    snap("1 点 chip 开面板");

    // 2. 点一级行换页：模型列表隐藏、档位页可见、一级行隐藏（返回行接管）。
    click(row);
    expect(page.hidden).toBe(false);
    expect(list.hidden).toBe(true);
    expect(row.hidden).toBe(true);
    expect(back.hidden).toBe(false);
    snap("2 点一级行换页");

    // 3. 点 Max：写偏好（storage + save-settings 同值）+ chip 更新 + 关面板。
    storageSet.mockClear();
    clickThinking("max");
    expect(chatSessionState.aiThinkingLevel).toBe("max");
    expect(storageSet).toHaveBeenCalledWith({ [THINKING_LEVEL_KEY]: "max" });
    expect(chipLevel.textContent).toBe("Max");
    expect(panel.hidden).toBe(true);
    expect(requireThinkingBtn("max").classList.contains("is-active")).toBe(true);
    snap("3 点 Max 选档");

    // 4. 重开面板：回到模型页（换页状态不留到下一次），一级行显示新值。
    click(chip);
    expect(panel.hidden).toBe(false);
    expect(list.hidden).toBe(false);
    expect(page.hidden).toBe(true);
    expect((document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement).textContent).toBe("Max");
    snap("4 重开面板");

    expect(steps).toHaveLength(5);

    // 工件：同一步走查的逐步快照（可重跑，内容确定）。
    const artifactDir = join(process.cwd(), ".scratch", "tickets", "chat-thinking-submenu", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "04-e2e-walkthrough.txt"),
      [
        "# 04 号票端到端走查工件（由 tests/reader/chat-tab-thinking-hint.test.ts 生成）",
        "# 用例：二级菜单端到端走查 —— deepseek/deepseek-v4-pro，偏好默认 off，点 Max",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});

// ============================================================
// D1=A2 本仓补声明端到端走查（票据 upstream-glm52-toggle/01）：真实模板 + 真实组合根，
// 6 行本地 glm-5.2（5 行目录内 + 1 行目录外兜底）走 DOM 事件切换模型，逐行看档位条目与提示。
// 先列可能失败的方式：① 误开 off（未登记开关形状的三家冒出 Off 条目 / 提示消失）；
// ② 少开 off（zhipu / qwen 没有 Off 条目）；③ 提示文案被顺手改动；
// ④ 目录外 glm-5.2-air 的 off 出口与目录内不一致（两条路径的档位词表本来就不同）；
// ⑤ 关不掉的三家仍显示 Off（一级行与线上实发的 high 不符，口径 ③）。
// ============================================================
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
    // 偏好 off：目录内两行应静默满足；三家未登记形状的行落长版提示（条目与提示与补声明前
    // 逐字相同，但一级行/chip 按口径 ③ 显示实发档 high，不再显示线上没发的 Off）。
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    const select = getModelSelect();
    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    const steps: string[] = [];
    function snap(label: string): void {
      steps.push(
        [
          label,
          `条目=[${renderedThinkingLevels().join(",")}]`,
          `显示名=[${renderedThinkingLabels().join(",")}]`,
          `选中=[${activeThinkingLevels().join(",")}]`,
          `chip=${chipLevel.textContent}`,
          `提示=${getHint().hidden ? "-" : getHint().textContent}`
        ].join(" | ")
      );
    }

    // ① 目录内·原生（zhipu 方言 thinking:{type}）：Off 条目在场、偏好 off 满足、无提示。
    expect(renderedThinkingLevels()).toEqual(["off", "high", "max"]);
    expect(renderedThinkingLabels()).toEqual(["Off", "High", "Max"]);
    expect(activeThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);
    snap("1 zhipu/glm-5.2（目录内·原生）");

    // 走一遍真实点击：Off → Max → 回 Off，chip 与落盘同步（补声明新开的 Off 条目真能选中）。
    clickThinking("max");
    expect(activeThinkingLevels()).toEqual(["max"]);
    expect(chatSessionState.aiThinkingLevel).toBe("max");
    expect(chipLevel.textContent).toBe("Max");
    clickThinking("off");
    expect(activeThinkingLevels()).toEqual(["off"]);
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevel.textContent).toBe("Off");

    // ② 目录内·托管（qwen 方言 enable_thinking）：A' 同为 {off,high,max}，偏好 off 静默。
    select.value = modelOptionValue("p2", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["off", "high", "max"]);
    expect(getHint().hidden).toBe(true);
    snap("2 qwen/glm-5.2（托管·借词）");

    // ③ 三家未登记开关形状的行：事实带 toggle 但无写点 → 条目仍是 {high,max}、提示逐字不变，
    //    一级行与选中项按口径 ③ 落在实发档 high。
    const unregistered: ReadonlyArray<[providerId: string, label: string, model: string]> = [
      ["p3", "openrouter/z-ai/glm-5.2", "z-ai/glm-5.2"],
      ["p4", "sensenova/glm-5.2", "glm-5.2"],
      ["p5", "opencodego/glm-5.2", "glm-5.2"]
    ];
    for (const [index, [providerId, label, model]] of unregistered.entries()) {
      select.value = modelOptionValue(providerId, model);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(renderedThinkingLevels(), label).toEqual(["high", "max"]);
      expect(activeThinkingLevels(), label).toEqual([]);
      expect(chipLevel.textContent, label).toBe("High");
      expect(getHint().hidden, label).toBe(false);
      expect(getHint().textContent, label).toBe(HINT_LOW_FALLBACK);
      snap(`${3 + index} ${label}（平台形状未登记）`);
    }

    // ④ 目录外兜底（glm-5.2-air）：off 出口与目录内同为 thinking 开关（档位词表本来就不同）。
    select.value = modelOptionValue("p6", "glm-5.2-air");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["off", "low", "high"]);
    expect(getHint().hidden).toBe(true);
    expect(chipLevel.textContent).toBe("Off");
    snap("6 zhipu/glm-5.2-air（目录外兜底）");

    expect(steps).toHaveLength(6);

    // 工件：逐步快照（可重跑，内容确定）。
    const artifactDir = join(process.cwd(), ".scratch", "tickets", "upstream-glm52-toggle", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "05-e2e-glm52-off.txt"),
      [
        "# D1=A2 端到端走查工件（由 tests/reader/chat-tab-thinking-hint.test.ts 生成）",
        "# 用例：6 行本地 glm-5.2（5 行目录内 + glm-5.2-air 兜底），偏好 off，逐行看档位条目与提示",
        "# 判据：zhipu / qwen 多出 Off（静默）；openrouter / sensenova / opencodego 的条目与提示不变（长版提示），",
        "#       一级行/chip 按口径 ③（2026-10-05 复审）显示实发档 High、列表无人打勾——线上发 high，界面不再写 Off",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});
