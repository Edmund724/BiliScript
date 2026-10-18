// tests/reader/chat-tab-thinking-hint.test.ts
// 组合根（extension/reader/chat-tab.ts）档位区的**接线与端到端走查**测试
//（tests/reader/chat-tab.test.ts 的姊妹篇）：真实模板（ensureUiReady）+ 懒装载组合根，
// 全部用真实 DOM 事件驱动（modelSelect change / 档位按钮 click），不直调组合根内部函数。
// 文件名沿用 2026-10-05 的订正（`chat-thinking-hint` 只是模板上的 CSS class，见
// extension/reader/chat-template.ts:139）；被测函数是 chat-tab 的 `refreshThinkingUi`。
//
// 这里钉住两件事：
//   ① 组合根只做「装配解析入参 → 把整份视图值交给面板」——识别入参取
//      parseModelOptionValue(select.value) 与 chatSessionState.providers 的
//      baseUrl/presetId/model，stream 恒 true（激活前档位页为空 / 一级行 hidden 即其黑盒佐证）；
//      档位条目、一级行、chip 显示名与提示行都随之落 DOM；
//   ② 端到端走查（点 chip 开面板 → 换页 → 选档 → 落盘 → 关面板 → 重开回模型页）与二级
//      菜单背后既有的持久化链。
//
// 2026-10 深化后的分工（提示行归属变了，改本文件前先读这一段）：
// - 提示行（工单 03「关不掉」/ 05 号票 clamp 说明）的**文案与显隐**已移入
//   reader/chat-model-panel.ts：组合根不再持有该元素（chat-tab 的 els 已删该字段），也不再
//   写它的 DOM、不知道调用顺序。因此「hint 显隐/接线」的专测下沉到
//   tests/reader/chat-model-panel.test.ts（真实 DOM 直测，不挂阅读壳）；显隐条件本身
//  （何时 view.hint = null）是 chat/thinking-picker 的纯函数口径，由
//   tests/chat/thinking-picker.test.ts 锁定。
// - 原先以提示行为**主题**的四组用例（Off 关不掉的逐字长/短文案、never 与可关模型的静默、
//   模型切换/档位点击的提示实时显隐、档位 clamp 的说明文本）已随之下沉/删除——逐模型的文案
//   矩阵在纯函数侧，文案 → DOM 在面板侧，两者都不需要真实阅读壳 + 播放器链 + 换模块纪元。
// - 本文件保留的用例是**组合根接线与端到端走查**：提示行只作为走查快照的一列被顺带断言
//  （真实链路整体一致性），不再是任一用例的主题。
//
// 覆盖：
// - 口径 ③/⑤（2026-10-05 复审 + 裁定 B）：偏好 ≠ 实发档时一级行/chip/勾都落在实发档、
//   点勾住的那一项即把该档写成偏好、偏好不迁移（换回原模型不回落）；走查产出可复现工件；
// - 06 号票：档位条目 = 模型可用集（只现渲存在的档位、不置灰；零档行只剩 Default；无上游
//   平台仍三档）；模型切换即重渲条目；点条目走既有持久化链；
// - 二级菜单端到端走查（票据 chat-thinking-submenu/04）：开面板 → 换页 → 选档 → 落盘 +
//   chip 更新 + 关面板 → 重开回模型页；产出工件；
// - D1=A2 补声明走查（upstream-glm52-toggle：glm-5.2 的 Off 由平台开关形状决定）；
// - default（不干预）档走查（thinking-default-level：出厂默认与零档行）。
//
// 模型选型依据（extension/ai/thinking-profiles.ts 表 + 02 产物指派表，勿凭记忆）：
// - kimi-k2.7-code → EXCEPTIONS kimi-always：always 且无 low/on → offUnavailable
//   + offFallback:null（短文案的角色仍在纯函数侧：tests/chat/thinking-picker.test.ts）；
// - glm-5.3 → 04 号票翻转后走上游指派表（值集 low-high-max：有档位、关不掉）→
//   offUnavailable + offFallback:"low"（长文案，同样在纯函数侧）；
// - glm-5.2 六行 → D1=A2 走查：zhipu / qwen 目录内行 off 可用（原生/托管两种方言），
//   openrouter / sensenova / opencodego 三家未登记开关形状 → 条目 {high,max} + 长版提示，
//   glm-5.2-air 目录外兜底同 zhipu 出口；
// - deepseek-v4-pro → 上游逐模型词表 {off,low,high,max}；deepseek-v4-pro-2026 → 上游未
//   登记、走手写兜底（xhigh → high）；
// - glm-4.6 → 上游指派表（zhipuai，值集 toggle）→ 开关型收成 Off/On（off 正常可用）；
// - qwen3.8-max → 上游 toggle+low-medium-xhigh（偏好 high 被裁到 medium）；
// - MiniMax-M3 → 登记开关形状后是开关型；anthropic/claude-haiku-4.5（openrouter）→
//   零档行（A' = ∅，只剩 Default）；
// - kimi-k2-instruct / deepseek-chat → TAXONOMY never（off 天然成立、静默，纯函数侧）；
// - 无上游平台（ollama / llama3.2）→ 今日三档。
//
// 模块纪元注意（与 chat-tab.test.ts 同款）：chatSessionState 与组合根闭包都是
// 模块级单例，beforeEach resetModules 后同纪元导入；chrome.storage / runtime
// 消息按 type 路由 stub（ai-providers-list 载荷带 baseUrl/model——档位判定的
// 识别入参与 refreshThinkingUi 读的 chatSessionState.providers 同源）。

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

// 热评/网络路径与本文件无关（档位判定不触网）：mock 保持确定性，防止 init 的
// 上下文链路意外走网络（与 chat-tab.test.ts 同款）。
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

// 提示文案逐字给定（工单 03 / 05 号票，勿改写）——本文件只在走查快照里顺带断言它
//（文案矩阵与显隐条件归纯函数侧 tests/chat/thinking-picker.test.ts，文案 → DOM 归面板侧
// tests/reader/chat-model-panel.test.ts）。
const HINT_LOW_FALLBACK = "当前模型不支持在本次请求中关闭思考，已使用最小思考档位";

// 05 号票（决策 #8）：偏好档位被模型词表 clamp 掉时的说明文本（源档 → 实发档）。
// 2026-10-05 复审裁定：句式与「关不掉思考」那句对齐，不附原因 → 断言也逐字。
const HINT_CLAMP_HIGH_TO_MEDIUM = "当前模型不支持思考强度 high，已使用 medium";
// 06 号票（2026-10-04 用户裁定：A' = 上游词表 ∩ 平台可表达）：平台声明里有 low、上游
// 词表没有 → 原因层是「模型词表」。13 号票 canonical 优先后 sensenova/glm-5.2 的模型侧
// 词表只剩 high（canonical = high-max），偏好 low 没有 ≤ low 的档 → 向上落最小可用档 high。
const HINT_CLAMP_LOW_TO_HIGH = "当前模型不支持思考强度 low，已使用 high";

// GLM preset host（core/presets.ts）：resolver host 推断的输入形状。
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
      local: ChromeHostStorageArea;
      sync: { set: SendStub };
      onChanged: { addListener: SendStub; removeListener: SendStub };
    };
  };
  chromeStub.runtime.sendMessage = callbackStyleSendMessage({
    "ai-providers-list": () => ({ ok: true, providers: providersPayload }),
    // 无设置回落：aiThinkingLevel 归一化到默认 off（档位测试的前置态）。
    "get-settings": () => ({ ok: true, settings: settingsPayload })
  });
  chromeStub.runtime.connect = vi.fn(() => ({
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (_fn: (msg: unknown) => void) => {} },
    onDisconnect: { addListener: (_fn: () => void) => {} }
  }));
  // storage.local = 共享内存面单源（写后可读回，三方法都是 vi.fn，调用记录照旧可断言）；
  // sync 面只记调用、不写盘——这些用例只断言 sync 写实参。
  chromeStub.storage.local = createMemoryStorageArea();
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

// 装载组合根并走完 init（loadProvidersAndPrefs 之后的 refreshThinkingUi 首判
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

// 列表里带勾（is-active）的档位值。2026-10-05 裁定 B 起：勾 = **实发档**（口径 ⑤），
// 不再是「偏好落在哪一项」——偏好 ≠ 实发时勾随实发走，点它即把该档写成偏好。
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

// chip 上的档位字与一级行右侧的值（口径 ③：两处同源显示，偏好 ≠ 实发时写实发档）。
function chipLevelText(): string {
  const node = document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement | null;
  return node?.textContent || "";
}

function levelRowValueText(): string {
  const node = document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement | null;
  return node?.textContent || "";
}

// ============================================================
// 显示口径统一（2026-10-05 复审 + 裁定 B，票据 chat-thinking-submenu/05）：偏好 ≠ 实发档时
// 一级行/chip/列表的勾**一律写实发档**，两格（档位型 clamp / off 关不掉）各有一处真相；
// 勾 = 实发档，点勾住的那一项即把该档写成偏好（用户显式接受本次 clamp），偏好的偏差由
// 面板底部提示行说明。
// 走查同时写出可复现工件（.scratch/tickets/chat-thinking-submenu/artifacts/05-showing-effective-level.txt）。
// 先列可能失败的方式：① clamp 格 chip 仍写被裁掉的偏好；② 两格提示句式不一致（一个带原因）；
// ③ 勾仍按偏好算（两格无人打勾，答不出线上实际发什么）；④ 偏好被迁移（换回原模型不回落）；
// ⑤ 勾住的那一项点下去不写偏好（用户以为选了、存储里还是旧偏好）。
// ============================================================
describe("口径 ③/⑤ 统一：偏好 ≠ 实发档 → 一级行/chip/勾都落在实发档（走查 + 工件）", () => {
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
          `勾=[${effectiveThinkingLevels().join(",")}]`,
          `chip=${chipLevelText()}`,
          `一级行=${levelRowValueText()}`,
          `提示=${getHint().hidden ? "-" : getHint().textContent}`
        ].join(" | ")
      );
    }

    // ① 档位型 clamp：偏好 high 被裁到 medium → chip/一级行 Medium、勾随实发落在 medium、提示两句式。
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "medium", "xhigh"]);
    expect(effectiveThinkingLevels()).toEqual(["medium"]);
    expect(chipLevelText()).toBe("Medium");
    expect(levelRowValueText()).toBe("Medium");
    expect(getHint().textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
    snap("1 qwen/qwen3.8-max（偏好 high → 实发 medium）");

    // ② 点勾住的实发档 medium（裁定 B：点它即把该档写成偏好）→ 偏好落盘 medium、提示收起。
    clickThinking("medium");
    expect(chatSessionState.aiThinkingLevel).toBe("medium");
    expect(chipLevelText()).toBe("Medium");
    expect(getHint().hidden).toBe(true);
    snap("2 qwen/qwen3.8-max（点勾住的 medium → 偏好落盘 medium）");

    // ③ 走真实持久化链把偏好改成 off：chip 照实发档回 Off、勾落 off、提示仍收起。
    clickThinking("off");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevelText()).toBe("Off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);
    snap("3 qwen/qwen3.8-max（偏好落盘 off）");

    // ④ off 关不掉：偏好 off 被级联到 high → chip/一级行 High、勾随实发落在 high、长版提示。
    select.value = modelOptionValue("p2", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["default", "high", "max"]);
    expect(effectiveThinkingLevels()).toEqual(["high"]);
    expect(chipLevelText()).toBe("High");
    expect(levelRowValueText()).toBe("High");
    expect(getHint().textContent).toBe(HINT_LOW_FALLBACK);
    snap("4 sensenova/glm-5.2（偏好 off → 实发 high）");

    // ⑤ 偏好不迁移：换回支持 off 的模型，偏好原样解析（仍是 off、不是被级联改写的 high）。
    select.value = modelOptionValue("p1", "qwen3.8-max");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevelText()).toBe("Off");
    expect(getHint().hidden).toBe(true);
    snap("5 qwen/qwen3.8-max（偏好仍 off，未被 ④ 迁移）");

    // ⑥ 关不掉那一格点勾住的实发档 high：偏好这才迁移成 high、长文案收起、勾仍在 high。
    select.value = modelOptionValue("p2", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

// 06 号票：面板档位 chip 按「该模型实际可用的档位」渲染（来源三层：上游逐模型
// 词表 / 借词类默认 / 回落今日三档）。只显示存在的档位、不置灰；被 05 clamp 掉的
// 偏好走既有说明文本，不做成禁用 chip；零档行（budget-only）只剩 Default 一项。
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

    // 上游 toggle + 已登记开关形状：off 真发 thinking:{type:"disabled"}、非 off 档发平台开词
    // adaptive（enum 里没有 enabled），面板收成 Default/Off/On 三项。
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "Off", "On"]);
    expect(getHint().hidden).toBe(true);
  });

  it("未登记词表且借不到（custom 自填端点）：不现渲任何档位，只保留「关不掉/不发参」说明", async () => {
    providersPayload = [provider({ id: "p1", model: "vendor-future-1", baseUrl: "https://api.example.com/v1", presetId: "custom" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default"]);
    // 无结论（fail-closed）：off 既不「可用」也不算「关不掉」，静默（与请求不发一致）。
    expect(getHint().hidden).toBe(true);
  });

  it("无上游平台（ollama）：仍显示今日三档", async () => {
    providersPayload = [provider({ id: "p1", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" })];

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high"]);
  });

  // 2026-10-04 用户裁定（A' = 上游词表在平台可表达的部分）：托管平台也不再整域放宽。
  // 13 号票 canonical 优先：sensenova/glm-5.2 的 canonical（zhipuai/glm-5.2）是 high-max
  // → 模型侧无 off → A' = {high, max}（丢 off 照收；18 号票删平台声明后 max 也显示出来）。
  it("high/max 类（sensenova/glm-5.2）：条目 = {high,max}；偏好 low 向上落 high（提示逐字）", async () => {
    providersPayload = [provider({ id: "p1", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" })];
    settingsPayload = { aiThinkingLevel: "low" };

    await activateChatTab();

    expect(renderedThinkingLevels()).toEqual(["default", "high", "max"]);
    // 偏好 low 保留在存储里（不迁移），本模型无 ≤ low 的档 → 落最小可用档 high。
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe(HINT_CLAMP_LOW_TO_HIGH);
    // 没有禁用态条目（被 clamp 掉的 low 是「不存在」而不是「灰色」）：
    // 条目只有两个，且高档位是上游词。
    expect(renderedThinkingLabels()).toEqual(["Default", "High", "Max"]);
    expect(getThinkingBtn("low")).toBe(null);
  });

  // 口径 ③/⑤（2026-10-05 复审 + 裁定 B）：关不掉时一级行/chip/勾都显示**实发档**，不再显示
  // 线上没发的 Off；偏好本身不迁移（换到能关的模型仍按 off 解析），但点勾住的实发档即把该档
  // 写成偏好（用户显式接受本次 clamp），所以它不是「重复选择」。
  it("偏好 off 且关不掉（sensenova/glm-5.2 → 级联发 high）：一级行 High、勾在 high、长文案在场", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-5.2", baseUrl: SENSENOVA_URL, presetId: "sensenova" }),
      provider({ id: "p2", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })
    ];
    settingsPayload = { aiThinkingLevel: "off" };

    await activateChatTab();

    const chipLevel = () =>
      (document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-level`) as HTMLElement).textContent;
    // A' = {high,max}：off 关不掉 → 级联落最小可用档 high（线上发 output_config.effort high）。
    expect(renderedThinkingLevels()).toEqual(["default", "high", "max"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "High", "Max"]);
    expect(effectiveThinkingLevels()).toEqual(["high"]);
    expect(chipLevel()).toBe("High");
    expect((document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement).textContent).toBe("High");
    // 工单 03 的长文案不动：它说的是「已使用最小思考档位」，与一级行的 High 一致。
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe(HINT_LOW_FALLBACK);

    // 偏好没有被迁移：切到能关的模型仍按 off 解析（一级行回 Off、勾落 off、提示收起）。
    const select = getModelSelect();
    select.value = modelOptionValue("p2", "deepseek-v4-pro");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevel()).toBe("Off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);

    // 切回来点勾住的实发档：偏好这才迁移成 high（存储 + 提示收起，勾仍在 high）。
    select.value = modelOptionValue("p1", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

    // 上游值集含 effort none（与平台方言无关）→ off 有写点；18 号票前平台声明无 off 写点，
    // 曾落「关不掉」长文案，现在偏好 off 直接满足。
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);
    // 非 off 只有一个真实档位 → 按用户裁定显示为 On（不是 High）。
    expect(renderedThinkingLabels()).toEqual(["Default", "Off", "On"]);
    expect(getHint().hidden).toBe(true);
  });

  it("clamp 掉的偏好不做成禁用条目：qwen3.8-max + high → High 不存在（无 active、无 disabled），文案在场", async () => {
    providersPayload = [provider({ id: "p1", model: "qwen3.8-max", baseUrl: QWEN_BASE_URL, presetId: "qwen" })];
    settingsPayload = { aiThinkingLevel: "high" };

    await activateChatTab();

    // 上游词表 toggle+low-medium-xhigh：High 不存在（不现渲、不置灰）。
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "medium", "xhigh"]);
    expect(getThinkingBtn("high")).toBe(null);
    // 偏好档位没有对应条目 → 勾落在**实发档** medium（口径 ⑤ 裁定 B：勾 = 线上实际发的那一档），
    // 且 chip 与一级行同样显示 Medium；偏好的偏差由说明文本承担。
    expect(effectiveThinkingLevels()).toEqual(["medium"]);
    expect(getHint().textContent).toBe(HINT_CLAMP_HIGH_TO_MEDIUM);
    expect(chipLevelText()).toBe("Medium");
  });

  it("模型切换即重渲条目：开关型（2 项）→ 三档模型 → 空集模型 → 切回", async () => {
    providersPayload = [
      provider({ id: "p1", model: "glm-4.6", baseUrl: GLM_BASE_URL, presetId: "zhipu" }),
      provider({ id: "p2", model: "llama3.2", baseUrl: OLLAMA_URL, presetId: "ollama" }),
      // 空集模型改用 budget-only 的 openrouter 行：minimax/MiniMax-M3 自 2026-10-05 登记开关
      // 形状后是开关型（Default/Off/On），不再是 A' = ∅。
      provider({ id: "p3", model: "anthropic/claude-haiku-4.5", baseUrl: OPENROUTER_URL, presetId: "openrouter" })
    ];

    await activateChatTab();
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high"]);

    const select = getModelSelect();
    select.value = modelOptionValue("p2", "llama3.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high"]);

    select.value = modelOptionValue("p3", "anthropic/claude-haiku-4.5");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["default"]);
    expect(thinkingRow().hidden).toBe(false);

    // 切回开关型模型：条目全部回来（渲染幂等，不是一次性改写）。
    select.value = modelOptionValue("p1", "glm-4.6");
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

// ============================================================
// 内联思考强度滑块端到端走查：真实模板 + 真实组合根，
// 全链只走 DOM 事件——开面板（点 chip）→ 模型列表与底部思考强度滑块同屏可见 →
// 选档（点刻度 / 点 ↻ 重置）→ 落盘 + chip 更新 + 面板保持打开 → 点模型项才关面板。
// ============================================================
describe("内联思考强度滑块端到端走查", () => {
  it("开面板 → 模型列表与底部思考滑块同屏 → 选档落盘 + chip 更新 + 面板保持打开 → 点模型项关面板", async () => {
    providersPayload = [provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" })];

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

    // 0. 激活后：面板关着，档位区已按模型现渲（default/off/low/high/max，默认 Default）。
    expect(panel.hidden).toBe(true);
    snap("0 激活后");

    // 1. 点 chip 开面板：模型列表与底部思考强度区同屏显示。
    click(chip);
    expect(panel.hidden).toBe(false);
    expect(list.hidden).toBe(false);
    expect(row.hidden).toBe(false);
    snap("1 点 chip 开面板");

    // 2. 点 Max：写偏好（storage + save-settings 同值）+ chip 更新 + 面板保持打开。
    storageSet.mockClear();
    clickThinking("max");
    expect(chatSessionState.aiThinkingLevel).toBe("max");
    expect(storageSet).toHaveBeenCalledWith({ [THINKING_LEVEL_KEY]: "max" });
    expect(chipLevel.textContent).toBe("Max");
    expect((document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement).textContent).toBe("Max");
    expect(panel.hidden).toBe(false);
    expect(requireThinkingBtn("max").classList.contains("is-active")).toBe(true);
    snap("2 点 Max 选档（面板保持打开）");

    // 3. 点模型项：面板立即关闭。
    const firstModelOption = list.querySelector<HTMLButtonElement>(".chat-model-option") as HTMLButtonElement;
    click(firstModelOption);
    expect(panel.hidden).toBe(true);
    snap("3 点模型项关面板");

    expect(steps).toHaveLength(4);
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
          `勾=[${effectiveThinkingLevels().join(",")}]`,
          `chip=${chipLevel.textContent}`,
          `提示=${getHint().hidden ? "-" : getHint().textContent}`
        ].join(" | ")
      );
    }

    // ① 目录内·原生（zhipu 方言 thinking:{type}）：Off 条目在场、偏好 off 满足、无提示。
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high", "max"]);
    expect(renderedThinkingLabels()).toEqual(["Default", "Off", "High", "Max"]);
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(getHint().hidden).toBe(true);
    snap("1 zhipu/glm-5.2（目录内·原生）");

    // 走一遍真实点击：Off → Max → 回 Off，chip 与落盘同步（补声明新开的 Off 条目真能选中）。
    clickThinking("max");
    expect(effectiveThinkingLevels()).toEqual(["max"]);
    expect(chatSessionState.aiThinkingLevel).toBe("max");
    expect(chipLevel.textContent).toBe("Max");
    clickThinking("off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(chipLevel.textContent).toBe("Off");

    // ② 目录内·托管（qwen 方言 enable_thinking）：A' 同为 {off,high,max}，偏好 off 静默。
    select.value = modelOptionValue("p2", "glm-5.2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["default", "off", "high", "max"]);
    expect(getHint().hidden).toBe(true);
    snap("2 qwen/glm-5.2（托管·借词）");

    // ③ 三家未登记开关形状的行：事实带 toggle 但无写点 → 条目仍是 {high,max}、提示逐字不变，
    //    一级行/chip/勾按口径 ③/⑤ 都落在实发档 high。
    const unregistered: ReadonlyArray<[providerId: string, label: string, model: string]> = [
      ["p3", "openrouter/z-ai/glm-5.2", "z-ai/glm-5.2"],
      ["p4", "sensenova/glm-5.2", "glm-5.2"],
      ["p5", "opencodego/glm-5.2", "glm-5.2"]
    ];
    for (const [index, [providerId, label, model]] of unregistered.entries()) {
      select.value = modelOptionValue(providerId, model);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(renderedThinkingLevels(), label).toEqual(["default", "high", "max"]);
      expect(effectiveThinkingLevels(), label).toEqual(["high"]);
      expect(chipLevel.textContent, label).toBe("High");
      expect(getHint().hidden, label).toBe(false);
      expect(getHint().textContent, label).toBe(HINT_LOW_FALLBACK);
      snap(`${3 + index} ${label}（平台形状未登记）`);
    }

    // ④ 目录外兜底（glm-5.2-air）：off 出口与目录内同为 thinking 开关（档位词表本来就不同）。
    select.value = modelOptionValue("p6", "glm-5.2-air");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high"]);
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
        "#       一级行/chip/勾按口径 ③/⑤（2026-10-05 复审 + 裁定 B）都落在实发档 High——线上发 high，界面不再写 Off",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});

// ============================================================
// default（不干预）档端到端走查（2026-10-05 用户裁定）：真实模板 + 真实组合根。
// 先列可能失败的方式：① 出厂默认没落到 default（chip/一级行仍写 Off、请求仍发关思考字段）；
// ② Default 条目没现渲或没打勾（用户看不到自己选的是「不干预」）；
// ③ 点 Default 不写偏好 / 点了别的档 Default 不取消打勾；④ 零档行（无强度档）一级行被隐藏
//（用户裁定「破例 = 能主动选」）；⑤ 零档行偏好强度档时不报「已调整」，chip 与线上不符。
// ============================================================
describe("default（不干预）档端到端走查：出厂默认与零档行", () => {
  // 零档行（A' = ∅）的代表：budget-only 的 openrouter 行。**不用 minimax/MiniMax-M3**——
  // 它自 2026-10-05 登记开关形状后是开关型（Default/Off/On），不再是零档行。
  const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
  const ZERO_TIER_MODEL = "anthropic/claude-haiku-4.5";

  it("出厂默认 = Default（chip/一级行/打勾），点 Off 落到 off、点回 Default 复位；零档行只剩 Default 也能主动选", async () => {
    providersPayload = [
      provider({ id: "p1", model: "deepseek-v4-pro", baseUrl: DEEPSEEK_BASE_URL, presetId: "deepseek" }),
      provider({ id: "p2", model: ZERO_TIER_MODEL, baseUrl: OPENROUTER_BASE_URL, presetId: "openrouter" })
    ];
    // 出厂形态：没有任何 aiThinkingLevel 落盘（get-settings 返回空载荷）。
    settingsPayload = {};

    await activateChatTab();

    const select = getModelSelect();
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

    // ① 出厂默认 = default：一级行/chip 都写 Default，列表首项 Default 打勾，无提示。
    expect(chatSessionState.aiThinkingLevel).toBe("default");
    expect(renderedThinkingLevels()).toEqual(["default", "off", "low", "high", "max"]);
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(chipLevel.textContent).toBe("Default");
    expect(thinkingRowValue.textContent).toBe("Default");
    expect(getHint().hidden).toBe(true);
    snap("1 deepseek/deepseek-v4-pro（出厂默认 = Default）");

    // ② 点 Off：偏好真落盘 off、Default 取消打勾、chip 跟着走。
    clickThinking("off");
    expect(chatSessionState.aiThinkingLevel).toBe("off");
    expect(effectiveThinkingLevels()).toEqual(["off"]);
    expect(chipLevel.textContent).toBe("Off");
    snap("2 点 Off（显式关思考）");

    // ③ 点回 Default：偏好回到不干预（不是「再也没法不说话」）。
    clickThinking("default");
    expect(chatSessionState.aiThinkingLevel).toBe("default");
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(chipLevel.textContent).toBe("Default");
    snap("3 点回 Default（不干预）");

    // ④ 零档行（budget-only 的 openrouter 行，A' = ∅）：一级行照旧显示、列表只剩 Default。
    select.value = modelOptionValue("p2", ZERO_TIER_MODEL);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderedThinkingLevels()).toEqual(["default"]);
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(thinkingRow().hidden).toBe(false);
    expect(chipLevel.textContent).toBe("Default");
    expect(getHint().hidden).toBe(true);
    snap(`4 openrouter/${ZERO_TIER_MODEL}（零档行，偏好 default）`);

    // ⑤ 零档行 + 偏好强度档（high）：先在有强度档的模型上把偏好点成 high（走真实持久化链），
    // 再切到零档行 —— 实发 default、勾落在 Default（口径 ⑤：勾 = 实发档）、如实报「已使用 default」。
    select.value = modelOptionValue("p1", "deepseek-v4-pro");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    clickThinking("high");
    expect(chatSessionState.aiThinkingLevel).toBe("high");
    select.value = modelOptionValue("p2", ZERO_TIER_MODEL);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chipLevel.textContent).toBe("Default");
    expect(effectiveThinkingLevels()).toEqual(["default"]);
    expect(getHint().hidden).toBe(false);
    expect(getHint().textContent).toBe("当前模型不支持思考强度 high，已使用 default");
    snap(`5 openrouter/${ZERO_TIER_MODEL}（零档行，偏好 high）`);

    // 工件：逐步快照（可重跑，内容确定）。
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
