import { state, clipState } from "../core/state.js";
import { formatLocalDate } from "../shared/utils.js";
import { logWarn } from "../shared/logging.js";
import { fetchHotComments } from "../bilibili/gateway.js";
import { normalizeChapters } from "./chapters.js";
import {
  buildMarkdown,
  buildSrt,
  buildTxt
} from "../notes/render.js";
import type { State } from "../core/state.js";

export interface ReadingSubtitleItem {
  index: number;
  from: number;
  to: number;
  content: string;
}

interface SubtitleBodyItemLike {
  from?: unknown;
  to?: unknown;
  content?: unknown;
}

interface ChapterItemLike {
  from?: unknown;
  to?: unknown;
  title?: string;
}

export function readVideoTitle(): string {
  const h1 = document.querySelector("h1.video-title");
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim();
  }

  const metaTitle = document.querySelector('meta[property="og:title"]');
  if (metaTitle?.getAttribute("content")) {
    return metaTitle.getAttribute("content")!.trim();
  }

  return document.title.replace(/_哔哩哔哩_bilibili/i, "").trim();
}

export function readVideoAuthor(): string {
  const owner = document.querySelector(".up-name");
  if (owner?.textContent?.trim()) {
    return owner.textContent.trim();
  }

  const author = document.querySelector('meta[name="author"]');
  return author?.getAttribute("content")?.trim() || "";
}

export function readUploadDate(): string {
  const publishNode = document.querySelector('meta[itemprop="uploadDate"]');
  if (publishNode?.getAttribute("content")) {
    return publishNode.getAttribute("content")!.trim();
  }

  const dateText = document.querySelector(".pubdate-ip-text")?.textContent?.trim();
  if (dateText) {
    return dateText;
  }

  return formatLocalDate();
}

// 视频简介读取：与 readVideoTitle/readVideoAuthor/readUploadDate 同址
//（arch-slim-2/03 自 subtitle/ui.js 归位——它与其他 DOM 读取同族，原放在链层
// 交互文件里纯属错位；唯一消费方是 fetcher 的 refreshClip）。
export function readVideoDescription(): string {
  const descNode = document.querySelector(
    ".desc-info-text, .video-desc .desc-info-text, .video-info-detail .text, .basic-desc-info"
  );
  return descNode?.textContent?.trim() || "";
}

// 归一化结果按「body 数组引用」缓存（WeakMap，照 chapters.ts normalizeChapters
// 先例）：sync tick / 搜索 / 渲染每拍都拿同一 state.clip.subtitleBody 引用重复做
// map→filter 新建数组，引用相同即零分配复用。前提：写路径一律经
// clipState.setSubtitleBody(新数组) 整体替换引用，不原地修改。
const readingSubtitleItemsCache = new WeakMap<object, ReadingSubtitleItem[]>();

export function getReadingSubtitleItems(body: SubtitleBodyItemLike[] = state.clip.subtitleBody): ReadingSubtitleItem[] {
  if (Array.isArray(body)) {
    const cached = readingSubtitleItemsCache.get(body);
    if (cached) {
      return cached;
    }
    const items = buildReadingSubtitleItems(body);
    readingSubtitleItemsCache.set(body, items);
    return items;
  }
  return buildReadingSubtitleItems([]);
}

function buildReadingSubtitleItems(body: SubtitleBodyItemLike[]): ReadingSubtitleItem[] {
  return body
    .map((item, index) => ({
      index,
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0,
      content: String(item?.content || "").trim()
    }))
    .filter((item) => item.content);
}

export function getReadingSubtitlePlaceholderText(): string {
  if (state.clip.subtitleFetchState === "loading") {
    return "正在加载字幕...";
  }
  if (state.clip.subtitleFetchState === "error") {
    return "字幕加载失败，请刷新重试。";
  }
  return "当前视频无字幕。";
}

// 候选10 批1：二分命中回扫上限。写入端已保证 subtitleBody 按 from 升序
// （字幕接受事务 subtitle/commit.js 落 state 前统一经 sortSubtitleBodyByFrom
// 稳定排序），
// 正常顺序字幕区间互不重叠，二分候选点（最后一个 from <= currentTime 的条目）
// 就是唯一可能命中者，第一步即返回或即无命中。回扫只为兼容写入端排序前遗留
// 的重叠区间脏缓存，上限之外的深层重叠本就不会出现在正常数据里。
const ACTIVE_SUBTITLE_BACKWARD_SCAN_LIMIT = 8;

// to 缺省/非法时视为 from + 2（与旧线性扫描逐字一致）。
function subtitleActiveRange(item: SubtitleBodyItemLike): { from: number; to: number } {
  const from = Number(item?.from || 0) || 0;
  const rawTo = Number(item?.to || 0) || 0;
  return { from, to: rawTo > from ? rawTo : from + 2 };
}

export function findActiveSubtitleIndex(currentTime: number): number {
  const items = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  // 二分定位最后一个 from <= currentTime 的条目（subtitleBody 按 from 升序，
  // 由写入端 sortSubtitleBodyByFrom 保证）。旧实现为线性扫描，长视频 1500+
  // 条时每拍 250ms 全量扫一遍，是阅读视图常驻开销的大头之一。
  let lo = 0;
  let hi = items.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((Number(items[mid]?.from || 0) || 0) <= currentTime) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) {
    return -1;
  }
  for (let i = candidate, scanned = 0; i >= 0 && scanned <= ACTIVE_SUBTITLE_BACKWARD_SCAN_LIMIT; i -= 1, scanned += 1) {
    const { from, to } = subtitleActiveRange(items[i]);
    if (currentTime >= from && currentTime < to) {
      return i;
    }
  }
  return -1;
}

export function findActiveChapterIndex(currentTime: number): number {
  const chapters = normalizeChapters(state.clip.chapters || []);
  for (let index = 0; index < chapters.length; index += 1) {
    const item = chapters[index];
    const from = Number(item?.from || 0) || 0;
    const next = chapters[index + 1];
    const explicitTo = Number(item?.to || 0) || 0;
    const fallbackTo = next && Number(next.from) > from ? Number(next.from) : explicitTo;
    const to = fallbackTo > from ? fallbackTo : Number.POSITIVE_INFINITY;
    if (currentTime >= from && currentTime < to) {
      return index;
    }
  }
  return -1;
}

export function rebuildDerivedContent(): void {
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  clipState.setMarkdown(body.length ? buildMarkdown(state as State, body, state.settings) : "");
  clipState.setSrt(body.length ? buildSrt(body) : "");
  clipState.setTxt(body.length ? buildTxt(body, state.settings) : "");
}

// ===== 派生内容懒生成（opt-backlog-2026-09/04）=====
// 落账（字幕接受事务）只存原始字幕体 + 拉热评，markdown/SRT/TXT 三份全文派生
// 内容推迟到首次消费（复制/导出/快照）时生成并缓存：构建各做一遍全文遍历 +
// 大字符串拼接，原先挡在 subtitle-ready 通知前、推迟阅读列表首屏。缓存输入
// 指纹取构建读取投影的超集——引用字段（body/settings/chapters）按引用比对
// （生产写路径经 setters 整体替换引用），标量元信息按值比对。笔记导出删除后
// buildMarkdown 只读 简介/章节/字幕 三段，location.href、created、hotComments
// 等已不再是读取项，指纹仍留作超集（多重建一次无害，收窄另立工单）；任何输入
// 变化即重建，消费产物与逐次重建逐字节一致，字幕更新后不会拿到旧派生。
interface DerivedContentCacheEntry {
  body: unknown;
  settings: unknown;
  chapters: unknown;
  hotComments: unknown;
  href: string;
  created: string;
  bvid: string;
  aid: string;
  cid: string;
  title: string;
  author: string;
  uploadDate: string;
  description: string;
  selectedSubtitleLang: string;
  videoDuration: number;
}

// 标量指纹字段单表：capture 与 validate 共用，避免两处清单漂移。
const DERIVED_SCALAR_FIELDS = [
  "bvid",
  "aid",
  "cid",
  "title",
  "author",
  "uploadDate",
  "description",
  "selectedSubtitleLang",
  "videoDuration"
] as const;

let derivedContentCache: DerivedContentCacheEntry | null = null;

function currentHref(): string {
  return typeof location !== "undefined" ? location.href : "";
}

function captureDerivedContentInputs(): DerivedContentCacheEntry {
  const clip = state.clip;
  const entry = {} as Record<(typeof DERIVED_SCALAR_FIELDS)[number], string | number>;
  for (const key of DERIVED_SCALAR_FIELDS) {
    entry[key] = clip[key] as string | number;
  }
  return {
    body: clip.subtitleBody,
    settings: state.settings,
    chapters: clip.chapters,
    hotComments: clip.hotComments,
    href: currentHref(),
    created: formatLocalDate(),
    ...(entry as Omit<DerivedContentCacheEntry, "body" | "settings" | "chapters" | "hotComments" | "href" | "created">)
  };
}

function isDerivedContentCacheValid(): boolean {
  const cached = derivedContentCache;
  if (!cached) {
    return false;
  }
  const clip = state.clip;
  if (
    cached.body !== clip.subtitleBody ||
    cached.settings !== state.settings ||
    cached.chapters !== clip.chapters ||
    cached.hotComments !== clip.hotComments ||
    cached.href !== currentHref() ||
    cached.created !== formatLocalDate()
  ) {
    return false;
  }
  return DERIVED_SCALAR_FIELDS.every((key) => cached[key] === clip[key]);
}

// 派生内容首次消费入口：缓存命中即零开销返回，未命中重建三份并落 state。
// 消费点（复制/导出/快照）调用本函数取代原先的消费前无条件重建双保险。
export function ensureDerivedContent(): void {
  if (isDerivedContentCacheValid()) {
    return;
  }
  rebuildDerivedContent();
  derivedContentCache = captureDerivedContentInputs();
}

// 热评拉取（自 refreshDerivedContent 拆出，opt-backlog-2026-09/04）：原是派生
// 刷新的一部分，但热评消费方不止笔记渲染（overview 分析/context 装配），且落账
// 后阅读视图即依赖它呈现——留在字幕接受事务内。派生三件套不再随本调用构建。
// 笔记导出删除后不再有 includeHotCommentsInNote 设置门：热评的消费方（概览 /
// AI 上下文）与导出无关，落账后一律按需补拉。
export async function refreshHotComments({ refreshComments = false } = {}): Promise<void> {
  const shouldFetchComments =
    refreshComments || !Array.isArray(state.clip.hotComments) || state.clip.hotComments.length === 0;
  if (shouldFetchComments) {
    try {
      clipState.setHotComments(await fetchHotComments(20));
    } catch (error) {
      clipState.setHotComments([]);
      logWarn("[BILISCRIPT] failed to fetch hot comments", error);
    }
  }
}

// 消费侧（复制 Markdown）的完整刷新：热评按需补拉 + 派生内容懒生成。
export async function refreshDerivedContent({ refreshComments = false } = {}): Promise<void> {
  await refreshHotComments({ refreshComments });
  ensureDerivedContent();
}
