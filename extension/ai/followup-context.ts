// 「追问上下文」模块（05 票 + 06 票）：总结完成后继续追问时，不再每轮重发整篇原始字幕，
// 常驻上下文改为「压缩摘要（分段小结 + 成稿笔记）+ 近 N 轮 verbatim + 本轮问题」，
// 保证 token 随追问近乎常数。术语与上限对齐 CONTEXT.md 与 ADR-0001（追问压缩路径）；
// 原始字幕段按需检索注入（06）由下半部编排函数接入 ladder 的 Map-Reduce 分派链：
// 超预算视频总结完成后继续追问时不再重跑 Map-Reduce，改走「压缩摘要（从段缓存加载的
// 分段小结 + 上一轮成稿笔记）+ 命中时间戳/章节/关键词注入的原始段」+ 单次调用；
// 首轮 / 尚未成稿（无笔记或无分段小结）→ 返回 null，交回上层跑完整 Map-Reduce。
//
// 文件组织：上半部是常量与纯函数（压缩摘要的取舍与上限，无 side effect）；
// 下半部是编排函数（装配压缩 + 检索）。段缓存宿主在 SW（arch-review-2026-09/05），
// 缺省 loader 走 segment-cache-proxy 消息代理。
// 诚实口径：本模块不再「不碰 chrome」——缺省 loader 经消息代理触达 chrome.runtime，
// 但只以箭头函数惰性默认值存在，无 chrome 环境下模块求值与注入桩测试均安全。

import { buildSubtitlePrompt, formatSegmentHeading, formatSegmentItem } from "./subtitle-prompt.js";
import { retrieveRawSegments, type RawSegment } from "./raw-retrieval.js";
import { segmentCacheProxy } from "./segment-cache-proxy.js";
import type { BudgetPlan, BudgetPlanSegment } from "./types.js";

// 近 N 轮 verbatim（N = 最近对话轮数）：由外部 buildMessages(history, userPrompt) 取近 N 轮
// 拼进消息历史，本模块只负责「字幕体」这一栏的取舍与压缩。
export const RECENT_TURNS_DEFAULT = 6;

// 检索注入（相关原始字幕段）总量上限：压缩摘要默认 ≤60k，注入 ≤30k，
// 合计 ≤90k < 素材预算 200k，保证追问仍走预算内单次、绝不溢出。
export const RAW_INJECTION_MAX_CHARS = 30000;

// 分段小结常驻的独立 token 上限：每条小结本身已由 03 按 ≤10k clamp，
// 此处对「汇总后的分段小结部分」再做独立截断（尾部）。40k ≈ 覆盖 ≥4 段小结的忠实汇总，
// 加上成稿 ≤16k 后整体仍在默认 maxChars=60k 之内——常驻上下文有界，不随原始字幕长度增长。
export const SEGMENT_SUMMARIES_MAX_CHARS = 40000;

// 整体压缩摘要默认上限（分段小结 + 成稿，字符≈token，对齐 ADR-0001 的 chars × 1.0）。
const COMPRESSED_SUMMARY_MAX_CHARS = 60000;
// 尾部截断标记：长度计入 maxChars，保证返回串严格 ≤ maxChars。
const TRUNCATION_MARKER = "\n…（压缩摘要过长，已截断尾部）";

// 保守地把 maxChars 规整为非负整数；非有限值（undefined/NaN 等）回落 0。
function normalizeMaxChars(maxChars: unknown): number {
  const n = Number(maxChars);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 尾部截断：超长时保留头部、在尾部补截断标记，返回串长度严格 ≤ maxChars。
function truncateTail(text: unknown, maxChars: unknown): string {
  const value = String(text ?? "");
  const max = normalizeMaxChars(maxChars);
  if (value.length <= max) return value;
  if (max <= TRUNCATION_MARKER.length) return value.slice(0, max);
  return value.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

interface FinalNoteInput {
  note?: unknown;
  segmentSummaries?: unknown[];
}

// 是否已「成稿」：笔记正文 + 分段小结两者齐备才算；首轮 / 尚未成稿 → false。
export function hasFinalNote({ note, segmentSummaries }: FinalNoteInput = {}): boolean {
  const noteText = String(note || "").trim();
  const hasSummaries = Array.isArray(segmentSummaries) && segmentSummaries.length > 0;
  return noteText.length > 0 && hasSummaries;
}

// 近 N 轮 verbatim：只保留最近 turns 轮对话（每轮 = 一 user 一 assistant，共 2 条），
// 把历史封顶，保证追问 token 不随轮数无限增长（对齐 ADR「token 随追问近乎常数」）。
export function trimRecentTurns(history: unknown, turns: unknown = RECENT_TURNS_DEFAULT): unknown[] {
  const list = Array.isArray(history) ? history : [];
  const safeTurns = Math.max(1, Math.floor(Number(turns) || RECENT_TURNS_DEFAULT));
  return list.slice(-(safeTurns * 2));
}

interface CompressedSummaryInput {
  segmentSummaries?: unknown[];
  note?: unknown;
  maxChars?: number | unknown;
}

// 组装「压缩摘要」字符串：分段小结（每条 `### 片段 i` 小标题 + 正文，先受独立上限约束）
// + 成稿笔记；整体再受 maxChars 约束（截断尾部）。保留各小结与笔记原文（verbatim）。
export function buildCompressedSummary({
  segmentSummaries = [],
  note = "",
  maxChars = COMPRESSED_SUMMARY_MAX_CHARS
}: CompressedSummaryInput = {}): string {
  const summaries = Array.isArray(segmentSummaries) ? segmentSummaries : [];
  const noteText = note == null ? "" : String(note);

  let summariesSection = "";
  if (summaries.length > 0) {
    // 分段标注与成稿材料（ai/map-reduce 的 buildMaterial）共用 formatSegmentHeading
    // 单源（arch-slim-2/03）——两条管线对同一份小结数组的分段语义必须逐字一致。
    const lines = summaries.map((summary, i) => `${formatSegmentHeading(i)}\n${summary == null ? "" : String(summary)}`);
    summariesSection = "## 分段小结\n\n" + truncateTail(lines.join("\n\n"), SEGMENT_SUMMARIES_MAX_CHARS);
  }

  const sections: string[] = [];
  if (summariesSection.length > 0) sections.push(summariesSection);
  if (noteText.length > 0) sections.push("## 成稿笔记\n\n" + noteText);

  return truncateTail(sections.join("\n\n"), maxChars);
}

interface FollowupSubtitleInput {
  contextData?: Record<string, unknown>;
  note?: unknown;
  segmentSummaries?: unknown[] | null;
  userPrompt?: unknown;
  retrieveRaw?: ((prompt: unknown) => unknown[]) | null;
}

// 追问时的字幕体：已成稿 → 压缩摘要 [+ 检索注入的原始段尾缀]；
// 尚未成稿（首轮 / 无笔记）→ 由 buildSubtitlePrompt 从原始字幕体（subtitleBody +
// chapters + videoDuration）现场渲染全文（协议已不含预渲染的 subtitleMarkdown）。
// retrieveRaw 为 06 注入的 (userPrompt) => string[]，缺省 () => []，完全解耦。
export function buildFollowupSubtitleMarkdown({
  contextData = {},
  note = null,
  segmentSummaries = null,
  userPrompt = "",
  retrieveRaw = null
}: FollowupSubtitleInput = {}): string {
  const ctx = contextData || {};
  const noteText = note == null ? "" : String(note);
  const summaries = Array.isArray(segmentSummaries) ? segmentSummaries : [];

  if (!hasFinalNote({ note: noteText, segmentSummaries: summaries })) {
    return buildSubtitlePrompt({
      body: ctx.subtitleBody as unknown[],
      chapters: ctx.chapters as unknown[],
      videoDuration: ctx.videoDuration,
      includeTimestampInBody: ctx.includeTimestampInBody
    });
  }

  const compressed = buildCompressedSummary({ segmentSummaries: summaries, note: noteText });

  const retrieveFn = typeof retrieveRaw === "function" ? retrieveRaw : () => [];
  const hits = (retrieveFn(userPrompt) || []).filter((text): text is string => typeof text === "string" && text.length > 0);
  if (hits.length === 0) {
    return compressed;
  }
  let injection = hits.join("\n\n");
  // 注入原始段设上限，保证「压缩摘要 + 注入」合计仍在预算内（避免追问静默溢出/无输出）。
  if (injection.length > RAW_INJECTION_MAX_CHARS) {
    injection = injection.slice(0, RAW_INJECTION_MAX_CHARS);
  }
  return compressed + "\n\n## 相关原始字幕段\n\n" + injection;
}

interface LoadSegmentSummariesInput {
  context?: Record<string, unknown>;
  plan?: { segments?: BudgetPlanSegment[] } | null;
  // 批量读取缝（08 票）：一次消息取 N 段小结，缺省经 segmentCacheProxy 到 SW。
  loadSummaries?: (input: { context?: Record<string, unknown>; segmentIndexes?: Array<number | string> }) => Promise<(string | null)[]>;
}

function keepSummary(summary: unknown): summary is string {
  return typeof summary === "string" && summary.trim().length > 0;
}

/**
 * 从段缓存按段顺序加载全部分段小结（跳过 null/空，保持段序）。
 * 缺省一次批量往返（08 票：N 段 = 1 次消息 + 1 次批量 storage.get）。
 */
export async function loadSegmentSummaries({
  context = {},
  plan = null,
  loadSummaries = (input) => segmentCacheProxy.loadSummaries(input)
}: LoadSegmentSummariesInput = {}): Promise<string[]> {
  const segments = Array.isArray(plan?.segments) ? plan.segments : [];
  const indexes = segments
    .map((segment) => segment?.index)
    .filter((index) => index !== undefined && index !== null);
  const summaries = await loadSummaries({ context, segmentIndexes: indexes });
  return (Array.isArray(summaries) ? summaries : []).filter(keepSummary);
}

// 单条命中的原始段渲染成注入文本块：逐条字幕项按 [起点-终点] 内容 拼行。
function renderRawSegment(segment: RawSegment): string {
  const items = Array.isArray(segment?.items) ? segment.items : [];
  return items
    .map((item) => formatSegmentItem(item))
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

interface BuildRetrieveRawInput {
  context?: Record<string, unknown>;
  plan?: { segments?: BudgetPlanSegment[] } | null;
}

// 构造一个「按需检索」函数：基于 plan.segments（已在内存的原始字幕段，与 04 缓存的段同构），
// 每次调用 06 的 retrieveRawSegments 命中后，把命中段渲染成文本块数组返回（同步，供 05 注入）。
export function buildRetrieveRaw({ context = {}, plan = null }: BuildRetrieveRawInput = {}) {
  const rawSegments = (Array.isArray(plan?.segments) ? plan.segments : []).map((seg) => ({
    index: seg.index,
    from: seg.from,
    to: seg.to,
    items: Array.isArray(seg.items) ? seg.items : []
  }));

  return function retrieveRaw(prompt: unknown): string[] {
    const hits = retrieveRawSegments({
      prompt,
      chapters: Array.isArray(context?.chapters) ? context.chapters : [],
      rawSegments
    });
    return hits.map((seg) => renderRawSegment(seg)).filter((text) => text.length > 0);
  };
}

// 取最近一条 assistant 消息正文（作为「成稿笔记」候选）；无则返回空串。
export function lastAssistantContent(history: unknown = []): string {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i] as { role?: unknown; content?: unknown };
    if (message && message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

interface ResolveFollowupContextInput {
  context?: Record<string, unknown>;
  plan?: BudgetPlan | null;
  history?: unknown[];
  userPrompt?: string;
  loadSummaries?: typeof loadSegmentSummaries;
  // 跨会话原始段读取缝（arch-review-2026-09/05）：缺省经 segmentCacheProxy
  // 消息到 SW，测试注入可控桩。userPrompt 非空时 SW 只回传命中段的 items（08 票）。
  loadStoredSegments?: (input: { context?: Record<string, unknown>; userPrompt?: unknown }) => Promise<unknown[]>;
}

/**
 * 解析追问上下文：超预算视频 + 已有历史 + 已能拼出「成稿笔记 + 分段小结」时，
 * 返回供 streamChat 复用的压缩上下文（compressedSummaryMarkdown 换成压缩摘要，
 * subtitleBody 置空）；
 * 其余情况（≤200k / 首轮 / 尚未成稿）返回 null，表示走完整 Map-Reduce。
 *
 * 段来源两级：会话内直接用内存 plan.segments（行为与既有路径逐字节一致）；
 * 跨会话（恢复会话 / 新会话，内存段已不在）且 plan.segments 为空时，回退到段缓存
 * 落盘的原始字幕段（loadStoredRawSegments，键位与 map-reduce 落盘完全一致），
 * 仅补空缺、不覆盖内存段；两级皆空则维持返回 null 交回完整 Map-Reduce。
 * bvid/cid 取自追问上下文（context 由侧边栏组装，含视频身份字段）。
 */
export async function resolveFollowupContext({
  context = {},
  plan = null,
  history = [],
  userPrompt = "",
  loadSummaries = loadSegmentSummaries,
  loadStoredSegments = (input) => segmentCacheProxy.loadStoredRaw(input)
}: ResolveFollowupContextInput = {}): Promise<Record<string, unknown> | null> {
  if (plan?.mode !== "map-reduce") {
    return null;
  }
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  const note = lastAssistantContent(history);
  if (!note) {
    return null;
  }

  // 段来源：内存优先，空缺时跨会话回退（仅此处触达段缓存，经消息代理到 SW；
  // userPrompt 一并下发，SW 侧预过滤后只回传命中段的 items——08 票）。
  const inMemorySegments = Array.isArray(plan?.segments) ? plan.segments : [];
  let segments: BudgetPlanSegment[] = inMemorySegments;
  if (segments.length === 0) {
    const stored = await loadStoredSegments({ context, userPrompt });
    if (Array.isArray(stored) && stored.length > 0) {
      segments = stored as BudgetPlanSegment[];
    }
  }

  const segmentSummaries = await loadSummaries({ context, plan: { ...plan, segments } });
  if (!hasFinalNote({ note, segmentSummaries })) {
    return null;
  }

  const compressedSummaryMarkdown = buildFollowupSubtitleMarkdown({
    contextData: context,
    note,
    segmentSummaries,
    userPrompt,
    retrieveRaw: buildRetrieveRaw({ context, plan: { segments } })
  });

  // 压缩摘要本身是文本产物，用显式的 compressedSummaryMarkdown 字段承载，
  // 不与已从协议删除的 subtitleMarkdown 混淆（context.js / client.js 读新字段）。
  return { ...context, compressedSummaryMarkdown, subtitleBody: [] };
}
