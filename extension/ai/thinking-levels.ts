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

// 「未归一的档位外部值」——**归一化边界以外的值**的声明面（端口载荷 / 请求字段 / 存储值）。
//
// 归一化的施加点就是下面那条**一条归一化、两处消费**：请求侧的 resolveThinkingProfile /
// resolveThinkingAdjustment（它们的 ResolveThinkingInput.level 声明的就是本类型的值——那是
// 「未归一的外部值」，见 thinking-profiles）与设置 / 面板侧的 normalizeThinkingLevel 消费者。
// 所以**从端口载荷到请求构造的整条链（ladder / client / completion / map-reduce / tool-loop /
// analysis-orchestrate / adapter 的 ChatRequest）传的都是本类型的值**：合法档位、缺省、以及
// 端口里真实可到的任意脏值（非字符串、空串、上游的 `none`、编造词——
// tests/ai/thinking-default-fallback.test.ts 钉着这条路径）。链上只透传：不判、不归、不拒
//（归一化只在边界做一次）。
//
// 为什么是 unknown 而不是 string（票 thinking-seam-tightening/02）：`string` 是**假装已经
// 合法**的收窄，而这条路径上的值恰恰可能是任何东西；收成 `string` 会让链上的值重新长出
// 字符串语义、让「哪一层是归一化边界」重新变得看不见。链上签名一律用它，编译期断言见
// tests/ai/thinking-level-boundary.types.ts。
export type ThinkingLevelInput = unknown;

// 缺省 / 无法识别的脏值（含未定义、空串、上游的 none）一律归 `default`（不干预）：
// **一条归一化、两处消费**（2026-10-05 用户裁定两轮落地，见 docs/adr/0015 文末修订块）——
//   - 请求路径：thinking-profiles 的两个解析入口（resolveThinkingProfile /
//     resolveThinkingAdjustment）用它归一「偏好值 → 线上发什么」——缺省 / 脏值 = 不干预
//     （不发任何思考字段），两条协议链都在它们下游，探针语义不可能分叉；
//   - 存储 / 面板：core/validators.ts 再导出为 normalizeAiThinkingLevel，chat/providers.ts
//     的落盘与读回落走它——脏值不再被读成「显式关思考」（off），与出厂默认同一说法。
// 合法值（含 `default` 与 7 档）原样返回；显式 `off` 的语义不变（照旧走该平台的关思考写点）。
export function normalizeThinkingLevel(value: unknown): ThinkingLevelValue {
  return isThinkingLevelValue(value) ? value : THINKING_DEFAULT_LEVEL;
}
