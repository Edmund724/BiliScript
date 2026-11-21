import { normalizeAsrProvider, resolveActiveAsrProviderId, type AsrProvider } from "./asr-provider-normalize.js";
import { createProviderStore } from "../core/provider-store.js";

export { resolveActiveAsrProviderId };
export type { AsrProvider } from "./asr-provider-normalize.js";

export const ASR_PROVIDER_KEYS_STORAGE = "asrProviderKeys";
export const ASR_PROVIDERS_STORAGE = "asrProviders";

export const asrProviderStore = createProviderStore<AsrProvider>({
  listStorageKey: ASR_PROVIDERS_STORAGE,
  keysStorageKey: ASR_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAsrProvider
});
