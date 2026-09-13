// extension/core/defaults.ts
// Default settings and default prompt constants shared across extension
// contexts. Pure data only — no logic; normalizers live in validators.ts /
// presets.ts, generic utils in shared/utils.ts.

// ===== Version =====
// Single source of truth for the extension version; consumed by the content
// script and the background side panel. Kept in sync with manifest.json's
// "version" by scripts/build-content.js' version guard.
// 实体在 core/version.ts（bootstrap 只打包这一个常量，不连带全部默认设置），
// 这里 re-export 维持既有 import 路径不变。
export { BOC_VERSION } from "./version.js";

// ===== AI Prompts =====
// 旧默认快捷提示词（长度规则引入前在用）：升新默认时冻结于此，供
// normalizePlayerAiQuickPrompt 对存量用户做一次性迁移。
export const LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT = "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。";

// 第二代默认快捷提示词（一行式 + 长度规则，第五代结构化默认引入前在用）：
// 升新默认时冻结于此，同机制迁移。
export const LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2 = "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。总结的详略按视频长度掌握，长视频不要压缩成短摘要。";

export const DEFAULT_PLAYER_AI_QUICK_PROMPT = [
  "整理这期视频的内容，输出结构化总结：",
  "1. TL;DR：两三句话说清这期视频讲了什么、核心结论是什么",
  "2. 主题与核心观点",
  "3. 内容梳理：按视频脉络分节展开，关键节点附时间戳；重要数据、事实、金句和论证过程不要省略",
  "4. 结论与可执行启发：看完能带走什么、可以怎么做",
  "5. （若附带评论）观众反响：提炼高赞评论的主要观点与争议点"
].join("\n");

export const DEFAULT_PRESET_PROMPTS = [
  "生成视频摘要和结论",
  "按章节整理视频内容",
  "生成带时间轴的笔记"
];

export const DEFAULT_INITIAL_QUICK_PROMPTS = [
  "用 3 句话总结这个视频",
  "提炼这个视频的 5 个重点",
  "按时间顺序整理这期视频的内容",
  "根据评论总结观众的看法"
];

export const LEGACY_DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习；自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

// 第二代默认（2026-09-13 前在用，无 ASR 提示行）：升第三代时冻结于此，供
// normalizeAiSystemPrompt 对存量用户做一次性迁移（与上面第一代的机制相同）。
export const LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2 = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

// 第三代默认（长度规则引入前在用）：升第四代时冻结于此，供
// normalizeAiSystemPrompt 对存量用户做一次性迁移（与第一/二代机制相同）。
export const LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3 = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "字幕多为语音识别（ASR）产物，同音错别字多：引用或整理时按上下文修正明显错字，人名、品牌名与术语尤须注意。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

// 第四代默认（分段式结构化默认引入前在用，一行式长度规则）：升第五代时冻结于
// 此，供 normalizeAiSystemPrompt 对存量用户做一次性迁移（与前几代机制相同）。
export const LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4 = [
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

export const DEFAULT_AI_SYSTEM_PROMPT = [
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

// PR5c：player-ai 的 storage 信箱（boc_player_ai_quick_action_v1）已随 AI
// 侧边栏摘除退役——快捷动作改走消息直发（reader-enter 的 chat 负载），
// 信箱键不再读写；存量键留存在用户 storage 中，无害。

export interface FixedFrontmatterProperty {
  key: string;
  type: "text" | "number" | "checkbox" | "list" | "date";
  value: string;
}

export interface NotePlaceholderSection {
  title: string;
  position: "before_intro" | "before_chapters" | "before_subtitle";
  content: string;
}

export interface Settings {
  [key: string]: unknown;
  tags: string;
  downloadFormat: string;
  includeDateInFilename: boolean;
  includeHotCommentsInNote: boolean;
  // 笔记正文顶部的 B 站播放器 <iframe>：默认开（Obsidian 等渲染内联 HTML 的
  // 编辑器可用），关闭后正文不再输出该行——MarkText 等按 GFM tagfilter 剥掉
  // iframe 的编辑器会把它渲染成一个空的 "Empty HTML Block" 占位块。仅影响
  // 笔记输出，不影响阅读面板内的播放。
  includePlayerEmbedInNote: boolean;
  enablePlayerAiQuickAction: boolean;
  // AI 键默认开迁移旗标（entry/settings-migration.ts）：true 表示存量显式
  // false 已随迁移改写回默认 true 一次，此后用户显式关闭的值不再被安装/更新
  // 迁移翻转。
  aiBtnDefaultOnMigrated: boolean;
  playerAiQuickPrompt: string;
  includeTimestampInBody: boolean;
  enableDebugLogs: boolean;
  readerTheme: string;
  // 主题手动选择哨兵：header 按钮点击循环置 true（updateReaderPreferences），
  // 从未手动选过则水合时按 prefers-color-scheme 定初始主题（不落盘）。
  readerThemeUserSet: boolean;
  frontmatterFields: string[];
  fixedFrontmatterProperties: FixedFrontmatterProperty[];
  notePlaceholderSections: NotePlaceholderSection[];
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
  aiPresetPrompts: string[];
  defaultModel: string;
  aiThinkingLevel: "off" | "low" | "high";
  activeAsrProviderId: string;
  asrAutoFallback: boolean;
  asrLanguage: string;
  // ===== 联网搜索（spec §3.2）=====
  // searchProviders 列表不在此处：provider 列表归 search/search-provider-store.js
  //（provider-store 收口，经 search-providers-save 消息写回），settings 只存标量。
  // activeSearchProviderId 对齐 ASR radio 心智（string，"" = 无激活平台；
  // spec 的 string | null 在 normalizeSettings 收口为 ""）。
  activeSearchProviderId: string; // 当前选用的搜索平台 id
  webSearchEnabled: boolean;      // 对话/选区解释链联网开关，全局记住上次状态，默认关
  webSearchMaxToolCalls: number;  // 单轮搜索次数上限（区间 1–10）
}

// ===== Merged default settings =====
export const DEFAULT_SETTINGS: Settings = {
  tags: "clippings,bilibili",
  downloadFormat: "srt",
  includeDateInFilename: true,
  includeHotCommentsInNote: false,
  includePlayerEmbedInNote: true,
  // 2026-09 起默认开启：AI 键与 digest 按钮一样进视频页即可见可点（此前默认
  // false，按钮对未手动开启的用户从不出现——设置门控挂载语义本身不变，见
  // content.ts 的启停接线与 ai/player-ai.ts 的 sync 门控）。存量显式 false 由
  // 安装/更新迁移一次性清位（entry/settings-migration.ts），此后用户显式关闭
  // 的值不再被后续更新翻转。
  enablePlayerAiQuickAction: true,
  aiBtnDefaultOnMigrated: false,
  playerAiQuickPrompt: DEFAULT_PLAYER_AI_QUICK_PROMPT,
  includeTimestampInBody: true,
  enableDebugLogs: false,
  readerTheme: "light",
  readerThemeUserSet: false,
  frontmatterFields: [
    "title",
    "url",
    "bvid",
    "cid",
    "author",
    "upload_date",
    "subtitle_lang",
    "created",
    "tags"
  ],
  fixedFrontmatterProperties: [],
  notePlaceholderSections: [],
  aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice(),
  defaultModel: "",
  aiThinkingLevel: "off",
  // ===== ASR（语音转写）回退配置 =====
  // asrProviders 列表不在此处：provider 列表归 asr/asr-provider-store.js
  // （provider-store 收口，经 asr-providers-save 消息写回），settings 只存标量。
  activeAsrProviderId: "",   // 当前选用的 ASR 平台 id
  asrAutoFallback: true,     // 无字幕轨时自动走 ASR；false 则仅提示
  asrLanguage: "auto",       // 转写语言档位（auto/zh/en），zh/en 传给平台
  // ===== 联网搜索标量（spec §3.2，走 save-settings 白名单）=====
  activeSearchProviderId: "", // 当前选用的搜索平台 id（单选激活，对齐 ASR radio）
  webSearchEnabled: false,    // 全局记住上次开关状态，默认关
  webSearchMaxToolCalls: 5    // 单轮搜索次数上限（1–10）
};
