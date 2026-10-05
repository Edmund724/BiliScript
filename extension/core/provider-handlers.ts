// extension/core/provider-handlers.ts
// Provider 消息处理器的通用工厂。
// extension/entry/background.js 里 AI 平台与 ASR 平台各有一组形状相同的
// 消息处理器（列表 / 读取 Key / 保存列表 / 删除），本工厂提取这组共享结构：
// 调用方注入对应 store 的函数，换回一组 (message, sender, sendResponse) →
// void 形状的标准处理器（get 例外，见下方响应负载契约）。background 的路由表
// 保持消息名不变，只换处理器指向。不持有状态、不直接碰 chrome.storage——存储
// 交互全部经由注入的 store 函数。（连通性 test 处理器与 probe/pickTestProvider
// 注入面已随 arch-slim-2/03 死能力退役：生产零注入，探针由 options 页直调
// ai/provider-test.js 与 asr/provider-test.js。）
//
// 响应负载契约（与被替换的原处理器一致）：
// - list / save / remove 成功 → { ok: true, providers: items }，返回 void：
//   回包时机（同步已答 / 异步持有通道）的口径唯一主人是协议层
//   BACKGROUND_MESSAGE_REGISTRY 的 reply 登记，入口 resolveReplyKeepOpen 兑现；
// - get 成功 → { ok: true, apiKey }；缺 providerId → 同步回包
//   { ok: false, error: "缺少 providerId" } 并返回 "answered"。get 保留判定是
//   **活判定**：它只服务 get-ai-provider-key，该消息登记为 branch，入口读
//   handler 返回值派生持有口径（同步预检即答 / 通过后转异步）。
//
// 回包形参按族收型（票 message-registry/02）：工厂按「族的条目类型」泛型化，
// 回包形参收成该族的响应形状；三个族的协议响应类型（providers?: <族条目>[]）
// 由 background 路由表的 satisfies 逐键对账——响应载荷与消息键配错在 tsc 门禁即红。

import type {
  AsrProviderListEntry,
  GetAsrRuntimeConfigResponse,
  MessageReplyDecision,
  ProviderListEntry,
  ResolveAiProviderResponse
} from "../shared/messaging-protocol.js";

export interface ProviderHandlersMessage {
  providerId?: string | number;
  providers?: unknown[];
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: unknown;
}

// ===== 异步错误回包包装单源（arch-slim-2/03）=====
// 「Promise → sendResponse」协议的唯一收口：task 决议值即完整 ok 负载（原样
// 回包）；task 拒绝统一映射为 { ok: false, error: <msg> }，缺省取 error.message
// （与被替换的逐字手抄一致）。文案带前缀/兜底的调用点传 toError（如
// background 的 request-provider-origins / fetch-json / player-ai-quick-action）。
//
// 失败信封（ok:false + 可读 error）是每种响应类型的共同支：回调面把成功载荷 R
// 与失败信封并列给出，调用方的窄回包形参必须同时收下两支——「响应类型缺失败支」
// 同样在 tsc 门禁即红。
export type MessageErrorEnvelope = { ok: false; error: string };

export function withOkResponse<R>(
  task: Promise<R>,
  sendResponse: (response: R | MessageErrorEnvelope) => void,
  toError: (error: unknown) => string = (error) => (error as Error).message
): void {
  void (async () => {
    try {
      const payload = await task;
      sendResponse(payload);
    } catch (error) {
      sendResponse({ ok: false, error: toError(error) });
    }
  })();
}

// 家族回包形状（三个 provider 家族的协议响应同构，只有条目类型不同：工厂按条目
// 类型泛型化，各族的 protocol 响应类型在 background 路由表处逐键对账）。
//
// EntryFace 是条目类型 E 的键面投影（匿名对象面）。为什么不让字段直接收 E：
// 三个族的协议条目类型里，AI 族那份（ai/types 的 AiProvider，线格式宽松面）带
// string 索引签名，而 store 产物是 core/ai-provider-store.AiProvider 与
// {hasSavedKey} 的交叉类型——TS 只给**匿名对象类型**推隐式索引签名，交叉类型
// 不获得（microsoft/TypeScript#15300），E 直接对线格式条目双向都不可赋值。键面
// 投影两侧都通：store 的精确交叉类型可赋进来（目标本身不带索引签名要求），投影
// 面又带隐式索引签名，可赋给线格式条目。条目语义不变，只是换一张等价的脸。
export type ProviderEntryFace<E> = { [K in keyof E]: E[K] };

export type ProviderProvidersResponse<E> = {
  ok: boolean;
  providers?: Array<ProviderEntryFace<E>>;
  error?: string;
};
export type ProviderKeyResponse = { ok: boolean; apiKey?: string; error?: string };

export interface ProviderMessageHandlersDeps<E> {
  loadProviders: () => Promise<Array<ProviderEntryFace<E>>>;
  saveProviders: (items: unknown[]) => Promise<Array<ProviderEntryFace<E>>>;
  deleteProvider: (providerId: string) => Promise<Array<ProviderEntryFace<E>>>;
  loadKeys: () => Promise<Record<string, string>>;
}

export interface ProviderMessageHandlers<E> {
  list: (message: unknown, sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void) => void;
  // 活判定（branch 消息 get-ai-provider-key 的唯一处理器）：返回值即持有口径
  get: (message: unknown, sender: unknown, sendResponse: (response: ProviderKeyResponse) => void) => MessageReplyDecision;
  save: (message: unknown, sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void) => void;
  remove: (message: unknown, sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void) => void;
}

export function createProviderMessageHandlers<E>({
  loadProviders,
  saveProviders,
  deleteProvider,
  loadKeys
}: ProviderMessageHandlersDeps<E>): ProviderMessageHandlers<E> {
  function list(_message: unknown, _sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void): void {
    withOkResponse(
      (async () => ({ ok: true, providers: await loadProviders() }))(),
      sendResponse
    );
  }

  function get(message: unknown, _sender: unknown, sendResponse: (response: ProviderKeyResponse) => void): MessageReplyDecision {
    const msg = message as ProviderHandlersMessage;
    const providerId = String(msg.providerId || "").trim();
    if (!providerId) {
      sendResponse({ ok: false, error: "缺少 providerId" });
      return "answered";
    }
    withOkResponse(
      (async () => {
        const keys = await loadKeys();
        const apiKey = String(keys[providerId] || "").trim();
        return { ok: true, apiKey };
      })(),
      sendResponse
    );
    return "hold";
  }

  function save(message: unknown, _sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void): void {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      (async () => ({ ok: true, providers: await saveProviders(msg.providers || []) }))(),
      sendResponse
    );
  }

  function remove(message: unknown, _sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void): void {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      (async () => ({
        ok: true,
        providers: await deleteProvider(String(msg.providerId || ""))
      }))(),
      sendResponse
    );
  }

  return { list, get, save, remove };
}

// ===== ASR 回退运行时配置处理器 =====

export interface AsrRuntimeConfigSettings {
  activeAsrProviderId?: string;
  asrLanguage?: string;
  asrAutoFallback?: boolean;
}

export interface AsrRuntimeConfigHandlerDeps {
  getMergedSettings: () => Promise<AsrRuntimeConfigSettings>;
  // 族条目类型与协议响应 providers?: AsrProviderListEntry[] 对齐（载荷与消息键
  // 的配错由这条精确类型在 tsc 门禁拦下）。
  loadProviders: () => Promise<AsrProviderListEntry[]>;
  getAsrProviderKey: (providerId: string) => Promise<string>;
}

export function createAsrRuntimeConfigHandler({
  getMergedSettings,
  loadProviders,
  getAsrProviderKey
}: AsrRuntimeConfigHandlerDeps) {
  return function handleGetAsrRuntimeConfig(
    _message: unknown,
    _sender: unknown,
    sendResponse: (response: GetAsrRuntimeConfigResponse) => void
  ): void {
    withOkResponse(
      (async () => {
        const settings = await getMergedSettings();
        const activeId = String(settings.activeAsrProviderId || "").trim();
        const [providers, activeKey] = await Promise.all([
          loadProviders(),
          activeId ? getAsrProviderKey(activeId) : Promise.resolve("")
        ]);
        return {
          ok: true,
          providers,
          activeAsrProviderId: activeId,
          activeKey,
          asrLanguage: settings.asrLanguage,
          asrAutoFallback: settings.asrAutoFallback === true
        };
      })(),
      sendResponse,
      (error) => (error as Error)?.message || String(error)
    );
  };
}

// ===== 「激活平台」单趟解析处理器（arch-slim-3/09，CONTEXT.md 域词条）=====

// 无可用平台的可读文案单源（原 ai/active-provider.ts 定义，随解析链收口搬入
// 处理器——错误在解析期产生，文案与产生点同居）。
export const NO_ACTIVE_PROVIDER_MESSAGE = "还没有配置 AI 平台，请先在插件设置中添加并启用。";

export interface AiResolvedProviderHandlerDeps {
  getMergedSettings: () => Promise<{ defaultModel?: unknown }>;
  loadProviders: () => Promise<unknown[]>;
  loadKeys: () => Promise<Record<string, string>>;
}

// 解析策略双档：providerId 给定 = 精确匹配（offscreen 聊天链，找不到即报错）；
// 缺省 = 设置 defaultModel → 首个启用平台回落（content 概览/选区解释）。
// requiresKey !== false 且密钥缺失在解析期即拒绝——content 侧此前不校验、会
// 拖到 HTTP 期才失败，两调用方统一收紧（arch-slim-3/09 行为裁决）。回包
// provider 为平台记录（含 hasSavedKey、不含明文 Key），apiKey 单列。
export function createAiResolvedProviderHandler({
  getMergedSettings,
  loadProviders,
  loadKeys
}: AiResolvedProviderHandlerDeps) {
  return function handleResolveAiProvider(
    message: unknown,
    _sender: unknown,
    sendResponse: (response: ResolveAiProviderResponse) => void
  ): void {
    withOkResponse(
      (async () => {
        const requestedId = String((message as { providerId?: unknown })?.providerId || "").trim();
        const providers = (await loadProviders()) || [];
        // 条目收束（判据在谓词里，收束结果 = 协议声明的线格式条目）：AI 族线格式
        // 条目（ai/types 的 AiProvider，带 string 索引签名）与 store 产物的精确
        // 条目（core/ai-provider-store.AiProvider 的交叉类型）是两份声明，交叉类型
        // 无隐式索引签名（TS #15300），静态上互不可赋值——本条处理器只做「对象 +
        // enabled 未显式关闭 + id 非空」的形状收束（与收敛前的过滤判据逐字同义）。
        const enabled = providers.filter(
          (item): item is ProviderListEntry =>
            Boolean(item)
            && typeof item === "object"
            && (item as { enabled?: unknown }).enabled !== false
            && String((item as { id?: unknown }).id || "").trim() !== ""
        );
        let provider: ProviderListEntry | null = null;
        if (requestedId) {
          provider = enabled.find((item) => String(item.id) === requestedId) || null;
          if (!provider) {
            throw new Error("未找到选中的平台");
          }
        } else {
          const settings = await getMergedSettings();
          const preferredId = String(settings?.defaultModel || "").trim();
          provider = enabled.find((item) => String(item.id) === preferredId) || enabled[0] || null;
          if (!provider) {
            throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
          }
        }
        const providerId = String(provider.id);
        const keys = (await loadKeys()) || {};
        const apiKey = String(keys[providerId] || "").trim();
        if (provider.requiresKey !== false && !apiKey) {
          throw new Error("该平台 API Key 未配置");
        }
        return { ok: true, provider, apiKey };
      })(),
      sendResponse,
      (error) => (error as Error)?.message || String(error)
    );
  };
}
