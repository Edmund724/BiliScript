// B 站原生载荷 → 本仓领域类型的映射叶（架构评审「轨道身份：selection.ts 按概念拆位」，
// 自 subtitle/selection.ts 逐字搬出，零逻辑改动）。
//
// 存在理由：SubtitleTrack / Chapter 的声明在本层的 gateway.ts，而把原生载荷
//（x/player/v2 的 subtitle.subtitles、播放器数据的 view_points）译成这两个类型的映射
// 原先住在消费侧的 subtitle/selection.ts——gateway 为拿映射而反向 import selection，
// 一条只为映射存在的边（评审 Problem：「一条轨的身份从哪来」要跳 gateway →
// selection → cache 三处）。映射随类型归位后，selection 只留「哪条轨被选中」。
//
// subtitleUrl 的两套归一也收口在此（原先分居 selection.ts 与 subtitle/cache.ts，
// 评审 Problem 的「同一 subtitleUrl 字段有两套归一」）：
//   - normalizeSubtitleUrl：原生 subtitle_url → 可装载的绝对地址；
//   - normalizeSubtitleUrlForCache：同一字段 → 缓存键分量（cache.buildSubtitleSourceKey
//     与 selection.pickPreferredSubtitle 的 URL 复用同吃这一格）。
// 两者算法不同（一个补协议、一个削成 hostname + 净化 path），不构成互相表达的关系，
// 故各自保留原实现——但只住这一处：cache.ts 与 selection.ts 都 import 这里的那一份。
//
// 叶子纪律：只 import subtitle/chapters 的归一叶与 gateway 的类型（type-only，编译期
// 擦除）。subtitle/cache 要 import 本叶拿缓存键分量，故本叶不得把 gateway.ts 的
// state/video-probe/messaging 闭包拖进它的静态图（arch-slim-2/04 的 SW 静态图纪律）。

import { normalizeChapters } from "../subtitle/chapters.js";
import type { Chapter, SubtitleTrack } from "./gateway.js";

// 单条轨的宽松输入形状：原生载荷是 lan / lan_doc / subtitle_url 的 snake_case，已映射
// 的轨是 lanDoc / subtitleUrl 的 camelCase——两个写方都喂给 selection 的排序与选轨
// 函数，故形状同时覆盖两种拼写。
export interface RawSubtitleTrack {
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

// 原 subtitle/cache.ts 的「第二套归一」（逐字搬来；cache.ts 改为 import 本实现）：
// 同一 subtitle_url 字段削成缓存键分量——hostname + 净化后的 path，query 不进键，
// auth_key 等动态参数因此不影响复用。
export function normalizeSubtitleUrlForCache(url: unknown): string {
  const text = String(url || "").trim();
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    const path = parsed.pathname.replace(/[^\w/.-]+/g, "_");
    return `${parsed.hostname}${path}`;
  } catch {
    return text.replace(/[^\w/.-]+/g, "_");
  }
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
