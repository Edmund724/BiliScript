export const LONG_VIDEO_DURATION_THRESHOLD_SECONDS = 1800;

export interface L0SubtitleLine {
  lineNumber: number;
  from: number;
  to: number;
  content: string;
}

export interface L0SemanticChunk {
  chunkIndex: number;
  startLineIdx: number;
  endLineIdx: number;
  startLineNumber: number;
  endLineNumber: number;
  fromSeconds: number;
  toSeconds: number;
  chapterIndex?: number;
  contextPrefix: string;
  bodyText: string;
  lines: readonly L0SubtitleLine[];
}

export interface L0ChunkHit {
  chunk: L0SemanticChunk;
  score: number;
  matchedTerms: readonly string[];
  coreTermCoverage: number;
  chapterIndex?: number;
}

export interface L0ContextWindow {
  anchorLineNumber: number;
  startLineNumber: number;
  endLineNumber: number;
  from: number;
  to: number;
  lines: readonly L0SubtitleLine[];
}

export interface L0LexicalSearchQuery {
  query?: string;
  terms?: readonly string[];
  timeRanges?: readonly RetrievalTimeRange[];
  topK?: number;
  windowRadiusLines?: number;
  windowRadiusSeconds?: number;
  maxInjectedChars?: number;
}

export interface L0LexicalHit {
  line: L0SubtitleLine;
  score: number;
  matchedTerms: readonly string[];
  chapterIndex?: number;
  window: L0ContextWindow;
}

export interface L0LexicalSearchResult {
  hits: readonly L0LexicalHit[];
  windows?: readonly L0ContextWindow[];
  totalLinesScanned: number;
  injectedChars: number;
  truncated: boolean;
}

export interface L1QuoteRef {
  from: number;
  content: string;
  lineNumber: number;
  chapterIndex?: number;
}

export interface L1ChapterNode {
  chapterIndex: number;
  title: string;
  from: number;
  to: number;
  coreThesis: string;
  keyEntities: readonly string[];
  quoteLineNumbers: readonly number[];
  startLineNumber?: number;
  endLineNumber?: number;
  missingSummary?: boolean;
}

export interface L1VideoIndexCacheRecord {
  schemaVersion: number;
  bvid: string;
  cid: string;
  sourceKey: string;
  subtitleSignature: string;
  videoDuration: number;
  lineCount: number;
  globalSummary: string;
  chapters: readonly L1ChapterNode[];
  quotes: readonly L1QuoteRef[];
  createdAt: number;
  updatedAt: number;
}

export interface L1VideoIndexCacheEnvelope {
  index: L1VideoIndexCacheRecord;
  timestamp: number;
}

export interface RelayActiveTopic {
  title: string;
  from: number;
  thesisDraft?: string;
}

export interface StateRelayCard {
  windowIndex: number;
  coveredUntilSeconds: number;
  coveredUntilLineNumber: number;
  rollingSummary: string;
  activeTopic?: RelayActiveTopic;
  confirmedEntities: readonly string[];
  openThreads: readonly string[];
  recentChapterTitles: readonly string[];
  collectedQuoteCount: number;
}

export interface StateRelayStepInput {
  windowIndex: number;
  totalWindows: number;
  fromSeconds: number;
  toSeconds: number;
  previousStateCard: StateRelayCard | null;
  lines: readonly L0SubtitleLine[];
  overlapLines?: readonly L0SubtitleLine[];
  givenChapters?: readonly L1ChapterNode[];
  titlesOnly?: boolean;
}

export interface StateRelayStepOutput {
  nextStateCard: StateRelayCard;
  windowSummary: string;
  chapters: readonly L1ChapterNode[];
  quotes: readonly L1QuoteRef[];
}

export interface RetrievalTimeRange {
  from: number;
  to: number;
  chapterIndex?: number;
  title?: string;
}

export type InteractionAnchorKind = "timestamp" | "explain-selection" | "playback-cursor";

export interface InteractionAnchorPoint {
  from: number;
  to?: number;
  lineNumber?: number;
  selection?: string;
  lineContent?: string;
}

export type ChatRetrievalFallbackPolicy =
  | "full-l0-bm25"
  | "compressed-summary-only";

export interface DirectAnswerRoutePlan {
  mode: "direct-answer";
  reason: string;
  includeL1Outline: boolean;
  includeGlobalSummary: boolean;
  includeCompressedSummary: boolean;
}

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

export interface InteractionAnchorRoutePlan {
  mode: "interaction-anchor";
  anchorKind: InteractionAnchorKind;
  reason: string;
  anchors: readonly InteractionAnchorPoint[];
  windowRadiusLines: number;
  maxInjectedChars: number;
  fallbackPolicy: ChatRetrievalFallbackPolicy;
}

export type ChatRetrievalRoutePlan =
  | DirectAnswerRoutePlan
  | HybridSingleHopRoutePlan
  | InteractionAnchorRoutePlan;

export type ChatRetrievalDegradeReason =
  | "l1-index-missing"
  | "chapter-range-empty-hits"
  | "l0-zero-hits"
  | "subtitle-unavailable"
  | "budget-capped";

export interface ChatRetrievalResolution {
  plan: ChatRetrievalRoutePlan;
  windows: readonly L0ContextWindow[];
  hits: readonly L0LexicalHit[];
  injectedChars: number;
  degraded: boolean;
  degradeReason?: ChatRetrievalDegradeReason;
}
