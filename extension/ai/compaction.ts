import type { chatCompletion as ChatCompletionFn } from "./completion.js";
import type { ChatMessage, ConversationSummaryAnchor, ProviderRequest } from "./types.js";

export const COMPACT_TRIGGER_TURNS = 12;
export const COMPACT_BATCH_TURNS = 8;
export const COMPACT_HARD_FALLBACK_TURNS = 16;
export const COMPACT_SUMMARY_MAX_CHARS = 300;
export const COMPACT_MAX_TOKENS = 512;
export const TOOL_RESULT_FOLD_RECENT_TURNS = 2;
export const TOOL_RESULT_FOLD_MIN_CHARS = 300;

export const SUMMARY_ANCHOR_USER_PREFIX = "【前序对话归档摘要】\n";
export const SUMMARY_ANCHOR_ASSISTANT_ACK = "明白，我将结合上述前序对话结论继续回答。";
export const FOLDED_TOOL_RESULT_PLACEHOLDER = "[历史工具原始返回已折叠，核心结论见紧随其后的助手回复]";

const COMPACTION_MSG_MAX_CHARS = 2000;

const COMPACTION_SYSTEM_PROMPT = [
  "你是对话记忆归档助手。请将已有前序摘要（如有）与新增历史对话合并，提炼为一段不超过 300 字的结构化中文摘要。",
  "必须优先保留：已确认的视频核心结论、用户关注的问题与偏好、关键时间戳与专有名词/数据。",
  "禁止编造未出现的信息，禁止输出多余寒暄或 Markdown 代码块，直接输出纯文本摘要。"
].join("\n");

export interface SummaryAnchorLike {
  text?: string;
  summaryText?: string;
  coveredMessageCount: number;
  updatedAt?: number;
  coveredMessageIds?: string[];
  boundaryHash?: string;
}

export interface CompactionBatchMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompactionPlan {
  previousSummaryText: string;
  batchMessages: CompactionBatchMessage[];
  coveredMessageCount: number;
  expectedCoveredMessageIds?: string[];
  expectedBoundaryContent: string;
}

export interface ActiveHistorySliceResult<T> {
  activeRawHistory: T[];
  anchorText: string;
  effectiveCoveredCount: number;
  hardTrimmedTurns: number;
}

export function getSummaryAnchorText(anchor: SummaryAnchorLike | null | undefined): string {
  if (!anchor || typeof anchor !== "object") {
    return "";
  }
  const primary = typeof anchor.text === "string" ? anchor.text.trim() : "";
  if (primary) {
    return primary;
  }
  return typeof anchor.summaryText === "string" ? anchor.summaryText.trim() : "";
}

export function getUserTurnStartIndexes(messages: readonly { role?: unknown }[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") {
      starts.push(i);
    }
  }
  return starts;
}

export function isCompleteUserTurnBoundary(
  messages: readonly { role?: unknown; tool_calls?: unknown }[],
  count: number
): boolean {
  if (!Number.isInteger(count) || count <= 0 || count > messages.length) {
    return false;
  }
  if (count < messages.length && messages[count]?.role !== "user") {
    return false;
  }
  const lastCovered = messages[count - 1];
  if (!lastCovered || lastCovered.role !== "assistant") {
    return false;
  }
  if (Array.isArray(lastCovered.tool_calls) && lastCovered.tool_calls.length > 0) {
    return false;
  }
  for (let i = 0; i < count; i += 1) {
    if (messages[i]?.role === "user") {
      return true;
    }
  }
  return false;
}

export function isSummaryAnchorValidForMessages(
  messages: readonly { role?: unknown; tool_calls?: unknown }[],
  anchor: SummaryAnchorLike | null | undefined
): boolean {
  if (!anchor || typeof anchor !== "object") {
    return false;
  }
  if (!getSummaryAnchorText(anchor)) {
    return false;
  }
  return isCompleteUserTurnBoundary(messages, Number(anchor.coveredMessageCount));
}

export function shouldInvalidateSummaryAnchor(
  anchor: SummaryAnchorLike | null | undefined,
  mutationIndex: number,
  nextMessages?: readonly { role?: unknown; tool_calls?: unknown }[]
): boolean {
  if (!anchor || typeof anchor !== "object") {
    return false;
  }
  const covered = Number(anchor.coveredMessageCount);
  if (!Number.isInteger(covered) || covered <= 0) {
    return true;
  }
  if (mutationIndex < covered) {
    return true;
  }
  if (nextMessages && !isCompleteUserTurnBoundary(nextMessages, covered)) {
    return true;
  }
  return false;
}

export function invalidateSummaryAnchorIfAffected<T extends SummaryAnchorLike>(
  anchor: T | null | undefined,
  mutationIndex: number,
  nextMessages?: readonly { role?: unknown; tool_calls?: unknown }[]
): T | undefined {
  if (!anchor) {
    return undefined;
  }
  return shouldInvalidateSummaryAnchor(anchor, mutationIndex, nextMessages) ? undefined : anchor;
}

export function sliceActiveHistoryWithFallback<T extends { role?: unknown; tool_calls?: unknown }>(
  rawHistory: readonly T[],
  summaryAnchor?: SummaryAnchorLike | null
): ActiveHistorySliceResult<T> {
  const list = Array.isArray(rawHistory) ? rawHistory : [];
  const validAnchor = isSummaryAnchorValidForMessages(list, summaryAnchor);
  const anchorText = validAnchor ? getSummaryAnchorText(summaryAnchor) : "";
  const effectiveCoveredCount = validAnchor ? Number(summaryAnchor!.coveredMessageCount) : 0;
  let active = effectiveCoveredCount > 0 ? list.slice(effectiveCoveredCount) : list.slice();

  const turnStarts = getUserTurnStartIndexes(active);
  let hardTrimmedTurns = 0;
  if (turnStarts.length >= COMPACT_HARD_FALLBACK_TURNS) {
    const chunksToDrop =
      Math.floor((turnStarts.length - COMPACT_HARD_FALLBACK_TURNS) / COMPACT_BATCH_TURNS) + 1;
    hardTrimmedTurns = Math.min(chunksToDrop * COMPACT_BATCH_TURNS, turnStarts.length - 1);
    const sliceStart = turnStarts[hardTrimmedTurns];
    if (typeof sliceStart === "number" && sliceStart > 0) {
      active = active.slice(sliceStart);
    } else {
      hardTrimmedTurns = 0;
    }
  }

  return {
    activeRawHistory: active,
    anchorText,
    effectiveCoveredCount,
    hardTrimmedTurns
  };
}

export function buildSummaryAnchorTurnPair(anchorText: string): [ChatMessage, ChatMessage] {
  return [
    { role: "user", content: `${SUMMARY_ANCHOR_USER_PREFIX}${anchorText}` },
    { role: "assistant", content: SUMMARY_ANCHOR_ASSISTANT_ACK }
  ];
}

export function foldHistoricalToolResults(messages: readonly ChatMessage[]): ChatMessage[] {
  const turnStarts = getUserTurnStartIndexes(messages);
  if (turnStarts.length <= TOOL_RESULT_FOLD_RECENT_TURNS) {
    return messages.slice();
  }
  const preserveFromIndex = turnStarts[turnStarts.length - TOOL_RESULT_FOLD_RECENT_TURNS];
  return messages.map((msg, index) => {
    if (
      index < preserveFromIndex &&
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg.content.length > TOOL_RESULT_FOLD_MIN_CHARS
    ) {
      return {
        ...msg,
        content: FOLDED_TOOL_RESULT_PLACEHOLDER
      };
    }
    return msg;
  });
}

function sanitizeMessageForCompaction(raw: {
  role?: unknown;
  content?: unknown;
  images?: unknown;
}): CompactionBatchMessage | null {
  if (raw.role !== "user" && raw.role !== "assistant") {
    return null;
  }
  const rawText = typeof raw.content === "string" ? raw.content.trim() : "";
  const hasImages = Array.isArray(raw.images) && raw.images.length > 0;
  if (!rawText && !hasImages) {
    return null;
  }
  const clipped = rawText.length > COMPACTION_MSG_MAX_CHARS
    ? `${rawText.slice(0, COMPACTION_MSG_MAX_CHARS)}…`
    : rawText;
  const suffix = hasImages ? (clipped ? " [附带图片]" : "[附带图片]") : "";
  return {
    role: raw.role,
    content: `${clipped}${suffix}`
  };
}

export function planConversationCompaction(
  messages: readonly {
    id?: unknown;
    role?: unknown;
    content?: unknown;
    images?: unknown;
    tool_calls?: unknown;
  }[],
  currentAnchor?: SummaryAnchorLike | null
): CompactionPlan | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const validAnchor = isSummaryAnchorValidForMessages(messages, currentAnchor);
  const baseCovered = validAnchor ? Number(currentAnchor!.coveredMessageCount) : 0;
  const previousSummaryText = validAnchor ? getSummaryAnchorText(currentAnchor) : "";
  const unarchived = messages.slice(baseCovered);
  const turnStarts = getUserTurnStartIndexes(unarchived);
  if (turnStarts.length < COMPACT_TRIGGER_TURNS) {
    return null;
  }

  let targetCovered = 0;
  for (let turnIndex = Math.min(COMPACT_BATCH_TURNS, turnStarts.length - 1); turnIndex >= 1; turnIndex -= 1) {
    const candidate = baseCovered + turnStarts[turnIndex];
    if (isCompleteUserTurnBoundary(messages, candidate)) {
      targetCovered = candidate;
      break;
    }
  }
  if (targetCovered <= baseCovered) {
    return null;
  }

  const batchMessages: CompactionBatchMessage[] = [];
  for (let i = baseCovered; i < targetCovered; i += 1) {
    const sanitized = sanitizeMessageForCompaction(messages[i]);
    if (sanitized) {
      batchMessages.push(sanitized);
    }
  }
  if (batchMessages.length === 0) {
    return null;
  }

  const coveredSlice = messages.slice(0, targetCovered);
  const allHaveIds = coveredSlice.every((m) => typeof m?.id === "string" && m.id.trim().length > 0);
  const expectedCoveredMessageIds = allHaveIds
    ? coveredSlice.map((m) => String(m.id).trim())
    : undefined;
  const expectedBoundaryContent = String(messages[targetCovered - 1]?.content ?? "");

  return {
    previousSummaryText,
    batchMessages,
    coveredMessageCount: targetCovered,
    ...(expectedCoveredMessageIds ? { expectedCoveredMessageIds } : {}),
    expectedBoundaryContent
  };
}

export function buildCompactionMessages(plan: CompactionPlan): ChatMessage[] {
  const parts: string[] = [];
  if (plan.previousSummaryText.trim()) {
    parts.push(`【已有前序摘要】\n${plan.previousSummaryText.trim()}`);
  }
  const transcriptLines = plan.batchMessages.map((msg) =>
    `${msg.role === "user" ? "用户" : "助手"}：${msg.content}`
  );
  parts.push(`【新增待归档对话】\n${transcriptLines.join("\n")}`);
  return [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") }
  ];
}

export function normalizeCompactedSummaryText(raw: string): string {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```(?:[\w-]+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length <= COMPACT_SUMMARY_MAX_CHARS) {
    return cleaned;
  }
  return cleaned.slice(0, COMPACT_SUMMARY_MAX_CHARS).trimEnd();
}

export interface SynthesizeCompactedSummaryInput {
  provider: ProviderRequest;
  plan: CompactionPlan;
  complete: typeof ChatCompletionFn;
  signal?: AbortSignal | null;
  now?: () => number;
}

export async function synthesizeCompactedSummary(
  input: SynthesizeCompactedSummaryInput
): Promise<ConversationSummaryAnchor | null> {
  const result = await input.complete({
    provider: input.provider,
    messages: buildCompactionMessages(input.plan),
    stream: false,
    thinkingLevel: "off",
    maxTokens: COMPACT_MAX_TOKENS,
    temperature: 0,
    retries: 0,
    signal: input.signal
  });
  const rawText = typeof result === "string"
    ? result
    : ("assistantContent" in result && typeof result.assistantContent === "string" ? result.assistantContent : "");
  const text = normalizeCompactedSummaryText(rawText);
  if (!text) {
    return null;
  }
  return {
    text,
    coveredMessageCount: input.plan.coveredMessageCount,
    updatedAt: (input.now ?? Date.now)()
  };
}
