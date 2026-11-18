// extension/ai/long-video-hybrid-types.ts
// 长视频「滑动状态接力总结 + L1 章节目录与 L0 本地轻量 BM25 混合单跳召回」纯类型契约（ADR-0027）。
//
// 约束：
// 1. 纯类型模块：零运行时 import、零运行时逻辑、零打包体积增量；
// 2. 领域命名对齐根目录 GLOSSARY.md（字幕 / 章节 / 金句 / 分段小结 / 压缩摘要 / 原始字幕缓存）；
// 3. 所有时间戳单位统一为秒（与 SubtitleBodyItem / AnalysisChapter / AnalysisQuote 一致），
//    行号（lineNumber）统一为归一化主轨字幕数组内的 0-based 下标。

// ============================================================
// 1. L0 词法层：原始字幕行、邻近扩窗片段与 BM25 检索命中
// ============================================================

/** L0 原始字幕行：对齐 ReadingSubtitleItem，保留显式行号与秒级起止时间戳。 */
export interface L0SubtitleLine {
  /** 主轨归一化字幕序列中的 0-based 行号 */
  lineNumber: number;
  /** 起始时间戳（秒） */
  from: number;
  /** 结束时间戳（秒） */
  to: number;
  /** 字幕文本正文 */
  content: string;
}

/** L0 邻近扩窗片段：以命中行或交互锚点为中心向前后扩展的连贯字幕上下文。 */
export interface L0ContextWindow {
  /** 触发该窗口的锚点行号（0-based） */
  anchorLineNumber: number;
  /** 扩窗起始行号（含） */
  startLineNumber: number;
  /** 扩窗结束行号（含） */
  endLineNumber: number;
  /** 窗口首行起始时间戳（秒） */
  from: number;
  /** 窗口末行结束时间戳（秒） */
  to: number;
  /** 窗口内的有序原始字幕行 */
  lines: readonly L0SubtitleLine[];
}

/** L0 本地轻量 BM25 检索输入参数。 */
export interface L0LexicalSearchQuery {
  /** 原始用户查询文本（与 terms 二选一或同时提供） */
  query?: string;
  /** 归一化与停用词过滤后的检索词项列表 */
  terms?: readonly string[];
  /** 可选的时间区间过滤（由 L1 章节路由选定）；缺省时检索全片 L0 */
  timeRanges?: readonly RetrievalTimeRange[];
  /** 返回命中上限 */
  topK?: number;
  /** 单条命中向前后扩展的字幕行数半径（N 句） */
  windowRadiusLines?: number;
  /** 单条命中向前后扩展的时间窗口半径（M 秒） */
  windowRadiusSeconds?: number;
  /** 全部命中窗口拼装后的字符预算上限 */
  maxInjectedChars?: number;
}

/** L0 词法检索单条命中结果。 */
export interface L0LexicalHit {
  /** 命中的核心字幕行 */
  line: L0SubtitleLine;
  /** 本地轻量 BM25 相关性得分 */
  score: number;
  /** 命中的检索词项集合 */
  matchedTerms: readonly string[];
  /** 所属 L1 章节节点索引（若已对齐章节目录） */
  chapterIndex?: number;
  /** 命中的邻近扩窗片段 */
  window: L0ContextWindow;
}

/** L0 词法检索汇总结果。 */
export interface L0LexicalSearchResult {
  hits: readonly L0LexicalHit[];
  /** 去重合并后的连续字幕上下文窗口列表（按时间/行号升序） */
  windows?: readonly L0ContextWindow[];
  totalLinesScanned: number;
  injectedChars: number;
  truncated: boolean;
}

// ============================================================
// 2. L1 章节目录层：章节节点、金句锚点与整片索引缓存结构
// ============================================================

/** 精选金句与 L0 原始字幕行号的关联结构（对齐 GLOSSARY「金句」）。 */
export interface L1QuoteRef {
  /** 金句时间戳（秒） */
  from: number;
  /** 纠偏润色后的金句正文 */
  content: string;
  /** 关联的 L0 原始字幕行号（0-based） */
  lineNumber: number;
  /** 所属 L1 章节序号（0-based，若位于首章前可缺省） */
  chapterIndex?: number;
}

/** L1 章节目录节点：在「概览」章节基础上承载核心论点、实体词与金句行号锚点。 */
export interface L1ChapterNode {
  /** 章节序号（0-based，按 from 升序） */
  chapterIndex: number;
  /** 章节标题 */
  title: string;
  /** 章节起始时间戳（秒） */
  from: number;
  /** 章节结束时间戳（秒） */
  to: number;
  /** 本章核心论点/一句话主旨 */
  coreThesis: string;
  /** 本章关键实体词列表（人名、机构、产品、术语等，供 L1->L0 术语补充检索） */
  keyEntities: readonly string[];
  /** 归属本章的精选金句关联行号列表（指向 L0SubtitleLine.lineNumber） */
  quoteLineNumbers: readonly number[];
  /** 章节覆盖的 L0 起始行号（可选，用于快速切片定位） */
  startLineNumber?: number;
  /** 章节覆盖的 L0 结束行号（可选，用于快速切片定位） */
  endLineNumber?: number;
  /** 给定章节缺说明时的占位标记（对齐 AnalysisChapter.missingSummary） */
  missingSummary?: boolean;
}

/** 整片 L1 章节目录索引缓存结构（按 bvid + cid + 字幕轨身份 + 字幕签名建键）。 */
export interface L1VideoIndexCacheRecord {
  /** 索引结构版本号，用于不兼容演进时失效重建 */
  schemaVersion: number;
  /** B 站视频 bvid */
  bvid: string;
  /** 分 P 标识 cid */
  cid: string;
  /** 字幕轨身份键（对齐 subtitle/source-key.ts 的 subtitleSourceKey 产物） */
  sourceKey: string;
  /** 字幕内容与分章来源签名（对齐 subtitle/cache.ts 的 buildSubtitleSignature 产物） */
  subtitleSignature: string;
  /** 视频总时长（秒） */
  videoDuration: number;
  /** 对应的 L0 原始字幕总行数 */
  lineCount: number;
  /** 全片总体简介 */
  globalSummary: string;
  /** 按时间升序排列的 L1 章节目录节点 */
  chapters: readonly L1ChapterNode[];
  /** 全片精选金句及其 L0 行号引用 */
  quotes: readonly L1QuoteRef[];
  /** 首次写入时间戳（毫秒） */
  createdAt: number;
  /** 最近更新时间戳（毫秒） */
  updatedAt: number;
}

/** 落入 chrome.storage.local 的 L1 索引缓存条目封包（对齐 core/cache-lru.ts 约定）。 */
export interface L1VideoIndexCacheEnvelope {
  index: L1VideoIndexCacheRecord;
  timestamp: number;
}

// ============================================================
// 3. 滑动状态接力总结：前序状态卡（State Card）输入/输出契约
// ============================================================

/** 跨窗口切点延续的当前活跃话题状态。 */
export interface RelayActiveTopic {
  title: string;
  from: number;
  thesisDraft?: string;
}

/** 滑动状态接力总结的「前序状态卡（State Card）」。 */
export interface StateRelayCard {
  /** 最近完成处理的窗口序号（0-based） */
  windowIndex: number;
  /** 已覆盖的视频时间游标（秒） */
  coveredUntilSeconds: number;
  /** 已覆盖的 L0 原始字幕行号（0-based） */
  coveredUntilLineNumber: number;
  /** 截至当前窗口的有界滚动主线摘要 */
  rollingSummary: string;
  /** 若上一窗口尾声的话题尚未结束，记录该活跃话题供下一窗口承接或闭合 */
  activeTopic?: RelayActiveTopic;
  /** 已确认并完成 ASR 同音纠偏的关键实体/专有名词列表 */
  confirmedEntities: readonly string[];
  /** 跨越切点的未闭合论证线索或待后续解答的伏笔 */
  openThreads: readonly string[];
  /** 近期已产出的章节标题，用于防止跨切点重复开章 */
  recentChapterTitles: readonly string[];
  /** 截至当前窗口已累计挑选的金句总数（用于全片每小时 3–5 条配额控制） */
  collectedQuoteCount: number;
}

/** 滑动状态接力总结单步输入。 */
export interface StateRelayStepInput {
  /** 当前窗口序号（0-based） */
  windowIndex: number;
  /** 计划总窗口数 */
  totalWindows: number;
  /** 当前窗口起始时间（秒） */
  fromSeconds: number;
  /** 当前窗口结束时间（秒） */
  toSeconds: number;
  /** 上一窗口传来的前序状态卡；首个窗口为 null */
  previousStateCard: StateRelayCard | null;
  /** 本窗口负责产出的 L0 原始字幕行 */
  lines: readonly L0SubtitleLine[];
  /** 可选的窗口边界前情只读字幕行（仅辅助语境理解，不归本窗口开章挑句） */
  overlapLines?: readonly L0SubtitleLine[];
  /** 存在现成时间轴/官方章节目录时的给定章节约束 */
  givenChapters?: readonly L1ChapterNode[];
  /** 密集时间轴仅保留标题模式（对齐 ChapterPlan.titlesOnly） */
  titlesOnly?: boolean;
}

/** 滑动状态接力总结单步输出。 */
export interface StateRelayStepOutput {
  /** 更新后传递给下一窗口的状态卡 */
  nextStateCard: StateRelayCard;
  /** 本窗口产出的分段小结（对齐 GLOSSARY「分段小结」） */
  windowSummary: string;
  /** 本窗口产出的 L1 章节目录节点 */
  chapters: readonly L1ChapterNode[];
  /** 本窗口筛选并锚定到 L0 行号的精选金句 */
  quotes: readonly L1QuoteRef[];
}

// ============================================================
// 4. 多轮对话渐进式单跳召回：路由计划与降级契约
// ============================================================

/** 路由选定的候选章节时间区间。 */
export interface RetrievalTimeRange {
  from: number;
  to: number;
  chapterIndex?: number;
  title?: string;
}

/** 交互锚点类型：显式时间戳 / 划词解释意图 / 当前播放游标。 */
export type InteractionAnchorKind = "timestamp" | "explain-selection" | "playback-cursor";

/** 交互锚点定位信息。 */
export interface InteractionAnchorPoint {
  /** 锚点起始时间戳（秒） */
  from: number;
  /** 锚点结束时间戳（秒，可选） */
  to?: number;
  /** 已知的 L0 原始字幕行号（0-based，可选） */
  lineNumber?: number;
  /** 划词选中的文本片段（explain-selection 场景） */
  selection?: string;
  /** 锚点所在字幕整句文本 */
  lineContent?: string;
}

/** 单跳召回零命中或索引缺失时的降级策略。 */
export type ChatRetrievalFallbackPolicy =
  | "full-l0-bm25"
  | "compressed-summary-only"
  | "legacy-raw-retrieval";

/** 路由模式一：直接作答（仅依托全局简介 / L1 章节目录 / 压缩摘要，不检索 L0）。 */
export interface DirectAnswerRoutePlan {
  mode: "direct-answer";
  reason: string;
  includeL1Outline: boolean;
  includeGlobalSummary: boolean;
  includeCompressedSummary: boolean;
}

/** 路由模式二：L1 选定章节时间区间 + 补充检索词 → L0 本地 BM25 单跳召回。 */
export interface HybridSingleHopRoutePlan {
  mode: "hybrid-single-hop";
  reason: string;
  chapterRanges: readonly RetrievalTimeRange[];
  lexicalTerms: readonly string[];
  maxHits: number;
  windowRadiusLines: number;
  maxInjectedChars: number;
  fallbackPolicy: ChatRetrievalFallbackPolicy;
}

/** 路由模式三：交互锚点直通（跳过 L1 路由，直接按锚点行号/时间戳扩窗抽取 L0）。 */
export interface InteractionAnchorRoutePlan {
  mode: "interaction-anchor";
  anchorKind: InteractionAnchorKind;
  reason: string;
  anchors: readonly InteractionAnchorPoint[];
  windowRadiusLines: number;
  maxInjectedChars: number;
  fallbackPolicy: ChatRetrievalFallbackPolicy;
}

/** 多轮对话渐进式单跳召回路由计划联合体。 */
export type ChatRetrievalRoutePlan =
  | DirectAnswerRoutePlan
  | HybridSingleHopRoutePlan
  | InteractionAnchorRoutePlan;

/** 单跳召回触发降级的原因枚举。 */
export type ChatRetrievalDegradeReason =
  | "l1-index-missing"
  | "chapter-range-empty-hits"
  | "l0-zero-hits"
  | "subtitle-unavailable"
  | "budget-capped";

/** 单跳召回执行后的上下文装配结果。 */
export interface ChatRetrievalResolution {
  plan: ChatRetrievalRoutePlan;
  windows: readonly L0ContextWindow[];
  hits: readonly L0LexicalHit[];
  injectedChars: number;
  degraded: boolean;
  degradeReason?: ChatRetrievalDegradeReason;
}
