export interface SearchAttempt {
  ok: boolean;
  latencyMs: number;
}

export interface SearchProviderHealth {
  attempts: SearchAttempt[];
  consecutiveFailures: number;
  cooldownLevel: number;
  cooldownUntil: number;
}

export type SearchHealthMap = Record<string, SearchProviderHealth>;

export const SEARCH_HEALTH_KEY = "biliscript_search_health";
export const SEARCH_HEALTH_WINDOW = 20;
export const SEARCH_COOLDOWN_FAILURE_THRESHOLD = 3;
export const SEARCH_COOLDOWN_BASE_MS = 300_000;
export const SEARCH_COOLDOWN_MAX_MS = 3_600_000;

const finiteNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function normalizeLatency(value: unknown): number {
  const latency = finiteNumber(value, 0);
  return latency >= 0 ? latency : 0;
}

function normalizeCount(value: unknown): number {
  const count = finiteNumber(value, 0);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function normalizeUntil(value: unknown): number {
  const until = finiteNumber(value, 0);
  return until > 0 ? until : 0;
}

interface RawSearchAttempt {
  ok?: unknown;
  latencyMs?: unknown;
}

function normalizeAttempt(value: unknown): SearchAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attempt = value as RawSearchAttempt;
  return { ok: attempt.ok === true, latencyMs: normalizeLatency(attempt.latencyMs) };
}

export function normalizeSearchHealth(entry: unknown): SearchProviderHealth | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const raw = entry as {
    attempts?: unknown;
    consecutiveFailures?: unknown;
    cooldownLevel?: unknown;
    cooldownUntil?: unknown;
  };
  if (!Array.isArray(raw.attempts)) return null;
  const attempts = raw.attempts
    .map(normalizeAttempt)
    .filter((attempt): attempt is SearchAttempt => attempt !== null)
    .slice(-SEARCH_HEALTH_WINDOW);
  return {
    attempts,
    consecutiveFailures: normalizeCount(raw.consecutiveFailures),
    cooldownLevel: normalizeCount(raw.cooldownLevel),
    cooldownUntil: normalizeUntil(raw.cooldownUntil)
  };
}

export function normalizeSearchHealthMap(raw: unknown): SearchHealthMap {
  const map: SearchHealthMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const presetId = key.trim();
    if (!presetId) continue;
    const entry = normalizeSearchHealth(value);
    if (entry) map[presetId] = entry;
  }
  return map;
}

export function applySearchAttempt(
  current: SearchProviderHealth | null | undefined,
  ok: unknown,
  latencyMs: unknown,
  now: number
): SearchProviderHealth {
  const attempts = [
    ...(current?.attempts ?? []),
    { ok: ok === true, latencyMs: normalizeLatency(latencyMs) }
  ].slice(-SEARCH_HEALTH_WINDOW);

  if (ok === true) {
    return { attempts, consecutiveFailures: 0, cooldownLevel: 0, cooldownUntil: 0 };
  }

  const consecutiveFailures = normalizeCount(current?.consecutiveFailures) + 1;
  const cooldownLevel = normalizeCount(current?.cooldownLevel);
  const cooldownUntil = normalizeUntil(current?.cooldownUntil);
  const at = finiteNumber(now, 0);
  if (consecutiveFailures >= SEARCH_COOLDOWN_FAILURE_THRESHOLD && at >= cooldownUntil) {
    const level = cooldownLevel + 1;
    const duration = Math.min(SEARCH_COOLDOWN_BASE_MS * 2 ** (level - 1), SEARCH_COOLDOWN_MAX_MS);
    return { attempts, consecutiveFailures: 0, cooldownLevel: level, cooldownUntil: at + duration };
  }
  return { attempts, consecutiveFailures, cooldownLevel, cooldownUntil };
}

export function cooldownUntilByPresetId(
  health: SearchHealthMap | null | undefined,
  now: number
): Record<string, number> {
  const at = finiteNumber(now, 0);
  const map: Record<string, number> = {};
  for (const [presetId, entry] of Object.entries(health ?? {})) {
    const until = normalizeUntil(entry?.cooldownUntil);
    if (until > at) map[presetId] = until;
  }
  return map;
}

export async function readSearchHealth(): Promise<SearchHealthMap> {
  try {
    const raw = (await chrome.storage.local.get(SEARCH_HEALTH_KEY)) as Record<string, unknown> | null | undefined;
    return normalizeSearchHealthMap(raw?.[SEARCH_HEALTH_KEY]);
  } catch {
    return {};
  }
}

export async function recordSearchAttempt(
  presetId: unknown,
  ok: unknown,
  latencyMs: unknown,
  now?: number
): Promise<void> {
  const id = String(presetId ?? "").trim();
  if (!id || typeof ok !== "boolean") return;
  const at = finiteNumber(now, Date.now());
  try {
    const raw = (await chrome.storage.local.get(SEARCH_HEALTH_KEY)) as Record<string, unknown> | null | undefined;
    const map = normalizeSearchHealthMap(raw?.[SEARCH_HEALTH_KEY]);
    map[id] = applySearchAttempt(map[id], ok, latencyMs, at);
    await chrome.storage.local.set({ [SEARCH_HEALTH_KEY]: map });
  } catch {
  }
}
