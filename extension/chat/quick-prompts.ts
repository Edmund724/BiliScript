// extension/chat/quick-prompts.ts
// 初始快捷问题的纯数据层：字幕节选、生成提示词组装、模型输出解析、三档取用
// （用户自定义 > 本视频生成结果 > 固定兜底）。
//
// 「自定义 > 生成 > 兜底」的顺序是设置面板语义的落点：设置里的初始问题留空
// 表示「按视频自动生成」（空数组不再回落固定文案，见 core/validators.ts），
// 填了则完全用用户那三条；固定三条（core/default-prompts.ts）只在生成不可用
// （没配平台 / 请求失败 / 输出解析不出）时兜底，保证建议区永远有内容可点。
//
// 本模块无 IO、无 chrome、无模块级状态，可在 Node 测试环境直接 evaluate
// （tests/chat/quick-prompts.test.ts）。生成编排在 reader/quick-prompts.ts。

import { DEFAULT_INITIAL_QUICK_PROMPTS, MAX_INITIAL_QUICK_PROMPTS } from "../core/default-prompts.js";
import type { ChatMessage } from "../ai/types.js";

// 条数上限单源在 core/default-prompts.ts（设置面板、归一化与本模块共用）；
// 此处再导出，消费方（reader/quick-prompts.ts、测试）从本模块取用即可。
export { MAX_INITIAL_QUICK_PROMPTS };
// 生成结果单条上限：chip 一行放得下，超长截断（用户自定义不受此限，见
// normalizePromptList 的 maxChars 形参）。
export const MAX_QUICK_PROMPT_CHARS = 40;
// 发给模型的字幕预算：标题 + 头/中/尾各一段，够模型认出主题与关键人物/概念，
// 又让这次调用保持廉价（约 1.5k 字符）。
export const QUICK_PROMPT_EXCERPT_CHARS = 1500;
// 三条短问题的输出预算（模型偶尔带点前言，留出余量；截断也不影响前三行解析）。
export const QUICK_PROMPT_MAX_TOKENS = 256;

const EXCERPT_JOINER = "……";

// 生成提示词：钉住条数、字数、角度与输出形状（要求 JSON 数组，解析层也容错
// 逐行列表——见 parseQuickPrompts）。
const QUICK_PROMPT_SYSTEM = [
  `你是 B 站视频阅读扩展的助手。读下面的视频标题与字幕节选，生成 ${MAX_INITIAL_QUICK_PROMPTS} 个用户最可能想问这个视频的问题。`,
  "要求：",
  "1. 每个问题都紧扣这段视频的具体内容（人名、产品、事件、观点、数据），不要写成「这个视频讲了什么」这类放到任何视频都成立的问题；",
  "2. 每问不超过 20 个字，中文，疑问句；",
  `${MAX_INITIAL_QUICK_PROMPTS} 个问题的角度互不重复，例如：一个问核心结论，一个问具体细节或数据，一个问方法或启发。`,
  '只输出一个 JSON 字符串数组，例如 ["问题一","问题二","问题三"]，不要输出任何其他文字。'
].join("\n");

/**
 * 问题列表归一：只留非空字符串、去空白、去重、最多 MAX_INITIAL_QUICK_PROMPTS 条。
 * maxChars > 0 时按字数截断（模型输出用），默认 0 不截断（用户自定义的问题
 * 可以是一整句指令，静默截短会改变语义）。
 */
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

/**
 * 字幕节选：字幕体拼成整段，超出预算时取头/中/尾各三分之一（用「……」连接）。
 * 只取开头会让「先讲背景、中途才给结论」的视频被模型认成背景介绍，三段式是最
 * 便宜的全片代表性采样。空字幕/非法项/非正预算 → 空串（调用方不生成）。
 */
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

// 生成请求的两条消息：system 定形状与条数，user 给素材（标题 + 字幕节选）。
export function buildQuickPromptMessages({ title, excerpt }: QuickPromptMessagesInput = {}): ChatMessage[] {
  const heading = String(title || "").trim() || "（未取到标题）";
  const material = String(excerpt || "").trim() || "（未取到字幕）";
  return [
    { role: "system", content: QUICK_PROMPT_SYSTEM },
    { role: "user", content: `视频标题：${heading}\n\n字幕节选：\n${material}` }
  ];
}

/**
 * 解析模型输出：宽进严出。JSON 数组（可带解说文字与 markdown 围栏）、逐行列表
 * （剥序号/项目符号/引号）都接；解析不出任何可用问题返回空表，由调用方回落
 * 固定三条。单行且非 JSON 的输出按「模型没照做」处理（多半是拒绝或客套话）。
 */
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

// 从可能夹带解说/围栏的文本里取出第一个 JSON 数组：整体、首个 "[" 到末个 "]"
// 的切片、非贪婪首次匹配，三种尝试从宽到窄，任一解析成数组即采用。
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
      // 继续试下一个候选
    }
  }
  return null;
}

// 逐行兜底解析的单行清理：剥前缀序号/项目符号（可叠多层）、剥首尾引号。
function stripPromptLine(line: unknown): string {
  return String(line ?? "")
    .replace(/^(?:(?:[-*•]|\d+\s*[.、)）])\s*)+/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

/**
 * 建议区最终取用：用户自定义 → 本视频生成结果 → 固定兜底。
 * 调用方（reader/chat-lists.ts）把设置里的自定义列表与该视频的缓存结果（可能
 * 为 null，预热还没落定或失败）一并传入，取第一条非空档。
 */
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
