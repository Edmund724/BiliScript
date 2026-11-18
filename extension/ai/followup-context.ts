// 「追问上下文」模块：超预算视频总结完成后继续追问时，不再重跑 Map-Reduce，
// 常驻上下文改为「压缩摘要（从段缓存加载的分段小结 + 上一轮成稿笔记）+ 近 N 轮 verbatim + 本轮问题」，
// 配合 L0+L1 混合单跳召回保证 token 随追问近乎常数（ADR-0001 / ADR-0027）。
// 首轮 / 尚未成稿（无笔记或无分段小结）→ 返回 null，交回上层跑完整 Map-Reduce。
//
// 文件组织：上半部是常量与纯函数（压缩摘要的取舍与上限，无 side effect）；
// 下半部是编排函数（加载分段小结并组装纯压缩摘要）。段缓存宿主在 SW，
// 缺省 loader 走 segment-cache-proxy 消息代理。
// 诚实口径：缺省 loader 经消息代理触达 chrome.runtime，
// 但只以箭头函数惰性默认值存在，无 chrome 环境下模块求值与注入桩测试均安全。

import { formatSegmentHeading } from "./subtitle-prompt.js";
import { segmentCacheProxy } from "./segment-cache-proxy.js";
import type { BudgetPlan, BudgetPlanSegment } from "./types.js";

// 近 N 轮 verbatim（N = 最近对话轮数）：由外部 buildMessages(history, userPrompt) 取近 N 轮
// 拼进消息历史，本模块只负责「压缩摘要」这一栏的取舍与组装。
export const RECENT_TURNS_DEFAULT = 6;

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
  loadSummaries?: typeof loadSegmentSummaries;
  loadStoredSummaries?: (input: { context?: Record<string, unknown>; budgetScale?: unknown }) => Promise<string[]>;
}

/**
 * 解析追问上下文：超预算视频 + 已有历史 + 已能拼出「成稿笔记 + 分段小结」时，
 * 返回供混合召回与 streamChat 复用的压缩上下文（`compressedSummaryMarkdown` 承载纯压缩摘要，
 * `subtitleBody` 置空）；
 * 其余情况（≤200k / 首轮 / 尚未成稿）返回 null，表示走完整 Map-Reduce。
 *
 * 当 `plan.segments` 为空时直接经 `loadStoredSummaries` 枚举存储中的分段小结。
 */
export async function resolveFollowupContext({
  context = {},
  plan = null,
  history = [],
  loadSummaries = loadSegmentSummaries,
  loadStoredSummaries = (input) => segmentCacheProxy.loadStoredSummaries(input)
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

  const inMemorySegments = Array.isArray(plan?.segments) ? plan.segments : [];
  const usingDefaultSummaryLoader = loadSummaries === loadSegmentSummaries;
  const segmentSummaries =
    inMemorySegments.length > 0 || !usingDefaultSummaryLoader
      ? await loadSummaries({ context, plan: { ...plan, segments: inMemorySegments } })
      : (await loadStoredSummaries({ context })).filter(keepSummary);
  if (!hasFinalNote({ note, segmentSummaries })) {
    return null;
  }

  const compressedSummaryMarkdown = buildCompressedSummary({ segmentSummaries, note });
  return { ...context, compressedSummaryMarkdown, subtitleBody: [] };
}
