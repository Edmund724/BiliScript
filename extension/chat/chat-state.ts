// extension/chat/chat-state.ts — 对话内核跨子模块共享的可变状态（PR5 自
// extension/pages/sidepanel-state.ts 迁入 chat 域；模块级单例与字段全部保留，
// 仅归属与命名空间变化）。
//
// sidepanel.js 原本持有 20 个模块级可变量，其中 13 个被 conversation-store /
// chat-runtime 子模块经 deps getter/setter 跨模块读写。本模块把这 13 个字段
// 收拢为一个可变状态对象，chat/* 子模块与 sidepanel.js（过渡期组合根）直接
// import 它，deps 里只剩 UI/transport 回调、storage 抽象与常量。
//
// 依赖方向（无环）：本文件 import 纯函数 buildContextKey（ai/conversation.js，
// 无状态无 Chrome API）与编译期 AiContext/ImagePart（import type）；aiPrefs 的
// 初始问题列表
// 现取空数组（空 = 按视频即时生成，见 aiPrefs 字段注释），不再静态取
// core/default-prompts 的固定文案。sidepanel.js / conversation-store.ts /
// chat-runtime.ts 单向 import 本文件。
//
// 纯局部单例（suggestionsNode / contextNoticeTimer / liveContextSyncTimer /
// liveContextSyncForceRefresh / modelSelectMeasureCanvas / initCompleted / els /
// subtitleWaiter / conversationStore / chatRuntime 实例 / shouldAutoScroll-
// Messages）不进本对象：它们只被单一模块使用，留在各自模块里。
//
// 测试注意：本对象是模块级单例，测试里若配合 vi.resetModules 切换模块纪元，
// 需重新 import 本模块取新鲜实例；单纪元内复用时经
// resetChatSessionStateForTests() 重置全部字段（见文件末尾）。

import type { AiContext, ImagePart } from "../ai/types.js";
import { buildContextKey } from "../ai/conversation.js";

// 上下文快照 = ContextFetch 全量 payload 的落地形态（core/context-assembly
// 装配链组出）。结构上与 AI 域的 AiContext 同形（含 subtitleBody /
// isVideoContext / url 等字段与开放索引签名），复用该类型避免第二份手写契约。
export type ChatSessionContextSnapshot = AiContext;

// 可用 AI 平台（loadProvidersAndProviders 过滤 enabled 后写入 providers）
export interface ChatSessionProvider {
  id: string;
  name?: string;
  // 历史单模型字段：ai-providers-list 载荷逐字段透传；新载荷走 models，旧载荷/
  // 测试字面量经 providers.ts 归一进 models 后此处仍保留原值（思考提示等
  // 回落读取）。
  model?: string;
  // 模型目录（multi-model-catalog）：chat 模型选择器按平台 optgroup 分组渲染，
  // 每个模型一个 option；选模型即隐式选定平台（拍板 Q8）。
  models?: string[];
  // 平台请求地址 / preset 词表键（ai-providers-list 载荷透传，不参与渲染）：
  // 思考档位「关不掉」提示的 resolver 识别入参（工单 03，判定在
  // reader/chat-tab.ts；presetId 是主路径，baseUrl 供 custom 场景 host 兜底）。
  baseUrl?: string;
  presetId?: string;
  enabled?: boolean;
}

// 当前会话元信息。字段集与 conversation-store 的 ConversationMeta 对齐（工单
// chat-state 写纪律：显式列出，删掉原先的 [key: string]: unknown 开口子）——
// 全部可选，写入方（conversation-store）按场景只落自己用到的那几项。
export interface CurrentConversationMeta {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  contextKey?: string;
  contextTitle?: string;
  contextUrl?: string;
  isVideoContext?: boolean;
  pinnedContext?: boolean;
  contextRef?: AiContext | null;
  resolvedContext?: AiContext | null;
}

// 一问一答条目（{ role, content }）；role 的取值由写入方约束为 user/assistant。
// 联网搜索（spec §2.5）：tool 轮的 assistant(tool_calls) 与 tool 结果消息
// （tool 内容已截断）也进历史，多轮追问保持工具上下文——字段对齐 ai/types 的
// ChatMessage（tool_calls / tool_call_id，普通消息不带字段）。
export interface ChatSessionMessage {
  role: string;
  content: string;
  // 图片输入（image-input 路线 B）：与 ai/types 的 ChatMessage.images 同形。
  images?: ImagePart[];
  tool_calls?: unknown;
  tool_call_id?: string;
}

// 持久化历史会话（storage 的内存镜像条目）。字段集与 conversation-store 的
// Conversation 对齐（其写入方构造完整对象后落进本状态）；渲染层只读 id/title/
// createdAt/updatedAt。
export interface ChatSessionSavedConversation {
  id: string;
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  createdAt: number;
  updatedAt: number;
  contextRef: unknown;
  messages: unknown[];
  [key: string]: unknown;
}

// 写纪律切片（工单 chat-state 写纪律，仿 core/state.ts 的 Readonly + setter
// 白名单三段交叉）：会话身份三件套（currentConversationId /
// currentConversationMeta / chatHistory）与 savedConversations 收进
// ChatSessionGuardedState；B 档 10 个散字段（contextData / currentContextKey /
// providers / live 三键 / aiPrefs / 杂项标志）收进 ChatSessionOpenState。两段在
// 公开类型 ChatSessionState 上整段 Readonly（aiPrefs / contextData / liveContextData
// 再深一层只读），生产写入一律经本文件末尾的意图级原语——B 档写方归并与只读面收口
// 见文末原语块（ADR-0005 适用范围二的 B 档记录已与此刻口径对齐）。
type ChatSessionGuardedState = {
  // 当前会话的一问一答数组 [{ role, content }]
  chatHistory: ChatSessionMessage[];
  // 持久化的历史会话列表（storage 的内存镜像）
  savedConversations: ChatSessionSavedConversation[];
  // 当前会话 id（"" = 无当前会话）
  currentConversationId: string;
  // 当前会话元信息（id/标题/上下文绑定等）；null = 无当前会话
  currentConversationMeta: CurrentConversationMeta | null;
};

// 思考档位（off/low/high）。持久化口径见 ChatSessionOpenState.aiThinkingLevel。
export type ChatThinkingLevel = "off" | "low" | "high";

// 平台偏好三键（loadProvidersAndPrefs 整体替换，modelSelect 局部改写）。
export interface ChatSessionPreferences {
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
  // modelSelect change 时局部写入（loadProvidersAndPrefs 整体替换前不存在）
  defaultModel?: string;
}

// B 档散字段（contextData / currentContextKey / providers / live 三键 / aiPrefs /
// asrTranscribingActive / aiThinkingLevel / webSearchEnabled）。
type ChatSessionOpenState = {
  // ---- 上下文（loadContextState 写，UI 渲染读） ----
  // 当前应用的上下文快照（视频信息/字幕等）；null = 无上下文
  contextData: ChatSessionContextSnapshot | null;
  // contextData 对应的上下文键（buildContextKey 产物）
  currentContextKey: string;
  // 可用 AI 平台列表（loadProvidersAndPrefs 过滤 enabled 后写入）
  providers: ChatSessionProvider[];
  // ---- 实时上下文（loadContextState 维护的"活跃标签页"快照，与 contextData
  // 分离：流式守卫冻结 contextData 时 live 侧继续断供更新） ----
  liveContextData: ChatSessionContextSnapshot | null;
  liveContextKey: string;
  // 活跃标签页 URL（isBoundConversationMismatched / 历史列表 live 匹配读）
  liveTabUrl: string;
  // ---- AI 偏好（形状与写入意图见 ChatSessionPreferences / applyProviderPrefs） ----
  aiPrefs: ChatSessionPreferences;
  // ---- 杂项标志 ----
  // content 侧音频转写进行中的兜底信号（biliscript-subtitle-status 广播写，
  // subtitleWaiter 轮询读）
  asrTranscribingActive: boolean;
  // 思考档位（off/low/high）。双持久化：chrome.storage.local
  // biliscript_ai_thinking_level（PR5 前为 localStorage）+ sync settings.aiThinkingLevel；
  // 读取以 settings ?? storage 为准（写点在 providers.ts 的 setThinkingLevel /
  // loadProvidersAndPrefs）。
  aiThinkingLevel: ChatThinkingLevel;
  // 联网搜索开关（spec §2.1/§4）：全局记忆（sync settings.webSearchEnabled），
  // 默认关；写点在 providers.ts 的 setWebSearchEnabled / loadProvidersAndPrefs。
  webSearchEnabled: boolean;
};

// 公开视图：两段切片整段只读，三键（aiPrefs / contextData / liveContextData）再深一层
// 只读——整组只经原语替换，嵌套标量字段（含快照 index signature 上的键）写即编译错误。
// 数组与更深层级不在约束内（浅 Readonly 的固有边界，见 ADR-0005「有意保留的可写面」）。
// 写入一律走本文件原语（编译期断言见 tests/chat/chat-state-readonly.types.ts）。
export type ChatSessionState = Readonly<ChatSessionGuardedState> &
  Readonly<Omit<ChatSessionOpenState, "aiPrefs" | "contextData" | "liveContextData">> & {
    readonly aiPrefs: Readonly<ChatSessionPreferences>;
    readonly contextData: Readonly<ChatSessionContextSnapshot> | null;
    readonly liveContextData: Readonly<ChatSessionContextSnapshot> | null;
  };
type ChatSessionStateWritable = ChatSessionGuardedState & ChatSessionOpenState;

// 初值的唯一出处：模块单例与测试注入口 resetChatSessionStateForTests 共用，
// 免得「重置到哪一版初值」成为第二处需要人肉对齐的地方（aiPrefs 的两个词表
// 每次现取 slice，调用方就地改写不会污染常量）。
function createInitialChatSessionState(): ChatSessionStateWritable {
  return {
    // ---- 上下文（loadContextState 写，UI 渲染读） ----
    // 当前应用的上下文快照（视频信息/字幕等）；null = 无上下文
    contextData: null,
    // contextData 对应的上下文键（buildContextKey 产物）
    currentContextKey: "",
    // 可用 AI 平台列表（loadProvidersAndPrefs 过滤 enabled 后写入）
    providers: [],
    // ---- 对话（conversation-store 与 chat-runtime 双侧读写） ----
    // 当前会话的一问一答数组 [{ role, content }]
    chatHistory: [],
    // 持久化的历史会话列表（storage 的内存镜像）
    savedConversations: [],
    // 当前会话 id（"" = 无当前会话）
    currentConversationId: "",
    // 当前会话元信息（id/标题/上下文绑定等）；null = 无当前会话
    currentConversationMeta: null,
    // ---- 实时上下文（loadContextState 维护的"活跃标签页"快照，与 contextData
    // 分离：流式守卫冻结 contextData 时 live 侧继续断供更新） ----
    liveContextData: null,
    liveContextKey: "",
    // 活跃标签页 URL（isBoundConversationMismatched / 历史列表 live 匹配读）
    liveTabUrl: "",
    // ---- AI 偏好（loadProvidersAndPrefs 整体替换，modelSelect 局部改写） ----
    aiPrefs: {
      aiSystemPrompt: "",
      // 初始快捷问题：空数组 = 按视频即时生成（设置里留空即此态），加载前的
      // 初值同样是空——不预置固定文案，免得首帧闪一批马上要被生成结果替换掉的
      // chip（renderSuggestions 对「空 + 无缓存」才回落固定三条兜底）。
      aiInitialQuickPrompts: []
    },
    // ---- 杂项标志 ----
    // content 侧音频转写进行中的兜底信号（biliscript-subtitle-status 广播写，
    // subtitleWaiter 轮询读）
    asrTranscribingActive: false,
    // 思考档位（off/low/high）。双持久化：chrome.storage.local
    // biliscript_ai_thinking_level（PR5 前为 localStorage）+ sync settings.aiThinkingLevel；
    // 读取以 settings ?? storage 为准（写点在 providers.ts 的 setThinkingLevel /
    // loadProvidersAndPrefs）。
    aiThinkingLevel: "off",
    // 联网搜索开关（spec §2.1/§4）：全局记忆，默认关。
    webSearchEnabled: false
  };
}

const chatSessionStateMutable: ChatSessionStateWritable = createInitialChatSessionState();

export const chatSessionState: ChatSessionState = chatSessionStateMutable;

// 仅供测试：可写把手（先例 resetChatSessionStateForTests，用例布置前置状态用）。
// 生产代码只 import 只读视图 chatSessionState，写入一律走意图原语；本把手不得出现在
// extension/ 的其它文件里（源码守卫见 tests/chat/chat-state-b-bag.test.ts）。
export const chatSessionStateForTests = chatSessionStateMutable;

// ---------------------------------------------------------------------------
// 意图级写入原语（会话身份切片；先例 core/state.ts 的 suppressUntil +
// transitionReaderShell——调用方表达意图，不碰具体槽位）
// ---------------------------------------------------------------------------

// 会话身份的一次写入。id / meta / history 三键各自可选：整组换身份走全参，
// 读-改-写（只补一个字段）只传被改的那几项。
export interface ConversationIdentityInput {
  id?: string;
  meta?: CurrentConversationMeta | null;
  history?: ChatSessionMessage[];
}

export function applyConversationIdentity({ id, meta, history }: ConversationIdentityInput): void {
  if (id !== undefined) {
    chatSessionStateMutable.currentConversationId = id;
  }
  if (meta !== undefined) {
    chatSessionStateMutable.currentConversationMeta = meta;
  }
  if (history !== undefined) {
    chatSessionStateMutable.chatHistory = history;
  }
}

// 拆除会话（conversation-store 的 detachCurrent 原语）：身份三键一并清空。
export function detachConversationIdentity(): void {
  applyConversationIdentity({ id: "", meta: null, history: [] });
}

// 发送前上下文失配守卫（chat-runtime）：只清身份两键，历史留在视图里延续
// ——与 detachConversationIdentity 的差别就在 chatHistory 不动。
export function clearConversationIdentity(): void {
  applyConversationIdentity({ id: "", meta: null });
}

// 会话 id 物化（chat-runtime 发送前）：已有身份时 no-op——本原语只补空位，
// 不改写既有 id。
export function ensureConversationId(id: string): void {
  if (chatSessionStateMutable.currentConversationId) {
    return;
  }
  chatSessionStateMutable.currentConversationId = id;
}

// 在途一问一答写回（chat-runtime 的 done / stopped 共享收尾）：整组追加，
// 免去调用方逐条 push。
export function appendChatHistory(...messages: ChatSessionMessage[]): void {
  chatSessionStateMutable.chatHistory.push(...messages);
}

export function setSavedConversations(next: ChatSessionSavedConversation[]): void {
  chatSessionStateMutable.savedConversations = next;
}

// ---------------------------------------------------------------------------
// B 档散字段写方归并（arch-review：ADR-0005 重开条件的落地轮——先归并写方，
// setter 白名单留待后续；会话主键/历史等 A 档切片归上文的意图原语）
// ---------------------------------------------------------------------------

// 转写相位订阅方（chat-tab 的状态总线回调 → send-gate）的写口。
export function setAsrTranscribingActive(active: boolean): void {
  chatSessionStateMutable.asrTranscribingActive = active;
}

// 模型下拉选中（reader/chat-tab 的 change 回调）：sync defaultModel 的进程内镜像。
export function noteDefaultModelChoice(providerId: string): void {
  chatSessionStateMutable.aiPrefs.defaultModel = providerId;
}

// 拆除会话（restartChat !keepContext 分支）：按当前主上下文重算 key。
export function rebuildCurrentContextKeyFromContext(): void {
  chatSessionStateMutable.currentContextKey = buildContextKey(chatSessionStateMutable.contextData);
}

// 开启新会话（startNewConversation）：live 快照落地主上下文（浅拷贝，与迁移前
// { ...live } 逐字一致）；liveContextKey 缺省时回退 key 重算。
export function applyLiveContextToMain(): void {
  if (chatSessionStateMutable.liveContextData) {
    applyContextToMain(
      { ...chatSessionStateMutable.liveContextData },
      chatSessionStateMutable.liveContextKey
    );
  }
}

// 落地解析后的上下文（hydratePinned 三支 / apply 占位与 live 命中分支）：按引用
// 写入，拷贝语义由调用方决定（各写点原状有 { ...x } 拷贝与不拷贝两种，逐字保持）；
// preferredKey 为空时回退 buildContextKey(next)。
export function applyContextToMain(next: AiContext | null, preferredKey?: string): void {
  chatSessionStateMutable.contextData = next;
  chatSessionStateMutable.currentContextKey = preferredKey || buildContextKey(next);
}

// 整组换上下文（context-load 的 applyContextPayload 写入半）：变化判定必须在
// 写入前读旧 key，故判定与落地内聚为同一原语，返回 contextChanged。
export function applyContextSnapshot(payload: unknown): boolean {
  const next = payload && typeof payload === "object" ? (payload as AiContext) : null;
  const nextKey = buildContextKey(next);
  const contextChanged = Boolean(
    chatSessionStateMutable.currentContextKey && nextKey && nextKey !== chatSessionStateMutable.currentContextKey
  );
  chatSessionStateMutable.contextData = next;
  chatSessionStateMutable.currentContextKey = nextKey;
  return contextChanged;
}

// hydratePinned 复读 live 分支的只写 key：loadContextState 已落地新上下文，
// 这里把 key 钉到会话 targetKey，data 不动。
export function pinCurrentContextKey(key: string): void {
  chatSessionStateMutable.currentContextKey = key;
}

// no-tab / error 计划里的 clearContext 分支：主上下文两键一并清空。
export function clearMainContext(): void {
  chatSessionStateMutable.contextData = null;
  chatSessionStateMutable.currentContextKey = "";
}

// ---------------------------------------------------------------------------
// B 档只读面收口（arch-review：B 档写方归并后的第二半——10 个散字段对外整段
// 只读，写方全部收在本块；形状与上文的 A 档原语一致：成组意图，不做逐字段
// setter 白名单）
// ---------------------------------------------------------------------------

// 平台与偏好一次加载结果的整组落地（providers.ts 的 loadProvidersAndPrefs）：
// 四组字段同出一份 settings/平台载荷，一次调用表达「本次加载结果」这一个意图。
export interface ChatSessionPrefsSnapshot {
  providers: ChatSessionProvider[];
  aiPrefs: ChatSessionPreferences;
  aiThinkingLevel: ChatThinkingLevel;
  webSearchEnabled: boolean;
}

export function applyProviderPrefs(snapshot: ChatSessionPrefsSnapshot): void {
  chatSessionStateMutable.providers = snapshot.providers;
  chatSessionStateMutable.aiPrefs = snapshot.aiPrefs;
  chatSessionStateMutable.aiThinkingLevel = snapshot.aiThinkingLevel;
  chatSessionStateMutable.webSearchEnabled = snapshot.webSearchEnabled;
}

// 思考档位切换（providers.ts 的 setThinkingLevel）：档位归一化留在调用方
// （词表在 core/validators，本模块不引第二个领域依赖）。
export function setAiThinkingLevel(level: ChatThinkingLevel): void {
  chatSessionStateMutable.aiThinkingLevel = level;
}

// 联网搜索开关切换（providers.ts 的 setWebSearchEnabled）。
export function setWebSearchEnabled(enabled: boolean): void {
  chatSessionStateMutable.webSearchEnabled = enabled;
}

// 往返结束后刷新活跃标签页 URL（context-load 的非 no-tab 分支：error 也写，
// 与迁移前同语义）。
export function noteLiveTabUrl(url: string): void {
  chatSessionStateMutable.liveTabUrl = url;
}

// live 快照落地 / 失效（context-load 的成功前缀与 ERROR 分支）：payload 非空时
// data 按引用落地、key 由 buildContextKey 派生；null 时快照两键一并清空（tabUrl
// 不动——它由 noteLiveTabUrl 单独维护）。
export function applyLiveContextSnapshot(payload: ChatSessionContextSnapshot | null): void {
  chatSessionStateMutable.liveContextData = payload;
  chatSessionStateMutable.liveContextKey = buildContextKey(payload);
}

// 无可用标签页：live 三键一并清空（context-load 的 no-tab 分支）。
export function resetLiveContext(): void {
  applyLiveContextSnapshot(null);
  chatSessionStateMutable.liveTabUrl = "";
}

// 测试注入口：把全部字段重置到初值（单纪元内复用模块单例的 beforeEach 用）。
// 生产代码不得调用——先例 core/state.ts 的 force-set 仅为测试脚手架保留。
export function resetChatSessionStateForTests(): void {
  Object.assign(chatSessionStateMutable, createInitialChatSessionState());
}
