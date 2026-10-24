// 默认提示词及其各代 legacy 冻结断言与迁移断言
// 确保默认提示词重构去重前后：
// 1. 全部导出逐字相等（含换行、标点、Emoji、空格）；
// 2. legacy 到当前默认的迁移映射与自定义提示词保持原样；
// 3. 导出键面不变。

import { describe, expect, it } from "vitest";
import * as defaultPrompts from "../../extension/core/default-prompts.js";
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_INITIAL_QUICK_PROMPTS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2,
  MAX_INITIAL_QUICK_PROMPTS
} from "../../extension/core/default-prompts.js";
import {
  normalizeAiInitialQuickPrompts,
  normalizeAiSystemPrompt,
  normalizePlayerAiQuickPrompt
} from "../../extension/core/validators.js";

// 改造前的原始冻结串副本（逐字、逐标点、逐换行锁定）：
const FROZEN_LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT =
  "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。";

const FROZEN_LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2 =
  "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。总结的详略按视频长度掌握，长视频不要压缩成短摘要。";

const FROZEN_DEFAULT_PLAYER_AI_QUICK_PROMPT = [
  "整理这期视频的内容，输出结构化总结：",
  "1. TL;DR：两三句话说清这期视频讲了什么、核心结论是什么",
  "2. 主题与核心观点",
  "3. 内容梳理：按视频脉络分节展开，关键节点附时间戳；重要数据、事实、金句和论证过程不要省略",
  "4. 结论与可执行启发：看完能带走什么、可以怎么做",
  "5. （若附带评论）观众反响：提炼高赞评论的主要观点与争议点"
].join("\n");

const FROZEN_MAX_INITIAL_QUICK_PROMPTS = 3;

const FROZEN_DEFAULT_INITIAL_QUICK_PROMPTS = [
  "用 3 句话总结这个视频",
  "提炼这个视频的 5 个重点",
  "按时间顺序整理这期视频的内容"
];

const FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习；自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

const FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2 = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

const FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3 = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "字幕多为语音识别（ASR）产物，同音错别字多：引用或整理时按上下文修正明显错字，人名、品牌名与术语尤须注意。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

const FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4 = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "字幕多为语音识别（ASR）产物，同音错别字多：引用或整理时按上下文修正明显错字，人名、品牌名与术语尤须注意。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "回答长度与视频时长和字幕量正相关：短视频精炼，长视频详尽，把重要事实、数据与论证细节收进来，大体量字幕的总结可以到数千字，不要把长视频压缩成短摘要。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

const FROZEN_DEFAULT_AI_SYSTEM_PROMPT = [
  "# 角色",
  "你是一名视频内容分析助手，服务于一个 B 站视频总结浏览器扩展。输入是视频字幕（多为 ASR 产物）与评论，输出是让用户「不看视频也能掌握全部重点」的结构化总结。",
  "",
  "# 输入处理规则",
  "- 字幕是语音识别产物，同音错别字多：引用和整理时按上下文修正明显错字，人名、品牌名、专业术语尤须注意；无法确定时保留原文。",
  "- 评论是观众观点，不是视频事实：仅用于提炼「观众反响」（高赞观点、共鸣点、争议点），不得混入视频内容本身。",
  "- 广告植入、口播带货、片头片尾客套、重复表达一律过滤，不占用篇幅。",
  "",
  "# 输出要求",
  "- 结构化、信息密度高：多用小标题和列表；有对比或并列数据时用表格。",
  "- 关键节点附时间戳，用普通正文格式（如 09:15、01:09:15），不要用反引号或代码块包裹。",
  "- 忠实于视频本身：不补充视频之外的知识，不评价对错；内容存疑或可能过时时，简短标注「（视频中的说法，建议核实）」。",
  "- 区分事实、数据、作者观点与推测：转述观点时用「UP 主认为/提到」等归属措辞。",
  "",
  "# 篇幅校准",
  "篇幅与视频时长、字幕量正相关：",
  "- 5 分钟以内：数百字精炼摘要",
  "- 5–30 分钟：完整要点覆盖，约 500–1500 字",
  "- 30 分钟以上或大体量字幕：详尽总结可达数千字，按内容自然分章节，重要事实、数据、论证细节尽量保留——绝不把长视频压成短摘要。",
  "",
  "# 边界",
  "- 信息不足（字幕缺失、音频听不清、内容与请求无关）时，明确指出哪部分无法总结，禁止猜测、编造、脑补。",
  "- 直接输出总结：不寒暄、不解释自己在做什么、不复述指令。"
].join("\n");

describe("default-prompts 冻结断言（逐字一致）", () => {
  it("导出的键面完整且未增减", () => {
    const expectedKeys = [
      "DEFAULT_AI_SYSTEM_PROMPT",
      "DEFAULT_INITIAL_QUICK_PROMPTS",
      "DEFAULT_PLAYER_AI_QUICK_PROMPT",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4",
      "LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT",
      "LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2",
      "MAX_INITIAL_QUICK_PROMPTS"
    ].sort();
    const actualKeys = Object.keys(defaultPrompts).sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it("LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT 逐字一致", () => {
    expect(LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT).toBe(FROZEN_LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT);
  });

  it("LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2 逐字一致", () => {
    expect(LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2).toBe(FROZEN_LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2);
  });

  it("DEFAULT_PLAYER_AI_QUICK_PROMPT 逐字一致", () => {
    expect(DEFAULT_PLAYER_AI_QUICK_PROMPT).toBe(FROZEN_DEFAULT_PLAYER_AI_QUICK_PROMPT);
  });

  it("MAX_INITIAL_QUICK_PROMPTS 数值一致", () => {
    expect(MAX_INITIAL_QUICK_PROMPTS).toBe(FROZEN_MAX_INITIAL_QUICK_PROMPTS);
  });

  it("DEFAULT_INITIAL_QUICK_PROMPTS 数组项逐字一致", () => {
    expect(DEFAULT_INITIAL_QUICK_PROMPTS).toEqual(FROZEN_DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  it("LEGACY_DEFAULT_AI_SYSTEM_PROMPT 逐字一致", () => {
    expect(LEGACY_DEFAULT_AI_SYSTEM_PROMPT).toBe(FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT);
  });

  it("LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2 逐字一致", () => {
    expect(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2).toBe(FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2);
  });

  it("LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3 逐字一致", () => {
    expect(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3).toBe(FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3);
  });

  it("LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4 逐字一致", () => {
    expect(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4).toBe(FROZEN_LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4);
  });

  it("DEFAULT_AI_SYSTEM_PROMPT 逐字一致", () => {
    expect(DEFAULT_AI_SYSTEM_PROMPT).toBe(FROZEN_DEFAULT_AI_SYSTEM_PROMPT);
  });
});

describe("提示词迁移映射与归一化断言", () => {
  it("normalizePlayerAiQuickPrompt 迁移与回落", () => {
    expect(normalizePlayerAiQuickPrompt(LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt(LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt("")).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt("   ")).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt(null)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt(undefined)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt("用户自定义快捷提示词")).toBe("用户自定义快捷提示词");
  });

  it("normalizeAiSystemPrompt 迁移与回落", () => {
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt("")).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt("   ")).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(null)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(undefined)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt("自定义系统提示词")).toBe("自定义系统提示词");
  });

  it("normalizeAiInitialQuickPrompts 归一化与条数限制", () => {
    expect(normalizeAiInitialQuickPrompts([])).toEqual([]);
    expect(normalizeAiInitialQuickPrompts(null)).toEqual([]);
    expect(normalizeAiInitialQuickPrompts([" 问题1 ", "", "  问题2  ", "问题3", "问题4"])).toEqual([
      "问题1",
      "问题2",
      "问题3"
    ]);
  });
});
