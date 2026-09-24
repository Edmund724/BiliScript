// extension/core/defaults.ts
// Default settings shared across extension contexts. AI prompt 默认文本已拆至
// default-prompts.ts（first-button-ux/03）：常驻底座不搭车 prompt 文本。
// Pure data only — no logic; normalizers live in validators.ts /
// presets.ts, generic utils in shared/utils.ts.

// ===== Version =====
// Single source of truth for the extension version; consumed by the content
// script and the background side panel. Kept in sync with manifest.json's
// "version" by scripts/build-content.js' version guard.
// 实体在 core/version.ts（bootstrap 只打包这一个常量，不连带全部默认设置），
// 这里 re-export 维持既有 import 路径不变。
export { BILISCRIPT_VERSION } from "./version.js";

// ===== AI Prompts =====
// prompt 默认文本（当前第五代 + 各代 legacy 冻结常量）在 default-prompts.ts。
// DEFAULT_SETTINGS 的 prompt 字段是空占位："" / [] 经 validators.ts 归一化
// 回落当前默认（空串不落盘，新装/缺键/清空保存都收敛到当前默认文本）。

// PR5c：player-ai 的 storage 信箱（biliscript_player_ai_quick_action_v1）已随 AI
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
  // 2026-09 起默认开启：AI 键与 script 按钮一样进视频页即可见可点（此前默认
  // false，按钮对未手动开启的用户从不出现——设置门控挂载语义本身不变，见
  // content.ts 的启停接线与 ai/player-ai.ts 的 sync 门控）。存量显式 false 由
  // 安装/更新迁移一次性清位（entry/settings-migration.ts），此后用户显式关闭
  // 的值不再被后续更新翻转。
  enablePlayerAiQuickAction: true,
  aiBtnDefaultOnMigrated: false,
  // prompt 默认文本在 default-prompts.ts；此处空占位，validators 归一化回落。
  playerAiQuickPrompt: "",
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
  aiSystemPrompt: "",
  aiInitialQuickPrompts: [],
  aiPresetPrompts: [],
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
