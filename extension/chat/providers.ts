// extension/chat/providers.ts — AI 平台加载渲染 + 思考档位（候选5 自 sidepanel.ts
// 迁出；PR5 自 extension/pages/sidepanel-providers.ts 迁入 chat 域并改造持久化
// 通道）：loadProvidersAndPrefs（providers + aiPrefs 整体加载，settings 获取走
// core 域消息）、renderModelSelect、renderThinkingLevel、setThinkingLevel、
// setSelectedProvider。
// refreshProvidersAndPrefsAfterExternalChange 的「流式则不重渲染」守卫留在
// sidepanel.ts（chatRuntime 编排职责），本模块只提供加载本体。
//
// PR5 改造（持久化通道）：SELECTED_PROVIDER_KEY / THINKING_LEVEL_KEY 从
// sidepanel 页面的 localStorage 换成 chrome.storage.local——reader 上下文与
// 扩展页 localStorage 不同源，不迁移则「选中的平台」在 reader 内每次丢失
// （盘点报告风险点 2）。aiThinkingLevel 原有的 sync settings 双持久化保留
//（读取以 settings ?? storage 为准）。localStorage 过渡迁移已随旧 sidepanel
// 扩展页退役一并移除：迁移只能发生在扩展页上下文（reader 上下文读不到扩展
// localStorage），该页面已不存在，无可迁移存量（最坏损失 = 重选一次平台）。
//
// 依赖方向（无环）：共享可变状态（providers / aiPrefs / aiThinkingLevel）直接
// import；sendRuntimeMessage（shared 传输层）、chrome.storage 抽象（可注入，
// 缺省全局 chrome.storage.local）、DOM 元素（modelSelect / thinkingBtns /
// updateModelSelectWidth 的 els 引用包）、渲染回调（renderPresetPrompts、
// persistAiPresetPrompts 惰性互引 presets 实例）经工厂 deps 注入。本模块不
// import 组合根。
import {
  DEFAULT_PRESET_PROMPTS
} from "../core/default-prompts.js";
import {
  normalizeAiInitialQuickPrompts,
  normalizeAiPresetPrompts,
  normalizeAiThinkingLevel
} from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { GetSettingsResponse } from "../shared/messaging-protocol.js";
import { escapeHtml } from "../shared/string-utils.js";
// 选中项键与复合值编解码的单源在 shared 叶子（ai 域同源消费，见该模块头注）；
// 本模块按原导入面再导出，既有消费方（chat-tab / image-support / 测试）不受影响。
import {
  SELECTED_PROVIDER_KEY,
  MODEL_OPTION_SEPARATOR,
  buildModelOptionValue,
  parseModelOptionValue
} from "../shared/selected-provider.js";
import { updateModelSelectWidth } from "./model-select-width.js";
import { chatSessionState } from "./chat-state.js";
import type { ModelSelectWidthEls } from "./model-select-width.js";

export const THINKING_LEVEL_KEY = "biliscript_ai_thinking_level";
export { SELECTED_PROVIDER_KEY, MODEL_OPTION_SEPARATOR, buildModelOptionValue, parseModelOptionValue };

// chrome.storage.local 的窄视图（conversation-store 的 StorageArea 同型；
// 缺省取全局 chrome.storage.local，测试注入 fake）。
export interface ProviderPrefsStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface CreateProviderPrefsDeps {
  modelSelect: HTMLSelectElement;
  thinkingBtns: NodeListOf<HTMLElement>;
  // 联网搜索开关 pill（spec §4，chat header 工具条；缺省 = 宿主无此控件）
  webSearchPill?: HTMLElement | null;
  // updateModelSelectWidth 的 els 引用包（含 chip/chipLabel/inputBar——发送框
  // 重构起度量对象是模型 chip 而非 select）
  widthEls: ModelSelectWidthEls;
  renderPresetPrompts: () => void;
  // 惰性互引（组装点以箭头函数接线，回调执行时 presets 实例已存在）
  persistAiPresetPrompts: () => Promise<void>;
  // chrome.storage.local 抽象（PR5 改造：原 localStorage 通道换此注入点；
  // 缺省取全局 chrome.storage.local）
  storage?: ProviderPrefsStorage;
}

export interface ProviderPrefs {
  loadProvidersAndPrefs: (opts?: { preferredProviderId?: string }) => Promise<void>;
  renderModelSelect: (preferredProviderId?: string) => void;
  setThinkingLevel: (level: string) => Promise<void>;
  // 联网搜索开关（spec §4）：点击即改全局记忆（sync settings.webSearchEnabled），
  // 默认关。渲染与写入同收口。
  setWebSearchEnabled: (enabled: boolean) => Promise<void>;
  // 选中项写入 chrome.storage.local（原 sidepanel.ts modelSelect change
  // 监听里的 localStorage.setItem 换通道）；闭包缓存同步更新供
  // renderModelSelect 的同步回退读取。multi-model-catalog 起写入的是复合值
  // （"pid\u0001model"，见 buildModelOptionValue），旧裸平台 id 读路径由
  // renderModelSelect 的选中回落兼容。
  setSelectedProvider: (providerId: string) => void;
  // 最近一次读到的 chrome.storage 选中平台（组合根在外部变更刷新时取
  // previousProviderId 用——原 localStorage.getItem 的替代）。
  getStoredSelectedProviderId: () => string;
}

// 平台条目 → 模型目录：新载荷读 models（trim/去空/去重，与存储归一化同口径）；
// 旧单模型载荷/测试字面量回落 model 包单元素。零模型平台返回空数组——
// 聊天选择器中不显示（拍板 Q13：目录外 ID 仍可直接发送）。
function normalizeProviderModels(provider: { models?: unknown; model?: unknown }): string[] {
  if (Array.isArray(provider?.models)) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of provider.models) {
      const id = String(entry ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }
  const legacy = String(provider?.model || "").trim();
  return legacy ? [legacy] : [];
}

// 组标题文案：平台名，缺省回落模型名（旧「name/model」合并文案的退化链），
// 都空给空串——与旧行为一致，不放假文案。
function formatProviderLabel(provider: { name?: string; model?: unknown }): string {
  const name = String(provider.name || "").trim();
  if (name) {
    return name;
  }
  return String(provider.model || "").trim();
}

export function createProviderPrefs(deps: CreateProviderPrefsDeps): ProviderPrefs {
  const { modelSelect, thinkingBtns, widthEls, webSearchPill } = deps;
  const storage =
    deps.storage ||
    (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : undefined);

  // chrome.storage.local 里最近读到的选中平台 id（loadProvidersAndPrefs 异步
  // 预取 + setSelectedProvider 写入时同步更新）。renderModelSelect 的同步回退
  // 读取由该闭包缓存承接——localStorage 时代「同步读选中平台」的语义。
  let storedSelectedProviderId = "";

  // 读 chrome.storage.local 两个偏好键（读取失败按空对象容错，偏好允许丢）。
  async function loadStoredPrefs(): Promise<Record<string, unknown>> {
    if (!storage) {
      return {};
    }
    try {
      return (await storage.get([SELECTED_PROVIDER_KEY, THINKING_LEVEL_KEY])) || {};
    } catch {
      return {};
    }
  }

  // ai-providers-list 响应里的平台条目由 ChatSessionProvider（chat-state.ts）
  // 描述：id 必填，name/model/enabled 宽松可选。响应形状自 arch-slim-2/02 起
  // 由消息类型经 ResponseOf 推断（原手猜元组断言移除）；线上条目
  //（aiProviderStore 归一化，id 必填）经显式映射落型为 ChatSessionProvider。
  async function loadProvidersAndPrefs({ preferredProviderId = "" }: { preferredProviderId?: string } = {}): Promise<void> {
    const [providersResp, settingsResp, storedPrefs] = await Promise.all([
      sendRuntimeMessage({ type: "ai-providers-list" }),
      // get-settings 失败按「无设置」回落：显式标注回包类型，settings 读取单轨
      sendRuntimeMessage({ type: "get-settings" }).catch(
        (): GetSettingsResponse => ({ ok: false, error: "" })
      ),
      loadStoredPrefs()
    ]) ;
    storedSelectedProviderId = String(storedPrefs[SELECTED_PROVIDER_KEY] || "").trim();
    // 与迁移前同语义：只看 providers 载荷，不查 ok（ok:false / 缺 key 一律空列表）
    const providers = Array.isArray(providersResp?.providers) ? providersResp.providers : [];
    chatSessionState.providers = providers
      .filter((p) => p.enabled)
      .map((p) => ({
        id: String(p.id || ""),
        // name 不在 AiProvider 显式字段里（走索引签名，unknown），按串收窄
        name: typeof p.name === "string" ? p.name : undefined,
        model: p.model,
        // 模型目录（multi-model-catalog）：渲染分组选项与选中回落的口径来源
        models: normalizeProviderModels(p),
        // baseUrl / presetId 透传（AiProvider 显式字段）：思考档位「关不掉」提示的
        // resolver 识别入参（工单 03，沿本消息链读取、不开新链）。presetId 是
        // 识别主路径（02 票纪律），baseUrl 供 custom/反代场景的 host 兜底。
        baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
        presetId: typeof p.presetId === "string" ? p.presetId : undefined,
        enabled: p.enabled
      }));
    const settings = settingsResp?.ok ? settingsResp.settings : null;
    chatSessionState.aiPrefs = {
      aiSystemPrompt: String(settings?.aiSystemPrompt || "").trim(),
      aiInitialQuickPrompts: normalizeAiInitialQuickPrompts(settings?.aiInitialQuickPrompts),
      aiPresetPrompts: normalizeAiPresetPrompts(settings?.aiPresetPrompts),
      defaultModel: String(settings?.defaultModel || "").trim()
    };
    chatSessionState.aiThinkingLevel = normalizeAiThinkingLevel(
      settingsResp?.settings?.aiThinkingLevel ?? storedPrefs[THINKING_LEVEL_KEY]
    );
    // 联网搜索开关（spec §2.1/§4）：全局记忆（sync settings），默认关。
    chatSessionState.webSearchEnabled = Boolean(settings?.webSearchEnabled);
    if (!chatSessionState.aiPrefs.aiPresetPrompts.length) {
      chatSessionState.aiPrefs.aiPresetPrompts = DEFAULT_PRESET_PROMPTS.slice();
      void deps.persistAiPresetPrompts();
    }
    renderModelSelect(preferredProviderId);
    renderThinkingLevel();
    renderWebSearchEnabled();
    deps.renderPresetPrompts();
  }

  // 选中值回落：依次尝试传入优先值 / chrome.storage 选中值（复合值，精确到
  // 模型）/ settings defaultModel（裸平台 id，只能解析到平台首个模型）。storage
  // 选中值必须排在 defaultModel 之前：两者由模型切换监听同趟写入（lifecycle 的
  // change 处理器），defaultModel 只是裸平台 id——排在前面会把 storage 里的精确
  // 模型选择遮蔽成「平台首个模型」，新开页面就丢模型（更换模型不被记住）。
  // 每个候选都接受新复合值（buildModelOptionValue 产物）与旧裸平台 id 两种
  // 形态；裸 id 命中平台时回落该平台首个模型（旧选中记录向前兼容）。全部
  // 不命中则首选项。
  function resolveOptionValue(
    saved: string,
    groups: Array<{ provider: (typeof chatSessionState.providers)[number]; models: string[] }>,
    optionValues: Set<string>
  ): string {
    if (!saved) return "";
    if (optionValues.has(saved)) return saved;
    const group = groups.find((g) => String(g.provider.id) === saved);
    if (group && group.models.length) {
      return buildModelOptionValue(String(group.provider.id), group.models[0]);
    }
    return "";
  }

  function renderModelSelect(preferredProviderId = ""): void {
    // 按平台 optgroup 分组、一模型一选项（multi-model-catalog 拍板 Q8）。
    // 零模型平台不进选择器（拍板 Q13）；所有平台都没有模型时等同未配置。
    const groups = chatSessionState.providers
      .map((provider) => ({ provider, models: normalizeProviderModels(provider) }))
      .filter((group) => group.models.length > 0);
    if (!groups.length) {
      modelSelect.innerHTML = '<option value="">未配置平台</option>';
      modelSelect.disabled = true;
      modelSelect.style.width = "96px";
      return;
    }

    modelSelect.innerHTML = groups
      .map((group) => {
        const providerId = String(group.provider.id || "");
        const options = group.models
          .map(
            (model) =>
              `<option value="${escapeHtml(buildModelOptionValue(providerId, model))}">${escapeHtml(model)}</option>`
          )
          .join("");
        return `<optgroup label="${escapeHtml(formatProviderLabel(group.provider))}">${options}</optgroup>`;
      })
      .join("");

    const optionValues = new Set(
      groups.flatMap((group) =>
        group.models.map((model) => buildModelOptionValue(String(group.provider.id), model))
      )
    );
    const firstValue = buildModelOptionValue(String(groups[0].provider.id), groups[0].models[0]);

    const candidates = [
      preferredProviderId,
      storedSelectedProviderId,
      chatSessionState.aiPrefs.defaultModel || ""
    ];
    let matched = "";
    for (const candidate of candidates) {
      matched = resolveOptionValue(String(candidate || "").trim(), groups, optionValues);
      if (matched) break;
    }
    modelSelect.value = matched || firstValue;
    modelSelect.disabled = false;
    updateModelSelectWidth(widthEls);
  }

  function renderThinkingLevel(): void {
    thinkingBtns.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.level === chatSessionState.aiThinkingLevel);
      btn.setAttribute("aria-pressed", btn.dataset.level === chatSessionState.aiThinkingLevel ? "true" : "false");
    });
  }

  async function setThinkingLevel(level: string): Promise<void> {
    chatSessionState.aiThinkingLevel = normalizeAiThinkingLevel(level);
    renderThinkingLevel();
    if (storage) {
      await storage.set({ [THINKING_LEVEL_KEY]: chatSessionState.aiThinkingLevel }).catch(() => {});
    }
    await sendRuntimeMessage({ type: "save-settings", settings: { aiThinkingLevel: chatSessionState.aiThinkingLevel } }).catch(() => null);
  }

  // 联网搜索开关渲染（spec §4）：pill 开启态 is-active（accent-soft 底）。
  function renderWebSearchEnabled(): void {
    if (!webSearchPill) return;
    webSearchPill.classList.toggle("is-active", chatSessionState.webSearchEnabled);
    webSearchPill.setAttribute("aria-pressed", chatSessionState.webSearchEnabled ? "true" : "false");
  }

  async function setWebSearchEnabled(enabled: boolean): Promise<void> {
    chatSessionState.webSearchEnabled = Boolean(enabled);
    renderWebSearchEnabled();
    await sendRuntimeMessage({ type: "save-settings", settings: { webSearchEnabled: chatSessionState.webSearchEnabled } }).catch(() => null);
  }

  function setSelectedProvider(providerId: string): void {
    storedSelectedProviderId = String(providerId || "").trim();
    if (storage) {
      void storage.set({ [SELECTED_PROVIDER_KEY]: storedSelectedProviderId }).catch(() => {});
    }
  }

  function getStoredSelectedProviderId(): string {
    return storedSelectedProviderId;
  }

  return { loadProvidersAndPrefs, renderModelSelect, setThinkingLevel, setWebSearchEnabled, setSelectedProvider, getStoredSelectedProviderId };
}
