export type ProviderKeys = Record<string, string>;

export interface ProviderBase {
  id: string;
}

export interface CreateProviderStoreDeps<T extends ProviderBase> {
  listStorageKey: string;
  keysStorageKey: string;
  normalizeProvider: (item: unknown) => T | null;
}

export interface ProviderStore<T extends ProviderBase> {
  loadKeys: () => Promise<ProviderKeys>;
  getKey: (providerId: string | null | undefined) => Promise<string>;
  resolveDraftApiKey: (
    apiKey: string | null | undefined,
    providerId: string | null | undefined
  ) => Promise<string>;
  loadProviders: () => Promise<Array<T & { hasSavedKey: boolean }>>;
  saveProviders: (items: unknown[]) => Promise<Array<T & { hasSavedKey: boolean }>>;
  deleteProvider: (providerId: string) => Promise<Array<T & { hasSavedKey: boolean }>>;
}

export function createProviderStore<T extends ProviderBase>({
  listStorageKey,
  keysStorageKey,
  normalizeProvider
}: CreateProviderStoreDeps<T>): ProviderStore<T> {
  async function loadKeys(): Promise<ProviderKeys> {
    const localData = await chrome.storage.local.get([keysStorageKey]);
    const keys = localData?.[keysStorageKey];
    return keys && typeof keys === "object" ? (keys as ProviderKeys) : {};
  }

  async function getKey(providerId: string | null | undefined): Promise<string> {
    const id = String(providerId || "").trim();
    if (!id) return "";
    const keys = await loadKeys();
    return String(keys[id] || "").trim();
  }

  async function resolveDraftApiKey(
    apiKey: string | null | undefined,
    providerId: string | null | undefined
  ): Promise<string> {
    const direct = String(apiKey || "").trim();
    if (direct) return direct;
    try {
      return await getKey(providerId);
    } catch {
      return "";
    }
  }

  async function loadRawProviders(): Promise<T[]> {
    const syncData = await chrome.storage.sync.get([listStorageKey]);
    const list: unknown[] = Array.isArray(syncData[listStorageKey]) ? syncData[listStorageKey] : [];
    return list
      .map(normalizeProvider)
      .filter((p): p is T => Boolean(p));
  }

  async function loadProviders(): Promise<Array<T & { hasSavedKey: boolean }>> {
    const [list, keys] = await Promise.all([
      loadRawProviders(),
      loadKeys()
    ]);
    return list.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
  }

  async function saveProviders(items: unknown[]): Promise<Array<T & { hasSavedKey: boolean }>> {
    const rawList = Array.isArray(items) ? items : [];
    const keys = await loadKeys();
    const nextList: T[] = [];
    for (const raw of rawList) {
      const normalized = normalizeProvider(raw);
      if (!normalized) continue;
      nextList.push(normalized);
      const incomingKey = String((raw as { apiKey?: unknown }).apiKey || "").trim();
      if (incomingKey) {
        keys[normalized.id] = incomingKey;
      }
    }
    await Promise.all([
      chrome.storage.sync.set({ [listStorageKey]: nextList }),
      chrome.storage.local.set({ [keysStorageKey]: keys })
    ]);
    return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
  }

  async function deleteProvider(providerId: string): Promise<Array<T & { hasSavedKey: boolean }>> {
    const list = await loadRawProviders();
    const next = list.filter((p) => p.id !== providerId);
    await chrome.storage.sync.set({ [listStorageKey]: next });
    const keys = await loadKeys();
    if (keys && providerId in keys) {
      delete keys[providerId];
      await chrome.storage.local.set({ [keysStorageKey]: keys });
    }
    return next.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
  }

  return { loadKeys, getKey, resolveDraftApiKey, loadProviders, saveProviders, deleteProvider };
}

export function formatProbeConnectionError(error: unknown): string {
  return `无法连接：${(error as Error | undefined)?.message || error}`;
}

export async function formatProbeHttpError(response: { status: number; text: () => Promise<string> }): Promise<string> {
  const { status } = response;
  if (status === 401 || status === 403) {
    return `HTTP ${status}: API Key 无效或未授权`;
  }
  const raw = await response.text().catch(() => "");
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const candidate =
        typeof parsed?.error === "string"
          ? parsed.error
          : typeof parsed?.error?.message === "string"
            ? parsed.error.message
            : typeof parsed?.message === "string"
              ? parsed.message
              : "";
      if (candidate.trim()) {
        return `HTTP ${status}: ${candidate.trim().slice(0, 200)}`;
      }
    } catch {
    }
    return `HTTP ${status}: ${trimmed.slice(0, 200)}`;
  }
  return `HTTP ${status}`;
}
