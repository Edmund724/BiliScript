// ai/platform-identity-vocab.ts — 平台身份键词表叶（架构评审候选 6）。
//
// 纯叶模块：零 import（零运行时依赖，SW 静态图安全）。平台身份键空间的**唯一来源**。
//
// 「平台身份」= thinking 侧的平台识别口径（ai/thinking-profiles.ts 的 PROVIDERS 键）。
// 四张平台键表都以本词表索引：PROVIDERS 与三张 Messages 出口表
// （MESSAGES_TIER_EXIT / MESSAGES_OFF_EXIT / MESSAGES_ON_EXIT）一律声明为
// `Record<PlatformKey, …>`，于是「四张表键集恰相同」这件事从运行期对账
// （测试里三份 PLATFORM_KEYS + preset-registration-view 的运行时镜像）搬进类型：
//   - 新增平台缺一格 = tsc 红（不再表现为运行期走表外兜底的行为退化）；
//   - 表里多出一个孤儿键 = tsc 红（整类不再存在）。
// 运行期只余「表外 / 未识别平台 → 兜底格」这一条真实分支：查表入口收的是**任意串**
// （custom 直填端点、host 未识别的记录），isPlatformKey 只回答「是不是本词表的键」。
//
// 键空间的边界（三套键空间不合并，混用即误报）：
//   - PLATFORM_QUIRKS（ai/compat-vocab.ts）是**稀疏**声明面，其键是本词表的真子集
//     （siliconflow 有思考档位、无怪癖声明）；词表成员资格走 ai/platform-quirk-id.ts。
//   - presetId（core/presets.ts）是另一套键空间（PRESETS ∌ siliconflow、本词表 ∌ custom）。

export const PLATFORM_IDENTITY_KEYS = [
  "deepseek",
  "qwen",
  "zhipu",
  "moonshot",
  "minimax",
  "mimo",
  "openrouter",
  "stepfun",
  "modelscope",
  "ollama",
  "siliconflow",
  "amd",
  "sensenova",
  "opencodego",
  "gemini"
] as const;

export type PlatformKey = (typeof PLATFORM_IDENTITY_KEYS)[number];

const PLATFORM_KEY_SET: ReadonlySet<string> = new Set<string>(PLATFORM_IDENTITY_KEYS);

// 表内格的运行时判据（与各表的 hasOwnProperty 兜底同款语义：原型链上的键不算表内格）。
export function isPlatformKey(value: unknown): value is PlatformKey {
  return typeof value === "string" && PLATFORM_KEY_SET.has(value);
}
