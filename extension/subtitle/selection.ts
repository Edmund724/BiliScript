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
  id_str?: string | number | null;
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
  // 排序键只比优先级：同优先级保持输入顺序（= 接口原顺序 = 播放器菜单顺序）。
  // 历史上同优先级还依次比 lanDoc 的字符串序（代码单元序，混合文字下不可读）、
  // 数字 id 升序，末尾再以 subtitleUrl 的 localeCompare 兜底；二级键在真实数据上
  // 把 8 条 ai-* 样本的「其余」段排成 ai-id / ai-es / ai-pt / ai-ar / ai-th / ai-ja
  // （research/01-track-shape.md），与接口原顺序、与播放器菜单都不同——三个二级键
  // 已按 Q8′ 一并去掉。
  // 已知副作用（接受）：视频只有非中英轨时 pickPreferredSubtitle 的 tracks[0]
  // 兜底从「字典序第一条」变为「接口第一条」，影响面为 0。
  // Array.prototype.sort 自 ES2019 起保证稳定，同优先级因此保持输入顺序。
  return [...(subtitles || [])].sort((a, b) => subtitlePriority(a) - subtitlePriority(b)) as SubtitleTrack[];
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

// ===== 来源标签（2026-09 用户决议，2026-10-04 收窄） =====
// 面板 meta 行的「字幕：来源（语言）」投影已按 2026-10-04 用户决议整条删除（不再
// 注明字幕来源）：人工上传 / B站 AI 识别 两支、语言归一与轨道身份判定一并退场，
// 此处只留本扩展 ASR 回退伪轨要用的来源串。平台名不进串：平台归设置页，串只回答
//「这段字幕是怎么来的」。
export const ASR_SUBTITLE_SOURCE = "自配平台转写";

// ASR 伪轨的来源串：生成时定型——语言档位只有发起转写那一刻知道，auto 档不附
// 语言（宁缺勿猜）。同一个串写进伪轨 lanDoc 与 selectedSubtitleLang，下载文件名
// 与 AI 上下文因此自动一致。
export function buildAsrSubtitleLabel(language: unknown): string {
  const lang = String(language ?? "").trim().toLowerCase();
  const doc = lang === "zh" ? "中文" : lang === "en" ? "英文" : "";
  return doc ? `${ASR_SUBTITLE_SOURCE}（${doc}）` : ASR_SUBTITLE_SOURCE;
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

// 轨道身份：id_str 优先。接口的 id 是 19 位 JSON 数字、> 2^53，JSON.parse 阶段
// 尾数已丢（2120476497172283392 → …400），id_str 是同一 id 的精确字符串；旧数据 /
// 其它来源无 id_str（缺失、null 或空串）时回落 id。身份两端（写 selected* 与
// 比 previousId）同源，故不引入新的不一致。
function mapRawSubtitleTrackId(item: RawSubtitleTrack): string {
  const idStr = item.id_str;
  if (idStr !== undefined && idStr !== null && String(idStr) !== "") {
    return String(idStr);
  }
  return item.id === undefined || item.id === null ? "" : String(item.id);
}

export function mapSubtitleTracks(subtitles: unknown[], source = "unknown"): SubtitleTrack[] {
  return (subtitles || []).map((item) => ({
    id: mapRawSubtitleTrackId(item as RawSubtitleTrack),
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
