// extension/search/search-health.ts
// 引擎健康度与冷却 SW 叶（spec §12.4 / §12.5 第 3 行、票 15 §4、§10 第 68–71 行）：
//   记账粒度 = **引擎级**（按 `presetId`：同一家的多条记录共用一个账——同一
//   presetId 的多条记录是同一个真实引擎）；存储 = `chrome.storage.local` 单键
//   `biliscript_search_health`（有界运行态：≤6 引擎 × 20 条；不含查询词 / 结果 / Key）。
//   ① 滑窗 = 最近 20 次尝试（成功 / 失败 + 延迟 ms），溢出丢头部（旧 → 新）；
//   ② 连续失败 3 次触发冷却：初始 5 分钟、每再犯翻倍（5/10/20/40…）、上限 1 小时；
//      触发时连败计数归零；**冷却期内不再触发、不延长**（`now ≥ cooldownUntil`
//      是触发条件的一部分）；
//   ③ 成功一次三者同清（连败计数 / 冷却截止 / 翻倍档位）——否则「初始 5 分钟」
//      只对第一次有意义（§12.7 第 4 条）；
//   ④ 冷却只是「智能链跳过」的输入（search-chain.ts 的 `cooldownUntil` 过滤）：
//      单选不消费冷却，但账照记（切到智能模式立刻受益）。
// 分层纪律：本模块上半是**纯逻辑**——零 Chrome API / 零 DOM / 不取时间（`now`
// 注入）、不改写入参；下半是**薄 storage 层**（只做一次 get / set 与防御读，失败
// 静默）。SW 可被休眠回收：本模块零内存状态，读 / 写都落 storage。

// 一次尝试（spec §12.4 常量块的形状）：只有成败与延迟，不含查询词 / 结果 / Key。
export interface SearchAttempt {
  ok: boolean;
  latencyMs: number;
}

// 单引擎账（键 = presetId）。
export interface SearchProviderHealth {
  // 旧 → 新；超 SEARCH_HEALTH_WINDOW 条丢头部
  attempts: SearchAttempt[];
  consecutiveFailures: number;
  // 0 = 未触发过；n ≥ 1 = 第 n 次触发
  cooldownLevel: number;
  // epoch ms；0 = 未冷却
  cooldownUntil: number;
}

export type SearchHealthMap = Record<string, SearchProviderHealth>;

export const SEARCH_HEALTH_KEY = "biliscript_search_health";
// 滑窗：最近 20 次尝试（spec §12.4 常量块）
export const SEARCH_HEALTH_WINDOW = 20;
// 连续失败 3 次触发（同上）
export const SEARCH_COOLDOWN_FAILURE_THRESHOLD = 3;
// 初始 5 分钟（同上；第 n 次触发 = min(base × 2^(n-1), max)）
export const SEARCH_COOLDOWN_BASE_MS = 300_000;
// 上限 1 小时（同上）
export const SEARCH_COOLDOWN_MAX_MS = 3_600_000;

const finiteNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// 延迟归一：非有限数 / 负数 → 0（脏值不污染账）。
function normalizeLatency(value: unknown): number {
  const latency = finiteNumber(value, 0);
  return latency >= 0 ? latency : 0;
}

// 计数归一：只认非负整数（档位与连败计数只由 +1 递增产生）；其余脏值一律 0。
function normalizeCount(value: unknown): number {
  const count = finiteNumber(value, 0);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

// 冷却截止归一：0 = 未冷却；非有限数 / 负数归 0。
function normalizeUntil(value: unknown): number {
  const until = finiteNumber(value, 0);
  return until > 0 ? until : 0;
}

// 存储里的单条尝试（未归一形状：字段都可能缺席 / 是脏值）。
interface RawSearchAttempt {
  ok?: unknown;
  latencyMs?: unknown;
}

function normalizeAttempt(value: unknown): SearchAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attempt = value as RawSearchAttempt;
  return { ok: attempt.ok === true, latencyMs: normalizeLatency(attempt.latencyMs) };
}

/**
 * 单引擎账的防御归一（spec §12.4）：形状不可信（非对象 / `attempts` 非数组）→
 * 返回 null（丢该条）；条内字段逐项归一（非法尝试项剔除、非法数值归 0），
 * 并截断到最近 `SEARCH_HEALTH_WINDOW` 条。纯函数、不改写入参。
 */
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

/**
 * 整张健康度图的防御读取（spec §12.4）：整图非对象 / 数组 → `{}`；单条不可信 → 丢
 * 该条（其余保留）；空 / 空白 presetId 丢弃。纯函数、不抛。
 */
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

/**
 * 记一次引擎尝试（spec §12.4 第 1–4 条，纯函数）：
 *   - 尝试进滑窗（超 20 条丢头部）；
 *   - 成功 → 连败计数 / 冷却截止 / 翻倍档位三者同清；
 *   - 失败 → 连败计数 +1；达阈值且 `now ≥ cooldownUntil` 时触发（档位 +1、
 *     冷却 = `now + min(5min × 2^(level-1), 1h)`、连败计数归零）；冷却期内只累加
 *     连败、不触发不延长。
 * `ok` 非布尔按失败记（脏载荷不假装成功）；延迟 / 计数 / 截止的脏值照
 * normalize 口径归一；返回新对象，不改写入参。
 */
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

/**
 * 链解析期交纯函数的冷却图（spec §12.4 第 6 条）：`presetId → cooldownUntil`，
 * **只含 `cooldownUntil > now` 的项**（到期项不出现在图里 = 引擎回链）。纯函数、
 * 不读 storage、不取时间。
 */
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

// ===== 薄 storage 层（SW 独占读者；零内存状态、失败静默）=====

/**
 * 防御读整张健康度图（spec §12.4 第 6 条）：读失败 / 超时按 `{}`（= 无引擎冷却，
 * 不拦任何链）——健康度绝不影响搜索与回答。
 */
export async function readSearchHealth(): Promise<SearchHealthMap> {
  try {
    const raw = (await chrome.storage.local.get(SEARCH_HEALTH_KEY)) as Record<string, unknown> | null | undefined;
    return normalizeSearchHealthMap(raw?.[SEARCH_HEALTH_KEY]);
  } catch {
    return {};
  }
}

/**
 * 读-改-写记一次尝试（spec §12.4 第 7 条）：时间戳由 SW 侧盖（缺省 `Date.now()`）；
 * 一条 presetId 一条账（引擎级聚合）；脏载荷（空 presetId / ok 非布尔）静默 no-op；
 * 读 / 写失败静默（不抛）——记账失败绝不影响链结果与回答。SW 冷启动后账仍在 storage。
 */
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
    // 写失败静默
  }
}
