// 三条通道（content script、service worker、offscreen document）之间的消息协议。
// 所有 runtime 消息与 offscreen port 消息统一建模为 discriminated union，
// 以既有代码中的协议字面量为事实来源。本文件以类型为主体；运行时导出只有协议
// 单源两处：SW 消息注册表 BACKGROUND_MESSAGE_REGISTRY 及其派生面
// （OFFSCREEN_ONLY_MESSAGE_TYPES 名单 / resolveReplyKeepOpen 回包口径）。
//
// 响应半边（arch-slim-2/02 → 消息注册表收敛）：每条请求消息在其声明处并列声明
// 响应类型（服务端处理器的 sendResponse 载荷即事实锚点），并登记进
// BACKGROUND_MESSAGE_REGISTRY（文件末节）；ResponseOf<M> 由该注册表派生——
// sendRuntimeMessage 泛型化后，调用点以消息字面量即得完整响应形状，不再手猜。
// 响应形状取「平面接口」（ok 恒为 boolean；payload 字段仅在成功分支实发，失败
// 分支可带 error），与全部消费点既有的防御式读取（resp?.x || 兜底）同构。本文件
// 引用的域类型一律 type-only import：编译期擦除，不向 core/ai/asr 引入任何
// 运行时依赖边；注册表与其派生面是零依赖常量 / 纯函数（形状判据是内联闭包），
// 同样不新增依赖边。

import type { Settings } from "../core/defaults.js";
import type { AiProviderPreset, AsrProviderPreset, SearchProviderPreset } from "../core/presets.js";
import type { AiProvider, ImagePart } from "../ai/types.js";
import type { AsrProvider } from "../asr/asr-provider-store.js";
import type { SearchProvider } from "../search/search-provider-normalize.js";
import type { NormalizedSearchResult } from "../search/adapters/types.js";
// 段缓存键位字段形状（纯类型引入，编译期擦除；字段清单单源在零依赖叶）。
import type { SegmentCacheContextFields } from "../ai/segment-cache-key-fields.js";

// ===== content script 处理的 runtime 消息 =====

export type ReaderEnterMessage = {
  type: "reader-enter";
  readerUrl?: string;
  // 快捷对话负载（可省）：带 chat = 进入阅读模式并在进入事务内激活对话 tab，
  // prompt 非空时自动发送快捷提示词（消费端 entry/message-handler.ts →
  // reader/shell.ts chat 档）。
  chat?: { prompt?: string };
};

// 响应锚点：entry/message-handler.ts reader-enter 处理器——命令已受理入队即答
// { ok: true }，不代表进入完成；shell 装载失败回 { ok: false, error }
//（arch-slim-2/09 shell 静态边改动态）。
export type ReaderEnterResponse = { ok: boolean };

// 退出阅读模式（SW 侧 triggerReaderModeCloseInTab 的重试发送；面板关闭按钮走
// 页内直调 reader 域，不经消息）。消费端（entry/message-handler.ts）收敛地址栏
// 后交 reader 域 closeReadingView + 摘阅读表（工单 02 起由 exitReaderShell 收口）。
export type ReaderCloseMessage = {
  type: "reader-close";
};

// 响应锚点：entry/message-handler.ts reader-close 处理器——退出事务完成后回包，
// 失败带可读 error。
export type ReaderCloseResponse = { ok: boolean; error?: string };

// 阅读视图自愈恢复（ui/script-button.ts 的 200ms 自查在失同步时派发）：
// URL 带 biliscript_reader=1 而视图没开（直达进入失败）、或状态开着而壳被页面重渲染
// 摘掉（状态-DOM 失同步）时，按 DOM 实况收敛状态后重走进入链。readerUrl 语义
// 同 reader-enter。仅 content 页内源使用（dispatchContentScriptMessage）。
export type ReaderRestoreMessage = {
  type: "reader-restore";
  readerUrl?: string;
};

// 响应锚点：entry/message-handler.ts reader-restore 处理器——同 reader-enter 的
// 即答语义，恒 { ok: true }。
export type ReaderRestoreResponse = { ok: boolean };

export type ContentScriptMessage =
  | ReaderEnterMessage
  | ReaderCloseMessage
  | ReaderRestoreMessage;

export type ContentScriptMessageType = ContentScriptMessage["type"];

// ===== service worker 处理的 runtime 消息 =====

export type GetSettingsMessage = { type: "get-settings" };
// 响应锚点：entry/background.ts handleGetSettings——getMergedSettings 的合并快照
//（已过 normalizeSettings 收口）。
export type GetSettingsResponse = {
  ok: boolean;
  settings?: Settings;
  error?: string;
};
export type SaveSettingsMessage = { type: "save-settings"; settings?: unknown };
// 响应锚点：entry/background.ts handleSaveSettings——落盘成功仅 { ok: true }。
export type SaveSettingsResponse = { ok: boolean; error?: string };
// script-only-ui：content script 语境没有 chrome.permissions API（仅扩展自有
// 页面/SW 可用），侧边栏设置面板保存时的 host 权限申请改走此消息由 SW 代为
// 申请。用户手势经一次 runtime 消息传导；SW 处理器必须在调用
// chrome.permissions.request 前零 await（见 entry/background.ts）。
export type RequestProviderOriginsMessage = {
  type: "request-provider-origins";
  baseUrls?: unknown;
};
// 响应锚点：entry/background.ts handleRequestProviderOrigins——用户拒绝 / 环境
// 不支持 / SW 报错时 error 为可操作提示文案。
export type RequestProviderOriginsResponse = { ok: boolean; error?: string };
// offscreen 代发（content 侧发起）的 host 权限预检：content script 没有
// chrome.permissions，经此消息问 SW「这个 origin 授权了吗」——只问不申请（申请走
// request-provider-origins，需用户手势）。
export type CheckProviderOriginMessage = {
  type: "check-provider-origin";
  /** 已提取的 match pattern（core/host-permissions 的 extractOriginFromBaseUrl 产物） */
  origin?: unknown;
};
// 响应锚点：entry/background.ts handleCheckProviderOrigin——granted 即该 origin 是否已获
// host 权限；origin 缺失/非法时按已授权回 true（fail-open，不新造拦截面）。
export type CheckProviderOriginResponse = { granted: boolean };
// PR5：对话 tab（content script）发送前的 offscreen 文档自愈 ensure——
// chrome.offscreen / getContexts 仅扩展上下文可用，content script 经此消息
// 委托 background 幂等创建（扩展页内直调 ensureChatOffscreenDocument 的
// 等价物，见 reader/chat-tab.ts 的 connectPort）。
export type EnsureOffscreenChatMessage = { type: "ensure-offscreen-chat" };
// 响应锚点：entry/background.ts handleEnsureOffscreenChat——ensured 为幂等创建
// 结果（ensureChatOffscreenDocument 的 boolean）。
export type EnsureOffscreenChatResponse = {
  ok: boolean;
  ensured?: boolean;
  error?: string;
};
export type PlayerAiQuickActionMessage = {
  type: "player-ai-quick-action";
  tabId?: number;
};
// 响应锚点：entry/background.ts handlePlayerAiQuickAction——失败带可读 error
//（找不到标签页 / 按钮未开启 / 触发失败）。
export type PlayerAiQuickActionResponse = { ok: boolean; error?: string };
export type FetchJsonMessage = { type: "fetch-json"; url?: string };
// 响应锚点：entry/background.ts handleFetchJson——data 为目标 JSON 原文（具体
// 形状由调用方的泛型参数收口），失败带可读 error（含 "Invalid JSON response"）。
export type FetchJsonResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

// provider 列表响应条目：core/provider-store 的 list 载荷——Key 不明文回传，
// 只带 hasSavedKey 占位。
// 条目类型真值（票 ai-entry-type/01）：AI 族的记录面（core/ai-provider-store.ts
// 的 AiProvider）继承本行字段面（ai/types.AiProvider），store 产物
// （AiProvider & {hasSavedKey}）即本类型的子类型，两侧不再各持一份互不可赋值的
// 声明。
export type ProviderListEntry = AiProvider & { hasSavedKey: boolean };
export type AsrProviderListEntry = AsrProvider & { hasSavedKey: boolean };
export type SearchProviderListEntry = SearchProvider & { hasSavedKey: boolean };

export type AiProvidersListMessage = { type: "ai-providers-list" };
// 响应锚点：core/provider-handlers.ts list——{ ok: true, providers }，失败经
// withOkResponse 统一映射为 { ok: false, error }（下同）。
export type AiProvidersListResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiPresetsListMessage = { type: "ai-presets-list" };
// 响应锚点：entry/background.ts handleAiPresetsList。
export type AiPresetsListResponse = {
  ok: boolean;
  presets?: AiProviderPreset[];
  error?: string;
};
export type GetAiProviderKeyMessage = {
  type: "get-ai-provider-key";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts get——缺 providerId 同步回
// { ok: false, error: "缺少 providerId" }。
export type GetAiProviderKeyResponse = {
  ok: boolean;
  apiKey?: string;
  error?: string;
};
export type AiProvidersSaveMessage = { type: "ai-providers-save"; providers?: unknown };
// 响应锚点：core/provider-handlers.ts save——回最新列表（含 hasSavedKey）。
export type AiProvidersSaveResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiProvidersDeleteMessage = {
  type: "ai-providers-delete";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts remove——回删除后存活列表。
export type AiProvidersDeleteResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiProvidersModelsMessage = {
  type: "ai-providers-models";
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
  // 平台协议（multi-protocol-ai）：gemini 时探针走 /v1beta/models + x-goog-api-key
  protocol?: string;
};
// 响应锚点：ai/provider-models.ts handleAiProvidersModels（AiProvidersModelsResult，arch-slim-2/09 自 core/ai-provider-store.ts 搬入）。
export type AiProvidersModelsResponse = {
  ok: boolean;
  models?: string[];
  error?: string;
};
// 平台请求代发（AI 探针的传输层）：content script 的跨域 fetch 服从**网页**
// CORS——平台网关不支持浏览器预检时（OPTIONS 无 Access-Control-Allow-*），带
// Authorization 的请求一律以 Failed to fetch 失败，而模型列表能跑通只是因为它
// 由 SW 发出（SW fetch 只受 host 权限约束）。探针请求经本通道同样交给 SW。
export type ProviderHttpMessage = {
  type: "provider-http";
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
// 响应锚点：core/provider-http.ts handleProviderHttpRequest。
export type ProviderHttpResponse = {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
};
// arch-slim-3/09：「激活平台」单趟解析——offscreen 聊天链与 content 侧概览/
// 选区解释共用（GLOSSARY.md 域词条「激活平台」）。providerId 给定 = 精确匹配
//（offscreen 语义）；缺省 = 设置 defaultModel → 首个启用平台回落（content
// 语义）。requiresKey 平台密钥缺失在解析期即报可读错误（此前 content 侧会
// 拖到 HTTP 期才失败）。
export type ResolveAiProviderMessage = {
  type: "resolve-ai-provider";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts createAiResolvedProviderHandler——
// provider 为平台记录（不含明文 Key，与列表条目同形），apiKey 单列回传。
export type ResolveAiProviderResponse = {
  ok: boolean;
  provider?: ProviderListEntry;
  apiKey?: string;
  error?: string;
};

// ===== offscreen 段缓存消息族 =====
// 来源守卫：本族在 OFFSCREEN_ONLY_MESSAGE_TYPES 名单内（只接受 offscreen 文档发送）。
// 平台事实（chrome.offscreen 官方文档）：offscreen 文档仅支持 chrome.runtime，
// 无 chrome.storage。段缓存（ai/segment-cache.js 的 biliscript_lvs_summary_* /
// biliscript_lvs_raw_* 两族）宿主是 SW——offscreen 的 Map-Reduce / 追问链经本族消息
// 读写（arch-review-2026-09/05，替下 storage-local-bridge 垫片），SW 端 handler
// 直调 segment-cache 单源（键位装配也在 SW 完成，消息只带 context 字段）。
// 写聚合（段缓存写聚合 ticket）：Map-Reduce 未命中段的 saveRaw 由 offscreen 侧
// run-scoped 写会话缓冲、随 saveSummary 合成一条 save-summary-raw 合并 op
//（写路径 3N→2N，SW 侧每段 2get+4set→1get+3set）；本次运行收尾经会话 close 把残留
// raw 按 save-raw 落盘，port 断开 / offscreen 自关则随文档销毁丢弃。
//
// 段缓存 context 的协议形状：出站点已投影为键位字段（字段口径与 SW 端
// segment-cache.ts 的 segmentCacheKeyFields 同源——两处与概览键位装配一并从零依赖叶
// ai/segment-cache-key-fields.ts 派生，候选 5）——整份 AiContext（含 ≥200k 字符
// 的 subtitleBody）不再过线；chapters 只为 load-stored-raw 的命中段预过滤保留
//（SW 侧 retrieveRawSegments 的章节名档输入，读行为依赖）。
export type SegmentCacheContext = SegmentCacheContextFields & { chapters?: unknown };
export type SegmentCacheMessage = {
  type: "segment-cache";
  op: "load-summary" | "load-summaries" | "save-summary" | "save-raw" | "save-summary-raw" | "load-stored-raw";
  // 键位字段载荷（出站点投影后的窄对象），SW 端经 segmentCacheKeyFields 归一为键位字段
  context?: SegmentCacheContext;
  segmentIndex?: number | string;
  // load-summaries 批量（08 票）：段序号清单，一次消息读 N 个键（追问 N 段 = N 次
  // 往返 → 常数级），SW 端按序装配键位
  segmentIndexes?: Array<number | string>;
  // load-stored-raw 命中段过滤（08 票）：携带时 SW 侧用同一检索规则预过滤，
  // 非命中段剥离 items 再回传（整篇数 MB → 仅命中段过线）；缺省整篇回传（行为不变）
  prompt?: string;
  // unknown 透传：budgetScaleSuffix 的 Number() 归一在 SW 的 segment-cache 单源
  // 完成，与迁移前直连调用的口径逐字一致
  budgetScale?: unknown;
  // save-summary 的载荷 / save-raw 与 save-summary-raw 的原始段条目
  summary?: string;
  segments?: unknown[];
};
export type SegmentCacheResponse = {
  ok: boolean;
  // load-summary 回包：小结文本（未命中为 null）
  summary?: string | null;
  // load-summaries 回包：与 segmentIndexes 按序对齐的小结（未命中为 null）
  summaries?: (string | null)[];
  // load-stored-raw 回包：按段序排列的落盘原始段（无命中为空数组；带 prompt 时
  // 非命中段 items 已被剥离，段元数据 index/from/to 保留）
  storedSegments?: unknown[];
  // save-summary-raw 合并写回包的 per-op 结果：两族各自成败（粗粒度，同败同果；
  // 保住写失败可观测性，offscreen 侧任一失败都汇成一次 { ok:false } 上浮）
  summarySaved?: { ok: boolean; error?: string };
  rawSaved?: { ok: boolean; error?: string };
  error?: string;
};

export type AsrPresetsListMessage = { type: "asr-presets-list" };
// 响应锚点：entry/background.ts handleAsrPresetsList。
export type AsrPresetsListResponse = {
  ok: boolean;
  presets?: AsrProviderPreset[];
  error?: string;
};
export type AsrProvidersListMessage = { type: "asr-providers-list" };
// 响应锚点：core/provider-handlers.ts list（ASR 家族与 AI 同契约）。
export type AsrProvidersListResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type AsrProvidersSaveMessage = { type: "asr-providers-save"; providers?: unknown };
// 响应锚点：core/provider-handlers.ts save。
export type AsrProvidersSaveResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type AsrProvidersDeleteMessage = {
  type: "asr-providers-delete";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts remove。
export type AsrProvidersDeleteResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type GetAsrRuntimeConfigMessage = { type: "get-asr-runtime-config" };
// 响应锚点：core/provider-handlers.ts createAsrRuntimeConfigHandler——settings
// 标量 + provider 列表 + 激活平台 Key 一次回包（Key 只进 offscreen context）。
export type GetAsrRuntimeConfigResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  activeAsrProviderId?: string;
  activeKey?: string;
  asrLanguage?: string;
  asrAutoFallback?: boolean;
  error?: string;
};

// ===== 搜索平台消息族（spec §3.3，仿 asr-providers-* 契约）=====
// 预设目录（SEARCH_PROVIDER_PRESETS）是纯数据常量，UI 直接 import core/presets，
// 不设 search-presets-list 消息。
export type SearchProvidersListMessage = { type: "search-providers-list" };
// 响应锚点：core/provider-handlers.ts list（搜索家族与 ASR 同契约）。
export type SearchProvidersListResponse = {
  ok: boolean;
  providers?: SearchProviderListEntry[];
  error?: string;
};
export type SearchProvidersSaveMessage = { type: "search-providers-save"; providers?: unknown };
// 响应锚点：core/provider-handlers.ts save。
export type SearchProvidersSaveResponse = {
  ok: boolean;
  providers?: SearchProviderListEntry[];
  error?: string;
};
export type SearchProvidersDeleteMessage = {
  type: "search-providers-delete";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts remove。
export type SearchProvidersDeleteResponse = {
  ok: boolean;
  providers?: SearchProviderListEntry[];
  error?: string;
};

// ===== 联网搜索运行时解析（spec §1 S4/S6 / §12.1–§12.3）=====
// offscreen 文档无 chrome.storage，工具循环的搜索配置（**回退链**：有序候选 +
// 各自 Key + 单轮上限）经本消息单趟往返解析（仿 resolve-ai-provider）。链语义两模式
// （spec §12.1）：`activeSearchProviderId` = 某条在场记录 id → **单选**（只有该家、
// 无回退）；= 哨兵 `SMART_SEARCH_ACTIVE_ID` 或空串 → **智能**（全组按
// `searchProviderOrder` 归一序 > 内置默认序串行回退，冷却中的引擎跳过）。
// 无任何合格记录时 chain 缺省——调用方（entry/offscreen.ts）据此 notice「未配置搜索平台」
// 并走原无工具路径，不算错误（搜索是增强，缺失不阻塞对话）。**空链归因**（spec
// §12.7 第 6 条，2026-10-01 翻案）：智能模式下若合格记录全部处于冷却中，空链的原因
// 不是「未配置」，回包附 `chainEmptyReason` 供调用方分文案；新增**可选**字段，
// 既有消费方（把 chain 缺省一律当未配置）不受影响。
export type ResolveSearchProviderMessage = { type: "resolve-search-provider" };

// 链候选（= ResolveSearchProviderResponse.chain 的元素形状，S4 单一形状）：
// presetId 供健康度按引擎（而非记录）记账（spec §12.4 第 1/7 条）。
// 形状单源在此（此前 search/search-chain.ts 自持同名副本、本文件再内联重写一份）——
// chain 是线格式，主人归协议层；search-chain 反向 import 消费（search → shared 顺向）。
export type SearchChainCandidate = {
  provider: { id: string; presetId: string; name: string; type: string; baseUrl: string };
  apiKey: string;
};

// 响应锚点：entry/background.ts handleResolveSearchProvider。
export type ResolveSearchProviderResponse = {
  ok: boolean;
  // 有序候选：每项自带 provider 身份（含 presetId，供引擎级健康度记账）与它的 Key。
  // apiKey 允许空串（keyless 预设无 Key 也进链，spec §2）；顶层不再有 provider /
  // apiKey（那会形成两套形状）。
  chain?: SearchChainCandidate[];
  // settings.webSearchMaxToolCalls（单轮搜索次数上限，区间 1–10）。
  maxToolCalls?: number;
  // 空链归因：只取 `"cooldown"`（合格记录全部在冷却中而被过滤成空链，spec §12.7 第 6 条）。
  // 缺省 = 真的没有合格记录（未配置）。只在 chain 缺省时有意义。
  chainEmptyReason?: "cooldown";
  error?: string;
};

// ===== 查询缓存消息族（spec §5 / §3 落点表第 10 行）=====
// 消费方是 offscreen 工具循环与 content 侧选区解释卡（都经 search/search-runtime.ts
// 同一解析器）；offscreen 无 chrome.storage → 宿主是 SW，两个消费方都走本族消息
// （不设 content 直读的第二条读路径）。归一（trim + 空白折叠 + toLowerCase）与
// 64 位哈希键在 SW 侧 search/search-cache.ts 单源完成，调用方只传原始 query。
// 来源守卫：本族**不进**来源名单（OFFSCREEN_ONLY_MESSAGE_TYPES，发送者含 content）。
export type SearchCacheMessage = {
  type: "search-cache";
  op: "get" | "put";
  // 归一在 SW 侧单源完成（调用方不拼键）
  query?: string;
  // put 载荷（链成功返回的归一结果，含空结果集）
  results?: NormalizedSearchResult[];
  // put 载荷：实际产出结果的引擎名
  platform?: string;
};
// 响应锚点：search/search-cache-handler.ts 的 createSearchCacheHandler（组合根只
// 登记工厂实例）。
export type SearchCacheResponse = {
  ok: boolean;
  // get：是否命中未过期条目
  hit?: boolean;
  // get 命中回包（不含 ts；引擎名供步骤行「N 条 · <引擎>」与模型侧注记）
  entry?: { results: NormalizedSearchResult[]; platform: string };
  error?: string;
};

// ===== 引擎健康度记账消息族（spec §12.4 第 7–8 条 / §12.5 第 5 行）=====
// 消费方是链执行侧（offscreen 工具循环 / content 选区解释卡，经 search-chain.ts
// 的 deps.recordAttempt 缺省 = search-health-client）：执行侧无 chrome.storage，
// 记账交 SW 落 search/search-health.ts 单源（**时间戳由 SW 侧盖**）。
// fire-and-forget：失败 / 无回包静默，绝不影响搜索与回答。
// 来源守卫：本族**不进**来源名单（OFFSCREEN_ONLY_MESSAGE_TYPES，发送者含 content）。
export type SearchHealthMessage = {
  type: "search-health";
  op: "record";
  // 引擎级记账键（链候选 provider.presetId）
  presetId?: string;
  // 本次尝试的成败与延迟 ms（记账范围 = 真实出网尝试）
  ok?: boolean;
  latencyMs?: number;
};
// 响应锚点：search/search-health-handler.ts 的 createSearchHealthHandler（组合根只
// 登记工厂实例）。
export type SearchHealthResponse = { ok: boolean; error?: string };

export type OffloadTaskMessage = {
  type: "offload-task";
  taskType?: string;
  [key: string]: unknown;
};
// 响应锚点：asr/offscreen-bridge.bg.ts prepare/cleanup 执行器 + entry/background.ts
// handleOffloadTask 的未知任务类型拒绝——prepare 成功带回本任务独立分配的
// ruleId，cleanup 成功仅 { ok: true }，失败一律 { ok: false, error }。
export type OffloadTaskResponse = {
  ok: boolean;
  ruleId?: number;
  error?: string;
};

// 工单 03：offscreen 文档自关闭的 SW 代执行（offscreen 无 chrome.offscreen，
// 自关请求经 runtime 消息委托 SW）。仅接受 offscreen 文档本身的请求（名单项 =
// 协议层 OFFSCREEN_ONLY_MESSAGE_TYPES，SW 侧守卫消费后校验 sender.url / sender.tab）。
export type OffscreenRequestCloseMessage = { type: "offscreen-request-close" };
// 响应锚点：asr/offscreen-bridge.bg.ts handleOffscreenRequestClose——关闭成功
// { ok: true }；拒绝（非 offscreen 发送者）或 closeDocument 抛错 { ok:false, error }。
export type OffscreenRequestCloseResponse = { ok: boolean; error?: string };

// 工单 03：offscreen 侧调试日志门（offscreen 无 chrome.storage，初始开关经
// runtime 消息向 SW 读一次；变更由 SW 广播 DebugLogGateChangedBroadcast）。
export type GetDebugLogGateMessage = { type: "get-debug-log-gate" };
// 响应锚点：entry/background.ts handleGetDebugLogGate。
export type GetDebugLogGateResponse = {
  ok: boolean;
  enabled?: boolean;
  error?: string;
};

export type BackgroundMessage =
  | GetSettingsMessage
  | SaveSettingsMessage
  | RequestProviderOriginsMessage
  | CheckProviderOriginMessage
  | EnsureOffscreenChatMessage
  | PlayerAiQuickActionMessage
  | FetchJsonMessage
  | AiProvidersListMessage
  | AiPresetsListMessage
  | GetAiProviderKeyMessage
  | AiProvidersSaveMessage
  | AiProvidersDeleteMessage
  | AiProvidersModelsMessage
  | ProviderHttpMessage
  | ResolveAiProviderMessage
  | AsrPresetsListMessage
  | AsrProvidersListMessage
  | AsrProvidersSaveMessage
  | AsrProvidersDeleteMessage
  | GetAsrRuntimeConfigMessage
  | SearchProvidersListMessage
  | SearchProvidersSaveMessage
  | SearchProvidersDeleteMessage
  | ResolveSearchProviderMessage
  | SearchCacheMessage
  | SearchHealthMessage
  | SegmentCacheMessage
  | OffloadTaskMessage
  | OffscreenRequestCloseMessage
  | GetDebugLogGateMessage;

export type BackgroundMessageType = BackgroundMessage["type"];

// ===== SW 广播（非请求响应式）=====

// 调试日志门变更广播（工单 03）：storage 是 SW 的独占读者，sync.enableDebugLogs
// 变化时 SW 广播给全部扩展上下文（offscreen 文档据它翻转本地门）。无请求方、
// 无回包，不在 BackgroundMessage 联合内。
export type DebugLogGateChangedBroadcast = {
  type: "debug-log-gate-changed";
  enabled: boolean;
};

// ===== offscreen document 接收的 port 消息 =====

export type OffscreenChatMessage = {
  action: "chat";
  providerId?: string;
  // 选中模型 id（multi-model-catalog）：缺省回落解析平台记录的目录首项
  model?: string;
  // 会话身份（Opencode Go 的 x-opencode-session 取值来源，见 ai/preset-headers.ts）：
  // 宿主每次发送带上当前 chat 会话 id，offscreen 挂到本轮 provider 上，本轮
  // 全部请求（工具循环 / Map-Reduce / 重试 / 截断重跑）共用同一个会话标识。
  conversationId?: string;
  // 联网搜索管线（spec §2.1）：宿主「联网」toggle 全局记忆，offscreen 据此决定
  // 是否解析搜索配置并注入 tools；Map-Reduce 归约轮由 ladder 静默禁用 + notice。
  webSearchEnabled?: boolean;
  // 图片输入（image-input 路线 B）：本轮用户消息的图片（宿主粘贴 → content 侧
  // 按 03 号票规格压缩后的 WebP base64，无图时不带字段）。
  images?: ImagePart[];
  subtitleBody?: unknown;
  [key: string]: unknown;
};

export type OffscreenStopMessage = { action: "stop" };

export type OffscreenCostGuardConfirmMessage = {
  action: "cost-guard-confirm";
  ok?: boolean;
};

export type OffscreenChatPortMessage =
  | OffscreenChatMessage
  | OffscreenStopMessage
  | OffscreenCostGuardConfirmMessage;

// asr-decode 端口上的两类任务（协议常量与契约见 asr/protocol.js）：解码走音轨
// 下载/解码/切片/转写；探针（asr-probe）只把草稿 provider 交给 offscreen 的真
// 适配器跑一次静音转写——页面侧探针必须落在扩展文档里，否则权限门 fail-open、
// 请求还受网页 CORS 约束，与实际转写不是同一条链。
export type OffscreenAsrPortMessage =
  | {
      action: "asr-decode";
      task: {
        audioUrl?: string;
        backupUrls?: string[];
        [key: string]: unknown;
      };
    }
  | {
      action: "asr-probe";
      task: {
        type?: string;
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        language?: string;
      };
    };

// 概览链的平台请求代发（overview-offscreen-transport）：content script 发起、
// offscreen 文档执行的一次性请求。概览是分钟级长请求，SW 代发（provider-http）
// 的 15s 超时与 MV3 SW 生命周期都不适用，故宿主取 offscreen——扩展源 fetch 只受
// host 权限约束，不过网页 CORS 预检（content 直发会撞网关预检白名单）。
// 端口名常量与两端实现在 core/provider-http-offscreen.ts（两端同文件）。
export type OffscreenProviderHttpPortMessage = {
  action: "provider-http";
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

// 回吐方向（offscreen → content，同一端口严格按序）：概览的模型调用走 SSE，
// 通道一律分块回吐——接管确认 { ok, accepted }（收到请求消息即回，先于预检与
// fetch，证明「端口已被 offscreen 文档接管」而非挂在无人服务的监听上）→ 响应头
// { ok, status } → 正文分片 { ok, status, chunk } → 收束 { ok, status, done }。
// 失败只带 { ok:false, error }：响应头未发 = 整体失败（content 侧拒绝），已发 =
// 中途失败（content 侧 error 掉读流，截断不得当作成功）。content 侧据此合成带
// ReadableStream body 的标准 Response，消费端见 core/provider-http-offscreen.ts。
export type OffscreenProviderHttpPortReply = {
  ok: boolean;
  status?: number;
  chunk?: string;
  done?: boolean;
  error?: string;
  // 派发确认：不是响应头，不得据此合成 Response（见消费端 openProviderStream）。
  accepted?: boolean;
};

export type OffscreenPortMessage =
  | OffscreenChatPortMessage
  | OffscreenAsrPortMessage
  | OffscreenProviderHttpPortMessage;

// ===== 通用处理函数签名 =====

export type MessageResponse = unknown;

export type SendResponse = (response?: MessageResponse) => void;

export type MessageSender = {
  tab?: { id?: number; url?: string };
  url?: string;
  id?: string;
};

// SW handler 注册面（按消息键收型，票 message-registry/02）：message 与
// sendResponse 都收成该键的具体形状——响应载荷与消息键配错在 tsc 门禁即红
//（编译期负向断言见 tests/shared/messaging-handler-types.types.ts）。返回值按
// 注册表 reply 登记派生（见 BackgroundHandlerResult）：async / sync 档返回值不
// 承载口径（void），branch 档必须显式返回判定——「handler 返回值承载回包口径」
// 只剩这一处显式契约。content 侧 handler 面是 entry/message-handler.ts 的局部
// 类型（本层不持有 content 路由）。
export type BackgroundHandlerResult<K extends BackgroundMessageType> =
  BackgroundMessageRegistry[K]["reply"] extends "branch" ? MessageReplyDecision : void;

export type HandlerForType<K extends BackgroundMessageType> = (
  message: Extract<BackgroundMessage, { type: K }>,
  sender: MessageSender,
  sendResponse: (response: BackgroundResponseOf<K>) => void
) => BackgroundHandlerResult<K>;

export type BackgroundMessageHandler<K extends BackgroundMessageType> = HandlerForType<K>;

export type BackgroundMessageHandlers = {
  [K in BackgroundMessageType]: HandlerForType<K>;
};

// ===== SW 消息注册表（一条消息一处登记）=====
//
// 「新增一条消息」要动三处：① 本文件的 XxxMessage 声明与并列的 XxxResponse
//（扫描测试强制）② 本表登记 ③ 组合根 handler 表条目（entry/background.ts，
// satisfies 穷尽对齐本表键集）。本表把「声明 + 形状判据 + 回包口径 + 来源登记」
// 收在一处，由它派生：
//   ① ResponseOf<M>（调用点响应形状推断的唯一事实源）；
//   ② 消息入口守卫的两项检查——来源标签（＝下表 sender 登记派生的
//      OFFSCREEN_ONLY_MESSAGE_TYPES）与 payload 最小 schema（＝下表 shape 判据）；
//   ③ 入口回包口径（下表 reply；branch 档的 handler 返回值判定见
//      MessageReplyDecision，handler 注册面的返回值契约由该登记派生）。
// 两项检查与回包口径的消费点是 core/message-router 的 createMessageRouter
//（组合根注入本表与 handler 表）。handler 本体以工厂形态住域 module
//（core/provider-handlers.ts、ai/segment-cache-handler.ts、
// search/search-cache-handler.ts 等），组合根 entry/background.ts 的路由表只登记
// 工厂实例（satisfies 穷尽对齐本表键集；shared 是叶子层，不得反向引用 entry 的
// handler）。

// 回包口径：chrome.runtime.onMessage 监听器返回值语义显式化。
// - async：处理器持有回包通道（可能同步也可能异步回包），入口恒返回 true
//   （处理器体里历史遗留的 return true / false 由此中立化，契约只在本表）；
// - sync：处理器返回前已同步回包，入口恒返回 false（通道关闭）；
// - branch：口径逐分支而定（同步预检失败即答、通过则转异步），handler 自持判定
//   （MessageReplyDecision，见下）——注册表只登记「这条消息是 branch」，具体分支
//   由 handler 返回值说。
export type MessageReplyMode = "async" | "sync" | "branch";

// branch 档 handler 返回值的显式判定（取代裸布尔；handler 面按注册表 reply 只把
// 它收给 branch 档）：
// - "answered"：handler 返回前已同步回包，入口关闭通道（keepOpen = false）；
// - "hold"：handler 未回包、转异步回包，入口保留通道（keepOpen = true）。
// 取值语义与收敛前裸布尔 true / false 逐字同义（true = 持有通道）。
export type MessageReplyDecision = "answered" | "hold";

// 入口 boolean 的唯一派生点（core/message-router 的 createMessageRouter 消费）。
// 未返回判定（undefined）与 "answered" 同义——对齐 onMessage「未持有通道」语义。
export function resolveReplyKeepOpen(mode: MessageReplyMode, handlerResult: MessageReplyDecision | void): boolean {
  if (mode === "async") return true;
  if (mode === "sync") return false;
  return handlerResult === "hold";
}

// 来源标签：注册条目 sender 的取值（当前唯一取值 "offscreen"）。标签是协议契约的
// 一部分，判据本体由组合根按标签注入（core/message-router 的 senders），故词表
// 住本层、契约消费方 core/ 反向 import 本层（shared 保持叶子）。
export type SenderLabel = string;

// 注册条目：消息声明与响应类型是类型层载体（运行期不存在，只供 ResponseOf 与
// 键对齐校验读），形状判据 / 回包口径 / 来源登记是运行期事实。Mode 保留每条登记
// 的 reply 字面量（登记值逐字不变）——handler 注册面的返回值契约由它派生。
export type BackgroundMessageRegistration<
  M extends BackgroundMessage,
  R,
  Mode extends MessageReplyMode = MessageReplyMode
> = {
  /** 回包口径（入口按它派生 keepOpen；字面量供 handler 面派生返回值契约） */
  readonly reply: Mode;
  /** payload 最小形状判据：返回 false = 形状明显非法，入口守卫拒绝（缺省 = 无判据）。
   *  存储面入参宽化为 unknown（作者侧经 registerBackgroundMessage 按本条消息
   *  收窄），守卫按键分发后直接调用，调用点无需断言。 */
  readonly shape?: (message: unknown) => boolean;
  /** 来源登记：本条消息的发送者标签（组合根按它注入对应判据；标签在场即进
   *  OFFSCREEN_ONLY_MESSAGE_TYPES 派生名单）。 */
  readonly sender?: SenderLabel;
  /** 本条消息的声明（类型层载体，运行期不存在） */
  readonly __message?: M;
  /** 本条消息的响应类型（类型层载体，ResponseOf 的唯一事实源） */
  readonly __response?: R;
};

// 登记助手：显式带上本条消息形状 M 与响应类型 R；回包口径档由重载把**字面量**
// 带进返回类型（handler 注册面的返回值契约从它派生，见 BackgroundHandlerResult）。
// 三个重载 = 三档，调用点维持两个显式类型实参（M / R），登记对象的形状与取值
// 逐字不变。唯一的 cast 是 shape 入参由 M 宽化到 unknown（存储面签名一致）。
type BackgroundMessageRegistrationArgument<M extends BackgroundMessage, Mode extends MessageReplyMode> = {
  reply: Mode;
  shape?: (message: M) => boolean;
  sender?: SenderLabel;
};

function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, "async">
): BackgroundMessageRegistration<M, R, "async">;
function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, "sync">
): BackgroundMessageRegistration<M, R, "sync">;
function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, "branch">
): BackgroundMessageRegistration<M, R, "branch">;
function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, MessageReplyMode>
): BackgroundMessageRegistration<M, R> {
  return registration as BackgroundMessageRegistration<M, R>;
}

// 三家 providers-save 共用的 payload 最小 schema 判据：providers 缺省放行，
// 出现时必须数组（null 也拒——与收敛前的 `!== undefined && !Array.isArray` 逐字同义）。
function isProvidersArrayOrAbsent(message: {
  providers?: unknown;
}): boolean {
  return message.providers === undefined || Array.isArray(message.providers);
}

// 逐条登记（键集 = BackgroundMessageType 全集，由 satisfies 穷尽；漏登记 / 多登记
// 在 tsc 门禁报错）。顺序与 BackgroundMessage 联合一致（名单派生顺序随它）。
export const BACKGROUND_MESSAGE_REGISTRY = {
  "get-settings": registerBackgroundMessage<GetSettingsMessage, GetSettingsResponse>({
    reply: "async"
  }),
  "save-settings": registerBackgroundMessage<SaveSettingsMessage, SaveSettingsResponse>({
    reply: "async",
    // payload 最小 schema：settings 缺省 / null 放行，非数组对象才合法
    shape: (message) =>
      message.settings == null
      || (typeof message.settings === "object" && !Array.isArray(message.settings))
  }),
  "request-provider-origins": registerBackgroundMessage<
    RequestProviderOriginsMessage,
    RequestProviderOriginsResponse
  >({
    reply: "branch"
  }),
  "check-provider-origin": registerBackgroundMessage<
    CheckProviderOriginMessage,
    CheckProviderOriginResponse
  >({
    reply: "async"
  }),
  "ensure-offscreen-chat": registerBackgroundMessage<
    EnsureOffscreenChatMessage,
    EnsureOffscreenChatResponse
  >({
    reply: "async"
  }),
  "player-ai-quick-action": registerBackgroundMessage<
    PlayerAiQuickActionMessage,
    PlayerAiQuickActionResponse
  >({
    reply: "branch",
    // payload 最小 schema：tabId 缺省放行，出现时必须有限数
    shape: (message) => message.tabId === undefined || Number.isFinite(message.tabId)
  }),
  "fetch-json": registerBackgroundMessage<FetchJsonMessage, FetchJsonResponse>({
    reply: "branch"
  }),
  "ai-providers-list": registerBackgroundMessage<AiProvidersListMessage, AiProvidersListResponse>({
    reply: "async"
  }),
  "ai-presets-list": registerBackgroundMessage<AiPresetsListMessage, AiPresetsListResponse>({
    reply: "sync"
  }),
  "get-ai-provider-key": registerBackgroundMessage<GetAiProviderKeyMessage, GetAiProviderKeyResponse>({
    reply: "branch"
  }),
  "ai-providers-save": registerBackgroundMessage<AiProvidersSaveMessage, AiProvidersSaveResponse>({
    reply: "async",
    shape: isProvidersArrayOrAbsent
  }),
  "ai-providers-delete": registerBackgroundMessage<
    AiProvidersDeleteMessage,
    AiProvidersDeleteResponse
  >({
    reply: "async"
  }),
  "ai-providers-models": registerBackgroundMessage<
    AiProvidersModelsMessage,
    AiProvidersModelsResponse
  >({
    reply: "async"
  }),
  "provider-http": registerBackgroundMessage<ProviderHttpMessage, ProviderHttpResponse>({
    reply: "async"
  }),
  "resolve-ai-provider": registerBackgroundMessage<
    ResolveAiProviderMessage,
    ResolveAiProviderResponse
  >({
    reply: "async"
  }),
  "asr-presets-list": registerBackgroundMessage<AsrPresetsListMessage, AsrPresetsListResponse>({
    reply: "sync"
  }),
  "asr-providers-list": registerBackgroundMessage<
    AsrProvidersListMessage,
    AsrProvidersListResponse
  >({
    reply: "async"
  }),
  "asr-providers-save": registerBackgroundMessage<AsrProvidersSaveMessage, AsrProvidersSaveResponse>({
    reply: "async",
    shape: isProvidersArrayOrAbsent
  }),
  "asr-providers-delete": registerBackgroundMessage<
    AsrProvidersDeleteMessage,
    AsrProvidersDeleteResponse
  >({
    reply: "async"
  }),
  "get-asr-runtime-config": registerBackgroundMessage<
    GetAsrRuntimeConfigMessage,
    GetAsrRuntimeConfigResponse
  >({
    reply: "async"
  }),
  "search-providers-list": registerBackgroundMessage<
    SearchProvidersListMessage,
    SearchProvidersListResponse
  >({
    reply: "async"
  }),
  "search-providers-save": registerBackgroundMessage<
    SearchProvidersSaveMessage,
    SearchProvidersSaveResponse
  >({
    reply: "async",
    shape: isProvidersArrayOrAbsent
  }),
  "search-providers-delete": registerBackgroundMessage<
    SearchProvidersDeleteMessage,
    SearchProvidersDeleteResponse
  >({
    reply: "async"
  }),
  "resolve-search-provider": registerBackgroundMessage<
    ResolveSearchProviderMessage,
    ResolveSearchProviderResponse
  >({
    reply: "async"
  }),
  "search-cache": registerBackgroundMessage<SearchCacheMessage, SearchCacheResponse>({
    reply: "async"
  }),
  "search-health": registerBackgroundMessage<SearchHealthMessage, SearchHealthResponse>({
    reply: "async"
  }),
  // 段缓存族是 offscreen 专属来源（只接受 offscreen 文档发送）
  "segment-cache": registerBackgroundMessage<SegmentCacheMessage, SegmentCacheResponse>({
    reply: "async",
    sender: "offscreen"
  }),
  "offload-task": registerBackgroundMessage<OffloadTaskMessage, OffloadTaskResponse>({
    reply: "branch"
  }),
  // 工单 03：offscreen 自关闭请求同样只接受 offscreen 文档本身
  "offscreen-request-close": registerBackgroundMessage<
    OffscreenRequestCloseMessage,
    OffscreenRequestCloseResponse
  >({
    reply: "async",
    sender: "offscreen"
  }),
  "get-debug-log-gate": registerBackgroundMessage<
    GetDebugLogGateMessage,
    GetDebugLogGateResponse
  >({
    reply: "async"
  })
} satisfies {
  readonly [K in BackgroundMessageType]: BackgroundMessageRegistration<
    Extract<BackgroundMessage, { type: K }>,
    unknown
  >;
};

export type BackgroundMessageRegistry = typeof BACKGROUND_MESSAGE_REGISTRY;

// 来源守卫的单源（名单从注册表逐条的 sender 标签派生，增减一项只改对应登记）：
// 「谁能发」属协议契约。语义 = 扩展级副作用能力只开放给 offscreen 文档本身
// （SW 代执行的另一面，当前唯一的标签是 "offscreen"）；名单外消息默认放行（发送者
// 含 content，见 search-cache / search-health 段的例外注释）。判据本体与关闭执行器
// 共用 asr/offscreen-bridge.bg.ts 的 isOffscreenDocumentSender（只判来源、不持名单），
// 由组合根按标签注入 core/message-router。
export const OFFSCREEN_ONLY_MESSAGE_TYPES: ReadonlyArray<BackgroundMessageType> = (
  Object.keys(BACKGROUND_MESSAGE_REGISTRY) as BackgroundMessageType[]
).filter((type) => BACKGROUND_MESSAGE_REGISTRY[type].sender !== undefined);

// ===== 响应类型映射（arch-slim-2/02 → 注册表派生）=====

// ResponseOf<M> 按消息类型分发到其响应类型：sendRuntimeMessage 泛型化后，调用点
// 以消息字面量（如 { type: "get-settings" }）即得完整响应形状。content 侧三条
// handler 消息仍是并列声明（owner 在 entry/message-handler.ts 的 content 路由表，
// 不在 SW 注册表）；SW 侧一律查注册表的响应类型载体。新增消息漏登记时注册表的
// satisfies 在 tsc 门禁报错（tests/shared/messaging-response-map.guard.ts 另有类型级
// 穷尽断言），不会静默退化为 unknown / never。
export type BackgroundResponseOf<K extends BackgroundMessageType> =
  NonNullable<BackgroundMessageRegistry[K]["__response"]>;

export type ResponseOf<M> = M extends ReaderEnterMessage ? ReaderEnterResponse
  : M extends ReaderCloseMessage ? ReaderCloseResponse
  : M extends ReaderRestoreMessage ? ReaderRestoreResponse
  : M extends BackgroundMessage ? BackgroundResponseOf<M["type"]>
  : never;

