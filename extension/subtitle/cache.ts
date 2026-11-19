import { logWarn, logError } from "../shared/logging.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { fnv1a32 } from "../shared/text-primitives.js";
import {
  registerSubtitleSessionBoundaryHooks,
  type SubtitleSessionBoundaryHook
} from "../core/state.js";
import {
  CacheWriteError,
  readFamilyKeys,
  type EvictionResult,
  type EvictionFailure
} from "../core/cache-lru.js";
import {
  ASR_SOURCE_KEY_PREFIX,
  TRANSLATED_SOURCE_KEY_PREFIX,
  subtitleSourceKey,
  type TrackIdentity
} from "./source-key.js";
import { getLangFamily, toCanonicalTargetLangBcp47 } from "./selection.js";
import {
  matchesGlossarySourceInText,
  normalizeModelForSignature,
  parseSubtitleGlossary,
  type SubtitleGlossaryEntry,
  type SubtitleGlossaryInput
} from "../shared/subtitle-glossary.js";
import {
  DEFAULT_SUBTITLE_CACHE_MAX_BYTES,
  DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES,
  SUBTITLE_IDB_NAME,
  SUBTITLE_IDB_STORE,
  SUBTITLE_IDB_VERSION,
  buildSegmentedTrackMapKey,
  buildSubtitlePageId,
  buildTranslatedTrackMapKey,
  createSubtitleIdbStore,
  defaultSubtitleIdbStore,
  mergeTranslatedItems,
  sanitizeMonolingualItems,
  sanitizeTranslatedItems,
  type SubtitleIdbStore,
  type SubtitlePageRecord,
  type SubtitleStoreWriteInterceptor,
  type SubtitleStoreWriteResult,
  type SubtitleTrackStorageKind
} from "./idb-store.js";
import type { SubtitleBodyItem } from "../ai/types.js";
import type { SubtitleCacheMessage, SubtitleCacheResponse } from "../shared/messaging-protocol.js";

export {
  buildSubtitleCandidates,
  buildSubtitleSignature,
  normalizeSubtitleItems,
  type SubtitleSignatureInput
} from "./signature.js";

export {
  DEFAULT_SUBTITLE_CACHE_MAX_BYTES,
  DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES,
  SUBTITLE_IDB_NAME,
  SUBTITLE_IDB_STORE,
  SUBTITLE_IDB_VERSION,
  buildSegmentedTrackMapKey,
  buildSubtitlePageId,
  buildTranslatedTrackMapKey,
  createSubtitleIdbStore,
  type SubtitleIdbStore,
  type SubtitlePageRecord,
  type SubtitleStoreWriteInterceptor,
  type SubtitleTrackStorageKind
};

const CACHE_KEY_PREFIX = "biliscript_subtitle_cache_";
export const DEFAULT_TRANSLATED_WRITE_DEBOUNCE_MS = 1500;
const SUBTITLE_STORE_RESET_SYMBOL = Symbol.for("biliscript.subtitleStoreReset");
const SUBTITLE_CACHE_LIFECYCLE_SYMBOL = Symbol.for("biliscript.subtitleCacheLifecycle");

export interface SubtitleCacheKeyOptions {
  bvid: string;
  cid: string;
  /** 字幕轨身份（track / url / lang / asr / translated），构造与优先级裁定在 subtitle/source-key。 */
  identity: TrackIdentity;
}

export type SaveSubtitleResult = EvictionResult | EvictionFailure;

export function getSubtitleCacheKey({ bvid, cid, identity }: SubtitleCacheKeyOptions): string {
  return `${CACHE_KEY_PREFIX}${bvid}_${cid}_${subtitleSourceKey(identity)}`;
}

// ===== 抗干扰内容签名（segmentationSig / translationSig）=====

function stableNumericField(value: unknown): string {
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "";
}

export interface SegmentationSignatureInput {
  strategy?: unknown;
  lang?: unknown;
  maxWords?: unknown;
  maxCjkChars?: unknown;
  maxDurationMs?: unknown;
  pauseTimeoutMs?: unknown;
  longSentenceThreshold?: unknown;
  scoreThreshold?: unknown;
  minWords?: unknown;
  minCjkChars?: unknown;
  minDurationMs?: unknown;
  [key: string]: unknown;
}

/**
 * 本地智能断句签名：
 * 仅纳入算法版本、断句策略、源语种族与内容断句阈值；显式剔除超时、并发、重试间隔等调度参数。
 */
export function buildSegmentationSignature(input: SegmentationSignatureInput = {}): string {
  const rawStrategy = String(input.strategy ?? "auto").trim().toLowerCase();
  const strategy =
    rawStrategy === "rule" || rawStrategy === "stats" || rawStrategy === "off"
      ? rawStrategy
      : "auto";
  const langFamily = getLangFamily(input.lang) || String(input.lang ?? "").trim().toLowerCase();
  const basis = [
    "seg-v1",
    strategy,
    langFamily,
    stableNumericField(input.maxWords),
    stableNumericField(input.maxCjkChars),
    stableNumericField(input.maxDurationMs),
    stableNumericField(input.pauseTimeoutMs),
    stableNumericField(input.longSentenceThreshold),
    stableNumericField(input.scoreThreshold),
    stableNumericField(input.minWords),
    stableNumericField(input.minCjkChars),
    stableNumericField(input.minDurationMs)
  ].join("|");
  return `seg_${fnv1a32(basis).toString(36)}`;
}

export type TranslationSignatureGlossaryEntry = SubtitleGlossaryEntry;

export interface TranslationSignatureInput {
  model?: unknown;
  protocolVersion?: unknown;
  targetLang?: unknown;
  customPrompt?: unknown;
  glossary?: unknown;
  matchedGlossary?: readonly TranslationSignatureGlossaryEntry[];
  sourceText?: unknown;
  [key: string]: unknown;
}

function resolveMatchedGlossaryForSignature(input: TranslationSignatureInput): SubtitleGlossaryEntry[] {
  if (Array.isArray(input.matchedGlossary)) {
    return parseSubtitleGlossary(input.matchedGlossary as SubtitleGlossaryInput);
  }
  const entries = parseSubtitleGlossary(input.glossary as SubtitleGlossaryInput | null | undefined);
  if (entries.length === 0) {
    return [];
  }
  if (input.sourceText === undefined || input.sourceText === null) {
    return entries;
  }
  const text = String(input.sourceText);
  if (!text.trim()) {
    return [];
  }
  return entries.filter((entry) => matchesGlossarySourceInText(entry.source, text));
}

/**
 * 翻译缓存签名（抗干扰）：
 * 仅纳入模型名、协议版本、规范化目标语言、自定义 Prompt 哈希与当前命中的术语哈希；
 * 显式剔除超时时间、并发度、重试间隔、API Key、Base URL 等非内容调度参数。
 */
export function buildTranslationSignature(input: TranslationSignatureInput = {}): string {
  const model = normalizeModelForSignature(input.model);
  const protocolVersion = String(input.protocolVersion ?? "cc-json").trim() || "cc-json";
  const targetLang = toCanonicalTargetLangBcp47(input.targetLang || "zh");
  const promptHash = fnv1a32(String(input.customPrompt ?? "").trim()).toString(36);
  const matchedTerms = resolveMatchedGlossaryForSignature(input)
    .slice()
    .sort((a, b) => a.source.toLowerCase().localeCompare(b.source.toLowerCase()))
    .map((entry) => `${entry.source.toLowerCase()}=${entry.target}|${entry.note || ""}`)
    .join("\n");
  const glossaryHash = fnv1a32(matchedTerms).toString(36);

  const basis = ["tr-v1", model, protocolVersion, targetLang, promptHash, glossaryHash].join("|");
  return `tr_${fnv1a32(basis).toString(36)}`;
}

// ===== 传输桥接（内容脚本 → SW 扩展源 IndexedDB；扩展源/单测环境直连本地存储）=====

let storeOverrideForTests: SubtitleIdbStore | null = null;

export function configureSubtitleCacheStoreForTests(store: SubtitleIdbStore | null): void {
  storeOverrideForTests = store;
}

export function setSubtitleCacheWriteInterceptorForTests(
  interceptor: SubtitleStoreWriteInterceptor | null
): void {
  (storeOverrideForTests ?? defaultSubtitleIdbStore).setWriteInterceptorForTests(interceptor);
}

function shouldRouteViaBackground(): boolean {
  if (storeOverrideForTests) {
    return false;
  }
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
    return false;
  }
  if (typeof window === "undefined") {
    return false;
  }
  const protocol = String(window.location?.protocol || "").toLowerCase();
  if (protocol === "chrome-extension:") {
    return false;
  }
  return protocol === "http:" || protocol === "https:";
}

async function sendSubtitleStoreRpc(
  message: SubtitleCacheMessage
): Promise<SubtitleCacheResponse | null> {
  try {
    const response = await sendRuntimeMessage(message);
    if (response && response.handled === true) {
      return response;
    }
  } catch {
    // 无 SW 监听时平滑回退本地 store（如 Vitest 缺省环境）
  }
  return null;
}

function toRpcWriteResult(
  response: SubtitleCacheResponse,
  fallbackErrorMessage: string
): SubtitleStoreWriteResult {
  if (response.ok) {
    return {
      ok: true,
      evictedIds: response.evictedIds ?? [],
      estimatedBytes: response.estimatedBytes
    };
  }
  return {
    ok: false,
    evictedIds: [],
    error: new Error(response.error || fallbackErrorMessage)
  };
}

function createSubtitleCacheRpcAdapter(fallbackStore: SubtitleIdbStore): SubtitleIdbStore {
  return {
    async getPageRecord(bvid, cid) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-page",
        bvid,
        cid
      });
      return viaBg ? viaBg.page ?? null : fallbackStore.getPageRecord(bvid, cid);
    },
    listPageRecords() {
      return fallbackStore.listPageRecords();
    },
    async getRawTrack(bvid, cid, trackKey) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-raw",
        bvid,
        cid,
        trackKey
      });
      return viaBg ? viaBg.items ?? null : fallbackStore.getRawTrack(bvid, cid, trackKey);
    },
    async putRawTrack(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "put-raw",
        bvid: input.bvid,
        cid: input.cid,
        trackKey: input.trackKey,
        ...(input.lang ? { lang: input.lang } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        items: input.items as SubtitleBodyItem[]
      });
      return viaBg
        ? toRpcWriteResult(viaBg, "写入原生字幕缓存失败")
        : fallbackStore.putRawTrack(input);
    },
    async getSegmentedTrack(bvid, cid, trackKey, segmentationSig) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-segmented",
        bvid,
        cid,
        trackKey,
        segmentationSig
      });
      return viaBg
        ? viaBg.items ?? null
        : fallbackStore.getSegmentedTrack(bvid, cid, trackKey, segmentationSig);
    },
    async putSegmentedTrack(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "put-segmented",
        bvid: input.bvid,
        cid: input.cid,
        trackKey: input.trackKey,
        segmentationSig: input.segmentationSig,
        items: input.items as SubtitleBodyItem[]
      });
      return viaBg
        ? toRpcWriteResult(viaBg, "写入重断句缓存失败")
        : fallbackStore.putSegmentedTrack(input);
    },
    async getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-translated",
        bvid,
        cid,
        sourceTrackKey,
        targetLang,
        ...(translationSig ? { translationSig } : {})
      });
      return viaBg
        ? viaBg.items ?? null
        : fallbackStore.getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig);
    },
    async upsertTranslatedTrack(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "upsert-translated",
        bvid: input.bvid,
        cid: input.cid,
        sourceTrackKey: input.sourceTrackKey,
        targetLang: input.targetLang,
        translationSig: input.translationSig,
        ...(input.mode ? { mode: input.mode } : {}),
        items: input.items as SubtitleBodyItem[],
        ...(input.replaceRange ? { replaceRange: input.replaceRange } : {})
      });
      return viaBg
        ? toRpcWriteResult(viaBg, "写入译文缓存失败")
        : fallbackStore.upsertTranslatedTrack(input);
    },
    async deleteTrackEntry(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "delete-entry",
        bvid: input.bvid,
        cid: input.cid,
        tier: input.tier,
        key: input.key
      });
      return viaBg ? Boolean(viaBg.ok) : fallbackStore.deleteTrackEntry(input);
    },
    async pruneAsrVariants(args) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "prune-asr",
        bvid: args.bvid,
        cid: args.cid,
        ...(args.keepTrackKey !== undefined ? { keepTrackKey: args.keepTrackKey } : {})
      });
      return viaBg ? viaBg.removedKeys ?? [] : fallbackStore.pruneAsrVariants(args);
    },
    async clearTranslatedTracksForPage(args) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "clear-translated",
        bvid: args.bvid,
        cid: args.cid,
        ...(args.sourceTrackKey ? { sourceTrackKey: args.sourceTrackKey } : {})
      });
      return viaBg ? viaBg.removedKeys ?? [] : fallbackStore.clearTranslatedTracksForPage(args);
    },
    clearAll() {
      return fallbackStore.clearAll();
    },
    setWriteInterceptorForTests(interceptor) {
      fallbackStore.setWriteInterceptorForTests(interceptor);
    }
  };
}

const rpcSubtitleIdbStore = createSubtitleCacheRpcAdapter(defaultSubtitleIdbStore);

function resolveActiveStore(): SubtitleIdbStore {
  if (storeOverrideForTests) {
    return storeOverrideForTests;
  }
  return shouldRouteViaBackground() ? rpcSubtitleIdbStore : defaultSubtitleIdbStore;
}

async function wrapStoreWrite(
  writeOp: () => Promise<SubtitleStoreWriteResult>,
  fallbackErrorMessage: string,
  logFailure?: { message: string; meta: Record<string, unknown> }
): Promise<SaveSubtitleResult> {
  try {
    const res = await writeOp();
    if (res.ok) {
      return { ok: true };
    }
    const err = new CacheWriteError(res.error?.message || fallbackErrorMessage, res.error);
    if (logFailure) {
      logError(logFailure.message, { ...logFailure.meta, error: err.message });
    }
    return { ok: false, error: err };
  } catch (error) {
    const err = new CacheWriteError((error as Error)?.message || String(error), error);
    if (logFailure) {
      logError(logFailure.message, { ...logFailure.meta, error: err.message });
    }
    return { ok: false, error: err };
  }
}

// ===== 1500ms 流式译文写防抖缓冲 + 立即 flush =====

interface PendingTranslatedWrite {
  key: string;
  bvid: string;
  cid: string;
  sourceTrackKey: string;
  targetLang: string;
  translationSig: string;
  mode?: "boundary-v3" | "cc-json";
  items: SubtitleBodyItem[];
  replaceRange?: { from: number; to: number };
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingTranslatedWrites = new Map<string, PendingTranslatedWrite>();

function buildPendingTranslatedKey(
  bvid: string,
  cid: string,
  sourceTrackKey: string,
  targetLang: string,
  translationSig: string
): string {
  return `${buildSubtitlePageId(bvid, cid)}|${buildTranslatedTrackMapKey(sourceTrackKey, targetLang, translationSig)}`;
}

async function commitTranslatedWriteToStore(entry: {
  bvid: string;
  cid: string;
  sourceTrackKey: string;
  targetLang: string;
  translationSig: string;
  mode?: "boundary-v3" | "cc-json";
  items: readonly unknown[];
  replaceRange?: { from: number; to: number };
}): Promise<SaveSubtitleResult> {
  const cleanItems = sanitizeTranslatedItems(entry.items);
  if (cleanItems.length === 0 && !entry.replaceRange) {
    return { ok: true };
  }
  return wrapStoreWrite(
    () =>
      resolveActiveStore().upsertTranslatedTrack({
        bvid: entry.bvid,
        cid: entry.cid,
        sourceTrackKey: entry.sourceTrackKey,
        targetLang: entry.targetLang,
        translationSig: entry.translationSig,
        ...(entry.mode ? { mode: entry.mode } : {}),
        items: cleanItems,
        ...(entry.replaceRange ? { replaceRange: entry.replaceRange } : {})
      }),
    "写入译文缓存失败",
    {
      message: "[BILISCRIPT] failed to save translated subtitle cache",
      meta: { bvid: entry.bvid, cid: entry.cid }
    }
  );
}

function clearPendingWriteTimer(pending: PendingTranslatedWrite): void {
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
}

export interface FlushSubtitleCacheFilter {
  bvid?: string;
  cid?: string;
}

/**
 * 立即将流式防抖缓冲中尚未落盘的译文合并写入 IndexedDB。
 * 切集（bvid/cid 变更）、切源轨、pagehide 或 visibilitychange 隐藏时必须立即调用。
 */
export async function flushSubtitleCache(filter?: FlushSubtitleCacheFilter): Promise<void> {
  const filterBvid = filter?.bvid ? String(filter.bvid).trim() : "";
  const filterCid = filter?.cid ? String(filter.cid).trim() : "";

  const snapshot: PendingTranslatedWrite[] = [];
  for (const [key, entry] of pendingTranslatedWrites.entries()) {
    if (filterBvid && entry.bvid !== filterBvid) continue;
    if (filterCid && entry.cid !== filterCid) continue;
    clearPendingWriteTimer(entry);
    pendingTranslatedWrites.delete(key);
    snapshot.push(entry);
  }

  if (snapshot.length === 0) {
    return;
  }

  await Promise.allSettled(snapshot.map((entry) => commitTranslatedWriteToStore(entry)));
}

function registerLifecycleFlushHandlers(): void {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const existing = globals[SUBTITLE_CACHE_LIFECYCLE_SYMBOL] as
    | {
        flushRef: () => Promise<void>;
        bound: boolean;
        onPageHide?: () => void;
        onVisibilityChange?: () => void;
      }
    | undefined;

  if (existing) {
    existing.flushRef = () => flushSubtitleCache();
    return;
  }

  const holder: {
    flushRef: () => Promise<void>;
    bound: boolean;
    onPageHide?: () => void;
    onVisibilityChange?: () => void;
  } = {
    flushRef: () => flushSubtitleCache(),
    bound: false
  };
  globals[SUBTITLE_CACHE_LIFECYCLE_SYMBOL] = holder;

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    holder.onPageHide = () => {
      void holder.flushRef();
    };
    window.addEventListener("pagehide", holder.onPageHide);
    holder.bound = true;
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    holder.onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void holder.flushRef();
      }
    };
    document.addEventListener("visibilitychange", holder.onVisibilityChange);
    holder.bound = true;
  }
}

export function resetSubtitleCacheRuntimeForTests(): void {
  for (const entry of pendingTranslatedWrites.values()) {
    clearPendingWriteTimer(entry);
  }
  pendingTranslatedWrites.clear();
  storeOverrideForTests = null;
  void defaultSubtitleIdbStore.clearAll();
}

(globalThis as unknown as Record<symbol, unknown>)[SUBTITLE_STORE_RESET_SYMBOL] =
  resetSubtitleCacheRuntimeForTests;
registerLifecycleFlushHandlers();

// ===== 结构化三层读写 API =====

export interface LoadRawTrackOptions {
  bvid: string;
  cid: string;
  trackKey: string;
  legacyCacheKey?: string;
}

export interface SaveRawTrackOptions {
  bvid: string;
  cid: string;
  trackKey: string;
  lang?: string;
  kind?: SubtitleTrackStorageKind;
  items: readonly unknown[];
}

export async function loadRawSubtitleTrack({
  bvid,
  cid,
  trackKey,
  legacyCacheKey
}: LoadRawTrackOptions): Promise<SubtitleBodyItem[] | null> {
  const cleanBvid = String(bvid || "").trim();
  const cleanCid = String(cid || "").trim();
  const cleanTrackKey = String(trackKey || "").trim();
  if (!cleanBvid || !cleanCid || !cleanTrackKey) {
    return null;
  }
  try {
    const hit = await resolveActiveStore().getRawTrack(cleanBvid, cleanCid, cleanTrackKey);
    if (Array.isArray(hit) && hit.length > 0) {
      return hit;
    }
    if (legacyCacheKey) {
      const migrated = await tryMigrateLegacyStorageEntry(legacyCacheKey);
      if (migrated) {
        return migrated as SubtitleBodyItem[];
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveRawSubtitleTrack({
  bvid,
  cid,
  trackKey,
  lang,
  kind,
  items
}: SaveRawTrackOptions): Promise<SaveSubtitleResult> {
  const cleanBvid = String(bvid || "").trim();
  const cleanCid = String(cid || "").trim();
  const cleanTrackKey = String(trackKey || "").trim();
  const sanitized = sanitizeMonolingualItems(items);
  if (!cleanBvid || !cleanCid || !cleanTrackKey) {
    return {
      ok: false,
      error: new CacheWriteError("Invalid bvid, cid or trackKey")
    };
  }
  return wrapStoreWrite(
    () =>
      resolveActiveStore().putRawTrack({
        bvid: cleanBvid,
        cid: cleanCid,
        trackKey: cleanTrackKey,
        ...(lang ? { lang } : {}),
        ...(kind ? { kind } : {}),
        items: sanitized
      }),
    "写入原生字幕缓存失败",
    {
      message: "[BILISCRIPT] failed to save raw subtitle cache",
      meta: { bvid: cleanBvid, cid: cleanCid, trackKey: cleanTrackKey }
    }
  );
}

export interface LoadSegmentedTrackOptions {
  bvid: string;
  cid: string;
  trackKey: string;
  segmentationSig: string;
}

export interface SaveSegmentedTrackOptions extends LoadSegmentedTrackOptions {
  items: readonly unknown[];
}

export async function loadSegmentedSubtitleTrack({
  bvid,
  cid,
  trackKey,
  segmentationSig
}: LoadSegmentedTrackOptions): Promise<SubtitleBodyItem[] | null> {
  const cleanBvid = String(bvid || "").trim();
  const cleanCid = String(cid || "").trim();
  const cleanTrackKey = String(trackKey || "").trim();
  const cleanSig = String(segmentationSig || "").trim();
  if (!cleanBvid || !cleanCid || !cleanTrackKey || !cleanSig) {
    return null;
  }
  try {
    const hit = await resolveActiveStore().getSegmentedTrack(cleanBvid, cleanCid, cleanTrackKey, cleanSig);
    return Array.isArray(hit) && hit.length > 0 ? hit : null;
  } catch {
    return null;
  }
}

export async function saveSegmentedSubtitleTrack({
  bvid,
  cid,
  trackKey,
  segmentationSig,
  items
}: SaveSegmentedTrackOptions): Promise<SaveSubtitleResult> {
  const cleanBvid = String(bvid || "").trim();
  const cleanCid = String(cid || "").trim();
  const cleanTrackKey = String(trackKey || "").trim();
  const cleanSig = String(segmentationSig || "").trim();
  const sanitized = sanitizeMonolingualItems(items);
  if (!cleanBvid || !cleanCid || !cleanTrackKey || !cleanSig) {
    return { ok: false, error: new CacheWriteError("Invalid segmented subtitle cache parameters") };
  }
  if (sanitized.length === 0) {
    return { ok: true };
  }
  return wrapStoreWrite(
    () =>
      resolveActiveStore().putSegmentedTrack({
        bvid: cleanBvid,
        cid: cleanCid,
        trackKey: cleanTrackKey,
        segmentationSig: cleanSig,
        items: sanitized
      }),
    "写入重断句缓存失败"
  );
}

export interface LoadTranslatedTrackOptions {
  bvid: string;
  cid: string;
  sourceTrackKey: string;
  targetLang: string;
  translationSig?: string;
  legacyCacheKey?: string;
}

export interface TranslatedTrackWriteOptions {
  bvid: string;
  cid: string;
  sourceTrackKey: string;
  targetLang: string;
  translationSig: string;
  mode?: "boundary-v3" | "cc-json";
  items: readonly unknown[];
  replaceRange?: { from: number; to: number };
  debounceMs?: number;
}

export async function loadTranslatedSubtitleTrack({
  bvid,
  cid,
  sourceTrackKey,
  targetLang,
  translationSig,
  legacyCacheKey
}: LoadTranslatedTrackOptions): Promise<SubtitleBodyItem[] | null> {
  const cleanBvid = String(bvid || "").trim();
  const cleanCid = String(cid || "").trim();
  const cleanSource = String(sourceTrackKey || "").trim();
  const cleanLang = toCanonicalTargetLangBcp47(targetLang);
  if (!cleanBvid || !cleanCid || !cleanSource || !cleanLang) {
    return null;
  }
  try {
    const stored = await resolveActiveStore().getTranslatedTrack(
      cleanBvid,
      cleanCid,
      cleanSource,
      cleanLang,
      translationSig
    );

    // 若指定了精确签名但未命中，合并未落盘的防抖缓冲
    const pendingKey = translationSig
      ? buildPendingTranslatedKey(cleanBvid, cleanCid, cleanSource, cleanLang, translationSig)
      : "";
    const pendingEntry = pendingKey ? pendingTranslatedWrites.get(pendingKey) : undefined;
    if (pendingEntry) {
      const merged = mergeTranslatedItems(stored ?? [], pendingEntry.items, pendingEntry.replaceRange);
      return merged.length > 0 ? merged : null;
    }

    if (Array.isArray(stored) && stored.length > 0) {
      return stored;
    }

    if (legacyCacheKey) {
      const migrated = await tryMigrateLegacyStorageEntry(legacyCacheKey);
      if (migrated) {
        return migrated as SubtitleBodyItem[];
      }
    }
    return null;
  } catch {
    return null;
  }
}

const CACHE_FLUSH_BOUNDARY_HOOK: SubtitleSessionBoundaryHook = {
  flush: () => flushSubtitleCache()
};

/**
 * 流式逐句增量合入：1500ms 防抖合并写盘，期间切集 / 切轨 / pagehide / visibilitychange 会立即 flush。
 * 绝不为纯空白译文创建条目。
 */
export function scheduleTranslatedTrackWrite(options: TranslatedTrackWriteOptions): void {
  const cleanBvid = String(options.bvid || "").trim();
  const cleanCid = String(options.cid || "").trim();
  const cleanSource = String(options.sourceTrackKey || "").trim();
  const cleanLang = toCanonicalTargetLangBcp47(options.targetLang);
  const cleanSig = String(options.translationSig || "").trim() || "legacy";
  const cleanItems = sanitizeTranslatedItems(options.items);
  if (!cleanBvid || !cleanCid || !cleanSource || !cleanLang) {
    return;
  }
  if (cleanItems.length === 0 && !options.replaceRange) {
    return;
  }

  registerLifecycleFlushHandlers();
  registerSubtitleSessionBoundaryHooks(CACHE_FLUSH_BOUNDARY_HOOK);
  const pendingKey = buildPendingTranslatedKey(cleanBvid, cleanCid, cleanSource, cleanLang, cleanSig);
  const existing = pendingTranslatedWrites.get(pendingKey);
  const mergedItems = mergeTranslatedItems(existing?.items ?? [], cleanItems, options.replaceRange);
  if (mergedItems.length === 0) {
    return;
  }

  if (existing) {
    clearPendingWriteTimer(existing);
  }

  const debounceMs = Math.max(0, Number(options.debounceMs ?? DEFAULT_TRANSLATED_WRITE_DEBOUNCE_MS));
  const record: PendingTranslatedWrite = {
    key: pendingKey,
    bvid: cleanBvid,
    cid: cleanCid,
    sourceTrackKey: cleanSource,
    targetLang: cleanLang,
    translationSig: cleanSig,
    ...(options.mode ? { mode: options.mode } : {}),
    items: mergedItems,
    ...(existing?.replaceRange || options.replaceRange
      ? {
          replaceRange:
            existing?.replaceRange && options.replaceRange
              ? {
                  from: Math.min(existing.replaceRange.from, options.replaceRange.from),
                  to: Math.max(existing.replaceRange.to, options.replaceRange.to)
                }
              : options.replaceRange ?? existing?.replaceRange
        }
      : {}),
    timer: null
  };

  record.timer = setTimeout(() => {
    const current = pendingTranslatedWrites.get(pendingKey);
    if (current !== record) {
      return;
    }
    record.timer = null;
    pendingTranslatedWrites.delete(pendingKey);
    void commitTranslatedWriteToStore(record);
  }, debounceMs);

  pendingTranslatedWrites.set(pendingKey, record);
}

/**
 * 立即落盘译文（先合并同键尚未触发防抖的缓冲条目，再写 IndexedDB）。
 */
export async function saveTranslatedSubtitleTrack(
  options: Omit<TranslatedTrackWriteOptions, "debounceMs">
): Promise<SaveSubtitleResult> {
  const cleanBvid = String(options.bvid || "").trim();
  const cleanCid = String(options.cid || "").trim();
  const cleanSource = String(options.sourceTrackKey || "").trim();
  const cleanLang = toCanonicalTargetLangBcp47(options.targetLang);
  const cleanSig = String(options.translationSig || "").trim() || "legacy";
  const cleanItems = sanitizeTranslatedItems(options.items);
  if (!cleanBvid || !cleanCid || !cleanSource || !cleanLang) {
    return { ok: false, error: new CacheWriteError("Invalid translated subtitle cache parameters") };
  }

  const pendingKey = buildPendingTranslatedKey(cleanBvid, cleanCid, cleanSource, cleanLang, cleanSig);
  const pending = pendingTranslatedWrites.get(pendingKey);
  if (pending) {
    clearPendingWriteTimer(pending);
    pendingTranslatedWrites.delete(pendingKey);
  }

  const merged = mergeTranslatedItems(pending?.items ?? [], cleanItems, options.replaceRange);
  if (merged.length === 0 && !options.replaceRange) {
    return { ok: true };
  }
  return commitTranslatedWriteToStore({
    bvid: cleanBvid,
    cid: cleanCid,
    sourceTrackKey: cleanSource,
    targetLang: cleanLang,
    translationSig: cleanSig,
    ...(options.mode ? { mode: options.mode } : {}),
    items: merged,
    ...(options.replaceRange ? { replaceRange: options.replaceRange } : {})
  });
}

export async function getSubtitlePageCacheRecord(
  bvid: string,
  cid: string
): Promise<SubtitlePageRecord | null> {
  const cleanBvid = String(bvid || "").trim();
  const cleanCid = String(cid || "").trim();
  if (!cleanBvid || !cleanCid) {
    return null;
  }
  await flushSubtitleCache({ bvid: cleanBvid, cid: cleanCid });
  return resolveActiveStore().getPageRecord(cleanBvid, cleanCid);
}

// ===== 旧版缓存键解析 & chrome.storage.local 平滑兼容迁移 =====

type ParsedCacheKey =
  | { kind: "raw"; bvid: string; cid: string; trackKey: string }
  | { kind: "translated"; bvid: string; cid: string; sourceTrackKey: string; targetLang: string };

export function parseSubtitleCacheKey(cacheKey: string): ParsedCacheKey | null {
  const raw = String(cacheKey || "");
  if (!raw.startsWith(CACHE_KEY_PREFIX)) {
    return null;
  }
  const rest = raw.slice(CACHE_KEY_PREFIX.length);
  const firstSep = rest.indexOf("_");
  if (firstSep <= 0) return null;
  const secondSep = rest.indexOf("_", firstSep + 1);
  if (secondSep <= firstSep + 1) return null;
  const bvid = rest.slice(0, firstSep);
  const cid = rest.slice(firstSep + 1, secondSep);
  const sourceKey = rest.slice(secondSep + 1);
  if (!bvid || !cid || !sourceKey) {
    return null;
  }
  if (sourceKey.startsWith(TRANSLATED_SOURCE_KEY_PREFIX)) {
    const rawLang = sourceKey.slice(TRANSLATED_SOURCE_KEY_PREFIX.length);
    return {
      kind: "translated",
      bvid,
      cid,
      sourceTrackKey: "asr",
      targetLang: toCanonicalTargetLangBcp47(rawLang || "zh")
    };
  }
  const translatedMatch = /^(.+)_translate-(.+)$/.exec(sourceKey);
  if (translatedMatch) {
    return {
      kind: "translated",
      bvid,
      cid,
      sourceTrackKey: translatedMatch[1],
      targetLang: toCanonicalTargetLangBcp47(translatedMatch[2] || "zh")
    };
  }
  return {
    kind: "raw",
    bvid,
    cid,
    trackKey: sourceKey
  };
}

async function readLegacyChromeStorageEntry(cacheKey: string): Promise<unknown[] | null> {
  if (!globalThis.chrome?.storage?.local) {
    return null;
  }
  try {
    const result = await chrome.storage.local.get(cacheKey);
    const cached = result?.[cacheKey] as { body?: unknown } | undefined;
    return Array.isArray(cached?.body) ? cached.body : null;
  } catch {
    return null;
  }
}

async function tryMigrateLegacyStorageEntry(cacheKey: string): Promise<unknown[] | null> {
  const legacyBody = await readLegacyChromeStorageEntry(cacheKey);
  if (!legacyBody || legacyBody.length === 0) {
    return null;
  }
  const parsed = parseSubtitleCacheKey(cacheKey);
  if (parsed) {
    const saved =
      parsed.kind === "translated"
        ? await saveTranslatedSubtitleTrack({
            bvid: parsed.bvid,
            cid: parsed.cid,
            sourceTrackKey: parsed.sourceTrackKey,
            targetLang: parsed.targetLang,
            translationSig: "legacy",
            items: legacyBody
          })
        : await saveRawSubtitleTrack({
            bvid: parsed.bvid,
            cid: parsed.cid,
            trackKey: parsed.trackKey,
            items: legacyBody
          });
    if (saved.ok) {
      await chrome.storage.local.remove(cacheKey).catch(() => {});
    }
  }
  return legacyBody;
}

export async function loadSubtitleFromCache(cacheKey: string): Promise<unknown[] | null> {
  try {
    const parsed = parseSubtitleCacheKey(cacheKey);
    if (!parsed) {
      return await readLegacyChromeStorageEntry(cacheKey);
    }
    if (parsed.kind === "translated") {
      // 兼容任何未落盘的同目标译文防抖缓冲
      for (const entry of pendingTranslatedWrites.values()) {
        if (
          entry.bvid === parsed.bvid &&
          entry.cid === parsed.cid &&
          entry.sourceTrackKey === parsed.sourceTrackKey &&
          entry.targetLang === parsed.targetLang
        ) {
          return entry.items.map((item) => ({ ...item }));
        }
      }
      return await loadTranslatedSubtitleTrack({
        bvid: parsed.bvid,
        cid: parsed.cid,
        sourceTrackKey: parsed.sourceTrackKey,
        targetLang: parsed.targetLang,
        legacyCacheKey: cacheKey
      });
    }
    return await loadRawSubtitleTrack({
      bvid: parsed.bvid,
      cid: parsed.cid,
      trackKey: parsed.trackKey,
      legacyCacheKey: cacheKey
    });
  } catch {
    return null;
  }
}

export async function saveSubtitleToCache(cacheKey: string, body: unknown[]): Promise<SaveSubtitleResult> {
  const parsed = parseSubtitleCacheKey(cacheKey);
  if (!parsed) {
    const err = new CacheWriteError(`无法解析字幕缓存键：${cacheKey}`);
    logError("[BILISCRIPT] failed to save subtitle cache after eviction", {
      cacheKey,
      error: err.message
    });
    return { ok: false, error: err };
  }
  if (parsed.kind === "translated") {
    return saveTranslatedSubtitleTrack({
      bvid: parsed.bvid,
      cid: parsed.cid,
      sourceTrackKey: parsed.sourceTrackKey,
      targetLang: parsed.targetLang,
      translationSig: "legacy",
      items: body
    });
  }
  return saveRawSubtitleTrack({
    bvid: parsed.bvid,
    cid: parsed.cid,
    trackKey: parsed.trackKey,
    items: body
  });
}

async function removeLegacyStorageByPrefix(
  cleanBvid: string,
  keyPrefix: string,
  excludeKey?: string
): Promise<string[]> {
  if (!globalThis.chrome?.storage?.local) {
    return [];
  }
  try {
    const indexKeys = await readFamilyKeys(CACHE_KEY_PREFIX, cleanBvid, keyPrefix);
    const all = indexKeys
      ? await chrome.storage.local.get(indexKeys)
      : await chrome.storage.local.get(null);
    const staleStorageKeys = Object.keys(all || {}).filter(
      (key) => typeof key === "string" && key.startsWith(keyPrefix) && key !== excludeKey
    );
    if (staleStorageKeys.length > 0) {
      await chrome.storage.local.remove(staleStorageKeys);
    }
    return staleStorageKeys;
  } catch {
    // 遗留 storage 清理失败不覆盖 IDB 结果
    return [];
  }
}

interface AsrCacheCleanupOptions {
  bvid: string;
  cid: string;
  keepKey?: string;
}

/**
 * ASR 孤儿清理：删除同 (bvid, cid) 下除 keepKey 外的 ASR 变体缓存（IndexedDB + 遗留 chrome.storage.local）。
 */
export async function clearStaleAsrSubtitleCache({
  bvid,
  cid,
  keepKey = ""
}: AsrCacheCleanupOptions): Promise<string[]> {
  try {
    const cleanBvid = String(bvid || "").trim();
    const cleanCid = String(cid || "").trim();
    if (!cleanBvid || !cleanCid) {
      return [];
    }
    const parsedKeep = keepKey ? parseSubtitleCacheKey(keepKey) : null;
    const keepTrackKey = parsedKeep?.kind === "raw" ? parsedKeep.trackKey : keepKey;

    const removedTrackKeys = await resolveActiveStore().pruneAsrVariants({
      bvid: cleanBvid,
      cid: cleanCid,
      keepTrackKey
    });

    const removedLegacyKeys = new Set<string>(
      removedTrackKeys.map((trackKey) => `${CACHE_KEY_PREFIX}${cleanBvid}_${cleanCid}_${trackKey}`)
    );

    const keyPrefix = `${CACHE_KEY_PREFIX}${cleanBvid}_${cleanCid}_${ASR_SOURCE_KEY_PREFIX}`;
    for (const key of await removeLegacyStorageByPrefix(cleanBvid, keyPrefix, keepKey)) {
      removedLegacyKeys.add(key);
    }

    return Array.from(removedLegacyKeys);
  } catch (error) {
    logWarn("[BILISCRIPT] failed to clear stale asr subtitle cache entries", { bvid, cid, error });
    return [];
  }
}

/**
 * 译文副轨失效清理：新转写落盘后清除同分 P 下依赖旧原文的译文轨（含未落盘防抖缓冲）。
 */
export async function clearTranslatedSubtitleCache({
  bvid,
  cid,
  sourceTrackKey
}: {
  bvid: string;
  cid: string;
  sourceTrackKey?: string;
}): Promise<string[]> {
  try {
    const cleanBvid = String(bvid || "").trim();
    const cleanCid = String(cid || "").trim();
    if (!cleanBvid || !cleanCid) {
      return [];
    }

    for (const [key, entry] of pendingTranslatedWrites.entries()) {
      if (
        entry.bvid === cleanBvid &&
        entry.cid === cleanCid &&
        (!sourceTrackKey || entry.sourceTrackKey === sourceTrackKey)
      ) {
        clearPendingWriteTimer(entry);
        pendingTranslatedWrites.delete(key);
      }
    }

    const removedMapKeys = await resolveActiveStore().clearTranslatedTracksForPage({
      bvid: cleanBvid,
      cid: cleanCid,
      sourceTrackKey
    });

    const removedKeys = new Set<string>(removedMapKeys);
    const keyPrefix = `${CACHE_KEY_PREFIX}${cleanBvid}_${cleanCid}_${TRANSLATED_SOURCE_KEY_PREFIX}`;
    for (const key of await removeLegacyStorageByPrefix(cleanBvid, keyPrefix)) {
      removedKeys.add(key);
    }

    return Array.from(removedKeys);
  } catch (error) {
    logWarn("[BILISCRIPT] failed to clear translated subtitle cache entries", { bvid, cid, error });
    return [];
  }
}

export interface PersistAsrSubtitleOptions {
  bvid: string;
  cid: string;
  identity: TrackIdentity;
  body: unknown[];
}

/**
 * 新 ASR 转写成果落盘事务：写入主轨缓存成功后，清理同 (bvid, cid) 的旧 ASR 变体与
 * 依赖旧原文的译文副轨缓存；写入失败时保留旧副本，不执行后续清理。
 */
export async function persistAsrSubtitleToCache({
  bvid,
  cid,
  identity,
  body
}: PersistAsrSubtitleOptions): Promise<SaveSubtitleResult> {
  const cacheKey = getSubtitleCacheKey({ bvid, cid, identity });
  const trackKey = subtitleSourceKey(identity);
  const saveResult = await saveRawSubtitleTrack({
    bvid,
    cid,
    trackKey,
    lang: identity.kind === "asr" ? String(identity.lang || "") : undefined,
    kind: "asr",
    items: body
  });
  if (saveResult && saveResult.ok === false) {
    return saveResult;
  }
  await clearStaleAsrSubtitleCache({ bvid, cid, keepKey: cacheKey });
  await clearTranslatedSubtitleCache({ bvid, cid, sourceTrackKey: "asr" });
  return saveResult;
}

export async function clearSubtitleCacheByKey(cacheKey: string): Promise<void> {
  try {
    const parsed = parseSubtitleCacheKey(cacheKey);
    if (parsed) {
      if (parsed.kind === "raw") {
        await resolveActiveStore().deleteTrackEntry({
          bvid: parsed.bvid,
          cid: parsed.cid,
          tier: "rawTracks",
          key: parsed.trackKey
        });
      } else {
        await clearTranslatedSubtitleCache({
          bvid: parsed.bvid,
          cid: parsed.cid,
          sourceTrackKey: parsed.sourceTrackKey
        });
      }
    }
    if (globalThis.chrome?.storage?.local) {
      await chrome.storage.local.remove(cacheKey);
    }
  } catch (error) {
    logWarn("[BILISCRIPT] failed to clear subtitle cache by key", { cacheKey, error });
  }
}
