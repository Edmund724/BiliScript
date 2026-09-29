import { normalizeSubtitleUrlForCache } from "./cache.js";
import { normalizeChapters } from "./chapters.js";
import type { Chapter, SubtitleTrack } from "../bilibili/gateway.js";

export interface PreferredSubtitleContext {
  previousId?: string;
  previousUrl?: string;
  previousLang?: string;
}

export interface DurationValidationResult {
  ok: boolean;
  reason: string;
  videoDuration: number;
  maxTo: number;
}

interface RawSubtitleTrack {
  id?: string | number | null;
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
  subtitleUrl?: string;
  lanDoc?: string;
}

interface RawChapterPoint {
  content?: string;
  title?: string;
  label?: string;
  from?: number | string;
  start?: number | string;
  start_time?: number | string;
  to?: number | string;
  end?: number | string;
  end_time?: number | string;
}

interface RawPlayerData {
  view_points?: RawChapterPoint[];
}

function subtitlePriority(item: SubtitleTrack | RawSubtitleTrack): number {
  const lan = String(item?.lan || "").toLowerCase();
  const label = String((item as { lanDoc?: string }).lanDoc || "").toLowerCase();

  // 优先级：中文（包含 AI 中文）-> 英文 -> 其他
  if (lan === "zh-cn" || lan === "zh-hans") {
    return 0;
  }
  if (lan === "zh") {
    return 1;
  }
  if (lan.includes("zh")) {
    return 2;
  }
  if (label.includes("中文")) {
    return 3;
  }

  if (lan === "en" || lan === "en-us" || lan === "en-gb") {
    return 10;
  }
  if (lan.includes("en")) {
    return 11;
  }
  if (label.includes("英文") || label.includes("英语") || label.includes("english")) {
    return 12;
  }

  return 50;
}

export function normalizeSubtitleTracks(subtitles?: SubtitleTrack[] | RawSubtitleTrack[] | null): SubtitleTrack[] {
  return [...(subtitles || [])].sort((a, b) => {
    const p = subtitlePriority(a) - subtitlePriority(b);
    if (p !== 0) {
      return p;
    }

    const lanA = String((a as { lanDoc?: string }).lanDoc || a.lan || "").toLowerCase();
    const lanB = String((b as { lanDoc?: string }).lanDoc || b.lan || "").toLowerCase();
    if (lanA < lanB) {
      return -1;
    }
    if (lanA > lanB) {
      return 1;
    }

    const idA = Number.parseInt(String(a.id || "0"), 10);
    const idB = Number.parseInt(String(b.id || "0"), 10);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) {
      return idA - idB;
    }

    return String((a as { subtitleUrl?: string }).subtitleUrl).localeCompare(String((b as { subtitleUrl?: string }).subtitleUrl));
  }) as SubtitleTrack[];
}

export function pickPreferredSubtitle(
  subtitles: SubtitleTrack[] | RawSubtitleTrack[] | null | undefined,
  { previousId = "", previousUrl = "", previousLang = "" }: PreferredSubtitleContext = {}
): SubtitleTrack | null {
  const tracks = subtitles || [];
  if (tracks.length === 0) {
    return null;
  }

  // 先按轨道 id 复用，最稳定
  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId as SubtitleTrack;
    }
  }

  // 其次按 URL 路径复用（忽略 auth_key 等动态参数）
  const prevUrlKey = normalizeSubtitleUrlForCache(previousUrl);
  if (prevUrlKey) {
    const byUrl = tracks.find(
      (item) => normalizeSubtitleUrlForCache((item as { subtitleUrl?: string }).subtitleUrl) === prevUrlKey
    );
    if (byUrl) {
      return byUrl as SubtitleTrack;
    }
  }

  const normalizedPrevLang = String(previousLang || "").trim().toLowerCase();
  if (normalizedPrevLang) {
    const byLang = tracks.find((item) => {
      const label = String((item as { lanDoc?: string }).lanDoc || item.lan || "").trim().toLowerCase();
      return label === normalizedPrevLang;
    });
    if (byLang) {
      return byLang as SubtitleTrack;
    }
  }

  // 默认直接拿排序后的第一条：中文优先，其次英文。
  return tracks[0] as SubtitleTrack;
}

export function validateSubtitleByDuration(body: unknown[], videoDuration: unknown): DurationValidationResult {
  const duration = Number(videoDuration || 0);
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: "empty", videoDuration: duration, maxTo: 0 };
  }

  let maxTo = 0;
  for (const item of body) {
    const to = Number((item as { to?: unknown }).to);
    const from = Number((item as { from?: unknown }).from);
    if (Number.isFinite(to) && to > maxTo) {
      maxTo = to;
    }
    if (Number.isFinite(from) && from > maxTo) {
      maxTo = from;
    }
  }

  if (!(duration > 0)) {
    return { ok: true, reason: "skip-no-video-duration", videoDuration: duration, maxTo };
  }

  const upperTolerance = Math.max(12, duration * 0.15);
  if (maxTo > duration + upperTolerance) {
    return { ok: false, reason: "too-long", videoDuration: duration, maxTo };
  }

  let minCoverageRatio = 0;
  if (duration >= 600) {
    minCoverageRatio = 0.18;
  } else if (duration >= 300) {
    minCoverageRatio = 0.22;
  } else if (duration >= 180) {
    minCoverageRatio = 0.25;
  }

  if (minCoverageRatio > 0 && maxTo < duration * minCoverageRatio) {
    return { ok: false, reason: "too-short", videoDuration: duration, maxTo };
  }

  return { ok: true, reason: "ok", videoDuration: duration, maxTo };
}

export function isAiSubtitle(item: { lan?: string } | null | undefined): boolean {
  const lan = String(item?.lan || "").toLowerCase();
  // B站 AI 自动字幕的 lan 以 "ai-" 开头
  return lan.startsWith("ai-");
}

export function isAsrSubtitle(item: { lan?: string } | null | undefined): boolean {
  const lan = String(item?.lan || "").toLowerCase();
  // 本扩展 ASR 回退的伪轨 lan 以 "asr-" 开头（asr/fallback.js 写入）
  return lan.startsWith("asr-");
}

// ===== 来源/语言标签（2026-09 用户决议：三种来源说同一套词） =====
// 人工上传（非 ai- 前缀的 B站 轨：UP 主上传或观众投稿的 CC 字幕） /
// B站 AI 识别（lan 前缀 ai-）/ 自配平台转写（本扩展 ASR 回退的伪轨）。
// 平台名不进任何字幕标签：平台归设置页，标签只回答「这段字幕是怎么来的」。
export const ASR_SUBTITLE_SOURCE = "自配平台转写";

const AI_LANGUAGE_TAIL = /[（(]\s*ai\s*(?:生成|识别)?\s*[）)]|[（(]\s*自动生成\s*[）)]/gi;

// 语言归一：B站 AI 轨的 lanDoc 自带「（自动生成）」这类机器尾巴，与来源标签
// 里的 AI 语义重复，剥掉后语言才是纯语言（「中文（简体）」等真实尾巴不动）。
export function normalizeSubtitleLanguageLabel(value: unknown): string {
  return String(value ?? "").replace(AI_LANGUAGE_TAIL, "").trim();
}

// ASR 伪轨的来源串：生成时定型——语言档位只有发起转写那一刻知道，auto 档不附
// 语言（宁缺勿猜）。同一个串写进伪轨 lanDoc 与 selectedSubtitleLang，meta 行、
// 下拉、下载文件名、AI 上下文因此自动一致。
export function buildAsrSubtitleLabel(language: unknown): string {
  const lang = String(language ?? "").trim().toLowerCase();
  const doc = lang === "zh" ? "中文" : lang === "en" ? "英文" : "";
  return doc ? `${ASR_SUBTITLE_SOURCE}（${doc}）` : ASR_SUBTITLE_SOURCE;
}

// meta 行「字幕：」值 = 来源（语言）。ASR 伪轨的 lanDoc 自产即显示串，原样采用；
// 轨道缺失（分类不了，如 ASR 缓存命中未塞伪轨）退回归一后的原始语言值，不编来源。
export function buildSubtitleSourceLabel(
  item: { id?: string | number | null; lan?: string; lanDoc?: string } | null | undefined,
  fallbackLang = ""
): string {
  if (!item) {
    return normalizeSubtitleLanguageLabel(fallbackLang);
  }
  if (isAsrSubtitle(item)) {
    return String(item.lanDoc || "").trim() || ASR_SUBTITLE_SOURCE;
  }
  const lang = normalizeSubtitleLanguageLabel(item.lanDoc || item.lan || "");
  const source = isAiSubtitle(item) ? "B站 AI 识别" : "人工上传";
  return lang ? `${source}（${lang}）` : source;
}

export interface SubtitleOptionView {
  id: string;
  url: string | undefined;
  // lang 是原始语言值（接口 lanDoc||lan||"unknown"）：写回 state 用（data-lang），
  // 保持接口原文；label 是下拉显示的语言名（AI 尾巴已归一）；sourceLabel 是
  // meta 行「字幕：」值（来源 + 语言）。
  lang: string;
  label: string;
  sourceLabel: string;
  isAi: boolean;
  selected: boolean;
}

// 字幕轨 option 视图模型的唯一投影（arch-slim-3/riders R2；2026-09/10 起含
// 来源/语言标签）：lang 即写回 state 的原始值，label 供下拉显示（isAi 标 [AI]），
// sourceLabel 供 meta 行「字幕：」值取用，选中态按 id（弱比较）或 URL 精确匹配。
// reader/lifecycle 的 select HTML 与 meta 行共用本模型，不各抄一份投影。
export function buildSubtitleOptionViews(
  subtitles: SubtitleTrack[] | RawSubtitleTrack[] | null | undefined,
  selectedSubtitleId?: string,
  selectedSubtitleUrl?: string
): SubtitleOptionView[] {
  return (subtitles || []).map((item) => {
    const lang = item.lanDoc || item.lan || "unknown";
    const isAi = isAiSubtitle(item);
    const selectedById = selectedSubtitleId && String(item.id || "") === String(selectedSubtitleId);
    const selectedByUrl = item.subtitleUrl === selectedSubtitleUrl;
    return {
      id: String(item.id || ""),
      url: item.subtitleUrl,
      lang,
      label: normalizeSubtitleLanguageLabel(lang),
      sourceLabel: buildSubtitleSourceLabel(item, lang),
      isAi,
      selected: Boolean(selectedById || selectedByUrl)
    };
  });
}

// 候选10 批1：写入端统一保证 subtitleBody 按 from 升序（稳定排序，同 from
// 保持原有相对顺序，与读路径旧线性扫描的命中顺序一致）。core.js 的
// findActiveSubtitleIndex 二分查找依赖该不变量；读路径一律不排序。
// 唯一写入点为字幕接受事务（subtitle/commit.js acceptSubtitle）；缓存写入前
// 的调用方预备排序（fetcher 网络路径落缓存）是仅有的例外。
// 返回新数组，不原地修改入参（调用方持有的原引用保持不变）。
export function sortSubtitleBodyByFrom<T>(body: T[] | null | undefined): T[] | null | undefined {
  if (!Array.isArray(body)) {
    return body;
  }
  return [...body].sort(
    (a, b) => (Number((a as { from?: unknown }).from || 0) || 0) - (Number((b as { from?: unknown }).from || 0) || 0)
  );
}

function normalizeSubtitleUrl(url: unknown): string {
  if (!url) {
    return "";
  }

  const text = String(url);
  if (text.startsWith("//")) {
    return `https:${text}`;
  }

  if (text.startsWith("http://") || text.startsWith("https://")) {
    return text;
  }

  return `https://${text.replace(/^\/+/, "")}`;
}

export function mapSubtitleTracks(subtitles: unknown[], source = "unknown"): SubtitleTrack[] {
  return (subtitles || []).map((item) => ({
    id: (item as RawSubtitleTrack).id === undefined || (item as RawSubtitleTrack).id === null ? "" : String((item as RawSubtitleTrack).id),
    lan: (item as RawSubtitleTrack).lan || "",
    lanDoc: (item as RawSubtitleTrack).lan_doc || "",
    subtitleUrl: normalizeSubtitleUrl((item as RawSubtitleTrack).subtitle_url || ""),
    source
  }));
}

export function mapChaptersFromPlayerData(data: RawPlayerData | unknown): Chapter[] {
  const viewPoints = (data as RawPlayerData)?.view_points;
  const raw = Array.isArray(viewPoints) ? viewPoints : [];
  return normalizeChapters(
    raw.map((item) => ({
      title: String(item?.content || item?.title || item?.label || "").trim(),
      from: normalizeChapterTime(item?.from ?? item?.start ?? item?.start_time),
      to: normalizeChapterTime(item?.to ?? item?.end ?? item?.end_time),
      source: "player-view-points"
    }))
  );
}

function normalizeChapterTime(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }

  // 某些接口会返回毫秒级时间戳，这里统一转换成秒。
  return num > 60 * 60 * 24 ? num / 1000 : num;
}
