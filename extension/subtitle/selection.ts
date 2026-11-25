import { normalizeSubtitleUrlForCache } from "../bilibili/native-payload.js";
import type { SubtitleTrack, SubtitleTrackOrigin } from "../bilibili/gateway.js";
import { getSiteCapabilities, type SiteId } from "../shared/site.js";
export type { SubtitleTrackOrigin } from "../bilibili/gateway.js";
import {
  LIVE_INTERPRET_TARGET_BCP47,
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";

const LANG_FAMILY_ALIASES: Record<string, string> = {
  zh: "zh",
  zho: "zh",
  chi: "zh",
  cmn: "zh",
  yue: "zh",
  wuu: "zh",
  nan: "zh",
  hak: "zh",
  en: "en",
  eng: "en",
  ja: "ja",
  jp: "ja",
  jpn: "ja",
  ko: "ko",
  kor: "ko",
  de: "de",
  deu: "de",
  ger: "de",
  fr: "fr",
  fra: "fr",
  fre: "fr",
  es: "es",
  spa: "es",
  ru: "ru",
  rus: "ru",
  it: "it",
  ita: "it",
  pt: "pt",
  por: "pt",
  tr: "tr",
  tur: "tr",
  el: "el",
  ell: "el",
  gre: "el",
  id: "id",
  ind: "id",
  in: "id",
  ms: "ms",
  msa: "ms",
  may: "ms"
};

export function getLangFamily(lan: unknown): string {
  const cleaned = String(lan || "")
    .trim()
    .toLowerCase()
    .replace(/^(ai|asr)[-_]/, "");
  if (!cleaned || cleaned === "auto" || cleaned === "unknown") {
    return "";
  }
  const primary = cleaned.split(/[-_]/)[0] || "";
  if (!primary) {
    return "";
  }
  return Object.prototype.hasOwnProperty.call(LANG_FAMILY_ALIASES, primary)
    ? LANG_FAMILY_ALIASES[primary]
    : primary;
}

export function isSameLangFamily(lanA: unknown, lanB: unknown): boolean {
  const familyA = getLangFamily(lanA);
  const familyB = getLangFamily(lanB);
  return Boolean(familyA && familyB && familyA === familyB);
}

export const ASR_SUBTITLE_TRACK_ID = "asr";

export type SubtitleTrackKind = "manual-cc" | "bili-ai" | "youtube-auto" | "asr";

export interface SubtitleTrackOriginLike {
  id?: unknown;
  lan?: unknown;
  subtitleUrl?: unknown;
  source?: unknown;
  origin?: unknown;
  kind?: unknown;
  site?: unknown;
}

export function createAsrPseudoTrack(
  sourceLabel: string,
  lan: string = "asr-zh"
): SubtitleTrack {
  return {
    id: ASR_SUBTITLE_TRACK_ID,
    lan,
    lanDoc: sourceLabel,
    subtitleUrl: "",
    source: "asr",
    origin: "asr"
  };
}

export function resolveSubtitleTrackOrigin(
  track: SubtitleTrackOriginLike | null | undefined
): SubtitleTrackOrigin {
  const explicit = String(track?.origin ?? "").trim().toLowerCase();
  if (explicit === "asr" || explicit === "bilibili" || explicit === "youtube") {
    return explicit;
  }
  const site = String(track?.site ?? "").trim().toLowerCase();
  if (site === "youtube") {
    return "youtube";
  }
  const source = String(track?.source ?? "").trim().toLowerCase();
  if (source === "asr") {
    return "asr";
  }
  if (source === "youtube-auto" || source === "youtube-cc" || source === "youtube") {
    return "youtube";
  }
  const id = String(track?.id ?? "").trim();
  const lan = String(track?.lan ?? "").trim().toLowerCase();
  if (id === ASR_SUBTITLE_TRACK_ID || lan === "asr" || lan.startsWith("asr-")) {
    return "asr";
  }
  if (id.startsWith("yt-auto-") || id.startsWith("yt-cc-")) {
    return "youtube";
  }
  const url = String(track?.subtitleUrl ?? "").trim().toLowerCase();
  if (url.startsWith("https://www.youtube.com/") || url.startsWith("https://youtube.com/")) {
    return "youtube";
  }
  return "bilibili";
}

export function isAsrSubtitleTrack(
  track: SubtitleTrackOriginLike | null | undefined
): boolean {
  return resolveSubtitleTrackOrigin(track) === "asr";
}

export function upsertAsrPseudoTrack<T extends SubtitleTrackOriginLike>(
  tracks: readonly T[] | null | undefined,
  asrTrack: T
): T[] {
  const list = [...(tracks || [])];
  const existingIndex = list.findIndex((item) => isAsrSubtitleTrack(item));
  if (existingIndex === -1) {
    return [asrTrack, ...list];
  }
  const deduped: T[] = [];
  for (let i = 0; i < list.length; i += 1) {
    if (i === existingIndex) {
      deduped.push(asrTrack);
      continue;
    }
    if (!isAsrSubtitleTrack(list[i])) {
      deduped.push(list[i]);
    }
  }
  return deduped;
}

export function classifySubtitleTrack(
  track: SubtitleTrackOriginLike | null | undefined
): SubtitleTrackKind {
  if (isAsrSubtitleTrack(track)) {
    return "asr";
  }
  const origin = resolveSubtitleTrackOrigin(track);
  const kind = String(track?.kind ?? "").trim().toLowerCase();
  const source = String(track?.source ?? "").trim().toLowerCase();
  const id = String(track?.id ?? "").trim().toLowerCase();
  if (
    source === "youtube-auto" ||
    (origin === "youtube" && (kind === "asr" || id.startsWith("yt-auto-") || id.startsWith("youtube-auto")))
  ) {
    return "youtube-auto";
  }
  const lan = String(track?.lan ?? "").trim().toLowerCase();
  if (lan.startsWith("ai-")) {
    return "bili-ai";
  }
  return "manual-cc";
}

export function isPlatformAutoTrack(
  track: SubtitleTrackOriginLike | null | undefined
): boolean {
  const kind = classifySubtitleTrack(track);
  return kind === "bili-ai" || kind === "youtube-auto";
}

export function isLoadableNativeTrack(
  track: SubtitleTrackOriginLike | null | undefined
): boolean {
  const origin = resolveSubtitleTrackOrigin(track);
  return (
    (origin === "bilibili" || origin === "youtube") &&
    String(track?.subtitleUrl ?? "").trim().length > 0
  );
}

export function isMonolingualNativeTracks(
  tracks: readonly { id?: unknown; lan?: unknown; subtitleUrl?: unknown }[] | null | undefined
): boolean {
  const nativeTracks = (tracks || []).filter(isLoadableNativeTrack);
  if (nativeTracks.length === 0) {
    return false;
  }
  const families = new Set<string>();
  for (const track of nativeTracks) {
    const family = getLangFamily(track.lan);
    if (family) {
      families.add(family);
    }
  }
  return families.size <= 1;
}

export function canUseNativeBilingualPair(
  tracks: readonly SubtitleTrackOriginLike[] | null | undefined,
  site?: SiteId
): boolean {
  if (site && !getSiteCapabilities(site).supportsNativeBilingualPair) {
    return false;
  }
  const nativeTracks = (tracks || []).filter(isLoadableNativeTrack);
  if (nativeTracks.length < 2) {
    return false;
  }
  if (!site && nativeTracks.every((track) => resolveSubtitleTrackOrigin(track) === "youtube")) {
    return false;
  }
  return !isMonolingualNativeTracks(nativeTracks);
}

export function hasCrossLangManualTracks(
  tracks: readonly { id?: unknown; lan?: unknown; subtitleUrl?: unknown }[] | null | undefined
): boolean {
  const manualTracks = (tracks || []).filter(
    (track) => isLoadableNativeTrack(track) && classifySubtitleTrack(track) === "manual-cc"
  );
  const families = new Set(manualTracks.map((track) => getLangFamily(track.lan)).filter(Boolean));
  return families.size >= 2;
}

export function findManualForeignTrackForAiRefine<
  T extends { id?: string; lan?: string; lanDoc?: string; subtitleUrl?: string }
>(tracks: readonly T[] | null | undefined): T | null {
  const nativeTracks = (tracks || []).filter(isLoadableNativeTrack);
  const hasManualZh = nativeTracks.some(
    (track) => classifySubtitleTrack(track) === "manual-cc" && getLangFamily(track.lan) === "zh"
  );
  if (hasManualZh) {
    return null;
  }
  const hasAiZh = nativeTracks.some(
    (track) => isPlatformAutoTrack(track) && getLangFamily(track.lan) === "zh"
  );
  if (!hasAiZh) {
    return null;
  }
  return (
    nativeTracks.find(
      (track) => classifySubtitleTrack(track) === "manual-cc" && getLangFamily(track.lan) !== "zh"
    ) ?? null
  );
}

export function parseInterpretTargetLang(value: unknown): LiveInterpretTargetLang | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const exact = LIVE_INTERPRET_TARGET_LANG_OPTIONS.find(
    (option) => option.value === raw.toLowerCase()
  );
  if (exact) {
    return exact.value;
  }
  const family = getLangFamily(raw);
  if (!family) {
    return null;
  }
  return LIVE_INTERPRET_TARGET_LANG_OPTIONS.find((option) => option.value === family)?.value ?? null;
}

export function toCanonicalTargetLangBcp47(targetLang: unknown): string {
  const parsed = parseInterpretTargetLang(targetLang);
  if (parsed) {
    return LIVE_INTERPRET_TARGET_BCP47[parsed];
  }
  return String(targetLang ?? "").trim() || "zh-CN";
}

export function getAvailableTargetLangOptions(
  sourceLan: unknown
): ReadonlyArray<(typeof LIVE_INTERPRET_TARGET_LANG_OPTIONS)[number]> {
  const sourceFamily = getLangFamily(sourceLan);
  if (!sourceFamily) {
    return LIVE_INTERPRET_TARGET_LANG_OPTIONS;
  }
  return LIVE_INTERPRET_TARGET_LANG_OPTIONS.filter(
    (option) => getLangFamily(option.value) !== sourceFamily
  );
}

export function resolveTargetLang(
  sourceLan: unknown,
  preferredTargetLan?: unknown
): LiveInterpretTargetLang {
  const sourceFamily = getLangFamily(sourceLan);
  const preferred = parseInterpretTargetLang(preferredTargetLan);
  if (preferred && (!sourceFamily || getLangFamily(preferred) !== sourceFamily)) {
    return preferred;
  }
  return sourceFamily === "zh" ? "en" : "zh";
}

export function resolveTargetLangBcp47(
  sourceLan: unknown,
  preferredTargetLan?: unknown
): string {
  return LIVE_INTERPRET_TARGET_BCP47[resolveTargetLang(sourceLan, preferredTargetLan)];
}

export interface PreferredSubtitleContext {
  previousId?: string;
  previousUrl?: string;
  previousLang?: string;
}

export interface SubtitleTrackTarget {
  id: string;
  url: string;
  lang: string;
  origin: SubtitleTrackOrigin;
}

export interface SubtitleTrackRef {
  id?: string;
  url?: string;
  subtitleUrl?: string;
  lang?: string;
  lan?: string;
  lanDoc?: string;
  source?: string;
  origin?: SubtitleTrackOrigin;
  kind?: string;
  site?: SiteId;
}

export function findTrackByRef<T extends { id?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  ref: { id?: string; url?: string; subtitleUrl?: string } | null | undefined
): T | null {
  const id = String(ref?.id || "");
  const url = String(ref?.url || ref?.subtitleUrl || "");
  return (
    (tracks || []).find(
      (track) => (!!id && String(track.id || "") === id) || (!!url && String(track.subtitleUrl || "") === url)
    ) ?? null
  );
}

export function resolveTrackTarget(
  trackOrRef: SubtitleTrackRef | null | undefined,
  tracks?: readonly { id?: string; subtitleUrl?: string; lan?: string; lanDoc?: string; source?: string; origin?: SubtitleTrackOrigin; kind?: string; site?: SiteId }[] | null
): SubtitleTrackTarget {
  const resolved = tracks ? (findTrackByRef(tracks, trackOrRef) ?? trackOrRef) : trackOrRef;
  return {
    id: String(resolved?.id || ""),
    url: String(resolved?.subtitleUrl || (resolved as SubtitleTrackRef | undefined)?.url || ""),
    lang: String(resolved?.lanDoc || resolved?.lan || (resolved as SubtitleTrackRef | undefined)?.lang || "unknown"),
    origin: resolveSubtitleTrackOrigin(resolved)
  };
}

export interface SubtitleTrackCandidate {
  id?: string;
  lan?: string;
  lanDoc?: string;
  subtitleUrl?: string;
  source?: string;
  origin?: SubtitleTrackOrigin;
  kind?: string;
  site?: SiteId;
}

function subtitlePriority(item: SubtitleTrackCandidate): number {
  const lan = String(item?.lan || "").toLowerCase();
  const label = String(item?.lanDoc || "").toLowerCase();
  const autoPenalty = isPlatformAutoTrack(item) ? 0.5 : 0;

  if (lan === "zh-cn" || lan === "zh-hans") {
    return 0 + autoPenalty;
  }
  if (lan === "zh") {
    return 1 + autoPenalty;
  }
  if (lan.includes("zh")) {
    return 2 + autoPenalty;
  }
  if (label.includes("中文")) {
    return 3 + autoPenalty;
  }

  if (lan === "en" || lan === "en-us" || lan === "en-gb") {
    return 10 + autoPenalty;
  }
  if (lan.includes("en")) {
    return 11 + autoPenalty;
  }
  if (label.includes("英文") || label.includes("英语") || label.includes("english")) {
    return 12 + autoPenalty;
  }

  return 50 + autoPenalty;
}

export function normalizeSubtitleTracks<TTrack extends SubtitleTrackCandidate = SubtitleTrack>(
  subtitles?: readonly TTrack[] | null
): TTrack[] {
  return [...(subtitles || [])].sort((a, b) => subtitlePriority(a) - subtitlePriority(b));
}

export function pickPreferredSubtitle<TTrack extends SubtitleTrackCandidate = SubtitleTrack>(
  subtitles: readonly TTrack[] | null | undefined,
  { previousId = "", previousUrl = "", previousLang = "" }: PreferredSubtitleContext = {}
): TTrack | null {
  const tracks = subtitles || [];
  if (tracks.length === 0) {
    return null;
  }

  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId;
    }
  }

  const prevUrlKey = normalizeSubtitleUrlForCache(previousUrl);
  if (prevUrlKey) {
    const byUrl = tracks.find(
      (item) => normalizeSubtitleUrlForCache(item.subtitleUrl) === prevUrlKey
    );
    if (byUrl) {
      return byUrl;
    }
  }

  const normalizedPrevLang = String(previousLang || "").trim().toLowerCase();
  if (normalizedPrevLang) {
    const byLang = tracks.find((item) => {
      const label = String(item.lanDoc || item.lan || "").trim().toLowerCase();
      return label === normalizedPrevLang;
    });
    if (byLang) {
      return byLang;
    }
  }

  return tracks[0];
}

export function subtitlePrimaryLangTag(lan: unknown): string {
  return getLangFamily(lan);
}

export function findTrackByPreferredLang<T extends { id?: string; lan?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  preference: unknown
): T | null {
  const wanted = String(preference || "")
    .trim()
    .toLowerCase();
  const target = getLangFamily(wanted);
  if (!target) {
    return null;
  }
  const loadable = (tracks || []).filter((track) => isLoadableNativeTrack(track));
  const exactManual = loadable.find(
    (track) =>
      classifySubtitleTrack(track) === "manual-cc" &&
      String(track.lan || "").trim().toLowerCase() === wanted
  );
  if (exactManual) {
    return exactManual;
  }
  const exactAny = loadable.find((track) => String(track.lan || "").trim().toLowerCase() === wanted);
  if (exactAny) {
    return exactAny;
  }
  const familyManual = loadable.find(
    (track) => classifySubtitleTrack(track) === "manual-cc" && getLangFamily(track.lan) === target
  );
  if (familyManual) {
    return familyManual;
  }
  return loadable.find((track) => getLangFamily(track.lan) === target) || null;
}

export function isMainSubtitleTrack(track: { id?: string } | null | undefined, mainTrackId: unknown): boolean {
  const id = String(track?.id || "");
  return !!id && id === String(mainTrackId || "");
}

export function findSecondaryTrackByPreferredLang<T extends { id?: string; lan?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  preference: unknown,
  mainTrackId: unknown
): T | null {
  const track = findTrackByPreferredLang(tracks, preference);
  if (!track || isMainSubtitleTrack(track, mainTrackId)) {
    return null;
  }
  const mainIdStr = String(mainTrackId || "");
  const mainTrack = mainIdStr
    ? (tracks || []).find((item) => String(item?.id || "") === mainIdStr) ?? null
    : null;
  if (mainTrack && isSameLangFamily(track.lan, mainTrack.lan)) {
    return null;
  }
  return track;
}

export function sortSubtitleBodyByFrom<T>(body: T[] | null | undefined): T[] | null | undefined {
  if (!Array.isArray(body)) {
    return body;
  }
  return [...body].sort(
    (a, b) => (Number((a as { from?: unknown }).from || 0) || 0) - (Number((b as { from?: unknown }).from || 0) || 0)
  );
}
