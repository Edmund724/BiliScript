import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../core/default-prompts.js";
import { PRESETS, ASR_PROVIDER_PRESETS, SEARCH_PROVIDER_PRESETS } from "../core/presets.js";
import { normalizePlayerAiQuickPrompt } from "../core/validators.js";
import { buildReaderModeUrl, isSupportedBilibiliPage } from "../bilibili/video-id-shared.js";
import {
  EXPECTED_CONTENT_SCRIPT_VERSION,
  injectReaderContent,
  probeContentScriptVersion,
  triggerReaderModeInTab
} from "./content-orchestration-wiring.js";
import { normalizeSettings, saveSettings } from "../core/settings-store.js";
// 设置快照（sw-settings-snapshot 票）：四个热路径读 handler 读设置/平台存储
// 的唯一读路径（设置 UI 的 list/get CRUD 读维持直读 provider-store，不入快照）。
// 读命中时热路径 storage 读为 0；失效双通道 = 写 handler 落盘后 inline
// invalidate + 快照内 onChanged 订阅兜底跨设备 sync 变更（onChanged 不在写入
// 方上下文触发，inline 失效是写后读的唯一保证）。
import {
  getSettings as getSettingsSnapshot,
  getProviderStore as getProviderStoreSnapshot,
  getSearchProviderOrder,
  getSearchHealth,
  invalidate as invalidateSettingsSnapshot,
  PROVIDER_FAMILY_STORAGE_KEYS
} from "../core/settings-snapshot.js";
// 安装/更新一次性设置迁移（2026-09 AI 键默认开：存量显式 false 清位；免 Key 搜索
// 预设自动激活的决策半边）
import {
  applyPlayerAiQuickActionDefaultOnMigration,
  planSearchPresetsAutoActivation
} from "./settings-migration.js";
// 调试日志门三宿主接线（shared/logging 的 registerDebugGate 消费方）
import { registerDebugLogGate } from "../shared/debug-log-gate.js";
import { logWarn } from "../shared/logging.js";
import {
  aiProviderStore
} from "../core/ai-provider-store.js";
import { asrProviderStore } from "../asr/asr-provider-store.js";
// 搜索平台存储（spec §3.3）：列表/Key 消息族与 AI/ASR 同契约
import { SEARCH_PROVIDER_ORDER_STORAGE, searchProviderStore } from "../search/search-provider-store.js";
// 搜索模式单源（spec §1 S6 / §12.1）：activeSearchProviderId 两义——记录 id = 单选、
// 哨兵 / 空串 = 智能（链解析按模式产出独苗链或有序回退链）
import { resolveSearchMode } from "../core/search-mode.js";
// 回退链解析（spec §1 S1/S4/S6、§12.1–§12.3）：链 = 记录集合按 presetId 查预设表定类，
// SW 是唯一知道 Key 的一侧（链解析回包一次带出有序候选 + 各自 Key）
import { resolveSearchChain } from "../search/search-chain.js";
// 查询缓存 SW 叶（spec §5）：宿主是 SW（offscreen 无 chrome.storage），offscreen
// 工具循环与 content 侧解释卡都经 search-cache 消息族读写；归一单源在本叶。
// clearSearchCache 只在本文件被两个撤回入口调用（§6.7）：不给消息族加 clear op。
import { clearSearchCache, getSearchCacheEntry, putSearchCacheEntry } from "../search/search-cache.js";
// 引擎健康度 SW 叶（spec §12.4）：记账落 chrome.storage.local 单键
// biliscript_search_health（引擎级 presetId），链解析期经快照读产冷却图。
import { SEARCH_HEALTH_KEY, cooldownUntilByPresetId, recordSearchAttempt } from "../search/search-health.js";
// 模型列表探测（fetch 原语）归 ai 域（arch-slim-2/09）；纯存储仍在 core/。
import { handleAiProvidersModels as fetchAiProviderModels } from "../ai/provider-models.js";
// 平台请求代发（AI 探针传输层）：content script 的跨域 fetch 服从网页 CORS，
// 不支持浏览器预检的平台（OPTIONS 无 Access-Control-Allow-*）只能报
// 「Failed to fetch」——代发让探针与模型列表同源路径（core/provider-http.ts）。
import { handleProviderHttpRequest } from "../core/provider-http.js";
import {
  createProviderMessageHandlers,
  createAsrRuntimeConfigHandler,
  createAiResolvedProviderHandler,
  withOkResponse
} from "../core/provider-handlers.js";
// offscreen 段缓存消息族 SW 端 handler（offscreen 文档无 chrome.storage，
// 段缓存读写经消息直调 ai/segment-cache 单源——arch-review-2026-09/05）
import { createSegmentCacheHandler } from "../ai/segment-cache-handler.js";
// 08 票 SW 保活：Map-Reduce/流式运行期间 offscreen 持长连端口钉住 SW
// （防 30s 空闲回收反复冷启动），SW 端接受持有即生效
import { isSwKeepalivePort } from "../ai/sw-keepalive.js";
// SW 静态图只进传输叶（arch-slim-2/04）：bgFetchJson/isBiliUrl 拆至 gateway-core，
// 不经 gateway 拖入 state/video-probe/selection→cache 链。
import { bgFetchJson, isBiliUrl } from "../bilibili/gateway-core.js";
// script-only-ui：侧边栏设置面板的 host 权限代申请（collectOrigins 纯函数）与
// content 侧 offscreen 代发的权限代查（hasHostPermission）
import { collectOrigins, hasHostPermission } from "../core/host-permissions.js";
// PR5：对话 tab 的 offscreen 文档 ensure 通道（background 侧唯一合法创建点）
import { ensureChatOffscreenDocument } from "../chat/offscreen-ensure.js";
import { handleAsrDecodePrepare, handleAsrDecodeCleanup, handleOffscreenRequestClose, isOffscreenDocumentSender, reapAllSessionRules } from "../asr/offscreen-bridge.bg.js";
import { ASR_TASK_PREPARE, ASR_TASK_CLEANUP } from "../asr/protocol.js";
import type {
  BackgroundMessage,
  BackgroundMessageType,
  MessageHandler,
  MessageSender,
  SendResponse
} from "../shared/messaging-protocol.js";

// ===== 消息路由表 =====

type BackgroundHandler = MessageHandler<BackgroundMessage>;
type Msg<T extends BackgroundMessageType> = Extract<BackgroundMessage, { type: T }>;

function handleGetSettings(_message: Msg<"get-settings">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  // 异步错误回包统一走 withOkResponse（arch-slim-2/03 单源）；同步错误回包
  // （缺参/拒绝处理等）保持处理器内直写。
  withOkResponse(
    (async () => ({ ok: true, settings: await getSettingsSnapshot() }))(),
    sendResponse
  );
  return true;
}

function handleSaveSettings(message: Msg<"save-settings">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => {
      // 显式取撤回判据（settings 是 unknown 线格式，落盘与失效各自照旧收口）
      const payload = (message.settings || {}) as { webSearchEnabled?: unknown };
      // 撤回同意的主入口（spec §6.7 / §10 第 40 行）：只有 webSearchEnabled
      // **从 true 变 false** 才是「关 pill」的撤回——content 侧整份
      // state.settings 落盘时 pill 恒 false，按 payload === false 判会把与撤回
      // 无关的保存误判成撤回。判据取**保存前**的快照值（判定用保存前的值，
      // 失效顺序维持既有形态）；payload 不带该键、false→false、true→true 都不清。
      const searchOptOut =
        payload.webSearchEnabled === false && (await getSettingsSnapshot()).webSearchEnabled;
      await saveSettings(message.settings || {});
      // 写后 inline 失效：payload 键全集交给快照按键域映射（白名单外键自然
      // 落空）；onChanged 不在写入方上下文触发，这里必须显式失效。
      invalidateSettingsSnapshot(Object.keys(message.settings || {}));
      if (searchOptOut) {
        // 缓存里存着 query 哈希与结果，撤回后本地继续留着说不通；清空失败静默
        // （logWarn 同既有形态），不因缓存清理失败阻断设置保存的回包。
        try {
          await clearSearchCache();
        } catch (error) {
          logWarn("[BILISCRIPT] search cache clear on opt-out failed", error);
        }
      }
      return { ok: true };
    })(),
    sendResponse
  );
  return true;
}

// script-only-ui：侧边栏设置面板（content script）保存时的 host 权限代申请。
// content script 无 chrome.permissions API，用户手势经本次 runtime 消息传导到
// 本处理器——chrome.permissions.request 必须是处理器内的第一个动作（任何先行
// await 都会耗尽手势，被 Chrome 以「缺少用户手势」拒绝，见
// core/host-permissions.ts 的 requestProviderOriginsViaBackground）。
function handleRequestProviderOrigins(message: Msg<"request-provider-origins">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const origins = collectOrigins(message.baseUrls);
  if (origins.length === 0) {
    sendResponse({ ok: true });
    return false;
  }
  if (typeof chrome.permissions?.request !== "function") {
    sendResponse({ ok: false, error: "当前环境不支持申请权限" });
    return false;
  }
  // chrome.permissions.request 仍是处理器内的第一个动作（手势不变式，见上方
  // 注释）：async 函数体在首个 await 前同步执行，request 在其中同步发起、
  // await 只落在其返回的 promise 上；拒绝文案带固定前缀，经 withOkResponse
  // 的 toError 保持逐字一致。
  withOkResponse(
    (async () => {
      const requestTask = chrome.permissions.request({ origins });
      const granted = await requestTask;
      return granted
        ? { ok: true }
        : {
            ok: false,
            error: `未授权 ${origins.join("、")}，操作已中止：请在权限弹窗中选择允许后重试`
          };
    })(),
    sendResponse,
    (error) => `申请域名权限失败：${(error as Error).message}`
  );
  return true;
}

// content 侧（概览/快捷提示词的 offscreen 代发）的 host 权限代查：只读一问，无手势
// 要求、无副作用。未授权时 content 侧直接以可操作文案失败，不再建 offscreen 文档、
// 也不发注定失败的跨域请求——与 SW 代发通道（core/provider-http.ts）的预检同口径。
// origin 缺失/非法按已授权回 true（core/host-permissions 的同款 fail-open）。
function handleCheckProviderOrigin(message: Msg<"check-provider-origin">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  void hasHostPermission(message.origin).then((granted) => sendResponse({ granted }));
  return true;
}

// PR5：对话 tab（content script）发送前的 offscreen 文档自愈 ensure。chrome.offscreen
// / chrome.runtime.getContexts 仅扩展上下文可用，content script 经此消息委托
// background 幂等创建（sidepanel 扩展页内直调 ensureChatOffscreenDocument 的
// 等价通道）。ensure 失败不再吞掉（工单 03）：ensureChatOffscreenDocument 的
// 原始错误经 withOkResponse 回 { ok:false, error }——调用方 catch 后仍由
// connect 结果兜底（发送链不中断），但失败原因不再无声丢失。
function handleEnsureOffscreenChat(_message: Msg<"ensure-offscreen-chat">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => ({ ok: true, ensured: await ensureChatOffscreenDocument() }))(),
    sendResponse
  );
  return true;
}

// 「进/聚焦阅读模式 + 定位对话 tab + 自动发送快捷提示词」的统一编排
//（arch-slim-3/04 收口）：单条带 chat 负载的 reader-enter 命令直达 content 侧
//（进入事务内激活对话 tab），不再即答后二次直发——双消息直发的进入/对话竞态
// 在消息序上收口。触发失败回可读文案。
const readerTriggerFailedText = "阅读模式触发失败，请刷新浏览器网页重试";

async function triggerReaderChatInTab(
  tabId: number,
  options: {
    requireQuickActionEnabled: boolean;
    readerUrl: string;
  }
): Promise<{ ok: true }> {
  const settings = await getSettingsSnapshot();
  if (options.requireQuickActionEnabled && !settings.enablePlayerAiQuickAction) {
    throw new Error("AI 按钮未开启");
  }
  const prompt = normalizePlayerAiQuickPrompt(settings.playerAiQuickPrompt || DEFAULT_PLAYER_AI_QUICK_PROMPT);
  let url = options.readerUrl;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.bilibili.com") {
        throw new Error("当前网页不是 B 站视频页");
      }
      parsed.searchParams.set("biliscript_reader", "1");
      url = parsed.toString();
    } catch (error) {
      throw new Error((error as Error).message || "阅读视图地址无效");
    }
  }
  const triggered = await triggerReaderModeInTab(tabId, url, { prompt });
  if (!triggered) {
    throw new Error(readerTriggerFailedText);
  }
  return { ok: true };
}

// player-ai 悬浮按钮语义反转（工单 08 决议 2）：不再打开 AI 侧边栏/写 storage
// 信箱（biliscript_player_ai_quick_action_v1 已退役），改为「进入/聚焦阅读模式 +
// 定位对话 tab + 自动发送快捷提示词」——单条带 chat 负载的 reader-enter 走
// triggerReaderModeInTab 链（空 readerUrl = 已在阅读模式内，只聚焦），
// 提示词组装后由 content 侧进入事务内的对话 seam runQuickActionPrompt 消费。
function handlePlayerAiQuickAction(message: Msg<"player-ai-quick-action">, sender: MessageSender, sendResponse: SendResponse): boolean {
  const senderTabId = Number(sender.tab?.id) || 0;
  const requestedTabId = Number(message.tabId) || 0;
  // 标签页归属（工单 03）：带 sender.tab 的来源（content script）只能操作
  // 自己所在的标签页——message.tabId 与 sender.tab.id 同时存在且不一致即
  // 跨标签页伪造，拒绝且不执行任何副作用。
  if (senderTabId && requestedTabId && requestedTabId !== senderTabId) {
    sendResponse({ ok: false, error: "请求目标与发送者标签页不一致，已拒绝。" });
    return false;
  }
  const tabId = senderTabId || requestedTabId;
  if (!tabId) {
    sendResponse({ ok: false, error: "找不到当前标签页。" });
    return false;
  }

  withOkResponse(
    triggerReaderChatInTab(tabId, {
      requireQuickActionEnabled: true,
      readerUrl: ""
    }),
    sendResponse,
    (error) => (error as Error).message || "打开 AI 对话失败"
  );
  return true;
}

function handleFetchJson(message: Msg<"fetch-json">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const url = typeof message.url === "string" ? message.url : "";
  if (!url) {
    sendResponse({ ok: false, error: "Missing subtitle URL" });
    return false;
  }
  // 策略收口到通道：本处理器只为 B 站 API/字幕 CDN 带 cookie 代理取数，
  // 非 B 站 URL 一律拒绝——调用方（gateway 的 isBiliUrl 前置过滤）之外再挡一层，
  // 防止未来新调用方漏掉前置过滤时把本通道当成任意 URL 的带凭据代理。
  if (!isBiliUrl(url)) {
    sendResponse({ ok: false, error: "Non-Bilibili URL" });
    return false;
  }

  // withOkResponse 收口（arch-slim-2/03）：JSON 解析失败（200 但非 JSON 响应）
  // 时给用户稳定的可读文案，而非引擎原生 SyntaxError。
  withOkResponse(
    (async () => ({ ok: true, data: await bgFetchJson(url) }))(),
    sendResponse,
    (error) => (error instanceof SyntaxError ? "Invalid JSON response" : (error as Error).message)
  );
  return true;
}

// Provider CRUD 消息：AI / ASR 两个家族形状相同，统一由
// core/provider-handlers.js 的工厂装配。响应负载与消息名保持不变，
// 路由表只换处理器指向。连通性测试均不在 SW 静态图里跑探针本体：AI 探针的
// 请求构造仍在 content 侧 ai/provider-test.js（completion 链不进 SW，候选 04
// 拆链），只有传输经 provider-http 代发；ASR 探针（asr/provider-test.js）仍在
// content 侧直调，wav-encode 链同样不进 SW。故本工厂不注入 probe。
//
// 写后 inline 失效：providers-save/delete 落盘 await 完成后失效对应族快照
// （onChanged 不在写入方上下文触发，写后读语义靠这里保证；load-modify-write
// 本体仍直读存储，不经快照——spec Q3 写路径纪律）。
function invalidateAfterWrite<TArgs extends unknown[], TResult>(
  write: (...args: TArgs) => Promise<TResult>,
  storageKeys: readonly string[]
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    const result = await write(...args);
    invalidateSettingsSnapshot(storageKeys);
    return result;
  };
}

const aiProviderHandlers = createProviderMessageHandlers({
  loadProviders: aiProviderStore.loadProviders,
  saveProviders: invalidateAfterWrite(aiProviderStore.saveProviders, PROVIDER_FAMILY_STORAGE_KEYS.ai),
  deleteProvider: invalidateAfterWrite(aiProviderStore.deleteProvider, PROVIDER_FAMILY_STORAGE_KEYS.ai),
  loadKeys: aiProviderStore.loadKeys
});

// 「激活平台」单趟解析（arch-slim-3/09）：offscreen 聊天链与 content 侧
// 概览/选区解释共用，解析策略与密钥校验单源在处理器内。列表与 Key 同走
// settings-snapshot 的 ai 族快照：一次 storage 读拿全（此前 aiProviderKeys
// 在 loadProviders 与 loadKeys 间重复读两次）。
const aiResolvedProviderHandler = createAiResolvedProviderHandler({
  getMergedSettings: getSettingsSnapshot,
  loadProviders: async () => (await getProviderStoreSnapshot("ai")).providers,
  loadKeys: async () => (await getProviderStoreSnapshot("ai")).keys
});

function handleAiPresetsList(_message: Msg<"ai-presets-list">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  sendResponse({ ok: true, presets: PRESETS.slice() });
  return false;
}

function handleAiProvidersModels(message: Msg<"ai-providers-models">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const baseUrl = String(message.baseUrl || "").trim();
  if (!baseUrl) {
    sendResponse({ ok: false, error: "请填写 baseUrl" });
    return true;
  }
  withOkResponse(
    fetchAiProviderModels({
      baseUrl,
      apiKey: String(message.apiKey || "").trim(),
      providerId: String(message.providerId || "").trim()
    }),
    sendResponse,
    (error) => (error as Error | undefined)?.message || String(error)
  );
  return true;
}

// 平台请求代发（AI 探针传输层）：URL 合法性与 host 权限判定收口在
// core/provider-http.ts；代发结果（含 HTTP 状态与响应体文本）原样回给
// content 侧合成的 Response，探针的错误文案仍由 completion 链统一拼装。
function handleProviderHttp(message: Msg<"provider-http">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    handleProviderHttpRequest({
      url: message.url,
      method: message.method,
      headers: message.headers,
      body: message.body
    }),
    sendResponse,
    (error) => (error as Error | undefined)?.message || String(error)
  );
  return true;
}

// ===== 联网搜索消息处理 =====

// 联网搜索运行时解析（spec §1 S4/S6、§3 落点表第 11 行、§12.1–§12.3、§12.5 第 10 行）：
// offscreen 文档无 chrome.storage，工具循环的搜索配置（**有序候选链 + 各自 Key** +
// 单轮上限）经本消息单趟往返。链成员是记录，成员资格由记录的 presetId 查预设表得出；
// 模式由 activeSearchProviderId 判定（记录 id = 单选独苗链 / 哨兵或空串 = 智能回退链），
// 智能链序 = searchProviderOrder 归一序 > 内置默认序，冷却中的引擎（健康度图里
// cooldownUntil > now 的 presetId）跳过；无任何合格记录时 chain 缺省
// ——调用方 notice 后走原无工具路径，不算错误（搜索是增强，缺失不阻塞对话）。
// **空链归因**（spec §12.7 第 6 条，2026-10-01 翻案）：空链有因不分——「真的没有
// 合格记录」与「合格记录全在冷却中」不是一回事，后者回 `chainEmptyReason:"cooldown"`
// 供调用方出专属文案（不再误报「未配置搜索平台」）。
function handleResolveSearchProvider(_message: Msg<"resolve-search-provider">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => {
      // settings 标量 + 搜索平台列表 + Key + 用户顺序一次快照读取（命中时零 storage 调用）
      const settings = await getSettingsSnapshot();
      const { providers, keys } = await getProviderStoreSnapshot("search");
      const order = await getSearchProviderOrder();
      const activeId = settings.activeSearchProviderId;
      // 冷却图（spec §12.4 第 6 条）：健康度快照 → 只含 cooldownUntil > now 的项；
      // 只有智能链消费它（单选不拦但账照记）。now 注入纯函数，与快照同一次取时。
      const now = Date.now();
      const cooldownUntil = cooldownUntilByPresetId(await getSearchHealth(), now);
      const mode = resolveSearchMode(activeId);
      const chain = resolveSearchChain(providers, keys, activeId, SEARCH_PROVIDER_PRESETS, {
        mode,
        order,
        cooldownUntil,
        now
      });
      if (chain.length === 0) {
        // 判空因（纯函数同参重跑，只是不消费冷却）：同一批记录在不消费冷却时非空
        // → 空的原因是合格记录全部在冷却中（单选不消费冷却，故单选空链在此必为空口径）。
        const unfiltered = resolveSearchChain(providers, keys, activeId, SEARCH_PROVIDER_PRESETS, {
          mode,
          order,
          now
        });
        return unfiltered.length > 0 ? { ok: true, chainEmptyReason: "cooldown" } : { ok: true };
      }
      return {
        ok: true,
        chain,
        maxToolCalls: settings.webSearchMaxToolCalls
      };
    })(),
    sendResponse,
    (error) => (error as Error | undefined)?.message || String(error)
  );
  return true;
}

// 查询缓存消息族 SW 端 handler（spec §5 / §3 落点表第 13 行）：get / put 直调
// search/search-cache.ts 单源（归一 + 64 位哈希键都在那一侧完成，调用方不拼键）。
// **不得**进 illegalMessageReason 的 offscreen-only 名单——本族发送者含 content
// （reader/explain-card.ts 与 offscreen 工具循环共用 search/search-runtime.ts）。
function handleSearchCache(message: Msg<"search-cache">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => {
      if (message.op === "get") {
        const entry = await getSearchCacheEntry(message.query);
        return entry
          ? { ok: true, hit: true, entry: { results: entry.results, platform: entry.platform } }
          : { ok: true, hit: false };
      }
      if (message.op === "put") {
        await putSearchCacheEntry(message.query, {
          results: Array.isArray(message.results) ? message.results : [],
          platform: String(message.platform ?? "")
        });
        return { ok: true };
      }
      throw new Error("不支持的搜索缓存操作：" + String((message as { op?: unknown }).op));
    })(),
    sendResponse,
    (error) => (error as Error | undefined)?.message || String(error)
  );
  return true;
}

// 引擎健康度记账消息族 SW 端 handler（spec §12.4 第 7–8 条 / §12.5 第 11 行）：执行侧
// （offscreen / content）无 chrome.storage，记账经本族落到 SW 叶 search/search-health.ts
// 单源（脏载荷静默 no-op、写失败静默、SW 侧盖时间戳）；落盘后 **inline 失效**健康度
// 快照，写后读（紧随其后的 resolve-search-provider）立刻消费新冷却图。
// **不得**进 illegalMessageReason 的 offscreen-only 名单——本族发送者含 content
//（reader/explain-card.ts 与 offscreen 工具循环共用 search-chain.ts 的缺省记账）。
function handleSearchHealth(message: Msg<"search-health">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => {
      if (message.op !== "record") {
        throw new Error("不支持的搜索健康度操作：" + String((message as { op?: unknown }).op));
      }
      await recordSearchAttempt(message.presetId, message.ok, message.latencyMs);
      invalidateSettingsSnapshot([SEARCH_HEALTH_KEY]);
      return { ok: true };
    })(),
    sendResponse,
    (error) => (error as Error | undefined)?.message || String(error)
  );
  return true;
}

// ===== ASR 平台消息处理 =====

function handleAsrPresetsList(_message: Msg<"asr-presets-list">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  sendResponse({ ok: true, presets: ASR_PROVIDER_PRESETS.slice() });
  return false;
}

// ASR 平台 CRUD 处理器：连通性测试已迁出 SW，本工厂只负责列表 / Key 的
// 消息路由，与 AI 家族共用同一套契约。
const asrProviderHandlers = createProviderMessageHandlers({
  loadProviders: asrProviderStore.loadProviders,
  saveProviders: invalidateAfterWrite(asrProviderStore.saveProviders, PROVIDER_FAMILY_STORAGE_KEYS.asr),
  deleteProvider: invalidateAfterWrite(asrProviderStore.deleteProvider, PROVIDER_FAMILY_STORAGE_KEYS.asr),
  loadKeys: asrProviderStore.loadKeys
});

// 删除搜索平台记录 + 清空整张查询缓存（spec §6.7 / §10 第 40 行）：删除是撤回的
// 次入口（「不想这家收到」），删除本身走与 CRUD 同一条写后失效包装；清缓存失败
// 静默（logWarn 同既有形态），不影响删除回包。
// 另把该 id 从 searchProviderOrder 剔除（spec §12.2 末条 / §12.5 第 11 行）：不改的话
// 「删掉一个平台」会让顺序数组含未知 id → 整份自定义顺序被「脏值整体作废」丢掉。
// 仅在数组确实含该 id 时写回 + inline 失效；键缺席 / 脏值 / 写失败都静默跳过
//（顺序是偏好不是数据）。
async function pruneSearchProviderOrder(providerId: string): Promise<void> {
  const stored = await chrome.storage.sync.get([SEARCH_PROVIDER_ORDER_STORAGE]);
  const raw = stored?.[SEARCH_PROVIDER_ORDER_STORAGE];
  if (!Array.isArray(raw) || !raw.includes(providerId)) return;
  await chrome.storage.sync.set({
    [SEARCH_PROVIDER_ORDER_STORAGE]: raw.filter((id) => id !== providerId)
  });
  invalidateSettingsSnapshot([SEARCH_PROVIDER_ORDER_STORAGE]);
}

async function deleteSearchProviderAndClearCache(providerId: string): Promise<unknown[]> {
  const providers = await invalidateAfterWrite(
    searchProviderStore.deleteProvider,
    PROVIDER_FAMILY_STORAGE_KEYS.search
  )(providerId);
  try {
    await pruneSearchProviderOrder(providerId);
  } catch (error) {
    logWarn("[BILISCRIPT] search provider order prune on provider delete failed", error);
  }
  try {
    await clearSearchCache();
  } catch (error) {
    logWarn("[BILISCRIPT] search cache clear on provider delete failed", error);
  }
  return providers;
}

// 搜索平台 CRUD 处理器（spec §3.3）：与 AI / ASR 家族共用同一套契约（列表 /
// Key 的消息路由），连通性测试随后续 tool-loop 迭代再议。删除入口挂撤回清缓存
// （§6.7 / §10 第 40 行）：删掉记录即本地不再留 query 哈希与结果。
const searchProviderHandlers = createProviderMessageHandlers({
  loadProviders: searchProviderStore.loadProviders,
  saveProviders: invalidateAfterWrite(searchProviderStore.saveProviders, PROVIDER_FAMILY_STORAGE_KEYS.search),
  deleteProvider: deleteSearchProviderAndClearCache,
  loadKeys: searchProviderStore.loadKeys
});

// 自动激活的记录写走与 CRUD 同一条写后失效包装（spec §2 落点③）：落盘后失效
// search 族快照，写后读（resolve-search-provider）拿新链。
const saveSearchProvidersWithInvalidate = invalidateAfterWrite(
  searchProviderStore.saveProviders,
  PROVIDER_FAMILY_STORAGE_KEYS.search
);

// 内容脚本 ASR 回退的运行时配置：settings 标量 + provider-store 列表 + 激活
// 平台 Key 一次回包，provider-store 存储层不再进内容 bundle（契约见
// provider-handlers.js）。读路径走 settings-snapshot 的 asr 族快照。
const handleGetAsrRuntimeConfig = createAsrRuntimeConfigHandler({
  getMergedSettings: getSettingsSnapshot,
  loadProviders: async () => (await getProviderStoreSnapshot("asr")).providers,
  getAsrProviderKey: async (providerId) => {
    const { keys } = await getProviderStoreSnapshot("asr");
    return String(keys[providerId] || "").trim();
  }
});

// offscreen 段缓存消息族：offscreen 文档只有 chrome.runtime（平台限制），
// Map-Reduce / 追问链的段缓存读写经此 handler 直调 ai/segment-cache 落真实
// chrome.storage.local（arch-review-2026-09/05，替下 storage-local-bridge 垫片）。
const handleSegmentCache = createSegmentCacheHandler();

// ===== 通用 offscreen 任务通道 =====

// 把任务转发给"临时创建的 offscreen 文档"执行：asr-decode-prepare 建文档 +
// 加防盗链规则（页面侧随后直连 offscreen 的 asr-decode 端口传下载解码任务），
// asr-decode-cleanup 清规则。消息类型分发给对应执行函数。
const offloadTaskHandlers = new Map<string, (message: unknown, sender: MessageSender, sendResponse: SendResponse) => void>([
  [ASR_TASK_PREPARE, handleAsrDecodePrepare],
  [ASR_TASK_CLEANUP, handleAsrDecodeCleanup]
]);

function handleOffloadTask(message: Msg<"offload-task">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const taskType = String(message.taskType || "").trim();
  const handler = offloadTaskHandlers.get(taskType);
  if (!handler) {
    sendResponse({ ok: false, error: "不支持的 offscreen 任务类型：" + taskType });
    return false;
  }
  handler(message, _sender, sendResponse);
  return true;
}

// 工单 03：offscreen 文档自关闭的代执行（offscreen 无 chrome.offscreen）。
// 发送者校验在执行器内（isOffscreenDocumentSender，与入口守卫共用判定）。
function handleOffscreenRequestCloseMsg(_message: Msg<"offscreen-request-close">, sender: MessageSender, sendResponse: SendResponse): boolean {
  void handleOffscreenRequestClose(_message, sender, sendResponse);
  return true;
}

// 工单 03：offscreen 侧调试日志门的初始开关（offscreen 无 chrome.storage，
// SW 是 storage 的独占读者；变更经下方 onChanged 监听广播）。
function handleGetDebugLogGate(_message: Msg<"get-debug-log-gate">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => {
      const data = await chrome.storage.sync.get("enableDebugLogs");
      return { ok: true, enabled: Boolean((data as { enableDebugLogs?: unknown })?.enableDebugLogs) };
    })(),
    sendResponse
  );
  return true;
}

// 编译期穷尽路由表（arch-slim-2/02）：字面量表经 satisfies 对
// { [K in BackgroundMessageType]: MessageHandler<Msg<K>> } 校验——
// 消息名 typo / 漏注册 handler / 多注册未知名在 typecheck 即报错（此前 Map +
// 逐条 `as BackgroundHandler` 断言对这一切零捕获）；每个条目的处理器同时按其
// 具体消息形状 Msg<K> 校验，签名与消息类型不匹配同样报错。script-only-ui：
// open-options 处理器已随 options 页删除（设置已全部并入侧边栏面板，无独立
// 设置页可开）。
const messageHandlerTable = {
  "get-settings": handleGetSettings,
  "save-settings": handleSaveSettings,
  "request-provider-origins": handleRequestProviderOrigins,
  "check-provider-origin": handleCheckProviderOrigin,
  "ensure-offscreen-chat": handleEnsureOffscreenChat,
  "player-ai-quick-action": handlePlayerAiQuickAction,
  "fetch-json": handleFetchJson,
  "ai-providers-list": aiProviderHandlers.list,
  "ai-presets-list": handleAiPresetsList,
  "get-ai-provider-key": aiProviderHandlers.get,
  "ai-providers-save": aiProviderHandlers.save,
  "ai-providers-delete": aiProviderHandlers.remove,
  "ai-providers-models": handleAiProvidersModels,
  "provider-http": handleProviderHttp,
  "resolve-ai-provider": aiResolvedProviderHandler,
  "asr-presets-list": handleAsrPresetsList,
  "asr-providers-list": asrProviderHandlers.list,
  "asr-providers-save": asrProviderHandlers.save,
  "asr-providers-delete": asrProviderHandlers.remove,
  "get-asr-runtime-config": handleGetAsrRuntimeConfig,
  "search-providers-list": searchProviderHandlers.list,
  "search-providers-save": searchProviderHandlers.save,
  "search-providers-delete": searchProviderHandlers.remove,
  "resolve-search-provider": handleResolveSearchProvider,
  "search-cache": handleSearchCache,
  "search-health": handleSearchHealth,
  "segment-cache": handleSegmentCache,
  "offload-task": handleOffloadTask,
  "offscreen-request-close": handleOffscreenRequestCloseMsg,
  "get-debug-log-gate": handleGetDebugLogGate
} satisfies { [K in BackgroundMessageType]: MessageHandler<Msg<K>> };

const messageHandlers = new Map<BackgroundMessageType, BackgroundHandler>(
  Object.entries(messageHandlerTable) as Array<[BackgroundMessageType, BackgroundHandler]>
);

// EXPECTED_CONTENT_SCRIPT_VERSION 单源在 entry/content-orchestration-wiring.ts
//（arch-slim-3/04 收编，本文件经 import 消费）。

chrome.runtime.onInstalled.addListener(async () => {
  // ASR 防盗链会话规则整池清理（工单 04，逻辑在 asr/offscreen-bridge.bg.ts）：
  // 安装/更新后把池区间内平台现存规则清掉并重置账本，防旧规则泄漏（会话规则
  // 跨浏览器重启由平台自动清空，本清理是对扩展 reload/update 行为差异的兜底）。
  try {
    await reapAllSessionRules();
  } catch (error) {
    // 清理失败只记日志：残留在下次 prepare 的对账/回收仍会被收编
    logWarn("[BILISCRIPT] asr session rule reap on install/update failed", error);
  }
  try {
    await initializeSettingsStorage();
  } catch (error) {
    // 安装/更新迁移失败不进 SW unhandled rejection，只记日志（下次安装/更新
    // 会重试整段迁移）。
    logWarn("[BILISCRIPT] settings storage init on install/update failed", error);
  }
  try {
    await autoActivateSearchPresets();
  } catch (error) {
    // 自动激活失败只记日志：flag 最后写，任一步失败都留着 flag 未置位，下一次
    // 安装/更新重试整段；判据按 presetId 查缺使重试安全（已补的不会重复写）。
    logWarn("[BILISCRIPT] search presets auto activation on install/update failed", error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  if (!isSupportedBilibiliPage(tab.url)) return;

  try {
    const loadedVersion = await probeContentScriptVersion(tabId);
    if (loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
      await injectReaderContent(tabId);
    }
  } catch (error) {
    // ignore injection failure; user may need a hard refresh
  }
});

// ===== 工具栏 action 点击（工单 02-toolbar-icon-opens-script）=====

// chrome.action 命名空间声明已归并 chrome-types.d.ts（工单 04），原局部
// ActionOnClickedEvent 契约与 cast 删除。可选链守卫：既有测试环境的 chrome
// stub 可能缺 action 命名空间（生产 MV3 + manifest.action 恒有），顶层注册
// 不可因缺命名空间抛错。

// 与页内 文摘按钮同一条 reader-enter 事务：经 triggerReaderModeInTab 的
// 重试/注入链发 reader-enter，content 侧落 entry/message-handler.ts →
// ensureReaderShell 进入事务——不建 popup / Side Panel / 第二套打开流程。
// 目标标签页只取 onClicked 事件自带的活动标签页：reader-enter 载荷没有 tabId
// 字段，跨标签页消息无从伪造目标；非受支持的 B 站视频/稍后再看页直接忽略。
// readerUrl 与页内按钮同源 buildReaderModeUrl（单源 bilibili/video-id-shared.ts，
// SW 侧不 import 拖 core/state 的 bilibili/reader-url.ts）。监听器顶层同步注册
//（MV3：SW 可被重启，事件监听器必须在首个事件前同步就位）。
chrome.action?.onClicked?.addListener(
  async (tab) => {
    const tabId = tab.id ?? 0;
    if (!tabId || !isSupportedBilibiliPage(tab.url)) {
      return;
    }
    const triggered = await triggerReaderModeInTab(tabId, buildReaderModeUrl(tab.url || ""));
    if (!triggered) {
      logWarn("[BILISCRIPT] toolbar action click: reader-enter 触发失败（重试耗尽）");
    }
  }
);

// ===== 入口监听 =====

// 08 票 SW 保活：接受 offscreen 运行期间的长连端口（MV3：SW 生命周期与活动
// 端口绑定，接受持有即钉住，无消息往来）；可选链与 chrome.action 先例一致，
// 测试桩无需提供 onConnect。端口断开（运行结束 / SW 重载）由 runtime 回收。
chrome.runtime.onConnect?.addListener?.((port) => {
  if (!isSwKeepalivePort(port)) {
    return;
  }
  // 保活端口无消息往来：接受持有即生效。
});

// 调试日志门：SW 自读 storage（此前门读 state.settings，SW 里恒为缺省关，
// 用户开的调试日志在 SW 静默）。
registerDebugLogGate();

// 调试日志门变更广播（工单 03）：offscreen 文档没有 chrome.storage，其调试
// 门靠本广播保活（初始开关走 get-debug-log-gate 消息）。无接收方（offscreen
// 未开、扩展页全关）时 sendMessage 会 reject——广播即止，不进 unhandled rejection。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.enableDebugLogs) {
    return;
  }
  void Promise.resolve(
    chrome.runtime.sendMessage({
      type: "debug-log-gate-changed",
      enabled: Boolean(changes.enableDebugLogs.newValue)
    })
  ).catch(() => {});
});

// ===== 消息入口守卫（工单 03）：发送者来源 + 内部 schema =====

// 内部消息 schema 的最小校验 + offscreen 专属消息族的来源校验（只拦形状
// 明显非法/来源不合法的请求，业务归一仍归处理器）。offscreen 专属族：扩展级
// 副作用能力只开放给 offscreen 文档本身（SW 代执行的另一面），判定与关闭
// 执行器共用 isOffscreenDocumentSender（asr/offscreen-bridge.bg.ts）。
function illegalMessageReason(message: BackgroundMessage, sender: MessageSender): string | null {
  if (
    (message.type === "segment-cache" || message.type === "offscreen-request-close")
    && !isOffscreenDocumentSender(sender)
  ) {
    return "仅接受 offscreen 文档发送";
  }
  const badShape =
    (message.type === "save-settings" && message.settings != null
      && (typeof message.settings !== "object" || Array.isArray(message.settings)))
    || ((message.type === "ai-providers-save" || message.type === "asr-providers-save"
      || message.type === "search-providers-save")
      && message.providers !== undefined && !Array.isArray(message.providers))
    || (message.type === "player-ai-quick-action" && message.tabId !== undefined
      && !Number.isFinite(message.tabId));
  return badShape ? "消息载荷不合法" : null;
}

chrome.runtime.onMessage.addListener((rawMessage, rawSender, sendResponse: SendResponse) => {
  if (!rawMessage || typeof rawMessage !== "object") {
    return false;
  }

  const message = rawMessage as BackgroundMessage;
  const sender = rawSender as MessageSender;
  const handler = messageHandlers.get(message.type);
  if (!handler) {
    return false;
  }

  // 守卫在路由之后、处理器执行之前：非法来源/载荷在产生任何副作用前被拒绝，
  // 并明确回 { ok:false }（不静默吞，也不让调用方空等）。
  const illegalReason = illegalMessageReason(message, sender);
  if (illegalReason) {
    sendResponse({ ok: false, error: illegalReason });
    return false;
  }

  return handler(message, sender, sendResponse);
});

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // 2026-09 AI 键默认开一次性迁移：存量显式 false 清位（清位后下方合并以新
  // 默认 true 写回），旗标随本次全量写落盘（语义见 entry/settings-migration.ts）。
  applyPlayerAiQuickActionDefaultOnMigration(syncCurrent);
  // 安装/更新迁移：合并结果先经 normalizeSettings 收口再落盘，存量 LEGACY
  // 默认提示词等旧值在此一次性改写为当前值，而不是每次读取时重复映射。
  await chrome.storage.sync.set(normalizeSettings({ ...DEFAULT_SETTINGS, ...syncCurrent }));
  // 迁移直写 storage（不经 save-settings），写后 inline 失效 settings 快照：
  // SW 存活期内的 onInstalled（扩展 reload/update）可能带着热缓存跑。
  invalidateSettingsSnapshot(Object.keys(DEFAULT_SETTINGS));
}

// 免 Key 搜索预设自动激活（spec §1 S2 / §2 展开，落点 §3 第 12 行）：决策走纯函数
// （输入 = 当前 settings 标量 + 当前搜索记录），写入顺序固定「记录 → 链首 → flag」。
// ① 记录写走 CRUD 同款写后失效包装（无记录要补时整步跳过；只追加不覆盖，已有
// 同 presetId 记录连同它的 Key 与 enabled 原样不动）；② 链首仅在为空或悬空时
// 直写 storage；③ flag **最后写**——即使本轮一条记录都没补也要写，否则判定会在
// 每次启动重跑；任一步失败时 flag 未落盘，下一次 onInstalled 重试整段。
async function autoActivateSearchPresets(): Promise<void> {
  const settings = await getSettingsSnapshot();
  const { providers } = await getProviderStoreSnapshot("search");
  const plan = planSearchPresetsAutoActivation(settings, providers);
  if (plan.providersToAdd.length > 0) {
    await saveSearchProvidersWithInvalidate([...providers, ...plan.providersToAdd]);
  }
  if (plan.activeSearchProviderId !== undefined) {
    await chrome.storage.sync.set({ activeSearchProviderId: plan.activeSearchProviderId });
    // 直写 storage 后 inline 失效（写后读语义靠这里保证，onChanged 不在写入方触发）
    invalidateSettingsSnapshot(["activeSearchProviderId"]);
  }
  if (plan.shouldWriteFlag) {
    await chrome.storage.sync.set({ searchPresetsAutoActivated: true });
    invalidateSettingsSnapshot(["searchPresetsAutoActivated"]);
  }
}
