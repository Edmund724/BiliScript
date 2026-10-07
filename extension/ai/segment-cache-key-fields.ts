// ai/segment-cache-key-fields.ts — 段缓存键位字段叶（架构评审候选 5）。
//
// 纯叶模块：零 import、零运行时依赖（不碰 chrome.storage / cache-lru / logging）。
// 为什么必须是零依赖叶：这份清单的四个消费者分处 SW 与 offscreen 两侧，而 offscreen
// 文档平台只开放 chrome.runtime、拿不到 chrome.storage——出站点 ai/segment-cache-proxy.ts
// 不能引用任何拖 storage 的层（segment-cache.ts / core/cache-lru.ts）。清单下沉到本叶后
// 两侧同源，不再各写一份字面量。先例：ai/protocol-vocab.ts / ai/thinking-levels.ts
// （同为 ai 域的零 import 词表叶）。
//
// 单一手写事实 = 下表：每行「族键位入参名（key）← 上下文字段名（context）」。两侧
// 不同名（selectedSubtitleId → subtitleId）是既有键形，不因本叶而变。
//
// 四个派生方（都不再手抄字段清单，加一个键位维度 = 只改下表一行）：
//   1. SW 侧键位装配：本叶 segmentCacheKeyFields（ai/segment-cache-handler.ts 消费）；
//   2. offscreen 出站点投影：本叶 projectSegmentCacheContext（ai/segment-cache-proxy.ts）；
//   3. 协议载荷类型：shared/messaging-protocol.ts 的 SegmentCacheContext（type-only 引入）；
//   4. 概览键位装配：ai/analysis-orchestrate.ts 的 contextKeyFields。
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

// 出站点 / 协议载荷的窄上下文形状（上下文字段名；缺失即 undefined，字段名与上表同源）。
export type SegmentCacheContextFields = { [K in SegmentCacheContextFieldName]?: unknown };

/**
 * AI 上下文 → 族键位入参（SW 侧键位装配的唯一实现）。
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
