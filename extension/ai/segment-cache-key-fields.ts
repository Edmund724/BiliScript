// ai/segment-cache-key-fields.ts — 段缓存键位字段叶（架构评审候选 5）。
//
// 纯叶模块：零 import、零运行时依赖（不碰 chrome.storage / cache-lru / logging）。
// 为什么必须是零依赖叶：这份清单的消费者分处 SW 与 offscreen 两侧，而 offscreen
// 文档平台只开放 chrome.runtime、拿不到 chrome.storage——出站点 ai/segment-cache-proxy.ts
// 不能引用任何拖 storage 的层（segment-cache.ts / core/cache-lru.ts）。清单下沉到本叶后
// 两侧同源，不再各写一份字面量。先例：ai/protocol-vocab.ts / ai/thinking-levels.ts
// （同为 ai 域的零 import 词表叶）。
//
// 单一手写事实 = 下表：每行「族键位入参名（key）← 上下文字段名（context）」。两侧
// 不同名（selectedSubtitleId → subtitleId）是既有键形，不因本叶而变。
//
// 派生方（都不再手抄字段清单，加一个键位维度 = 只改下表一行）：
//   1. SW 侧 raw 键位装配：本叶 segmentCacheKeyFields（ai/segment-cache.ts 消费）；
//   2. SW 侧 string 键位装配：本叶 segmentCacheKeyStringFields（ai/segment-cache-handler.ts 消费）；
//   3. offscreen 出站点投影：本叶 projectSegmentCacheContext（ai/segment-cache-proxy.ts）；
//   4. 协议载荷类型：shared/messaging-protocol.ts 的 SegmentCacheContext（type-only 引入）；
//   5. 概览键位装配：ai/analysis-orchestrate.ts 的 contextKeyFields（经 segmentCacheKeyStringFields）。
//
// 口径等价性判据（arch-review-batch4/02）：
// 编排侧原 `String(v ?? "")` 与消费侧原 `String(v || "")` 在现键值域（bvid 为 BV 号串，
// cid 为正整数/串，subtitleId 为正整数/ASR伪轨串，subtitleUrl 为 URL 串，lang 为语言代码串；
// 缺省为 undefined/null/空串）上严格等价：
//   - 缺失值（undefined / null / ""）：两口径均归一为空串 ""；
//   - 域内有效值（非空串、正整数）：均为真值（truthy），两口径均得 String(v)；
//   - 差异仅在域外 falsy 值（0 / false / NaN 等）：`?? ""` 保留字面量（"0" / "false"），
//     `|| ""` 吞为空串。
// 故在现键值域上两口径可观测等价。统一采用保留字面量的 `String(raw ?? "")` 收敛为单源命名投影
// segmentCacheKeyStringFields，raw / string 两种口径并排由调用方按名点选，族键字节逐位冻结。
//
// 族键算法（core/cache-lru.ts 的 key()：prefix + bvid + cid + sourceKey + tail）读的是
// 键位入参名、不读本表，所以「表里的每个维度都真实改变族键」这半条由测试钉住——
// tests/ai/segment-cache-key-fields.test.ts 逐维断言族键变化：新维度没接进 key()
// 会在那里红，而不是静默串键（表现是缓存互相命中、不报错）。
export const SEGMENT_CACHE_KEY_FIELDS = [
  { key: "bvid", context: "bvid" },
  { key: "cid", context: "cid" },
  { key: "subtitleId", context: "selectedSubtitleId" },
  { key: "subtitleUrl", context: "selectedSubtitleUrl" },
  { key: "lang", context: "subtitleLang" }
] as const;

export type SegmentCacheKeyFieldName = (typeof SEGMENT_CACHE_KEY_FIELDS)[number]["key"];
export type SegmentCacheContextFieldName = (typeof SEGMENT_CACHE_KEY_FIELDS)[number]["context"];

// 族键位入参形状（表里每个维度恒在；值一律 unknown——未归一的上下文值原样透传）。
export type SegmentCacheKeyFields = { [K in SegmentCacheKeyFieldName]: unknown };

// 族键位字符串化入参形状（表里每个维度恒在；值一律 string——缺失值归一为空串 ""，保留 0/false 等字面量）。
export type SegmentCacheKeyStringFields = { [K in SegmentCacheKeyFieldName]: string };

// 出站点 / 协议载荷的窄上下文形状（上下文字段名；缺失即 undefined，字段名与上表同源）。
export type SegmentCacheContextFields = { [K in SegmentCacheContextFieldName]?: unknown };

/**
 * AI 上下文 → 族键位入参（SW 侧键位装配的 raw 实现）。
 * 键位字段恒在（值缺失即 undefined）；字段名映射单源在上表，落盘 / 复用 / 概览三处
 * 共用同一份投影，键位不再各自手拼。
 */
export function segmentCacheKeyFields(context?: Record<string, unknown> | null): SegmentCacheKeyFields {
  const fields = {} as Record<SegmentCacheKeyFieldName, unknown>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    fields[field.key] = context ? context[field.context] : undefined;
  }
  return fields;
}

/**
 * AI 上下文 → 字符串化族键位入参（显式命名 string 投影，SW 读原始段与概览键位装配单源）。
 * 键位字段恒在；缺失值（undefined / null）归一为空串 ""，保留 0 / false 等 falsy 值的字面量。
 */
export function segmentCacheKeyStringFields(context?: Record<string, unknown> | null): SegmentCacheKeyStringFields {
  const fields = {} as Record<SegmentCacheKeyFieldName, string>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    const raw = context ? context[field.context] : undefined;
    fields[field.key] = String(raw ?? "");
  }
  return fields;
}

/**
 * AI 上下文 → 出站点载荷（offscreen 侧投影的唯一实现）：整份 AiContext（含 ≥200k 字符的
 * subtitleBody）的无关字段挡在传输层之外，键位维度一个不少（字段名 = 上下文字段名）。
 */
export function projectSegmentCacheContext(context?: Record<string, unknown> | null): SegmentCacheContextFields {
  const fields = {} as Record<SegmentCacheContextFieldName, unknown>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    fields[field.context] = context ? context[field.context] : undefined;
  }
  return fields;
}
