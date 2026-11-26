import { state } from "../core/state.js";
import type { SubtitleBodyItem } from "../ai/types.js";
import type { L1VideoIndexCacheRecord } from "../ai/long-video-hybrid-types.js";
import type { TranslateSubtitleTrackResult } from "../ai/subtitle-translate.js";
import type { SubtitleTranslateProviderResolution } from "../ai/subtitle-translate-config.js";
import type { StreamingSubtitleCue } from "./streaming-parser.js";
import {
  extractPreviousBilingualLinesBeforeTime,
  resolveL1ChapterTranslateContext,
  type SubtitleGlossaryInput,
  type SubtitlePreviousLine,
  type SubtitleTranslatePromptContext
} from "../ai/subtitle-context.js";
import { logWarn } from "../shared/logging.js";
import { isStaleRunError } from "../shared/error-helpers.js";
import { buildSecondaryAlignment, type SecondaryAlignment } from "./alignment.js";
import { findActiveSubtitleIndexInItems } from "./core.js";
import {
  buildTranslationSignature,
  flushSubtitleCache,
  getSubtitleCacheKey,
  loadTranslatedSubtitleTrack,
  saveTranslatedSubtitleTrack,
  scheduleTranslatedTrackWrite
} from "./cache.js";
import { acceptSecondarySubtitle } from "./commit.js";
import { classifySubtitleTrack, findTrackByRef, toCanonicalTargetLangBcp47 } from "./selection.js";
import type { SubtitleTrackOrigin } from "../shared/video-dto.js";
import {
  buildSubtitleSourceKey,
  trackTranslatedSlotId,
  translatedTrackId,
  type TrackIdentity
} from "./source-key.js";

export const TRANSLATION_CHUNK_SEC = 60;
const DEFAULT_TRANSLATION_MODEL = "Index-Translate-35B-A3B";

export type TranslationProtocolMode = "boundary-v3" | "cc-json";

export interface TranslatedTrackSourceSpec {
  isAsrSource: boolean;
  selectedSubtitleId?: string;
  selectedSubtitleUrl?: string;
  selectedSubtitleLang?: string;
  trackLan?: string;
  origin?: SubtitleTrackOrigin;
  kind?: string;
  source?: string;
  targetLang: string;
}

export interface TranslatedTrackSourceTrackLike {
  id?: string;
  subtitleUrl?: string;
  lan?: string;
  lanDoc?: string;
  origin?: SubtitleTrackOrigin;
  kind?: string;
  source?: string;
}

export interface TranslatedTrackSourceRef {
  isAsrSource?: boolean;
  track?: TranslatedTrackSourceTrackLike | null;
  tracks?: readonly TranslatedTrackSourceTrackLike[];
  selectedSubtitleId?: string;
  selectedSubtitleUrl?: string;
  selectedSubtitleLang?: string;
}

export function resolveTranslatedTrackSource(
  trackRef: TranslatedTrackSourceRef,
  targetLang: string
): TranslatedTrackSourceSpec {
  const normalizedTargetLang = String(targetLang || "").trim();
  if (trackRef.isAsrSource) {
    return {
      isAsrSource: true,
      targetLang: normalizedTargetLang
    };
  }

  const selectedId = String(trackRef.selectedSubtitleId || trackRef.track?.id || "").trim();
  const selectedUrl = String(trackRef.selectedSubtitleUrl || trackRef.track?.subtitleUrl || "").trim();
  const selectedLang = String(trackRef.selectedSubtitleLang || trackRef.track?.lanDoc || "").trim();
  const matchedTrack =
    trackRef.track ??
    (trackRef.tracks
      ? (findTrackByRef(trackRef.tracks as Parameters<typeof findTrackByRef>[0], {
          id: selectedId,
          url: selectedUrl
        }) as TranslatedTrackSourceTrackLike | null)
      : null);

  const trackKind = classifySubtitleTrack(
    matchedTrack ?? { id: selectedId, lan: selectedLang, subtitleUrl: selectedUrl }
  );
  const isAsrSource = trackKind === "asr" || (!selectedUrl && (!selectedId || selectedId === "asr"));
  if (isAsrSource) {
    return {
      isAsrSource: true,
      targetLang: normalizedTargetLang
    };
  }

  return {
    isAsrSource: false,
    selectedSubtitleId: selectedId,
    selectedSubtitleUrl: selectedUrl,
    selectedSubtitleLang: selectedLang,
    trackLan: matchedTrack?.lan,
    ...(matchedTrack?.origin !== undefined ? { origin: matchedTrack.origin } : {}),
    ...(matchedTrack?.kind !== undefined ? { kind: matchedTrack.kind } : {}),
    ...(matchedTrack?.source !== undefined ? { source: matchedTrack.source } : {}),
    targetLang: normalizedTargetLang
  };
}

export interface TranslatedTrackPrimaryChunk {
  index: number;
  startSec: number;
  endSec: number;
  items: SubtitleBodyItem[];
}

export interface TranslatedTrackTranslateInput {
  items: SubtitleBodyItem[];
  targetLang: string;
  selectedSubtitleId?: string;
  selectedSubtitleLang?: string;
  trackLan?: string;
  origin?: SubtitleTrackOrigin;
  kind?: string;
  source?: string;
  providerResolution?: SubtitleTranslateProviderResolution;
  chunkFromSec?: number;
  chunkToSec?: number;
  l1Index?: L1VideoIndexCacheRecord | null;
  context?: SubtitleTranslatePromptContext;
  chapterContext?: string;
  referenceEntities?: string[];
  previousLines?: SubtitlePreviousLine[];
  signal?: AbortSignal | null;
  fallbackToOriginal?: boolean;
  onCueReady?: (cue: StreamingSubtitleCue) => void;
}

export type ResolveTranslationProtocolFn = (input: {
  selectedSubtitleId?: string;
  selectedSubtitleLang?: string;
  trackLan?: string;
  origin?: SubtitleTrackOrigin;
  kind?: string;
  source?: string;
  items?: readonly SubtitleBodyItem[];
}) => TranslationProtocolMode;

export type TranslateTrackFn = (
  input: TranslatedTrackTranslateInput
) => Promise<TranslateSubtitleTrackResult>;

export interface TranslatedTrackSessionOptions {
  bvid: string;
  cid: string;
  source: TranslatedTrackSourceSpec;
  runId?: number;
  model?: string;
  glossary?: SubtitleGlossaryInput | null;
  primaryItems?: readonly SubtitleBodyItem[];
  protocolProbeItems?: readonly SubtitleBodyItem[];
  isStale?: () => boolean;
}

export interface TranslatedTrackSessionDeps {
  resolveProtocolMode?: ResolveTranslationProtocolFn;
  translateTrack?: TranslateTrackFn;
  loadCustomCache?: (cacheKey: string) => Promise<unknown[] | null>;
  saveCustomCache?: (cacheKey: string, items: SubtitleBodyItem[]) => Promise<unknown>;
  onStreamingUpdate?: (update: {
    items: SubtitleBodyItem[];
    cue: { from: number; to: number; content: string };
  }) => void;
  onAfterStreamingAccept?: () => void;
  onBeforePersistChunk?: (context: {
    chunkIndex: number;
    displayBody: SubtitleBodyItem[];
    completedBody: SubtitleBodyItem[];
  }) => Promise<void>;
  onAfterPersistChunk?: (context: {
    chunkIndex: number;
    displayBody: SubtitleBodyItem[];
    completedBody: SubtitleBodyItem[];
    updatedRange?: { from: number; to: number };
  }) => void;
}

export interface TranslateSessionChunkInput {
  chunkIndex: number;
  chunkFromSec: number;
  chunkToSec: number;
  items?: SubtitleBodyItem[];
  l1Index?: L1VideoIndexCacheRecord | null;
  baseContext?: SubtitleTranslatePromptContext;
  providerResolution?: SubtitleTranslateProviderResolution;
  signal?: AbortSignal | null;
}

export interface TranslateSessionChunkResult {
  status: "done" | "aborted" | "stale-revision";
  items: SubtitleBodyItem[];
}

export interface TranslatedTrackTranslatorConfig {
  model?: string;
  glossary?: SubtitleGlossaryInput | null;
  resolveProtocolMode?: ResolveTranslationProtocolFn;
  translateTrack?: TranslateTrackFn;
  protocolItems?: readonly SubtitleBodyItem[];
}

export interface HydrateTranslatedTrackInput {
  mode: "cache-only" | "translate";
  loadTranslator?: () => Promise<TranslatedTrackTranslatorConfig | null | undefined | void>;
  acceptOnHit?: boolean;
  protocolItems?: readonly SubtitleBodyItem[];
}

export interface HydrateTranslatedTrackResult {
  status: "ready" | "pending" | "aborted";
  totalChunks: number;
  doneChunks: number;
  pendingChunks: TranslatedTrackPrimaryChunk[];
  secondaryItems: SubtitleBodyItem[];
  sigChanged: boolean;
}

export interface TranslatedTrackSession {
  readonly slotId: string;
  readonly sourceKey: string;
  readonly canonicalTargetLang: string;
  readonly legacyCacheKey: string;
  readonly protocolMode: TranslationProtocolMode;
  readonly translationSig: string;
  hydrate(input: HydrateTranslatedTrackInput): Promise<HydrateTranslatedTrackResult>;
  translateChunk(input: TranslateSessionChunkInput): Promise<TranslateSessionChunkResult>;
  querySecondaryLine(
    currentTimeSec: number,
    activePrimaryRange?: { from: number; to: number } | null
  ): string;
  setPrimaryChunk(chunkIndex: number, items: readonly SubtitleBodyItem[]): void;
  invalidateChunk(chunkIndex: number): void;
  getPrimaryItems(): SubtitleBodyItem[];
  getPrimaryChunks(): TranslatedTrackPrimaryChunk[];
  getSecondaryItems(): SubtitleBodyItem[];
  isChunkDone(chunkIndex: number): boolean;
  persistCurrent(): Promise<void>;
  flush(): Promise<void>;
}

export function isUsableSubtitleItem(item: unknown): item is SubtitleBodyItem {
  const candidate = item as SubtitleBodyItem | null;
  if (!candidate) {
    return false;
  }
  const from = Number(candidate.from);
  const to = Number(candidate.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return false;
  }
  return String(candidate.content ?? "").trim().length > 0;
}

export function sortSubtitleItemsByFrom(items: readonly SubtitleBodyItem[]): SubtitleBodyItem[] {
  return items.slice().sort((a, b) => Number(a.from) - Number(b.from));
}

export function chunkIndexForTimeSec(fromSec: unknown): number {
  return Math.floor((Number(fromSec) || 0) / TRANSLATION_CHUNK_SEC);
}

function inferDefaultProtocolMode(source: TranslatedTrackSourceSpec): TranslationProtocolMode {
  if (source.isAsrSource) {
    return "boundary-v3";
  }
  const trackKind = classifySubtitleTrack({
    id: source.selectedSubtitleId,
    lan: source.trackLan || source.selectedSubtitleLang,
    subtitleUrl: source.selectedSubtitleUrl,
    origin: source.origin,
    kind: source.kind,
    source: source.source
  });
  return trackKind === "asr" || trackKind === "bili-ai" || trackKind === "youtube-auto"
    ? "boundary-v3"
    : "cc-json";
}

function computeItemsRange(items: readonly SubtitleBodyItem[]): { from: number; to: number } | undefined {
  let minFrom = Infinity;
  let maxTo = -Infinity;
  for (const item of items) {
    const from = Number(item.from);
    const to = Number(item.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      if (from < minFrom) minFrom = from;
      if (to > maxTo) maxTo = to;
    }
  }
  return Number.isFinite(minFrom) && Number.isFinite(maxTo) && maxTo > minFrom
    ? { from: minFrom, to: maxTo }
    : undefined;
}

export function createTranslatedTrackSession(
  options: TranslatedTrackSessionOptions,
  deps: TranslatedTrackSessionDeps = {}
): TranslatedTrackSession {
  const bvid = String(options.bvid || "").trim();
  const cid = String(options.cid || "").trim();
  const runId = options.runId;
  const source = options.source;
  const targetLang = String(source.targetLang || "").trim();
  const canonicalTargetLang = toCanonicalTargetLangBcp47(targetLang);
  const selectedId = String(source.selectedSubtitleId || "").trim();
  const selectedUrl = String(source.selectedSubtitleUrl || "").trim();
  const selectedLang = String(source.selectedSubtitleLang || "").trim();
  const trackLan = source.isAsrSource ? "asr-zh" : String(source.trackLan || "").trim();

  const sourceKey = source.isAsrSource
    ? "asr"
    : buildSubtitleSourceKey(selectedId, selectedUrl, selectedLang);
  const slotId = source.isAsrSource
    ? translatedTrackId(targetLang)
    : trackTranslatedSlotId(sourceKey, canonicalTargetLang);
  const cacheIdentity: TrackIdentity = source.isAsrSource
    ? { kind: "translated", targetLang }
    : { kind: "track-translated", sourceKey, targetLang: canonicalTargetLang };
  const legacyCacheKey = getSubtitleCacheKey({
    bvid,
    cid,
    identity: cacheIdentity
  });

  let resolveProtocolFn = deps.resolveProtocolMode;
  let translateTrackFn = deps.translateTrack;
  let resolvedModel = String(
    options.model || state.settings?.subtitleTranslateModel || DEFAULT_TRANSLATION_MODEL
  );
  let activeGlossary: SubtitleGlossaryInput | null | undefined =
    options.glossary ?? state.settings?.subtitleTranslateGlossary;

  const primaryByChunk = new Map<number, SubtitleBodyItem[]>();
  const primaryRevisionByChunk = new Map<number, number>();
  const completedSecondaryByChunk = new Map<number, SubtitleBodyItem[]>();
  const streamingCuesByChunk = new Map<number, Map<string, SubtitleBodyItem>>();
  const doneChunks = new Set<number>();

  let cachedDisplaySecondary: SubtitleBodyItem[] | null = null;
  let cachedSecondaryAlignment: SecondaryAlignment | null = null;
  let hasUnflushedStreamingCues = false;
  let persistQueue: Promise<void> = Promise.resolve();

  function invalidateSecondaryCache(): void {
    cachedDisplaySecondary = null;
    cachedSecondaryAlignment = null;
  }

  if (Array.isArray(options.primaryItems)) {
    for (const item of options.primaryItems) {
      const idx = chunkIndexForTimeSec(item.from);
      const list = primaryByChunk.get(idx);
      if (list) {
        list.push(item);
      } else {
        primaryByChunk.set(idx, [item]);
      }
    }
    for (const [idx, list] of primaryByChunk.entries()) {
      primaryByChunk.set(idx, sortSubtitleItemsByFrom(list));
    }
  }

  function getPrimaryItems(): SubtitleBodyItem[] {
    return Array.from(primaryByChunk.entries())
      .sort(([a], [b]) => a - b)
      .flatMap(([, items]) => items)
      .sort((a, b) => Number(a.from) - Number(b.from));
  }

  function getPrimaryChunks(): TranslatedTrackPrimaryChunk[] {
    return Array.from(primaryByChunk.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, items]) => ({
        index,
        startSec: index * TRANSLATION_CHUNK_SEC,
        endSec: (index + 1) * TRANSLATION_CHUNK_SEC,
        items
      }));
  }

  function getPendingPrimaryChunks(): TranslatedTrackPrimaryChunk[] {
    return getPrimaryChunks().filter((chunk) => !doneChunks.has(chunk.index));
  }

  function resolveProtocol(probeItems?: readonly SubtitleBodyItem[]): TranslationProtocolMode {
    const itemsForProbe =
      probeItems && probeItems.length > 0
        ? probeItems
        : options.primaryItems && options.primaryItems.length > 0
          ? options.primaryItems
          : options.protocolProbeItems && options.protocolProbeItems.length > 0
            ? options.protocolProbeItems
            : [];
    if (resolveProtocolFn) {
      return resolveProtocolFn({
        selectedSubtitleId: source.isAsrSource ? "asr" : selectedId,
        selectedSubtitleLang: source.isAsrSource ? undefined : selectedLang,
        trackLan,
        ...(source.isAsrSource
          ? {}
          : {
              ...(source.origin !== undefined ? { origin: source.origin } : {}),
              ...(source.kind !== undefined ? { kind: source.kind } : {}),
              ...(source.source !== undefined ? { source: source.source } : {})
            }),
        items: itemsForProbe
      });
    }
    return inferDefaultProtocolMode(source);
  }

  function computeSignature(protocol: TranslationProtocolMode): string {
    const primary = getPrimaryItems();
    const sourceText = primary.length > 0 ? primary.map((item) => item.content).join("\n") : undefined;
    return buildTranslationSignature({
      model: resolvedModel,
      protocolVersion: protocol,
      targetLang: canonicalTargetLang,
      glossary: activeGlossary,
      ...(sourceText !== undefined ? { sourceText } : {})
    });
  }

  let protocolMode: TranslationProtocolMode = resolveProtocol();
  let translationSig: string = computeSignature(protocolMode);

  function isStale(): boolean {
    return options.isStale?.() === true;
  }

  function collectCompletedSecondary(): SubtitleBodyItem[] {
    return Array.from(completedSecondaryByChunk.entries())
      .sort(([a], [b]) => a - b)
      .flatMap(([, items]) => items)
      .sort((a, b) => Number(a.from) - Number(b.from));
  }

  function getDisplaySecondary(): SubtitleBodyItem[] {
    if (cachedDisplaySecondary !== null) {
      return cachedDisplaySecondary;
    }
    const merged: SubtitleBodyItem[] = [];
    const allChunks = new Set<number>([
      ...completedSecondaryByChunk.keys(),
      ...streamingCuesByChunk.keys()
    ]);
    for (const idx of Array.from(allChunks).sort((a, b) => a - b)) {
      const streaming = streamingCuesByChunk.get(idx);
      if (streaming && streaming.size > 0) {
        merged.push(...streaming.values());
      } else {
        const completed = completedSecondaryByChunk.get(idx);
        if (completed) {
          merged.push(...completed);
        }
      }
    }
    cachedDisplaySecondary = sortSubtitleItemsByFrom(merged);
    return cachedDisplaySecondary;
  }

  async function loadCachedInternal(): Promise<SubtitleBodyItem[]> {
    const raw = deps.loadCustomCache
      ? await deps.loadCustomCache(legacyCacheKey)
      : await loadTranslatedSubtitleTrack({
          bvid,
          cid,
          sourceTrackKey: sourceKey,
          targetLang: canonicalTargetLang,
          translationSig,
          legacyCacheKey
        });
    return Array.isArray(raw) ? sortSubtitleItemsByFrom(raw.filter(isUsableSubtitleItem)) : [];
  }

  function seedSecondaryInternal(items: readonly unknown[]): SubtitleBodyItem[] {
    completedSecondaryByChunk.clear();
    streamingCuesByChunk.clear();
    doneChunks.clear();
    hasUnflushedStreamingCues = false;
    invalidateSecondaryCache();

    const sorted = sortSubtitleItemsByFrom(items.filter(isUsableSubtitleItem));
    for (const item of sorted) {
      const idx = chunkIndexForTimeSec(item.from);
      const list = completedSecondaryByChunk.get(idx);
      if (list) {
        list.push(item);
      } else {
        completedSecondaryByChunk.set(idx, [item]);
      }
      doneChunks.add(idx);
    }
    return sorted;
  }

  async function acceptCurrentSecondaryInternal(): Promise<void> {
    const current = getDisplaySecondary();
    if (current.length === 0) {
      return;
    }
    await acceptSecondarySubtitle({
      body: current.slice(),
      subtitleId: slotId,
      subtitleUrl: "",
      runId
    });
  }

  function reconfigureInternal(next: TranslatedTrackTranslatorConfig): boolean {
    if (next.resolveProtocolMode) {
      resolveProtocolFn = next.resolveProtocolMode;
    }
    if (next.translateTrack) {
      translateTrackFn = next.translateTrack;
    }
    if (next.model) {
      resolvedModel = next.model;
    }
    if (next.glossary !== undefined) {
      activeGlossary = next.glossary;
    }
    protocolMode = resolveProtocol(next.protocolItems);
    const nextSig = computeSignature(protocolMode);
    const changed = nextSig !== translationSig;
    translationSig = nextSig;
    return changed;
  }

  function warnUnlessStaleRun(
    message: string,
    detail: Record<string, unknown>,
    error: unknown
  ): void {
    if (!isStaleRunError(error)) {
      logWarn(message, { ...detail, error });
    }
  }

  function enqueuePersist(
    task: () => Promise<void>
  ): Promise<void> {
    const next = persistQueue.catch(() => {}).then(async () => {
      if (isStale()) {
        return;
      }
      await task();
    });
    persistQueue = next;
    return next;
  }

  async function persistSecondarySnapshot(
    displayBody: SubtitleBodyItem[],
    cacheBodyToSave?: SubtitleBodyItem[]
  ): Promise<void> {
    if (displayBody.length > 0) {
      await acceptSecondarySubtitle({
        body: displayBody,
        subtitleId: slotId,
        subtitleUrl: "",
        runId
      });
    }
    if (isStale() || !cacheBodyToSave || cacheBodyToSave.length === 0) {
      return;
    }
    if (deps.saveCustomCache && legacyCacheKey) {
      await deps.saveCustomCache(legacyCacheKey, cacheBodyToSave);
    }
    if (bvid && cid) {
      const saveResult = await saveTranslatedSubtitleTrack({
        bvid,
        cid,
        sourceTrackKey: sourceKey,
        targetLang: canonicalTargetLang,
        translationSig,
        mode: protocolMode,
        items: cacheBodyToSave
      });
      if (saveResult && saveResult.ok === false) {
        logWarn("[BILISCRIPT] failed to persist translated subtitle cache", {
          bvid,
          cid,
          targetLang
        });
      }
    }
  }

  return {
    slotId,
    sourceKey,
    canonicalTargetLang,
    legacyCacheKey,
    get protocolMode() {
      return protocolMode;
    },
    get translationSig() {
      return translationSig;
    },

    async hydrate(input: HydrateTranslatedTrackInput): Promise<HydrateTranslatedTrackResult> {
      const chunks = getPrimaryChunks();
      const abortedResult = (): HydrateTranslatedTrackResult => ({
        status: "aborted",
        totalChunks: chunks.length,
        doneChunks: 0,
        pendingChunks: [],
        secondaryItems: [],
        sigChanged: false
      });

      if (isStale()) {
        return abortedResult();
      }
      if (chunks.length === 0) {
        if (input.mode === "cache-only") {
          return {
            status: "ready",
            totalChunks: 0,
            doneChunks: 0,
            pendingChunks: [],
            secondaryItems: [],
            sigChanged: false
          };
        }
        let sigChanged = false;
        if (input.loadTranslator) {
          const config = await input.loadTranslator();
          if (isStale()) {
            return abortedResult();
          }
          if (config) {
            sigChanged = reconfigureInternal({
              ...config,
              protocolItems: config.protocolItems ?? input.protocolItems
            });
          }
        }
        return {
          status: "ready",
          totalChunks: 0,
          doneChunks: 0,
          pendingChunks: [],
          secondaryItems: [],
          sigChanged
        };
      }

      const cached = await loadCachedInternal();
      if (isStale()) {
        return abortedResult();
      }
      if (cached.length > 0) {
        seedSecondaryInternal(cached);
      }

      let pending = getPendingPrimaryChunks();
      if (chunks.length > 0 && pending.length === 0) {
        if (input.acceptOnHit !== false) {
          await acceptCurrentSecondaryInternal();
          if (isStale()) {
            return abortedResult();
          }
        }
        return {
          status: "ready",
          totalChunks: chunks.length,
          doneChunks: chunks.length,
          pendingChunks: [],
          secondaryItems: getDisplaySecondary().slice(),
          sigChanged: false
        };
      }

      if (input.mode === "cache-only") {
        return {
          status: "pending",
          totalChunks: chunks.length,
          doneChunks: chunks.length - pending.length,
          pendingChunks: pending,
          secondaryItems: getDisplaySecondary().slice(),
          sigChanged: false
        };
      }

      let sigChanged = false;
      if (input.loadTranslator) {
        const config = await input.loadTranslator();
        if (isStale()) {
          return abortedResult();
        }
        if (config) {
          sigChanged = reconfigureInternal({
            ...config,
            protocolItems: config.protocolItems ?? input.protocolItems
          });
        }
        if (sigChanged) {
          const exactCached = await loadCachedInternal();
          if (isStale()) {
            return abortedResult();
          }
          if (exactCached.length > 0) {
            seedSecondaryInternal(exactCached);
            pending = getPendingPrimaryChunks();
          }
        }
      }

      if (isStale()) {
        return abortedResult();
      }

      if (chunks.length > 0 && pending.length === 0) {
        if (input.acceptOnHit !== false) {
          await acceptCurrentSecondaryInternal();
          if (isStale()) {
            return abortedResult();
          }
        }
        return {
          status: "ready",
          totalChunks: chunks.length,
          doneChunks: chunks.length,
          pendingChunks: [],
          secondaryItems: getDisplaySecondary().slice(),
          sigChanged
        };
      }

      const currentSecondary = getDisplaySecondary();
      if (input.acceptOnHit !== false && currentSecondary.length > 0) {
        await acceptCurrentSecondaryInternal();
        if (isStale()) {
          return abortedResult();
        }
      }

      return {
        status: chunks.length === 0 ? "ready" : "pending",
        totalChunks: chunks.length,
        doneChunks: chunks.length - pending.length,
        pendingChunks: pending,
        secondaryItems: getDisplaySecondary().slice(),
        sigChanged
      };
    },

    querySecondaryLine(
      currentTimeSec: number,
      activePrimaryRange?: { from: number; to: number } | null
    ): string {
      const items = getDisplaySecondary();
      if (items.length === 0) {
        return "";
      }
      const idx = findActiveSubtitleIndexInItems(items, currentTimeSec);
      if (idx >= 0 && idx < items.length) {
        const direct = String(items[idx]?.content || "").trim();
        if (direct) {
          return direct;
        }
      }
      if (activePrimaryRange) {
        if (!cachedSecondaryAlignment) {
          cachedSecondaryAlignment = buildSecondaryAlignment(items);
        }
        return cachedSecondaryAlignment.query(activePrimaryRange) || "";
      }
      return "";
    },

    setPrimaryChunk(chunkIndex: number, items: readonly SubtitleBodyItem[]): void {
      primaryByChunk.set(chunkIndex, sortSubtitleItemsByFrom(items));
      primaryRevisionByChunk.set(chunkIndex, (primaryRevisionByChunk.get(chunkIndex) ?? 0) + 1);
    },

    getPrimaryItems,

    getPrimaryChunks,

    getSecondaryItems(): SubtitleBodyItem[] {
      return getDisplaySecondary().slice();
    },

    isChunkDone(chunkIndex: number): boolean {
      return doneChunks.has(chunkIndex);
    },

    invalidateChunk(chunkIndex: number): void {
      primaryRevisionByChunk.set(chunkIndex, (primaryRevisionByChunk.get(chunkIndex) ?? 0) + 1);
      doneChunks.delete(chunkIndex);
      completedSecondaryByChunk.delete(chunkIndex);
      streamingCuesByChunk.delete(chunkIndex);
      invalidateSecondaryCache();
    },

    async translateChunk(input: TranslateSessionChunkInput): Promise<TranslateSessionChunkResult> {
      if (!translateTrackFn) {
        throw new Error("TranslatedTrackSession requires translateTrack before translateChunk");
      }
      const { chunkIndex, chunkFromSec, chunkToSec, l1Index, baseContext, providerResolution, signal } =
        input;
      const items = input.items ?? primaryByChunk.get(chunkIndex) ?? [];
      if (items.length === 0) {
        return { status: "done", items: [] };
      }

      if (isStale() || signal?.aborted) {
        return { status: "aborted", items: [] };
      }

      const revisionAtStart = primaryRevisionByChunk.get(chunkIndex) ?? 0;
      const allPrimary = getPrimaryItems();
      const completedSecondary = collectCompletedSecondary();
      const previousLines = extractPreviousBilingualLinesBeforeTime(
        allPrimary,
        completedSecondary,
        chunkFromSec,
        2
      );
      const chunkL1 = l1Index
        ? resolveL1ChapterTranslateContext({
            l1Index,
            chunkFromSec,
            chunkToSec,
            items,
            glossary: baseContext?.glossary ?? activeGlossary
          })
        : {};
      const chunkContext = baseContext
        ? {
            ...baseContext,
            ...chunkL1
          }
        : undefined;

      try {
        const translated = await translateTrackFn({
          items,
          targetLang,
          selectedSubtitleId: source.isAsrSource ? "asr" : selectedId,
          selectedSubtitleLang: source.isAsrSource ? undefined : selectedLang,
          trackLan,
          ...(source.isAsrSource
            ? {}
            : {
                ...(source.origin !== undefined ? { origin: source.origin } : {}),
                ...(source.kind !== undefined ? { kind: source.kind } : {}),
                ...(source.source !== undefined ? { source: source.source } : {})
              }),
          ...(providerResolution ? { providerResolution } : {}),
          fallbackToOriginal: false,
          chunkFromSec,
          chunkToSec,
          ...(l1Index ? { l1Index } : {}),
          ...(chunkContext
            ? { context: chunkContext }
            : {
                ...(chunkL1.chapterContext ? { chapterContext: chunkL1.chapterContext } : {}),
                ...(chunkL1.referenceEntities?.length
                  ? { referenceEntities: chunkL1.referenceEntities }
                  : {})
              }),
          ...(previousLines.length > 0 ? { previousLines } : {}),
          signal,
          onCueReady: (cue) => {
            if (isStale() || signal?.aborted) {
              return;
            }
            if ((primaryRevisionByChunk.get(chunkIndex) ?? 0) !== revisionAtStart) {
              return;
            }
            const text = String(cue.translation ?? "").trim();
            if (!text || !(cue.to > cue.from)) {
              return;
            }
            let cueMap = streamingCuesByChunk.get(chunkIndex);
            if (!cueMap) {
              cueMap = new Map<string, SubtitleBodyItem>();
              streamingCuesByChunk.set(chunkIndex, cueMap);
            }
            const cueItem: SubtitleBodyItem = {
              from: cue.from,
              to: cue.to,
              content: text
            };
            cueMap.set(`${cue.startIndex}:${cue.endIndex}`, cueItem);
            invalidateSecondaryCache();

            const previewBody = getDisplaySecondary().slice();
            if (previewBody.length > 0) {
              hasUnflushedStreamingCues = true;
              if (bvid && cid) {
                scheduleTranslatedTrackWrite({
                  bvid,
                  cid,
                  sourceTrackKey: sourceKey,
                  targetLang: canonicalTargetLang,
                  translationSig,
                  mode: protocolMode,
                  items: previewBody
                });
              }
              deps.onStreamingUpdate?.({ items: previewBody, cue: cueItem });
              void enqueuePersist(async () => {
                await acceptSecondarySubtitle({
                  body: previewBody,
                  subtitleId: slotId,
                  subtitleUrl: "",
                  runId
                });
                if (!isStale()) {
                  deps.onAfterStreamingAccept?.();
                }
              }).catch((err) => {
                warnUnlessStaleRun(
                  "[BILISCRIPT] failed to accept streaming secondary subtitle",
                  { bvid, cid, chunkIndex },
                  err
                );
              });
            }
          }
        });

        streamingCuesByChunk.delete(chunkIndex);
        invalidateSecondaryCache();
        if (isStale() || signal?.aborted) {
          return { status: "aborted", items: [] };
        }

        if ((primaryRevisionByChunk.get(chunkIndex) ?? 0) !== revisionAtStart) {
          return { status: "stale-revision", items: [] };
        }

        const usable = sortSubtitleItemsByFrom(
          (Array.isArray(translated?.translations) ? translated.translations : []).filter(isUsableSubtitleItem)
        );
        if (usable.length > 0) {
          completedSecondaryByChunk.set(chunkIndex, usable);
          invalidateSecondaryCache();
        }
        doneChunks.add(chunkIndex);

        const displayBody = getDisplaySecondary().slice();
        const completedBody = collectCompletedSecondary();
        const updatedRange = computeItemsRange(usable.length > 0 ? usable : items);
        if (usable.length > 0 || deps.onBeforePersistChunk) {
          await enqueuePersist(async () => {
            hasUnflushedStreamingCues = false;
            await deps.onBeforePersistChunk?.({ chunkIndex, displayBody, completedBody });
            if (isStale()) {
              return;
            }
            await persistSecondarySnapshot(
              displayBody,
              deps.saveCustomCache ? displayBody : completedBody
            );
            if (!isStale()) {
              deps.onAfterPersistChunk?.({
                chunkIndex,
                displayBody,
                completedBody,
                updatedRange
              });
            }
          });
        }

        return {
          status: "done",
          items: usable
        };
      } catch (err) {
        const hadStreamingForChunk = streamingCuesByChunk.has(chunkIndex);
        streamingCuesByChunk.delete(chunkIndex);
        invalidateSecondaryCache();
        if (hadStreamingForChunk && !isStale() && !signal?.aborted) {
          const rolledBack = getDisplaySecondary().slice();
          await enqueuePersist(async () => {
            if (bvid && cid) {
              if (rolledBack.length > 0) {
                scheduleTranslatedTrackWrite({
                  bvid,
                  cid,
                  sourceTrackKey: sourceKey,
                  targetLang: canonicalTargetLang,
                  translationSig,
                  mode: protocolMode,
                  items: [],
                  replaceRange: { from: chunkFromSec, to: chunkToSec }
                });
              } else {
                hasUnflushedStreamingCues = false;
                const saveResult = await saveTranslatedSubtitleTrack({
                  bvid,
                  cid,
                  sourceTrackKey: sourceKey,
                  targetLang: canonicalTargetLang,
                  translationSig,
                  mode: protocolMode,
                  items: [],
                  replaceRange: { from: chunkFromSec, to: chunkToSec }
                });
                if (saveResult && saveResult.ok === false) {
                  logWarn("[BILISCRIPT] failed to rollback translated subtitle cache", {
                    bvid,
                    cid,
                    chunkIndex,
                    error: saveResult.error
                  });
                }
              }
            }
            await acceptSecondarySubtitle({
              body: rolledBack,
              subtitleId: slotId,
              subtitleUrl: "",
              runId
            });
          }).catch((rollbackErr) => {
            warnUnlessStaleRun(
              "[BILISCRIPT] failed to rollback translated subtitle chunk",
              { bvid, cid, chunkIndex },
              rollbackErr
            );
          });
        }
        throw err;
      }
    },

    async persistCurrent(): Promise<void> {
      const displayBody = getDisplaySecondary().slice();
      const completedBody = collectCompletedSecondary();
      await enqueuePersist(async () => {
        hasUnflushedStreamingCues = false;
        await deps.onBeforePersistChunk?.({ chunkIndex: -1, displayBody, completedBody });
        if (isStale()) {
          return;
        }
        await persistSecondarySnapshot(
          displayBody,
          deps.saveCustomCache ? displayBody : completedBody
        );
        if (!isStale()) {
          deps.onAfterPersistChunk?.({
            chunkIndex: -1,
            displayBody,
            completedBody
          });
        }
      });
    },

    async flush(): Promise<void> {
      const snapItems = getDisplaySecondary().slice();
      const hadStreaming = hasUnflushedStreamingCues;
      hasUnflushedStreamingCues = false;

      await persistQueue.catch(() => {});
      const tasks: Promise<unknown>[] = [
        flushSubtitleCache(bvid && cid ? { bvid, cid } : undefined)
      ];
      if (hadStreaming && deps.saveCustomCache && legacyCacheKey && snapItems.length > 0) {
        tasks.push(Promise.resolve(deps.saveCustomCache(legacyCacheKey, snapItems)));
      }
      await Promise.allSettled(tasks);
    }
  };
}
