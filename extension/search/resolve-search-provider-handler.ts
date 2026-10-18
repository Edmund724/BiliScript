// extension/search/resolve-search-provider-handler.ts
// resolve-search-provider SW 端 handler 工厂：链装配编排整体自 entry/background.ts
// 搬入 search 域——五份快照读跨三域（settings 标量 / search 族列表+Key / ai 族
// 列表+Key / 用户顺序 / 引擎健康度）、冷却图、模式解析、DeepSeek 付费 Key 的凭据
// 引用、链解析与空链归因都是搜索编排知识，组合根只注入读取 primitive 并登记
// 工厂实例（形态同 search-cache-handler.ts）。
// 纯域 module 直接 import，不进 deps：core/search-mode（模式单源）、./search-chain
//（链解析）、./search-health（冷却图）、./deepseek-credential（凭据引用）、
// core/presets 的 SEARCH_PROVIDER_PRESETS（预设表）。
// 回包信封（withOkResponse：决议值原样回包 / 拒绝统一 { ok:false, error }）收进
// 工厂，与 core/provider-handlers.ts 的先例同形态。

import { SEARCH_PROVIDER_PRESETS } from "../core/presets.js";
import { resolveSearchMode } from "../core/search-mode.js";
import { resolveSearchChain } from "./search-chain.js";
import type { SearchProvider } from "./search-provider-normalize.js";
import type { SearchHealthMap } from "./search-health.js";
import { cooldownUntilByPresetId } from "./search-health.js";
import { resolveDeepseekSearchKey, type DeepseekAiRecordLike } from "./deepseek-credential.js";
import { withOkResponse } from "../core/provider-handlers.js";
import type { ResolveSearchProviderResponse } from "../shared/messaging-protocol.js";

export interface ResolveSearchProviderHandlerDeps {
  /** settings 标量快照（activeSearchProviderId / allowPaidSearchProviders / webSearchMaxToolCalls） */
  getSettings: () => Promise<{
    activeSearchProviderId?: unknown;
    allowPaidSearchProviders?: unknown;
    webSearchMaxToolCalls?: number;
  }>;
  /** 搜索族快照：归一记录列表 + 明文 Key 映射 */
  getSearchStore: () => Promise<{
    providers: ReadonlyArray<SearchProvider>;
    keys: Record<string, string> | null | undefined;
  }>;
  /** AI 族快照：DeepSeek 付费候选的 Key 经凭据引用取这里（搜索读 AI、绝不回写） */
  getAiStore: () => Promise<{
    providers: ReadonlyArray<DeepseekAiRecordLike>;
    keys: Record<string, string> | null | undefined;
  }>;
  /** 用户拖拽顺序快照（归一产物；缺席 / 脏值 → []） */
  getOrder: () => Promise<readonly string[] | null | undefined>;
  /** 引擎健康度快照（链解析期读一次产冷却图） */
  getHealth: () => Promise<SearchHealthMap>;
  /** 注入时钟（缺省 Date.now；测试直注固定值） */
  now?: () => number;
}

export function createResolveSearchProviderHandler({
  getSettings,
  getSearchStore,
  getAiStore,
  getOrder,
  getHealth,
  now
}: ResolveSearchProviderHandlerDeps): (
  message: unknown,
  sender: unknown,
  sendResponse: (response: ResolveSearchProviderResponse) => void
) => void {
  return function handleResolveSearchProvider(_message: unknown, _sender: unknown, sendResponse: (response: ResolveSearchProviderResponse) => void): void {
    withOkResponse(
      // 返回类型显式收到本条消息的响应类型：三个分支的载荷（含 chainEmptyReason
      // 的字面量档）在这一行逐字对账（不写死类型则 "cooldown" 会被推宽成 string）。
      (async (): Promise<ResolveSearchProviderResponse> => {
        // settings 标量 + 搜索平台列表 + Key + 用户顺序一次快照读取（命中时零 storage 调用）
        const settings = await getSettings();
        const { providers, keys } = await getSearchStore();
        // AI 族快照：DeepSeek 付费候选的 Key 经凭据引用取这里（官方端点判定单点在
        // deepseek-credential 叶，AI 记录 / Key 变更经快照失效面联动清 search 缓存）。
        const { providers: aiProviders, keys: aiKeys } = await getAiStore();
        const order = await getOrder();
        const activeId = String(settings.activeSearchProviderId || "");
        // 冷却图（spec §12.4 第 6 条）：健康度快照 → 只含 cooldownUntil > now 的项；
        // 只有智能链消费它（单选不拦但账照记）。now 注入纯函数，与快照同一次取时。
        const at = now ? now() : Date.now();
        const cooldownUntil = cooldownUntilByPresetId(await getHealth(), at);
        const mode = resolveSearchMode(activeId);
        const resolved = resolveSearchChain(providers, keys, activeId, SEARCH_PROVIDER_PRESETS, {
          mode,
          order,
          cooldownUntil,
          now: at,
          // 付费平台准入（GLOSSARY「付费平台」）：开关只影响智能链；DeepSeek 候选的
          // Key 经凭据引用从 AI 族解析（无合格记录 / 非官方端点 / 无 Key = 空串跳过）。
          allowPaid: settings.allowPaidSearchProviders === true,
          paidKeys: {
            deepseek: resolveDeepseekSearchKey(aiProviders, aiKeys)
          }
        });
        if (resolved.chain.length === 0) {
          // 判空因随链一趟给出（票 16 C3，不再同参重跑）：链空且确有合格候选在冷却处
          // 被剔 → 冷却专属归因；否则真的没有合格记录。单选不消费冷却，故单选空链
          // 在此必为「未配置」口径（§12.4 第 5 条 / §12.7 第 6 条）。
          return resolved.emptyCause === "cooldown"
            ? { ok: true, chainEmptyReason: "cooldown" }
            : { ok: true };
        }
        return {
          ok: true,
          chain: resolved.chain,
          maxToolCalls: settings.webSearchMaxToolCalls
        };
      })(),
      sendResponse,
      (error) => (error as Error | undefined)?.message || String(error)
    );
  };
}
