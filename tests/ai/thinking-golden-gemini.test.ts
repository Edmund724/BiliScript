// tests/ai/thinking-golden-gemini.test.ts
// 思考参数 golden（Gemini 原生 generateContent 通道）——与 openai / anthropic 共用同一套
// 按类断言与六道防线（tests/ai/thinking-golden-defenses.ts）。
//
// 口径：
//   - 用例 = (valuesetId, 代表模型) × 7 档 → 逐字节整 body（contents + generationConfig）；
//   - 思考片段的形态是 `{ thinkingConfig: { thinkingLevel, includeThoughts? } }`，没有字段时
//     整个 generationConfig 不发射（2.5 系只有预算区间、toggle 值集、目录外模型都落这一格）；
//   - 通道只承载 `protocol: "gemini"` 的预设（跨协议组合不是产品路径）；
//   - 字面表由 scripts/artifacts/gen-golden-tables.ts 生成（留痕
//     07-golden-cases.generated.ts），生成器先与 06 请求体矩阵工件的 gemini:off/low/high
//     三列逐格对账；测试期由 F3 再对一次。
//
// 独立期望（本表之外的第二层）：tests/ai/adapter-gemini.test.ts 的逐族表手工钉住
// 「哪个模型家族发什么」，本表只钉「类 × 出口形态 → 整 body」的 7 档快照。

import { channelHarness, type ByClassCase } from "./thinking-golden-classes.js";
import { registerByClassDefenses, registerByClassGolden } from "./thinking-golden-defenses.js";

const HARNESS = channelHarness("gemini");

// ===== 按类用例表（生成器产物；勿手改，重跑 pnpm artifacts:sync）=====
// 字段序 = AI_THINKING_LEVELS（off/minimal/low/medium/high/xhigh/max）；{} = 不发任何字段。
const CASES: readonly ByClassCase[] = [
  { valuesetId: "b:128-32768", presetId: "gemini", model: "gemini-2.5-pro", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "low-high", presetId: "gemini", model: "gemini-3-pro-image", available: ["low", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "low-medium-high", presetId: "gemini", model: "gemini-3.1-pro-preview", available: ["low", "medium", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MEDIUM","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "minimal-high", presetId: "gemini", model: "gemini-3.1-flash-image", available: ["minimal", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "minimal-low-medium-high", presetId: "gemini", model: "gemini-3-flash-preview", available: ["minimal", "low", "medium", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MEDIUM","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "toggle", presetId: "gemini", model: "gemma-4-26b-a4b-it", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:0-24576", presetId: "gemini", model: "gemini-2.5-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:512-24576", presetId: "gemini", model: "gemini-2.5-flash-lite", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
];

registerByClassGolden(HARNESS, CASES);
registerByClassDefenses(HARNESS, CASES);
