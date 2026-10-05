// ai/thinking-levels.ts — 思考档位词表叶（7 档 + 档位序 + 归一化 + 「不干预」档）。
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

// 「不干预」档（2026-10-05 用户裁定）：**所有模型都可选、都可发**，落线 = 不发任何思考字段
// （由平台默认行为决定）。与 off 的区别：off 是显式发关思考字段（可能被平台忽略 / 400），
// default 是压根不表态。
// **刻意不进 `AI_THINKING_LEVELS`**：那个数组同时是 clamp 的档位序（「向下取最近可用档」），
// default 进去会被当成最小强度档参与级联，把「关不掉 → 落最小思考档」的既有裁定悄悄推翻。
// 因此这里分成两个词表：强度阶梯（`AI_THINKING_LEVELS`，clamp 用）与可选值（含 default，
// 存储 / 面板 / 归一化用）。
export const THINKING_DEFAULT_LEVEL = "default";
export const AI_THINKING_LEVEL_VALUES = [THINKING_DEFAULT_LEVEL, ...AI_THINKING_LEVELS] as const;

export type ThinkingLevelValue = (typeof AI_THINKING_LEVEL_VALUES)[number];

const LEVEL_SET: ReadonlySet<string> = new Set<string>(AI_THINKING_LEVELS);
const VALUE_SET: ReadonlySet<string> = new Set<string>(AI_THINKING_LEVEL_VALUES);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && LEVEL_SET.has(value);
}

export function isThinkingLevelValue(value: unknown): value is ThinkingLevelValue {
  return typeof value === "string" && VALUE_SET.has(value);
}

// 非法值（含未定义/空串/上游的 none）一律回落 off：存储归一化与请求侧同一口径。
// 合法值（含 default）原样返回。
export function normalizeThinkingLevel(value: unknown): ThinkingLevelValue {
  return isThinkingLevelValue(value) ? value : "off";
}
