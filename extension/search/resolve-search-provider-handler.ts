import { SEARCH_PROVIDER_PRESETS } from "../core/presets.js";
import { resolveSearchMode } from "../core/search-mode.js";
import { resolveSearchChain } from "./search-chain.js";
import type { SearchProvider } from "./search-provider-normalize.js";
import type { SearchHealthMap } from "./search-health.js";
import { cooldownUntilByPresetId } from "./search-health.js";
import { resolveAiCredentialKey, type AiCredentialRecordLike } from "../core/ai-credential-reference.js";
import { withOkResponse } from "../core/provider-handlers.js";
import type { ResolveSearchProviderResponse } from "../shared/messaging-protocol.js";

export interface ResolveSearchProviderHandlerDeps {
  getSettings: () => Promise<{
    activeSearchProviderId?: unknown;
    allowPaidSearchProviders?: unknown;
    webSearchMaxToolCalls?: number;
  }>;
  getSearchStore: () => Promise<{
    providers: ReadonlyArray<SearchProvider>;
    keys: Record<string, string> | null | undefined;
  }>;
  getAiStore: () => Promise<{
    providers: ReadonlyArray<AiCredentialRecordLike>;
    keys: Record<string, string> | null | undefined;
  }>;
  getOrder: () => Promise<readonly string[] | null | undefined>;
  getHealth: () => Promise<SearchHealthMap>;
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
      (async (): Promise<ResolveSearchProviderResponse> => {
        const settings = await getSettings();
        const { providers, keys } = await getSearchStore();
        const { providers: aiProviders, keys: aiKeys } = await getAiStore();
        const order = await getOrder();
        const activeId = String(settings.activeSearchProviderId || "");
        const at = now ? now() : Date.now();
        const cooldownUntil = cooldownUntilByPresetId(await getHealth(), at);
        const mode = resolveSearchMode(activeId);
        const resolved = resolveSearchChain(providers, keys, activeId, SEARCH_PROVIDER_PRESETS, {
          mode,
          order,
          cooldownUntil,
          now: at,
          allowPaid: settings.allowPaidSearchProviders === true,
          paidKeys: {
            deepseek: resolveAiCredentialKey("deepseek", aiProviders, aiKeys).key
          }
        });
        if (resolved.chain.length === 0) {
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
