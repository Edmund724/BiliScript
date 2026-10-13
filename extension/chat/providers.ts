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
// 依赖方向（无环）：共享可变状态（providers / aiPrefs / aiThinkingLevel）经
// chat-state 的只读视图读、经其意图原语写；sendRuntimeMessage（shared 传输层）、
// chrome.storage 抽象（可注入，缺省全局 chrome.storage.local）、DOM 元素
//（modelSelect / thinkingBtns / updateModelSelectWidth 的 els 引用包）经工厂
// deps 注入。本模块不 import 组合根。
import {
  normalizeAiInitialQuickPrompts,
  normalizeAiThinkingLevel
} from "../core/validators.js";
// 档位入参的声明面（未归一的外部值；词表叶，纯类型引入、无运行时依赖边）。
import type { ThinkingLevelInput } from "../ai/thinking-levels.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
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
import {
  applyProviderPrefs,
  chatSessionState,
  setAiThinkingLevel,
  // 与本地同名（本模块对外导出的 setWebSearchEnabled 工厂件）：状态写走别名
  setWebSearchEnabled as setWebSearchEnabledState
} from "./chat-state.js";
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
  // 联网搜索开关 pill（spec §4，chat header 工具条；缺省 = 宿主无此控件）
  webSearchPill?: HTMLElement | null;
  // updateModelSelectWidth 的 els 引用包（含 chip/chipLabel/inputBar——发送框
  // 重构起度量对象是模型 chip 而非 select）
  widthEls: ModelSelectWidthEls;
  // chrome.storage.local 抽象（PR5 改造：原 localStorage 通道换此注入点；
  // 缺省取全局 chrome.storage.local）
  storage?: ProviderPrefsStorage;
}

export interface ProviderPrefs {
  loadProvidersAndPrefs: (opts?: { preferredProviderId?: string }) => Promise<void>;
  renderModelSelect: (preferredProviderId?: string) => void;
  // 思考档位落盘（设置 / 面板侧的归一入口）：入参是**未归一的外部值**——合法档位、缺省、
  // 端口 / 面板里真实可到的脏值都可能到（宽容面见 ai/thinking-levels.ts 的
  // ThinkingLevelInput）。归一化在下面的实现里做一次（缺省 / 脏值 → default，见 ADR-0015
  // 修订块），所以这里收的是声明面而不是过滤器。
  setThinkingLevel: (level: ThinkingLevelInput) => Promise<void>;
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
  const { modelSelect, widthEls, webSearchPill } = deps;
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
    const settings = settingsResp?.ok ? settingsResp.settings : null;
    // 四组偏好同出一份加载结果（平台列表 / aiPrefs / 思考档位 / 联网开关）：
    // 整组经 chat-state 的意图原语落地（B 档只读面，ADR-0005）。
    applyProviderPrefs({
      providers: providers
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
        })),
      aiPrefs: {
        aiSystemPrompt: String(settings?.aiSystemPrompt || "").trim(),
        aiInitialQuickPrompts: normalizeAiInitialQuickPrompts(settings?.aiInitialQuickPrompts),
        defaultModel: String(settings?.defaultModel || "").trim()
      },
      // 出厂/重置默认 = DEFAULT_SETTINGS 的那一份（2026-10-05 起是 `default` 不干预档）：
      // settings 与 storage 两处都没有值时，回落单源默认，而不是在这里硬写一个档位词
      //（否则新装用户界面写 Off、线上却按「不干预」发——与用户裁定相反）。
      aiThinkingLevel: normalizeAiThinkingLevel(
        settingsResp?.settings?.aiThinkingLevel ?? storedPrefs[THINKING_LEVEL_KEY] ?? DEFAULT_SETTINGS.aiThinkingLevel
      ),
      // 联网搜索开关（spec §2.1/§4）：全局记忆（sync settings），默认关。
      webSearchEnabled: Boolean(settings?.webSearchEnabled)
    });
    renderModelSelect(preferredProviderId);
    renderWebSearchEnabled();
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

  // 档位落盘（不碰 UI）：档位区 DOM 已由 reader/chat-model-panel.ts 按
  // chat/thinking-picker 的显示条目现渲（二级菜单），它的选中态与显示名由组合根的
  // refreshThinkingUi 每次重算——原先按静态按钮 data-level 打 is-active 的
  // renderThinkingLevel 随 7 个静态按钮一起退役（2026-10 用户裁定）。
  async function setThinkingLevel(level: ThinkingLevelInput): Promise<void> {
    setAiThinkingLevel(normalizeAiThinkingLevel(level));
    if (storage) {
      await storage.set({ [THINKING_LEVEL_KEY]: chatSessionState.aiThinkingLevel }).catch(() => {});
    }
    await sendRuntimeMessage({ type: "save-settings", settings: { aiThinkingLevel: chatSessionState.aiThinkingLevel } }).catch(() => null);
  }

  // 联网搜索开关渲染（spec §4）：pill 开启态 is-active（accent-soft 底）。
  // 两个静止态的字形完全相同，方向只由切换动画表达：开启 = 经线往左转
  // （is-spinning-left）、关闭 = 往右。只认真实状态变化——首帧（水合）与无变化的
  // 重渲不转，否则每次打开面板、每次刷新偏好都白转一圈。连续两次切换的方向必然
  // 相反，故「先摘类再挂类」在同一帧里就换了 animation-name，动画自然重播。
  let renderedWebSearchEnabled: boolean | null = null;

  function spinWebSearchPill(enabled: boolean): void {
    if (!webSearchPill) return;
    webSearchPill.classList.remove("is-spinning-left", "is-spinning-right");
    webSearchPill.classList.add(enabled ? "is-spinning-left" : "is-spinning-right");
  }

  function renderWebSearchEnabled(): void {
    if (!webSearchPill) return;
    const enabled = chatSessionState.webSearchEnabled;
    const changed = renderedWebSearchEnabled !== null && renderedWebSearchEnabled !== enabled;
    renderedWebSearchEnabled = enabled;
    webSearchPill.classList.toggle("is-active", enabled);
    webSearchPill.setAttribute("aria-pressed", enabled ? "true" : "false");
    if (changed) spinWebSearchPill(enabled);
  }

  // 动画收尾摘类：留着不影响外观（fill-mode 默认 none，结束即回静止字形），但会让
  // 「同一方向的动画」不再重播，且把动画态混进开关态。只认自己的动画名。
  if (webSearchPill) {
    webSearchPill.addEventListener("animationend", (event) => {
      if (event.animationName.startsWith("biliscript-web-search-meridian")) {
        webSearchPill.classList.remove("is-spinning-left", "is-spinning-right");
      }
    });
  }

  async function setWebSearchEnabled(enabled: boolean): Promise<void> {
    setWebSearchEnabledState(Boolean(enabled));
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
