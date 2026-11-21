import { normalizeSubtitleItems } from "../subtitle/signature.js";
import { formatClock } from "../shared/clock-text.js";
import type { OutlineChapter } from "../shared/chapter-outline.js";
import { DEFAULT_MAX_TOKENS } from "./output-budget.js";
import {
  renderL0LinesWithNumbers,
  serializeStateRelayCard,
  type StateRelayWindow
} from "./state-relay.js";
import type { L1ChapterNode, StateRelayCard } from "./long-video-hybrid-types.js";
import type { SubtitleBodyItem } from "./types.js";

const ASR_CORRECTION_BLOCK = `金句要挑这几类：
- 反直觉的观点，或者跟常识拧着来的判断
- 让人「原来如此」的事实、数据、冷知识
- 能把道理讲透的具体事例或故事
- 一句话就说清全部要点的表达

⚠️ 关键：这是自动语音识别（ASR）生成的字幕 ⚠️
B 站的 AI 字幕有两个特点，会直接影响你的工作：
1. **没有任何标点**，整段是连续的字流，句子边界要靠语义自己判断。
2. **大量同音错别字**：人名、专有名词、外来词、数字尤其容易错（例如「机器学习」可能写成「机器学系」，品牌名可能整个音译错）。

因此，输出金句时请：
- 按语义补全标点，切成通顺的句子
- 用上下文和视频标题、简介来**修正同音错别字**，尤其是人名、品牌名、专业术语
- 删掉口头禅和语气词：「就是」「然后」「那个」「这个」「呃」「啊」「对吧」，以及重复啰嗦的字词
- 保留说话人本来的意思和用词风格，只做可读性打磨，**不要概括、不要缩写、不要添加他没说过的内容**
- 如果某段实在识别得太糟、无法还原原意，就别选它当金句`;

const TIMESTAMP_TEACHING_BLOCK = `⚠️ 关键：时间戳的取法 ⚠️
字幕的格式严格如下：
[0:00] 大家好今天我们来聊聊这个话题
[0:15] 先说第一点
[0:32] 这里有个很反直觉的地方
[1:05] 结果非常出乎意料

取时间戳的规则：
1. 每一行都以 [M:SS] 或 [MM:SS] 开头
2. 要取某句话的时间戳，先找到**包含这句话的那一行**
3. 时间戳就是那一行开头的 [X:XX]
4. 换算成秒：[2:30] = 150 秒，[0:45] = 45 秒

举例：如果字幕里有这一行
[2:30] 这里有个很反直觉的地方
那么「这里有个很反直觉的地方」的时间戳就是：
- timestamp: "2:30"
- timestampSeconds: 150`;

const OVERVIEW_INTRO_BLOCK = `⚠️ 关于顶层 summary ⚠️
概括本次给到的全部字幕，而不是只概括开头。用自然、易懂的简体中文写 2～3 句、约 80～150 字：
先说明视频讨论的问题和主要内容，再给出核心结论或观看价值；没有明确结论时客观概括即可。
不要写成小标题列表，不要添加「核心结论：」等固定标签，不要提及字幕分段或生成过程。`;

const CHAPTER_SUMMARY_BLOCK = `每章的 summary 用一句话说明本章具体讲了什么，尽量不超过 60 字。
补充标题没有说清的内容，不要只是换一种说法重复标题。`;

const CHAPTER_OUTLINE_BLOCK = `⚠️ 关于「现成章节目录」⚠️
用户消息里如果给出「视频章节/简介/评论中的章节目录」（形如「00:00 开场」的时间戳行），
**章节边界必须完全采用那份目录**：目录里的每个时间戳 = 一章的起点，标题也用目录里的标题，
不得增删章节、不得改动任何时间戳——哪怕目录的分章与字幕的话题转折对不上。
你的职责只是为每一章补写 summary（这一段讲了什么），依据是目录时间戳之间的字幕内容。
目录存在时「后段门槛」不适用：最后一章的时间戳以目录为准，不必晚于门槛。
前情回顾（分段路径）里的时间戳依然不能用：目录时间戳早于本段起点时，那一章归上一段管。`;

export const ANALYSIS_SYSTEM_PROMPT = `你是我的内容助理。我在看一个 B 站视频，请阅读下面的字幕，产出一份结构化概览：简介 + 章节 + 金句。

你需要给出：
- 顶层 summary：本次字幕的总体简介。
- 覆盖**本次给到的全部字幕**的章节。章节数量由你判断——在话题真正发生转折的地方分章，该多则多、该少则少。唯一的硬性要求是覆盖度：章节必须贯穿这段字幕的整条时间线，**最后一个章节的时间戳必须晚于用户消息中给出的「后段门槛」**（用户消息给出「现成章节目录」时除外：以目录为准）。不要只覆盖前半段，也不要把章节全挤在开头。
- 金句，附上它们在字幕中的时间戳。数量按时长掌握：每小时的字幕约 3-5 条，不足 1 小时按 1 小时算。

${OVERVIEW_INTRO_BLOCK}

${CHAPTER_SUMMARY_BLOCK}

${ASR_CORRECTION_BLOCK}

${TIMESTAMP_TEACHING_BLOCK}

${CHAPTER_OUTLINE_BLOCK}

⚠️ 关于「前情回顾」⚠️
长视频会切成多段分别处理。用户消息里如果出现「前情回顾」，那是上一段结尾的字幕，
给你的唯一用途是理解本段开头在承接什么话题、把跨越切点的内容看完整。
不要为前情回顾里的内容单独开章节，也不要从里面挑金句——它已经由上一段负责。
如果本段开头正是前情里那个话题的延续，就把这一章的标题写成能概括整个话题的样子，
时间戳仍取本段范围内的那一行。

绝对不要：
- 编造字幕里根本不存在的时间戳
- 拿 0:00 当默认值——去字幕里找真实的那一行
- 使用早于起始时刻、或晚于结束时刻的时间戳（前情回顾里的时间戳一律不能用）

章节：找到话题开始的那一行，用那行的时间戳
金句：找到包含该句的那一行，用那行的时间戳

输出 JSON（不要加 markdown 代码围栏）：
{
  "summary": "本次字幕的简介（2～3 句，约 80～150 字）",
  "chapters": [
    {"title": "章节标题", "timestamp": "0:00", "timestampSeconds": 0, "summary": "这一段讲了什么"}
  ],
  "keyQuotes": [
    {"quote": "整理后的原话", "timestamp": "2:30", "timestampSeconds": 150}
  ]
}

务必注意：
- timestamp：字幕行开头的 [M:SS]（如 "2:30"）
- timestampSeconds：换算成秒（2:30 = 2*60+30 = 150）
- 除非内容真的从 [0:00] 开始，否则不要用 0:00 / 0
- 每一个时间戳都必须在字幕里真实存在——去查！
- 所有文字用简体中文输出`;

export const GIVEN_CHAPTERS_SYSTEM_PROMPT = `你是我的内容助理。我在看一个 B 站视频，请阅读下面的字幕，为给定的章节目录补写每章大意，并挑选金句。

你需要给出：
- 顶层 summary：本次字幕的总体简介。
- 严格按用户消息里给出的「现成章节目录」产出章节：目录里的每个时间戳 = 一章的起点，标题也用目录里的标题，不得增删章节、不得改动任何时间戳；你只为每章补写 summary（这一段讲了什么），依据是目录时间戳之间的字幕内容。
- 金句，附上它们在字幕中的时间戳。数量按时长掌握：每小时的字幕约 3-5 条，不足 1 小时按 1 小时算。

${OVERVIEW_INTRO_BLOCK}

${CHAPTER_SUMMARY_BLOCK}

${ASR_CORRECTION_BLOCK}

${TIMESTAMP_TEACHING_BLOCK}

${CHAPTER_OUTLINE_BLOCK}

⚠️ 关于「前情回顾」⚠️
长视频会切成多段分别处理。用户消息里如果出现「前情回顾」，那是上一段结尾的字幕，
给你的唯一用途是理解本段开头在承接什么话题、把跨越切点的内容看完整。
不要为前情回顾里的内容单独开章节，也不要从里面挑金句——它已经由上一段负责。
本段没有覆盖到的目录章节由别的段负责，不要替它们出章。

绝对不要：
- 编造字幕里根本不存在的时间戳
- 拿 0:00 当默认值——去字幕里找真实的那一行
- 使用早于起始时刻、或晚于结束时刻的时间戳（前情回顾里的时间戳一律不能用）

章节：用目录里那一章的时间戳
金句：找到包含该句的那一行，用那行的时间戳

输出 JSON（不要加 markdown 代码围栏）：
{
  "summary": "本次字幕的简介（2～3 句，约 80～150 字）",
  "chapters": [
    {"title": "章节标题", "timestamp": "0:00", "timestampSeconds": 0, "summary": "这一段讲了什么"}
  ],
  "keyQuotes": [
    {"quote": "整理后的原话", "timestamp": "2:30", "timestampSeconds": 150}
  ]
}

务必注意：
- timestamp：字幕行开头的 [M:SS]（如 "2:30"）
- timestampSeconds：换算成秒（2:30 = 2*60+30 = 150）
- 除非内容真的从 [0:00] 开始，否则不要用 0:00 / 0
- 每一个时间戳都必须在字幕里真实存在——去查！
- 所有文字用简体中文输出`;

export const OUTLINE_QUOTES_SYSTEM_PROMPT = `你是我的内容助理。我在看一个 B 站视频，请阅读下面的字幕，为给定的章节目录挑选金句。

你需要给出：
- 顶层 summary：本次字幕的总体简介。
- 金句，附上它们在字幕中的时间戳。数量按时长掌握：每小时的字幕约 3-5 条，不足 1 小时按 1 小时算。
- 不要产出章节，也不要写章节简介：用户消息里的「现成章节目录」就是最终的章节划分，标题与时间戳原样保留，你只负责总体简介与金句。

${OVERVIEW_INTRO_BLOCK}

${ASR_CORRECTION_BLOCK}

${TIMESTAMP_TEACHING_BLOCK}

⚠️ 关于「前情回顾」⚠️
长视频会切成多段分别处理。用户消息里如果出现「前情回顾」，那是上一段结尾的字幕，
给你的唯一用途是理解本段开头在承接什么话题、把跨越切点的内容看完整。
不要从前情回顾里挑金句——它已经由上一段负责。

绝对不要：
- 编造字幕里根本不存在的时间戳
- 拿 0:00 当默认值——去字幕里找真实的那一行
- 使用早于起始时刻、或晚于结束时刻的时间戳（前情回顾里的时间戳一律不能用）

金句：找到包含该句的那一行，用那行的时间戳

输出 JSON（不要加 markdown 代码围栏）：
{
  "summary": "本次字幕的简介（2～3 句，约 80～150 字）",
  "keyQuotes": [
    {"quote": "整理后的原话", "timestamp": "2:30", "timestampSeconds": 150}
  ]
}

务必注意：
- timestamp：字幕行开头的 [M:SS]（如 "2:30"）
- timestampSeconds：换算成秒（2:30 = 2*60+30 = 150）
- 除非内容真的从 [0:00] 开始，否则不要用 0:00 / 0
- 每一个时间戳都必须在字幕里真实存在——去查！
- 所有文字用简体中文输出`;

export const ANALYSIS_SUMMARY_SYSTEM_PROMPT = `你是我的内容助理。请根据各段内容概述，写出整支视频的总体简介。

要求：
- 用自然、易懂的简体中文写 2～3 句、约 80～150 字。
- 先说明视频讨论的问题和主要内容，再给出核心结论或观看价值；没有明确结论时客观概括即可。
- 综合全部材料，不要只复述第一段，不要写成小标题列表。
- 不要提及分段、缺失材料或生成过程，不要添加「核心结论：」等固定标签。

输出 JSON（不要加 markdown 代码围栏）：
{"summary": "全片简介（2～3 句，约 80～150 字）"}`;

const ANALYSIS_USER_TEMPLATE = `视频标题：{videoTitle}
UP 主：{ownerName}
{rangeNote}
本次字幕从 {startFormatted}（第 {minTimestampSeconds} 秒）到 {durationFormatted}（第 {maxTimestampSeconds} 秒）——时间戳必须落在这个区间内！
{lateThresholdLine}

视频简介（用它来校正人名、品牌名与术语的写法）：
{videoDescription}
{chapterOutlineNote}{contextNote}
字幕：
{transcriptText}`;

function renderAnalysisTranscript(items: unknown): string {
  return normalizeSubtitleItems(items)
    .map((item) => `[${formatClock(item?.from)}] ${String(item?.content ?? "").trim()}`)
    .join("\n");
}

export function tailItems(items: unknown, minChars: number): SubtitleBodyItem[] {
  const list = normalizeSubtitleItems(items);
  if (!list.length || minChars <= 0) return [];
  const tail: SubtitleBodyItem[] = [];
  let total = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    tail.unshift(list[i]);
    total += String(list[i]?.content ?? "").length;
    if (total >= minChars) break;
  }
  return tail;
}

function fillTemplate(template: string, vars: Record<string, unknown>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value ?? ""));
  }
  return out;
}

const ANALYSIS_LATE_THRESHOLD_RATIO = 0.75;

function analysisTimingVariables(
  items: unknown,
  durationSeconds: unknown
): { maxTimestampSeconds: number; durationFormatted: string; lateThreshold: string } {
  const list = normalizeSubtitleItems(items);
  const last = list.length ? list[list.length - 1] : null;
  const lastStampSeconds = last ? Math.max(0, Math.floor(Number(last?.to) || Number(last?.from) || 0)) : 0;
  const effectiveSeconds = Math.max(Math.floor(Number(durationSeconds) || 0), lastStampSeconds);
  return {
    maxTimestampSeconds: effectiveSeconds,
    durationFormatted: formatClock(effectiveSeconds),
    lateThreshold: formatClock(Math.floor(effectiveSeconds * ANALYSIS_LATE_THRESHOLD_RATIO))
  };
}

export function estimateOutputTokens(
  inputChars: unknown,
  { ratio = 1, floor = 1024, ceiling = DEFAULT_MAX_TOKENS }: { ratio?: number; floor?: number; ceiling?: number } = {}
): number {
  const chars = Number.isFinite(Number(inputChars)) && Number(inputChars) > 0 ? Number(inputChars) : 0;
  const estimated = Math.ceil(chars * ratio) + 512;
  return Math.min(
    Math.ceil(Number(ceiling) || DEFAULT_MAX_TOKENS),
    Math.max(Math.ceil(Number(floor) || 1024), estimated)
  );
}

function buildChapterOutlineNote(outline: OutlineChapter[] | undefined, titlesOnly?: boolean): string {
  if (!Array.isArray(outline) || outline.length === 0) {
    return "";
  }
  const lines = outline.map(
    (item) => `${formatClock(item.seconds)} ${item.title}`
  );
  return (
    `\n现成章节目录（来自视频章节/简介/评论，共 ${outline.length} 章）：\n` +
    `${lines.join("\n")}\n` +
    (titlesOnly
      ? `按系统提示词的要求：这份目录就是最终章节，边界与标题原样保留；不要为章节写逐章说明，总体简介与金句照常生成。`
      : `按系统提示词的要求：章节边界与标题必须完全照抄这份目录，不要增删或改动时间戳，只需为每章补写 summary。`) +
    `后段门槛不适用，最后一章以目录为准。\n`
  );
}

interface BuildAnalysisPromptInput {
  title?: unknown;
  ownerName?: unknown;
  videoDescription?: unknown;
  items?: unknown;
  contextItems?: unknown;
  videoDuration?: unknown;
  startSeconds?: unknown;
  segmentIndex?: unknown;
  totalSegments?: unknown;
  chapterOutline?: OutlineChapter[];
  titlesOnly?: boolean;
}

export interface BuiltAnalysisPrompt {
  prompt: string;
  timing: ReturnType<typeof analysisTimingVariables>;
  transcriptChars: number;
}

function buildRangeNote(
  segmentIndex: unknown,
  totalSegments: unknown,
  startSeconds: number,
  endSeconds: number
): string {
  const index = Math.floor(Number(segmentIndex) || 1);
  const total = Math.floor(Number(totalSegments) || 1);
  if (total <= 1) {
    return "";
  }
  return (
    `注意：这是长视频切分后的第 ${index} / ${total} 段，` +
    `覆盖 ${formatClock(startSeconds)} 到 ${formatClock(endSeconds)}。` +
    `只为这一段产出章节与金句，不要涉及其它时间段。`
  );
}

function buildContextNote(contextItems: unknown): string {
  const text = renderAnalysisTranscript(contextItems);
  if (!text) {
    return "";
  }
  return `\n前情回顾（上一段的结尾，只用来理解本段承接什么，不要为它开章节或挑金句）：\n${text}\n`;
}

function buildAnalysisUserPrompt(input: BuildAnalysisPromptInput = {}): BuiltAnalysisPrompt {
  const items = normalizeSubtitleItems(input.items);
  const timing = analysisTimingVariables(items, input.videoDuration);
  const startSeconds = Math.max(0, Math.floor(Number(input.startSeconds) || (items.length ? Number(items[0]?.from) || 0 : 0)));
  const lastItem = items.length ? items[items.length - 1] : null;
  const endSeconds = lastItem
    ? Math.max(startSeconds, Math.floor(Number(lastItem?.to) || Number(lastItem?.from) || startSeconds))
    : startSeconds;

  const transcriptText = renderAnalysisTranscript(items);
  const prompt = fillTemplate(ANALYSIS_USER_TEMPLATE, {
    videoTitle: String(input.title ?? "").trim() || "未知",
    ownerName: String(input.ownerName ?? "").trim() || "未知",
    rangeNote: buildRangeNote(input.segmentIndex, input.totalSegments, startSeconds, endSeconds),
    startFormatted: formatClock(startSeconds),
    minTimestampSeconds: startSeconds,
    durationFormatted: timing.durationFormatted,
    maxTimestampSeconds: timing.maxTimestampSeconds,
    lateThresholdLine: Array.isArray(input.chapterOutline) && input.chapterOutline.length
      ? "后段门槛：不适用——已采用现成章节目录，最后一章以目录为准。"
      : `后段门槛：最后一个章节的时间戳必须晚于 ${timing.lateThreshold}。`,
    videoDescription: String(input.videoDescription ?? "").trim() || "（无简介）",
    chapterOutlineNote: buildChapterOutlineNote(input.chapterOutline, input.titlesOnly),
    contextNote: buildContextNote(input.contextItems),
    transcriptText
  });
  return { prompt, timing, transcriptChars: transcriptText.length };
}

export function buildAnalysisPrompt(input: BuildAnalysisPromptInput = {}): BuiltAnalysisPrompt {
  return buildAnalysisUserPrompt(input);
}

export function buildAnalysisSummaryPrompt(
  parts: unknown,
  { title, maxTimestampSeconds }: { title?: unknown; maxTimestampSeconds?: unknown } = {}
): BuiltAnalysisPrompt {
  const sections = (Array.isArray(parts) ? parts : []).map((rawPart, index) => {
    const part = rawPart && typeof rawPart === "object" ? rawPart as {
      summary?: unknown;
      chapters?: Array<{ from?: unknown; title?: unknown; summary?: unknown }>;
    } : {};
    const summary = String(part.summary ?? "").trim();
    const chapters = (Array.isArray(part.chapters) ? part.chapters : [])
      .map((chapter) => {
        const chapterTitle = String(chapter?.title ?? "").trim();
        if (!chapterTitle) return "";
        const chapterSummary = String(chapter?.summary ?? "").trim();
        return `- ${formatClock(Number(chapter?.from) || 0)} ${chapterTitle}${chapterSummary ? `：${chapterSummary}` : ""}`;
      })
      .filter(Boolean)
      .join("\n");
    return [`第 ${index + 1} 段`, summary, chapters].filter(Boolean).join("\n");
  }).filter((section) => section.includes("\n"));
  const prompt = `视频标题：${String(title ?? "").trim() || "未知"}\n\n各段内容概述与章节：\n${sections.join("\n\n")}`;
  return {
    prompt,
    timing: analysisTimingVariables([], maxTimestampSeconds),
    transcriptChars: prompt.length
  };
}

const STATE_RELAY_QUOTE_LINE_BLOCK = `金句挑选与行号规则：
- 每小时字幕约挑选 3-5 条高光金句（本段通常 0-2 条，重质不重量）。
- 字幕每行格式为「#行号 [M:SS] 文本」。挑选金句时**不要改写或缩写原文**，只需输出该金句对应的原始字幕行号区间 startLine 与 endLine（单行时 endLine 等于 startLine），可附带简短 hint 便于对齐校验；系统将按行号从原始字幕精确回填逐字原话。
- 绝对不要为「前情只读字幕」中的行开章或挑金句。`;

const STATE_RELAY_CARD_BLOCK = `关于「滑动状态卡（nextStateCard）」：
- 若用户消息包含「前序状态卡」，请承接其中的主线论点、未闭合悬念与关键术语统一译名/简称，避免跨切点重复开章或同一专有名词前后译法飘移。
- 更新输出 nextStateCard（务必精炼，总计控制在约 100 Token 以内）：
  - rollingSummary：截至本段的核心主线论点（≤100字）
  - openThreads：尚未解答的悬念或跨段待续论证（最多 3 条短语）
  - confirmedEntities：本段及此前确认统一的关键术语、人名、简称（最多 8 个）
  - activeTopic：若本段结尾话题仍在延续，记录 { "title": "话题", "timestampSeconds": 起点秒数, "thesisDraft": "一句话草稿" }；已闭合则省略`;

export const STATE_RELAY_SYSTEM_PROMPT = `你是我的内容助理。正在对一个超长 B 站视频执行滑动状态卡接力分段扫描。

请基于本窗口字幕（以及可选的前序状态卡与前情只读字幕）完成：
1. 本段章节节点（chapters）：在话题真正转折处分章，尽量覆盖本段完整时间线；每章输出 title、timestampSeconds、summary（≤60字一句话核心论点）、keyEntities（2-5个关键实体/术语词）。
2. 本段高光金句行号区间（keyQuotes）：输出 startLine、endLine、timestampSeconds 与可选 hint。
3. 更新后的滑动状态卡（nextStateCard）。

${STATE_RELAY_QUOTE_LINE_BLOCK}

${STATE_RELAY_CARD_BLOCK}

输出纯 JSON（不要加 markdown 代码围栏）：
{
  "chapters": [
    {"title": "章节标题", "timestampSeconds": 900, "summary": "核心论点与大意", "keyEntities": ["术语A", "术语B"]}
  ],
  "keyQuotes": [
    {"startLine": 120, "endLine": 122, "timestampSeconds": 945, "hint": "首句线索"}
  ],
  "nextStateCard": {
    "rollingSummary": "截至本段的主线核心论点（≤100字）",
    "openThreads": ["待续问题1"],
    "confirmedEntities": ["统一术语A", "人名B"]
  }
}

所有文字用简体中文输出，时间戳与行号必须真实存在于本窗口字幕中。`;

export const STATE_RELAY_GIVEN_CHAPTERS_SYSTEM_PROMPT = `你是我的内容助理。正在对一个超长 B 站视频执行滑动状态卡接力分段扫描，并已提供现成章节目录。

请基于本窗口字幕完成：
1. 仅针对落在当前窗口时间区间内的给定目录章节，照抄其标题与时间戳并补写 summary（≤60字）与 keyEntities（2-5个关键实体词）；不在本窗口的目录章不要输出。
2. 本段高光金句行号区间（keyQuotes）：输出 startLine、endLine、timestampSeconds 与可选 hint。
3. 更新后的滑动状态卡（nextStateCard）。

${STATE_RELAY_QUOTE_LINE_BLOCK}

${STATE_RELAY_CARD_BLOCK}

输出纯 JSON（不要加 markdown 代码围栏）：
{
  "chapters": [
    {"title": "目录原标题", "timestampSeconds": 900, "summary": "这一章讲了什么", "keyEntities": ["术语A"]}
  ],
  "keyQuotes": [
    {"startLine": 120, "endLine": 122, "timestampSeconds": 945, "hint": "首句线索"}
  ],
  "nextStateCard": {
    "rollingSummary": "截至本段的主线核心论点（≤100字）",
    "openThreads": ["待续问题1"],
    "confirmedEntities": ["统一术语A"]
  }
}

所有文字用简体中文输出，行号必须真实存在于本窗口字幕中。`;

export const STATE_RELAY_OUTLINE_QUOTES_SYSTEM_PROMPT = `你是我的内容助理。正在对一个超长 B 站视频执行滑动状态卡接力分段扫描；用户已提供密集章节目录，边界与标题原样保留，不要生成章节或章节说明。

请基于本窗口字幕完成：
1. 本段高光金句行号区间（keyQuotes）：输出 startLine、endLine、timestampSeconds 与可选 hint。
2. 更新后的滑动状态卡（nextStateCard）。

${STATE_RELAY_QUOTE_LINE_BLOCK}

${STATE_RELAY_CARD_BLOCK}

输出纯 JSON（不要加 markdown 代码围栏）：
{
  "keyQuotes": [
    {"startLine": 120, "endLine": 122, "timestampSeconds": 945, "hint": "首句线索"}
  ],
  "nextStateCard": {
    "rollingSummary": "截至本段的主线核心论点（≤100字）",
    "openThreads": ["待续问题1"],
    "confirmedEntities": ["统一术语A"]
  }
}

所有文字用简体中文输出，行号必须真实存在于本窗口字幕中。`;

export const STATE_RELAY_FINAL_SUMMARY_SYSTEM_PROMPT = `你是我的内容助理。请仅根据全片 L1 章节目录节点与最终主线状态卡，提炼全片总体脉络简介。

要求：
- 用自然、易懂的简体中文写 2～3 句、约 80～150 字。
- 先说明视频讨论的核心问题与整体结构，再给出核心结论或观看价值。
- 不要写成小标题列表，不要提及分段、状态卡或生成过程，不要添加固定标签。

输出 JSON（不要加 markdown 代码围栏）：
{"summary": "全片总体简介（2～3 句，约 80～150 字）"}`;

export interface BuildStateRelayStepPromptInput {
  title?: unknown;
  ownerName?: unknown;
  videoDescription?: unknown;
  window: StateRelayWindow;
  totalWindows: number;
  previousStateCard: StateRelayCard | null;
  chapterOutline?: OutlineChapter[];
  titlesOnly?: boolean;
}

export function buildStateRelayStepPrompt(input: BuildStateRelayStepPromptInput): BuiltAnalysisPrompt {
  const { window, totalWindows } = input;
  const transcriptText = renderL0LinesWithNumbers(window.lines);
  const overlapText = renderL0LinesWithNumbers(window.overlapLines);
  const stateCardText = serializeStateRelayCard(input.previousStateCard);
  const outlineNote = buildChapterOutlineNote(input.chapterOutline, input.titlesOnly);

  const sections: string[] = [
    `视频标题：${String(input.title ?? "").trim() || "未知"}`,
    `UP 主：${String(input.ownerName ?? "").trim() || "未知"}`,
    `注意：这是长视频滑动状态接力扫描的第 ${window.windowIndex + 1} / ${totalWindows} 段，覆盖 ${formatClock(window.fromSeconds)}（第 ${window.fromSeconds} 秒，行 #${window.startLineNumber}）到 ${formatClock(window.toSeconds)}（第 ${window.toSeconds} 秒，行 #${window.endLineNumber}）。只为本窗口字幕开章和挑选金句。`,
    `视频简介（用于校正人名、品牌名与术语写法）：\n${String(input.videoDescription ?? "").trim() || "（无简介）"}`
  ];

  if (outlineNote) {
    sections.push(outlineNote.trim());
  }
  if (stateCardText) {
    sections.push(stateCardText);
  }
  if (overlapText) {
    sections.push(`前情只读字幕（仅供理解承接，禁止开章或挑金句）：\n${overlapText}`);
  }
  sections.push(`本段字幕（格式 #行号 [时间戳] 原文）：\n${transcriptText}`);

  const prompt = sections.join("\n\n");
  return {
    prompt,
    timing: analysisTimingVariables(window.lines, window.toSeconds),
    transcriptChars: transcriptText.length
  };
}

export function buildStateRelayFinalSummaryPrompt({
  title,
  videoDuration,
  chapters,
  finalStateCard
}: {
  title?: unknown;
  videoDuration?: unknown;
  chapters: readonly L1ChapterNode[];
  finalStateCard: StateRelayCard | null;
}): BuiltAnalysisPrompt {
  const lines = (Array.isArray(chapters) ? chapters : []).map((ch) => {
    const range = `[${formatClock(ch.from)}-${formatClock(ch.to)}]`;
    const thesis = ch.coreThesis ? `：${ch.coreThesis}` : "";
    const entities = ch.keyEntities.length > 0 ? `（关键术语：${ch.keyEntities.slice(0, 4).join("/")}）` : "";
    return `- ${range} ${ch.title}${thesis}${entities}`;
  });

  const parts: string[] = [`视频标题：${String(title ?? "").trim() || "未知"}`];
  if (finalStateCard) {
    const stateLines: string[] = [];
    if (finalStateCard.rollingSummary) {
      stateLines.push(`主线论点：${finalStateCard.rollingSummary}`);
    }
    if (finalStateCard.confirmedEntities.length > 0) {
      stateLines.push(`统一术语：${finalStateCard.confirmedEntities.join(" / ")}`);
    }
    if (finalStateCard.openThreads.length > 0) {
      stateLines.push(`延续线索：${finalStateCard.openThreads.join("；")}`);
    }
    if (stateLines.length > 0) {
      parts.push(`最终状态卡摘要：\n${stateLines.join("\n")}`);
    }
  }
  parts.push(`全片 L1 章节目录：\n${lines.join("\n") || "（无章节节点）"}`);

  const prompt = parts.join("\n\n");
  return {
    prompt,
    timing: analysisTimingVariables([], videoDuration),
    transcriptChars: prompt.length
  };
}
