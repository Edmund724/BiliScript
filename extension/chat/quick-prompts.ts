import { DEFAULT_INITIAL_QUICK_PROMPTS, MAX_INITIAL_QUICK_PROMPTS } from "../core/default-prompts.js";
import type { ChatMessage } from "../ai/types.js";

export { MAX_INITIAL_QUICK_PROMPTS };
export const MAX_QUICK_PROMPT_CHARS = 40;
export const QUICK_PROMPT_EXCERPT_CHARS = 1500;
export const QUICK_PROMPT_MAX_TOKENS = 256;

const EXCERPT_JOINER = "……";

const QUICK_PROMPT_SYSTEM = [
  `你是 B 站视频阅读扩展的助手。读下面的视频标题与字幕节选，生成 ${MAX_INITIAL_QUICK_PROMPTS} 个用户最可能想问这个视频的问题。`,
  "要求：",
  "1. 每个问题都紧扣这段视频的具体内容（人名、产品、事件、观点、数据），不要写成「这个视频讲了什么」这类放到任何视频都成立的问题；",
  "2. 每问不超过 20 个字，中文，疑问句；",
  `${MAX_INITIAL_QUICK_PROMPTS} 个问题的角度互不重复，例如：一个问核心结论，一个问具体细节或数据，一个问方法或启发。`,
  '只输出一个 JSON 字符串数组，例如 ["问题一","问题二","问题三"]，不要输出任何其他文字。'
].join("\n");

export function normalizePromptList(value: unknown, maxChars = 0): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const prompts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    let text = item.trim();
    if (!text) {
      continue;
    }
    if (maxChars > 0 && text.length > maxChars) {
      text = `${text.slice(0, maxChars - 1)}…`;
    }
    if (prompts.indexOf(text) !== -1) {
      continue;
    }
    prompts.push(text);
    if (prompts.length >= MAX_INITIAL_QUICK_PROMPTS) {
      break;
    }
  }
  return prompts;
}

export function buildQuickPromptExcerpt(body: unknown, maxChars = QUICK_PROMPT_EXCERPT_CHARS): string {
  const items = Array.isArray(body) ? body : [];
  const text = items
    .map((item) => String((item as { content?: unknown } | null)?.content ?? "").trim())
    .filter(Boolean)
    .join("");
  const budget = Math.floor(Number(maxChars));
  if (!text || !Number.isFinite(budget) || budget <= 0) {
    return "";
  }
  if (text.length <= budget) {
    return text;
  }
  const window = Math.floor(budget / 3);
  if (window <= 0) {
    return text.slice(0, budget);
  }
  const middleStart = Math.max(0, Math.floor(text.length / 2 - window / 2));
  return [
    text.slice(0, window),
    text.slice(middleStart, middleStart + window),
    text.slice(text.length - window)
  ].join(EXCERPT_JOINER);
}

export interface QuickPromptMessagesInput {
  title?: unknown;
  excerpt?: unknown;
}

export function buildQuickPromptMessages({ title, excerpt }: QuickPromptMessagesInput = {}): ChatMessage[] {
  const heading = String(title || "").trim() || "（未取到标题）";
  const material = String(excerpt || "").trim() || "（未取到字幕）";
  return [
    { role: "system", content: QUICK_PROMPT_SYSTEM },
    { role: "user", content: `视频标题：${heading}\n\n字幕节选：\n${material}` }
  ];
}

export function parseQuickPrompts(text: unknown): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return [];
  }
  const parsed = extractJsonArray(raw);
  if (parsed) {
    return normalizePromptList(parsed, MAX_QUICK_PROMPT_CHARS);
  }
  const lines = raw
    .split(/\r?\n/)
    .map(stripPromptLine)
    .filter(Boolean);
  if (lines.length < 2) {
    return [];
  }
  return normalizePromptList(lines, MAX_QUICK_PROMPT_CHARS);
}

function extractJsonArray(raw: string): unknown[] | null {
  const candidates: string[] = [raw];
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start !== -1 && end > start) {
    candidates.push(raw.slice(start, end + 1));
  }
  const nonGreedy = raw.match(/\[[\s\S]*?\]/);
  if (nonGreedy) {
    candidates.push(nonGreedy[0]);
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) {
        return value;
      }
    } catch {
    }
  }
  return null;
}

function stripPromptLine(line: unknown): string {
  return String(line ?? "")
    .replace(/^(?:(?:[-*•]|\d+\s*[.、)）])\s*)+/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

export function resolveInitialQuickPrompts(custom: unknown, generated: unknown): string[] {
  const customList = normalizePromptList(custom);
  if (customList.length) {
    return customList;
  }
  const generatedList = normalizePromptList(generated);
  if (generatedList.length) {
    return generatedList;
  }
  return normalizePromptList(DEFAULT_INITIAL_QUICK_PROMPTS);
}
