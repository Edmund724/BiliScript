// ai/thinking-levels.ts — 思考档位词表叶（7 档 + 档位序 + 归一化）。
//
// 为什么独立成叶（05 号票）：档位取值域有两个消费者，而它们分处 SW 静态图的两侧——
//   - 请求路径：ai/thinking-profiles.ts（解析 + 落线；**在 SW 静态图禁区**，见
//     scripts/build.js 的 assertBackgroundStaticGraphSlim）；
//   - 设置归一化：core/validators.ts（在 SW 静态图里，不能反向 import thinking-profiles）。
// 词表本身是纯数据 + 一个谓词，下沉到零 import 的叶后两边同源、不复制第二份字面量。
// 先例：ai/protocol-vocab.ts（协议词表叶，core/ai-provider-store.ts 同样是 SW 侧消费者）。
//
// 档位序 = 上游 effort 词表的全序子集（off < minimal < low < medium < high < xhigh < max）；
// clamp（决策 #8「向下取」）依赖此序，改动序即改语义（tests/ai/thinking-levels.test.ts 钉住）。
// 上游的 `none` **不在**词表里：它是 `off` 的一种线值实现（决策 #7），不是独立档位。
export const AI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof AI_THINKING_LEVELS)[number];

const LEVEL_SET: ReadonlySet<string> = new Set<string>(AI_THINKING_LEVELS);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && LEVEL_SET.has(value);
}

// 非法值（含未定义/空串/上游的 none）一律回落 off：存储归一化与请求侧同一口径。
export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return isThinkingLevel(value) ? value : "off";
}
