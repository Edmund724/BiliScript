import { normalizeSearchProvider } from "./search-provider-normalize.js";
import { createProviderStore } from "../core/provider-store.js";

export const SEARCH_PROVIDER_KEYS_STORAGE = "searchProviderKeys";
export const SEARCH_PROVIDERS_STORAGE = "searchProviders";
export const SEARCH_PROVIDER_ORDER_STORAGE = "searchProviderOrder";

export const searchProviderStore = createProviderStore({
  listStorageKey: SEARCH_PROVIDERS_STORAGE,
  keysStorageKey: SEARCH_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeSearchProvider
});
