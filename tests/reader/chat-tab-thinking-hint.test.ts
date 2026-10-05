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
//   Low→Off（关不掉模型）再现；
// - 05 号票：偏好档位被 clamp 时的说明文本（逐字）；
// - 06 号票：档位 chip 集合 = 模型可用集（只显示存在的档位、不置灰；minimax-m3
//   一个 chip 都不显示；无上游平台仍三档；clamp 掉的偏好走说明文本）。
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

// 05 号票（决策 #8）：偏好档位被模型词表 clamp 掉时的说明文本（源档 → 实发档 + 原因）。
// 断言逐字——文案与源/目标档是本票的验收面之一。
const HINT_CLAMP_HIGH_TO_MEDIUM = "档位已按模型能力调整：high → medium（模型词表没有这个档位）";
const HINT_CLAMP_XHIGH_TO_HIGH = "档位已按模型能力调整：xhigh → high（上游未登记该模型，档位按本仓词表取）";
// 06 号票（2026-10-04 用户裁定：A' = 上游词表 ∩ 平台可表达）：平台声明里有 low、上游
// 词表没有 → 原因层是「模型词表」。13 号票 canonical 优先后 sensenova/glm-5.2 的模型侧
// 词表只剩 high（canonical = high-max），偏好 low 没有 ≤ low 的档 → 向上落最小可用档 high。
const HINT_CLAMP_LOW_TO_HIGH = "档位已按模型能力调整：low → high（模型词表没有这个档位）";

// Kimi/GLM preset host（core/presets.ts）：resolver host 推断的输入形状。
const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

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

async function loadShell() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  modelOptionValue = (await import("../../extension/chat/providers.js")).buildModelOptionValue;
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

function getThinkingBtn(level: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    `#${ids.readingChatThinkingToggle} .chat-thinking-btn[data-level="${level}"]`
  ) as HTMLButtonElement;
}

// 当前可见（未隐藏）的 chip 档位（06 号票：只显示存在的档位）。
function visibleThinkingLevels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn`)]
    .filter((btn) => !btn.hidden)
    .map((btn) => btn.dataset.level || "");
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
    // 档位 chip 组本身由模板给出（06 号票起 7 个静态占位、按可用集显隐）：
    // 默认档位 Off 仍由既有 is-active 语义表达。
    expect(getThinkingBtn("off").classList.contains("is-active")).toBe(true);
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

  it("档位 click：Off→Low 提示收起；Low→Off（关不掉模型）提示再现且文案不变", async () => {
    // 模型 = glm-5.3（04 号票翻转后关不掉、级联落 low）；翻转前这个角色是 kimi-k3。
    providersPayload = [provider({ id: "p1", model: "glm-5.3", baseUrl: GLM_BASE_URL })];

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);

    // Off→Low：档位切走即收提示（setThinkingLevel 同步写档位，紧随的重判读到新值）。
    getThinkingBtn("low").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
    expect(getThinkingBtn("low").classList.contains("is-active")).toBe(true);

    // Low→Off（关不掉模型）：提示按长文案再现。
    getThinkingBtn("off").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);
    expect(getThinkingBtn("off").classList.contains("is-active")).toBe(true);
  });
});

// 05 号票（决策 #8 + 裁定 A「clamp 落线 = 实发档位」）：偏好档位被模型词表 clamp 掉时，
// 提示行如实给出源档 → 实发档 + 原因。off 的既有判定与文案（上面两组）保持不变。
describe("档位 clamp：提示面给出「源档 → 实发档 + 原因」", () => {
  it("模型词表没有该档：qwen3.8-max + 偏好 high → 实发 medium（提示逐字）", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL })];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
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

  it("实时刷新：档位切到被调整的档位即出现、切回可用档位即收起", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL })];
    settingsPayload = { aiThinkingLevel: "low" };

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(true);

    // low → high（被 clamp 到 medium）：提示按说明文本出现。
    getThinkingBtn("high").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);

    // high → low（原样可用）：提示收起。
    getThinkingBtn("low").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

// 06 号票：面板档位 chip 按「该模型实际可用的档位」渲染（来源三层：上游逐模型
// 词表 / 借词类默认 / 回落今日三档）。只显示存在的档位、不置灰；被 05 clamp 掉的
// 偏好走既有说明文本，不做成禁用 chip；minimax-m3 一个 chip 都不显示（关不掉）。
describe("档位 chip 集合：按模型可用集渲染（06 号票）", () => {
  const OLLAMA_URL = "http://localhost:11434/v1";
  const MINIMAX_URL = "https://api.minimaxi.com/v1";
  const OPENCODEGO_URL = "https://opencode.ai/zen/go/v1";
  const SENSENOVA_URL = "https://token.sensenova.cn/v1";

  it("模板 7 个 chip 的静态文案与标签表同源（激活前的占位形态）", async () => {
    // 未激活：壳已建、组合根未装载，chip 由模板给出。文案必须是权威标签表的值
    // （06 号票起 renderThinkingChips 会改写，但两处漂移会让首帧说错档位名）。
    const panel = await import("../../extension/reader/chat-model-panel.js");
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn`)];
    expect(buttons.map((btn) => btn.dataset.level)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const btn of buttons) {
      expect(btn.textContent, btn.dataset.level).toBe(panel.THINKING_LEVEL_LABELS[btn.dataset.level || ""]);
    }
  });

  it("上游逐模型词表：deepseek-v4-pro → {off, low, high, max}（minimal/medium/xhigh 隐藏）", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

    await activateChatTab();

    expect(visibleThinkingLevels()).toEqual(["off", "low", "high", "max"]);
  });

  it("上游只有 toggle 的词表：zhipu/glm-4.6 → 全 7 档（on 写点服务所有非 off 档）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" })];

    await activateChatTab();

    expect(visibleThinkingLevels()).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("minimax-m3：一个 chip 都不显示（关不掉思考、无已登记档位），off 也不可用 → 短文案", async () => {
    providersPayload = [provider({ id: "p1", model: "MiniMax-M3", baseUrl: MINIMAX_URL, presetId: "minimax" })];

    await activateChatTab();

    expect(visibleThinkingLevels()).toEqual([]);
    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);
  });

  it("未登记词表且借不到（custom 自填端点）：隐藏全部档位，只保留「关不掉/不发参」说明", async () => {
    providersPayload = [provider({ id: "p1", model: "vendor-future-1", baseUrl: "https://api.example.com/v1", presetId: "custom" })];

    await activateChatTab();

    expect(visibleThinkingLevels()).toEqual([]);
    // 无结论（fail-closed）：off 既不「可用」也不算「关不掉」，静默（与请求不发一致）。
    expect(getHint().hidden).toBe(true);
  });

  it("无上游平台（ollama）：仍显示今日三档", async () => {
    providersPayload = [provider({ id: "p1", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" })];

    await activateChatTab();

    expect(visibleThinkingLevels()).toEqual(["off", "low", "high"]);
  });

  // 2026-10-04 用户裁定（A' = 上游词表 ∩ 平台可表达）：override 平台也不再整域放宽。
  // 13 号票 canonical 优先：sensenova/glm-5.2 的 canonical（zhipuai/glm-5.2）是 high-max
  // → 模型侧无 off → A' = {high}（丢 off 照收）。
  it("high/max 类（sensenova/glm-5.2）：chip = {high}；偏好 low 向上落 high（提示逐字）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" })];
    settingsPayload = { aiThinkingLevel: "low" };

    await activateChatTab();

    expect(visibleThinkingLevels()).toEqual(["high"]);
    // 偏好 low 保留在存储里（不迁移），本模型无 ≤ low 的档 → 落最小可用档 high。
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe(HINT_CLAMP_LOW_TO_HIGH);
    // 没有禁用态 chip（被 clamp 掉的 low 是「不存在」而不是「灰色」）。
    expect(getThinkingBtn("low").hidden).toBe(true);
    expect(getThinkingBtn("low").disabled).toBe(false);
  });

  it("平台无 off 写点（opencodego/hy4-preview，上游 none-high）：chip 只剩 {high}，偏好 off 走「关不掉」长文案", async () => {
    providersPayload = [provider({ id: "p1", model: "hy4-preview", baseUrl: OPENCODEGO_URL, presetId: "opencodego" })];

    await activateChatTab();

    expect(visibleThinkingLevels()).toEqual(["high"]);
    expect(getHint().textContent).toBe(HINT_LOW_FALLBACK);
  });

  it("clamp 掉的偏好不做成禁用 chip：qwen3.8-max + high → High 不在（无 active、无 disabled），Medium 在，文案在场", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" })];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    // 上游词表 toggle+low-medium-xhigh：High 不存在（不显示、不置灰）。
    expect(visibleThinkingLevels()).toEqual(["off", "low", "medium", "xhigh"]);
    expect(getThinkingBtn("high").hidden).toBe(true);
    expect(getThinkingBtn("high").disabled).toBe(false);
    // 偏好档位没有对应 chip → 没有 active chip（chip 行的语义 = 「这个模型有哪些档位」，
    // 偏好的偏差由说明文本承担）。
    const active = visibleThinkingLevels().filter((level) => getThinkingBtn(level).classList.contains("is-active"));
    expect(active).toEqual([]);
    expect(getHint().textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
  });

  it("模型切换即重渲 chip：7 档模型 → 三档模型 → 空集模型", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" }),
      provider({ id: "p2", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" }),
      provider({ id: "p3", model: "MiniMax-M3", baseUrl: MINIMAX_URL, presetId: "minimax" })
    ];

    await activateChatTab();
    expect(visibleThinkingLevels()).toHaveLength(7);

    const select = getModelSelect();
    select.value = modelOptionValue("p2", "llama3.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(visibleThinkingLevels()).toEqual(["off", "low", "high"]);

    select.value = modelOptionValue("p3", "MiniMax-M3");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(visibleThinkingLevels()).toEqual([]);

    // 切回 7 档模型：隐藏的 chip 全部回来（渲染幂等，不是一次性改写）。
    select.value = modelOptionValue("p1", "glm-4.6");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(visibleThinkingLevels()).toHaveLength(7);
  });

  it("点击可见 chip 仍走既有持久化链：切换档位后 chip 文案与 active 同步", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

    await activateChatTab();
    expect(visibleThinkingLevels()).toEqual(["off", "low", "high", "max"]);

    getThinkingBtn("max").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(getThinkingBtn("max").classList.contains("is-active")).toBe(true);
    const chipLevel = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement;
    expect(chipLevel.textContent).toBe("Max");
  });
});
