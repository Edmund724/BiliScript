import { logWarn, logError } from "../shared/logging.js";
import { fnv1a32 } from "../shared/text-primitives.js";
import {
  registerSubtitleSessionBoundaryHooks,
  type SubtitleSessionBoundaryHook
} from "../core/state.js";
import {
  CACHE_FAMILIES,
  CacheWriteError,
  buildLruIndexEntryKey,
  listStorageKeysByPrefix,
  type EvictionResult,
  type EvictionFailure
} from "../core/cache-lru.js";
import {
  ASR_SOURCE_KEY_PREFIX,
  TRANSLATED_SOURCE_KEY_PREFIX,
  isAsrVariantSourceKey,
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
  AI_ARTIFACTS_IDB_STORE,
  AI_ARTIFACT_FAMILIES,
  AI_ARTIFACT_FAMILY_KEEP_VIDEOS,
  CHAT_IMAGES_IDB_STORE,
  DEFAULT_SUBTITLE_CACHE_MAX_BYTES,
  DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES,
  SUBTITLE_IDB_BVID_INDEX,
  SUBTITLE_IDB_NAME,
  SUBTITLE_IDB_STORE,
  SUBTITLE_IDB_VERSION,
  buildSegmentedTrackMapKey,
  buildSubtitlePageId,
  buildTranslatedTrackMapKey,
  createSubtitleIdbStore,
  mergeTranslatedItems,
  resolveVideoStorageIdentity,
  sanitizeMonolingualItems,
  sanitizeTranslatedItems,
  type AiArtifactFamily,
  type AiArtifactRecord,
  type ClearVideoResult,
  type RawSubtitleTrackRecord,
  type SubtitleIdbStore,
  type SubtitlePageRecord,
  type SubtitleStoreWriteInterceptor,
  type SubtitleStoreWriteResult,
  type SubtitleTrackStorageKind
} from "./idb-store.js";
import {
  configureSubtitleCacheStoreForTests,
  registerSubtitleStoreResetHookForTests,
  resetSubtitleStoreClientForTests,
  resolveActiveSubtitleStore,
  runVideoCacheClearHooks,
  setSubtitleCacheWriteInterceptorForTests
} from "./store-client.js";
import { SUBTITLE_CACHE_KEY_PREFIX, parseSubtitleCacheKey } from "./legacy-key.js";
import type { SiteId } from "../shared/site.js";
import type { SubtitleBodyItem } from "../ai/types.js";

export {
  buildSubtitleCandidates,
  buildSubtitleSignature,
  normalizeSubtitleItems,
  type SubtitleSignatureInput
} from "./signature.js";

export {
  AI_ARTIFACTS_IDB_STORE,
  AI_ARTIFACT_FAMILIES,
  AI_ARTIFACT_FAMILY_KEEP_VIDEOS,
  CHAT_IMAGES_IDB_STORE,
  DEFAULT_SUBTITLE_CACHE_MAX_BYTES,
  DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES,
  SUBTITLE_IDB_BVID_INDEX,
  SUBTITLE_IDB_NAME,
  SUBTITLE_IDB_STORE,
  SUBTITLE_IDB_VERSION,
  buildSegmentedTrackMapKey,
  buildSubtitlePageId,
  buildTranslatedTrackMapKey,
  configureSubtitleCacheStoreForTests,
  createSubtitleIdbStore,
  parseSubtitleCacheKey,
  setSubtitleCacheWriteInterceptorForTests,
  type AiArtifactFamily,
  type AiArtifactRecord,
  type ClearVideoResult,
  type RawSubtitleTrackRecord,
  type SubtitleIdbStore,
  type SubtitlePageRecord,
  type SubtitleStoreWriteInterceptor,
  type SubtitleTrackStorageKind
};

const CACHE_KEY_PREFIX = SUBTITLE_CACHE_KEY_PREFIX;
export const DEFAULT_TRANSLATED_WRITE_DEBOUNCE_MS = 1500;
declare const SUBTITLE_CACHE_LIFECYCLE_KEY: unique symbol;
const SUBTITLE_CACHE_LIFECYCLE_SYMBOL: typeof SUBTITLE_CACHE_LIFECYCLE_KEY = Symbol.for(
  "biliscript.subtitleCacheLifecycle"
) as typeof SUBTITLE_CACHE_LIFECYCLE_KEY;

export interface SubtitleCacheKeyOptions {
  bvid: string;
  cid: string;
  identity: TrackIdentity;
  site?: SiteId;
}

export type SaveSubtitleResult = EvictionResult | EvictionFailure;

export function getSubtitleCacheKey({ bvid, cid, identity, site }: SubtitleCacheKeyOptions): string {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  return `${CACHE_KEY_PREFIX}${resolved.bvid}_${resolved.cid}_${subtitleSourceKey(identity)}`;
}

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

const resolveActiveStore = resolveActiveSubtitleStore;

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
  commit?: (entry: PendingTranslatedWrite) => Promise<SaveSubtitleResult>;
}

interface SubtitleCacheLifecycleRegistry {
  pendingTranslatedWrites: Map<string, PendingTranslatedWrite>;
  flushRef: () => Promise<void>;
  inFlightFlushes: Set<Promise<void>>;
  bound: boolean;
  onPageHide?: () => void;
  onVisibilityChange?: () => void;
}

type SubtitleCacheLifecycleGlobal = typeof globalThis & {
  [SUBTITLE_CACHE_LIFECYCLE_SYMBOL]?: SubtitleCacheLifecycleRegistry;
};

function getSubtitleCacheLifecycleRegistry(): SubtitleCacheLifecycleRegistry {
  const globals = globalThis as SubtitleCacheLifecycleGlobal;
  let registry = globals[SUBTITLE_CACHE_LIFECYCLE_SYMBOL];
  if (!registry) {
    registry = {
      pendingTranslatedWrites: new Map<string, PendingTranslatedWrite>(),
      flushRef: () => flushSubtitleCache(),
      inFlightFlushes: new Set<Promise<void>>(),
      bound: false
    };
    globals[SUBTITLE_CACHE_LIFECYCLE_SYMBOL] = registry;
  } else {
    if (!registry.pendingTranslatedWrites) {
      registry.pendingTranslatedWrites = new Map<string, PendingTranslatedWrite>();
    }
    if (!registry.inFlightFlushes) {
      registry.inFlightFlushes = new Set<Promise<void>>();
    }
  }
  return registry;
}

function getPendingTranslatedWrites(): Map<string, PendingTranslatedWrite> {
  return getSubtitleCacheLifecycleRegistry().pendingTranslatedWrites;
}

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
  site?: SiteId;
}

export async function flushSubtitleCache(filter?: FlushSubtitleCacheFilter): Promise<void> {
  const registry = getSubtitleCacheLifecycleRegistry();
  const priorFlushes = Array.from(registry.inFlightFlushes);
  const rawFilterBvid = filter?.bvid ? String(filter.bvid).trim() : "";
  const rawFilterCid = filter?.cid ? String(filter.cid).trim() : "";
  const resolvedFilter = rawFilterBvid
    ? resolveVideoStorageIdentity(rawFilterBvid, rawFilterCid, filter?.site)
    : null;
  const filterBvid = resolvedFilter ? resolvedFilter.bvid : "";
  const filterCid = rawFilterCid ? (resolvedFilter ? resolvedFilter.cid : rawFilterCid) : "";

  const snapshot: PendingTranslatedWrite[] = [];
  for (const [key, entry] of registry.pendingTranslatedWrites.entries()) {
    if (filterBvid && entry.bvid !== filterBvid) continue;
    if (filterCid && entry.cid !== filterCid) continue;
    clearPendingWriteTimer(entry);
    registry.pendingTranslatedWrites.delete(key);
    snapshot.push(entry);
  }

  if (snapshot.length === 0) {
    if (priorFlushes.length > 0) {
      await Promise.allSettled(priorFlushes);
    }
    return;
  }

  const currentFlush = Promise.allSettled(
    snapshot.map((entry) => (entry.commit ?? commitTranslatedWriteToStore)(entry))
  ).then(() => undefined);

  registry.inFlightFlushes.add(currentFlush);
  try {
    await Promise.allSettled([...priorFlushes, currentFlush]);
  } finally {
    registry.inFlightFlushes.delete(currentFlush);
  }
}

function registerLifecycleFlushHandlers(): void {
  const registry = getSubtitleCacheLifecycleRegistry();
  registry.flushRef = () => flushSubtitleCache();

  if (!registry.onPageHide && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    registry.onPageHide = () => {
      void registry.flushRef();
    };
    window.addEventListener("pagehide", registry.onPageHide);
    registry.bound = true;
  }
  if (
    !registry.onVisibilityChange &&
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  ) {
    registry.onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void registry.flushRef();
      }
    };
    document.addEventListener("visibilitychange", registry.onVisibilityChange);
    registry.bound = true;
  }
}

function clearPendingTranslatedWritesForReset(): void {
  const pendingWrites = getPendingTranslatedWrites();
  for (const entry of pendingWrites.values()) {
    clearPendingWriteTimer(entry);
  }
  pendingWrites.clear();
}

export function resetSubtitleCacheRuntimeForTests(): void {
  clearPendingTranslatedWritesForReset();
  resetSubtitleStoreClientForTests();
}

registerSubtitleStoreResetHookForTests(clearPendingTranslatedWritesForReset);
registerLifecycleFlushHandlers();

export interface LoadRawTrackOptions {
  bvid: string;
  cid: string;
  trackKey: string;
  legacyCacheKey?: string;
  site?: SiteId;
}

export interface SaveRawTrackOptions {
  bvid: string;
  cid: string;
  trackKey: string;
  lang?: string;
  kind?: SubtitleTrackStorageKind;
  items: readonly unknown[];
  site?: SiteId;
}

export async function loadRawSubtitleTrack({
  bvid,
  cid,
  trackKey,
  legacyCacheKey,
  site
}: LoadRawTrackOptions): Promise<SubtitleBodyItem[] | null> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
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
        return migrated;
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
  items,
  site
}: SaveRawTrackOptions): Promise<SaveSubtitleResult> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
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
  site?: SiteId;
}

export interface SaveSegmentedTrackOptions extends LoadSegmentedTrackOptions {
  items: readonly unknown[];
}

export async function loadSegmentedSubtitleTrack({
  bvid,
  cid,
  trackKey,
  segmentationSig,
  site
}: LoadSegmentedTrackOptions): Promise<SubtitleBodyItem[] | null> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
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
  items,
  site
}: SaveSegmentedTrackOptions): Promise<SaveSubtitleResult> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
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
  site?: SiteId;
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
  site?: SiteId;
}

export async function loadTranslatedSubtitleTrack({
  bvid,
  cid,
  sourceTrackKey,
  targetLang,
  translationSig,
  legacyCacheKey,
  site
}: LoadTranslatedTrackOptions): Promise<SubtitleBodyItem[] | null> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
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

    const pendingKey = translationSig
      ? buildPendingTranslatedKey(cleanBvid, cleanCid, cleanSource, cleanLang, translationSig)
      : "";
    const pendingEntry = pendingKey ? getPendingTranslatedWrites().get(pendingKey) : undefined;
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
        return migrated;
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

export function scheduleTranslatedTrackWrite(options: TranslatedTrackWriteOptions): void {
  const resolved = resolveVideoStorageIdentity(options.bvid, options.cid, options.site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
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
  const pendingWrites = getPendingTranslatedWrites();
  const pendingKey = buildPendingTranslatedKey(cleanBvid, cleanCid, cleanSource, cleanLang, cleanSig);
  const existing = pendingWrites.get(pendingKey);
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
    timer: null,
    commit: commitTranslatedWriteToStore
  };

  record.timer = setTimeout(() => {
    const current = pendingWrites.get(pendingKey);
    if (current !== record) {
      return;
    }
    record.timer = null;
    pendingWrites.delete(pendingKey);
    void commitTranslatedWriteToStore(record);
  }, debounceMs);

  pendingWrites.set(pendingKey, record);
}

export async function saveTranslatedSubtitleTrack(
  options: Omit<TranslatedTrackWriteOptions, "debounceMs">
): Promise<SaveSubtitleResult> {
  const resolved = resolveVideoStorageIdentity(options.bvid, options.cid, options.site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
  const cleanSource = String(options.sourceTrackKey || "").trim();
  const cleanLang = toCanonicalTargetLangBcp47(options.targetLang);
  const cleanSig = String(options.translationSig || "").trim() || "legacy";
  const cleanItems = sanitizeTranslatedItems(options.items);
  if (!cleanBvid || !cleanCid || !cleanSource || !cleanLang) {
    return { ok: false, error: new CacheWriteError("Invalid translated subtitle cache parameters") };
  }

  const pendingWrites = getPendingTranslatedWrites();
  const pendingKey = buildPendingTranslatedKey(cleanBvid, cleanCid, cleanSource, cleanLang, cleanSig);
  const pending = pendingWrites.get(pendingKey);
  if (pending) {
    clearPendingWriteTimer(pending);
    pendingWrites.delete(pendingKey);
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
  cid: string,
  site?: SiteId
): Promise<SubtitlePageRecord | null> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
  if (!cleanBvid || !cleanCid) {
    return null;
  }
  await flushSubtitleCache({ bvid: cleanBvid, cid: cleanCid, site: resolved.site });
  return resolveActiveStore().getPageRecord(cleanBvid, cleanCid);
}

async function readLegacyChromeStorageEntry(cacheKey: string): Promise<SubtitleBodyItem[] | null> {
  if (!globalThis.chrome?.storage?.local) {
    return null;
  }
  try {
    const result = await chrome.storage.local.get(cacheKey);
    const cached = result?.[cacheKey] as { body?: SubtitleBodyItem[] } | undefined;
    return Array.isArray(cached?.body) ? cached.body : null;
  } catch {
    return null;
  }
}

async function tryMigrateLegacyStorageEntry(cacheKey: string): Promise<SubtitleBodyItem[] | null> {
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
      const keysToRemove = [
        cacheKey,
        buildLruIndexEntryKey(CACHE_KEY_PREFIX, parsed.bvid, cacheKey)
      ];
      await chrome.storage.local.remove(keysToRemove).catch(() => {});
    }
  }
  return legacyBody;
}

export async function loadSubtitleFromCache(cacheKey: string): Promise<SubtitleBodyItem[] | null> {
  try {
    const parsed = parseSubtitleCacheKey(cacheKey);
    if (!parsed) {
      return await readLegacyChromeStorageEntry(cacheKey);
    }
    if (parsed.kind === "translated") {
      for (const entry of getPendingTranslatedWrites().values()) {
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
  keyPrefix: string,
  excludeKey?: string
): Promise<string[]> {
  if (!globalThis.chrome?.storage?.local) {
    return [];
  }
  try {
    const matchedKeys = await listStorageKeysByPrefix(keyPrefix);
    const staleStorageKeys = matchedKeys.filter(
      (key) => typeof key === "string" && key.startsWith(keyPrefix) && key !== excludeKey
    );
    if (staleStorageKeys.length > 0) {
      await chrome.storage.local.remove(staleStorageKeys);
    }
    return staleStorageKeys;
  } catch {
    return [];
  }
}

interface AsrCacheCleanupOptions {
  bvid: string;
  cid: string;
  keepKey?: string;
  site?: SiteId;
}

export async function clearStaleAsrSubtitleCache({
  bvid,
  cid,
  keepKey = "",
  site
}: AsrCacheCleanupOptions): Promise<string[]> {
  try {
    const resolved = resolveVideoStorageIdentity(bvid, cid, site);
    const cleanBvid = resolved.bvid;
    const cleanCid = resolved.cid;
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
    for (const key of await removeLegacyStorageByPrefix(keyPrefix, keepKey)) {
      removedLegacyKeys.add(key);
    }

    return Array.from(removedLegacyKeys);
  } catch (error) {
    logWarn("[BILISCRIPT] failed to clear stale asr subtitle cache entries", { bvid, cid, error });
    return [];
  }
}

export async function clearTranslatedSubtitleCache({
  bvid,
  cid,
  sourceTrackKey,
  site
}: {
  bvid: string;
  cid: string;
  sourceTrackKey?: string;
  site?: SiteId;
}): Promise<string[]> {
  try {
    const resolved = resolveVideoStorageIdentity(bvid, cid, site);
    const cleanBvid = resolved.bvid;
    const cleanCid = resolved.cid;
    if (!cleanBvid || !cleanCid) {
      return [];
    }

    const pendingWrites = getPendingTranslatedWrites();
    for (const [key, entry] of pendingWrites.entries()) {
      if (
        entry.bvid === cleanBvid &&
        entry.cid === cleanCid &&
        (!sourceTrackKey || entry.sourceTrackKey === sourceTrackKey)
      ) {
        clearPendingWriteTimer(entry);
        pendingWrites.delete(key);
      }
    }

    const removedMapKeys = await resolveActiveStore().clearTranslatedTracksForPage({
      bvid: cleanBvid,
      cid: cleanCid,
      sourceTrackKey
    });

    const removedKeys = new Set<string>(removedMapKeys);
    const keyPrefix = `${CACHE_KEY_PREFIX}${cleanBvid}_${cleanCid}_${TRANSLATED_SOURCE_KEY_PREFIX}`;
    for (const key of await removeLegacyStorageByPrefix(keyPrefix)) {
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
  site?: SiteId;
}

export interface CachedAsrSubtitleTrack {
  body: SubtitleBodyItem[];
  lang: string;
  trackKey: string;
  cacheKey: string;
}

function extractAsrLangFromTrackKey(trackKey: string): string {
  if (!isAsrVariantSourceKey(trackKey)) {
    return "";
  }
  const rest = trackKey.slice(ASR_SOURCE_KEY_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  return lastColon === -1 ? "" : rest.slice(lastColon + 1).trim();
}

export async function findCachedAsrSubtitleTrack({
  bvid,
  cid,
  preferredCacheKey,
  site
}: {
  bvid: string;
  cid: string;
  preferredCacheKey?: string;
  site?: SiteId;
}): Promise<CachedAsrSubtitleTrack | null> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cleanBvid = resolved.bvid;
  const cleanCid = resolved.cid;
  if (!cleanBvid || !cleanCid) {
    return null;
  }

  if (preferredCacheKey) {
    const preferredBody = await loadSubtitleFromCache(preferredCacheKey);
    if (Array.isArray(preferredBody) && preferredBody.length > 0) {
      const parsed = parseSubtitleCacheKey(preferredCacheKey);
      const trackKey = parsed && parsed.kind === "raw" ? parsed.trackKey : "";
      return {
        body: preferredBody as SubtitleBodyItem[],
        lang: extractAsrLangFromTrackKey(trackKey),
        trackKey,
        cacheKey: preferredCacheKey
      };
    }
  }

  try {
    const page = await getSubtitlePageCacheRecord(cleanBvid, cleanCid);
    const rawTracks = page?.rawTracks;
    if (rawTracks) {
      let best: RawSubtitleTrackRecord | null = null;
      for (const record of Object.values(rawTracks)) {
        if (!record || !Array.isArray(record.items) || record.items.length === 0) {
          continue;
        }
        if (record.kind !== "asr" && !isAsrVariantSourceKey(record.trackKey)) {
          continue;
        }
        if (!best || (Number(record.updatedAt) || 0) >= (Number(best.updatedAt) || 0)) {
          best = record;
        }
      }
      if (best) {
        return {
          body: best.items.map((item) => ({ ...item })),
          lang: String(best.lang || extractAsrLangFromTrackKey(best.trackKey) || ""),
          trackKey: best.trackKey,
          cacheKey: `${CACHE_KEY_PREFIX}${cleanBvid}_${cleanCid}_${best.trackKey}`
        };
      }
    }
  } catch (error) {
    logWarn("[BILISCRIPT] failed to inspect cached asr subtitle track", {
      bvid: cleanBvid,
      cid: cleanCid,
      error
    });
  }

  if (globalThis.chrome?.storage?.local) {
    try {
      const prefix = `${CACHE_KEY_PREFIX}${cleanBvid}_${cleanCid}_${ASR_SOURCE_KEY_PREFIX}`;
      const legacyKeys = await listStorageKeysByPrefix(prefix);
      for (const legacyKey of legacyKeys) {
        const migrated = await loadSubtitleFromCache(legacyKey);
        if (Array.isArray(migrated) && migrated.length > 0) {
          const parsed = parseSubtitleCacheKey(legacyKey);
          const trackKey = parsed && parsed.kind === "raw" ? parsed.trackKey : "";
          return {
            body: migrated as SubtitleBodyItem[],
            lang: extractAsrLangFromTrackKey(trackKey),
            trackKey,
            cacheKey: legacyKey
          };
        }
      }
    } catch {
    }
  }

  return null;
}

export async function persistAsrSubtitleToCache({
  bvid,
  cid,
  identity,
  body,
  site
}: PersistAsrSubtitleOptions): Promise<SaveSubtitleResult> {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  const cacheKey = getSubtitleCacheKey({ bvid: resolved.bvid, cid: resolved.cid, identity, site: resolved.site });
  const trackKey = subtitleSourceKey(identity);
  const saveResult = await saveRawSubtitleTrack({
    bvid: resolved.bvid,
    cid: resolved.cid,
    site: resolved.site,
    trackKey,
    lang: identity.kind === "asr" ? String(identity.lang || "") : undefined,
    kind: "asr",
    items: body
  });
  if (saveResult && saveResult.ok === false) {
    return saveResult;
  }
  await clearStaleAsrSubtitleCache({ bvid: resolved.bvid, cid: resolved.cid, site: resolved.site, keepKey: cacheKey });
  await clearTranslatedSubtitleCache({ bvid: resolved.bvid, cid: resolved.cid, site: resolved.site, sourceTrackKey: "asr" });
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

export interface ClearVideoCacheResult extends ClearVideoResult {
  removedLegacyKeys: string[];
}

export async function clearVideoCache(
  bvid: string,
  cid?: string,
  site?: SiteId
): Promise<ClearVideoCacheResult> {
  const hasCid = cid !== undefined && cid !== null && String(cid).trim() !== "";
  const resolved = resolveVideoStorageIdentity(bvid, hasCid ? cid : "", site);
  const cleanBvid = resolved.bvid;
  const cleanCid = hasCid ? resolved.cid : "";
  if (!cleanBvid) {
    return { removedPageIds: [], removedArtifactKeys: [], removedLegacyKeys: [] };
  }

  const pendingWrites = getPendingTranslatedWrites();
  for (const [key, entry] of pendingWrites.entries()) {
    if (entry.bvid === cleanBvid && (!cleanCid || entry.cid === cleanCid)) {
      clearPendingWriteTimer(entry);
      pendingWrites.delete(key);
    }
  }

  runVideoCacheClearHooks(cleanBvid, cleanCid || undefined);

  let idbResult: ClearVideoResult = { removedPageIds: [], removedArtifactKeys: [] };
  try {
    idbResult = await resolveActiveStore().clearVideo(cleanBvid, cleanCid || undefined);
  } catch (error) {
    logWarn("[BILISCRIPT] failed to clear video cache from IndexedDB", { bvid: cleanBvid, cid: cleanCid, error });
  }

  const removedLegacyKeys: string[] = [];
  if (globalThis.chrome?.storage?.local) {
    try {
      const allKeys = await listStorageKeysByPrefix("");
      const dataPrefixes = CACHE_FAMILIES.map((family) =>
        cleanCid ? `${family}${cleanBvid}_${cleanCid}_` : `${family}${cleanBvid}_`
      );
      const exactLegacyKeys = cleanCid
        ? new Set<string>()
        : new Set(CACHE_FAMILIES.map((family) => `${family}${cleanBvid}`));
      const indexPrefixes = CACHE_FAMILIES.map((family) =>
        buildLruIndexEntryKey(
          family,
          cleanBvid,
          cleanCid ? `${family}${cleanBvid}_${cleanCid}_` : ""
        )
      );

      const matched = allKeys.filter(
        (key) =>
          exactLegacyKeys.has(key) ||
          dataPrefixes.some((prefix) => key.startsWith(prefix)) ||
          indexPrefixes.some((prefix) => key.startsWith(prefix))
      );
      if (matched.length > 0) {
        await chrome.storage.local.remove(matched);
        removedLegacyKeys.push(...matched);
      }
    } catch (error) {
      logWarn("[BILISCRIPT] failed to clear legacy storage keys for video", {
        bvid: cleanBvid,
        cid: cleanCid,
        error
      });
    }
  }

  return {
    removedPageIds: idbResult.removedPageIds,
    removedArtifactKeys: idbResult.removedArtifactKeys,
    removedLegacyKeys
  };
}
