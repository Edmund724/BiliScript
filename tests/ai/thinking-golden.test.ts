// tests/ai/thinking-golden.test.ts
// 思考参数 golden（openai chat/completions 通道）——07 号票改成**按类断言**：
//   `(valuesetId = 02 值集 id, 档位) → 请求体`，逐字节整 body（不做包含式）。
//
// 用例数据的来源（不手抄）：
//   - 类与代表平台/模型 = 02 号票产物（ASSIGNMENTS / VALUESETS / MODEL_ID_ALIASES）
//     经 tests/ai/thinking-golden-classes.ts 的枚举（每个 (类, 平台) 实现取排序首个模型）；
//   - 字面片段由 .scratch/.../artifacts/07-gen-golden-tables.ts 生成（留痕
//     artifacts/07-golden-cases.generated.ts），生成器自己先与 06 请求体矩阵工件
//     （artifacts/06-request-matrix.tsv，04-prune-matrix.ts 跑出，371 行）逐格对账；
//   - 测试期再对一次（F3），所以 runtime 漂移与手抄漂移都会红。
//
// 逐平台逐档的旧形状压成「类 × 出口形态」：本文件 60 个类实现（51 个值集全覆盖；18 号票
// 删平台 override 后，原先按平台声明分叉的同值集实现收敛成同一签名，用例数随之下降）。
// 同类的其它平台/模型由 F2 归纳完整性防线扫（产物里每个 (类, 平台) 实现的 7 档行为
// 必须有同签名用例承载）——旧 golden 的逐平台覆盖一行不丢，只是换成按类承载。
//
// 先列系统可能失败的方式（每条都有对应防线，注册在 thinking-golden-defenses.ts）：
//   F1 覆盖防线：02 产物新增值集而 golden 没加用例 → 红；
//   F2 归纳完整性：某 (类, 平台) 实现的行为没有用例承载 → 红；
//   F3 来源防线：用例字面值与 06 矩阵工件不一致（runtime 漂移 / 手抄漂移）→ 红；
//   F4 验收工件：07-golden-coverage.tsv 与用例表不符 → 红；
//   F5 表自洽：用例声明的 valuesetId / A' 与实际解析不符 → 红；
//   F6 塌陷：effort 血统 low==high（缺陷），或开关型/budget-only 的正当塌陷被改 → 红。
//
// 出口形态以矩阵为准（openai 通道实际出现五种：top-level `reasoning_effort` /
// `enable_thinking` / `thinking:{type}` / 不发任何字段，均有用例）。**矩阵里没有任何
// budget_tokens**（硬规则：本仓两通道都不发预算），故票面列的「按档 budget_tokens」
// 这一形态无回归钉——这是「实际出口形态以矩阵为准」的直接结论。
//
// 手工可读用例（票面非目标：不删，转成每方言一条）在本文件压到 5 条：
// openai（effort 词汇本体）/ siliconflow（enable_thinking）/ doubao（thinking:{type}）/
// ollama（无上游 preset 的 unknownClass 兜底）/ unknown 哨兵（三档不发）。
// 加上 Messages 通道的 7 条，两文件合计 12 条精确 body 钉（票面上限）。
// tokenParam（04 号票）与 ModelScope streamOnly（Q14A）语义不是方言钉，原样保留。

import { describe, expect, it } from "vitest";
import { channelHarness, type ByClassCase } from "./thinking-golden-classes.js";
import { registerByClassDefenses, registerByClassGolden } from "./thinking-golden-defenses.js";

const HARNESS = channelHarness("openai");

// ===== 按类用例表（生成器产物；勿手改，重跑 07-gen-golden-tables.ts）=====
// 字段序 = AI_THINKING_LEVELS（off/minimal/low/medium/high/xhigh/max）；{} = 不发任何字段。
const CASES: readonly ByClassCase[] = [
  { valuesetId: "b", presetId: "openrouter", model: "qwen/qwen3-next-80b-a3b-thinking", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "b:1024-", presetId: "openrouter", model: "anthropic/claude-haiku-4.5", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "b:128-32768", presetId: "openrouter", model: "google/gemini-2.5-pro", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "high", presetId: "openrouter", model: "openai/gpt-5-pro", available: ["high"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "high-max", presetId: "opencodego", model: "glm-5.2", available: ["high", "max"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "high-xhigh", presetId: "openrouter", model: "sakana/fugu-ultra", available: ["high", "xhigh"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "high-xhigh-max", presetId: "openrouter", model: "sakana/fugu-max", available: ["high", "xhigh", "max"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-high", presetId: "openrouter", model: "google/gemini-3-pro-image", available: ["low", "high"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "low-high-max", presetId: "moonshot", model: "k3-256k", available: ["low", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-medium", presetId: "amd", model: "Qwen3.8-27B", available: ["low", "medium"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}] },
  { valuesetId: "low-medium-high", presetId: "opencodego", model: "grok-4.5", available: ["low", "medium", "high"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "low-medium-high+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.5", available: ["low", "medium", "high"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "low-medium-high-max+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.6", available: ["low", "medium", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-medium-high-xhigh", presetId: "opencodego", model: "grok-4.6", available: ["low", "medium", "high", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "low-medium-high-xhigh-max", presetId: "opencodego", model: "space-bunny-free", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-medium-xhigh", presetId: "amd", model: "Qwen3.8-Flash-Next", available: ["low", "medium", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2-pro", available: ["medium", "high", "xhigh"], fields: [{"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "minimal-high", presetId: "openrouter", model: "google/gemini-3.1-flash-image", available: ["minimal", "high"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "minimal-low-medium-high", presetId: "openrouter", model: "google/gemini-3-flash-preview", available: ["minimal", "low", "medium", "high"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "minimal-low-medium-high-xhigh", presetId: "opencodego", model: "muse-spark-1.2-contributor", available: ["minimal", "low", "medium", "high", "xhigh"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "minimal-low-medium-high-xhigh-max", presetId: "openrouter", model: "meta/muse-spark-1.3", available: ["minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-high", presetId: "opencodego", model: "hy4-preview", available: ["off", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-low-high", presetId: "opencodego", model: "hy3", available: ["off", "low", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-low-medium-high", presetId: "openrouter", model: "inception/mercury-2", available: ["off", "low", "medium", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-low-medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2", available: ["off", "low", "medium", "high", "xhigh"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "none-low-medium-high-xhigh-max", presetId: "opencodego", model: "gpt-5.6-luna", available: ["off", "low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-low-medium-xhigh", presetId: "openrouter", model: "qwen/qwen3.8-omni-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "none-medium-high", presetId: "openrouter", model: "nex-agi/nex-n2.5-mini", available: ["off", "medium", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-minimal-low-medium-high", presetId: "openrouter", model: "perceptron/perceptron-mk1.5", available: ["off", "minimal", "low", "medium", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-minimal-low-medium-high-max", presetId: "openrouter", model: "thinkingmachines/inkling", available: ["off", "minimal", "low", "medium", "high", "max"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-minimal-low-medium-high-xhigh-max", presetId: "openrouter", model: "upstage/solar-mini4", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle", presetId: "mimo", model: "mimo-v2-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle", presetId: "minimax", model: "MiniMax-M3", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle", presetId: "moonshot", model: "kimi-k2.6", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b", presetId: "openrouter", model: "meituan/longcat-2.0", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b", presetId: "qwen", model: "qwen3.6-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-131072", presetId: "qwen", model: "glm-5.1", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-262144", presetId: "opencodego", model: "qwen3.7-max", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:-262144", presetId: "qwen", model: "qwen3.7-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-32768", presetId: "qwen", model: "glm-5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-38912", presetId: "qwen", model: "qwen-turbo", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-81920", presetId: "opencodego", model: "qwen3.6-plus", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:-81920", presetId: "qwen", model: "kimi-k2.5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:0-24576", presetId: "openrouter", model: "google/gemini-2.5-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:512-24576", presetId: "openrouter", model: "google/gemini-2.5-flash-lite", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+low-high-max", presetId: "amd", model: "DeepSeek-V4-Flash", available: ["low", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-high-max", presetId: "deepseek", model: "deepseek-flash", available: ["off", "low", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-high-max", presetId: "qwen", model: "deepseek-v4-flash", available: ["off", "low", "high", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":false}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-medium+b", presetId: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b", available: ["low", "medium"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}] },
  { valuesetId: "toggle+low-medium-high", presetId: "openrouter", model: "bytedance-seed/seed-2.0-code", available: ["low", "medium", "high"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "toggle+low-medium-high-xhigh-max", presetId: "openrouter", model: "anthropic/claude-sonnet-5", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-medium-xhigh", presetId: "openrouter", model: "qwen/qwen3.8-27b", available: ["low", "medium", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "opencodego", model: "qwen3.8-flash", available: ["low", "medium", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "qwen", model: "qwen3.8-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"enable_thinking":false}, {"enable_thinking":false}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "opencodego", model: "qwen3.8-max", available: ["low", "medium", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "qwen", model: "qwen3.8-max", available: ["off", "low", "medium", "xhigh"], fields: [{"enable_thinking":false}, {"enable_thinking":false}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+medium-high+b", presetId: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b", available: ["medium", "high"], fields: [{"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "toggle+medium-xhigh", presetId: "openrouter", model: "prism-ml/ternary-bonsai-2-27b", available: ["medium", "xhigh"], fields: [{"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+minimal-low-medium-high", presetId: "openrouter", model: "bytedance-seed/seed-2.0-lite", available: ["minimal", "low", "medium", "high"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
];

registerByClassGolden(HARNESS, CASES);
registerByClassDefenses(HARNESS, CASES);

// ===== 每方言一条逐平台精确 body（真实平台回归钉；≤12 条）=====
describe("golden：每方言一条精确 body（openai 通道）", () => {
  it("(1) api.openai.com + gpt-5.1：top-level reasoning_effort（off 用 none 实现关思考）", () => {
    const baseUrl = "https://api.openai.com/v1";
    expect(HARNESS.bodyAt({ baseUrl, model: "gpt-5.1", level: "off" })).toEqual(HARNESS.expectedBody("gpt-5.1", { reasoning_effort: "none" }));
    expect(HARNESS.bodyAt({ baseUrl, model: "gpt-5.1", level: "low" })).toEqual(HARNESS.expectedBody("gpt-5.1", { reasoning_effort: "low" }));
  });

  it("(2) api.siliconflow.cn + qwen3-max：enable_thinking 开关词汇（裸 id 命中模式表）", () => {
    const baseUrl = "https://api.siliconflow.cn/v1";
    // 开关型血统：该通道只有开/关两态，low 与 high 同为 enable_thinking:true——
    // 上游 qwen3-max 的 reasoning_options 是 [toggle, budget_tokens max 81920]（无 effort），
    // 没有档位词可发，塌陷是上游唯一支持的形状，不是缺陷（同 qwen3-max 的 Messages 侧）。
    expect(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level: "off" })).toEqual(HARNESS.expectedBody("qwen3-max", { enable_thinking: false }));
    for (const level of ["low", "high"] as const) {
      expect(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level }), level).toEqual(HARNESS.expectedBody("qwen3-max", { enable_thinking: true }));
    }
    expect(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level: "low" })).toEqual(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level: "high" }));
  });

  it("(3) api.doubao.com + doubao-seed-1.6：thinking:{type} 开关词汇（域名已死，血统仍识别）", () => {
    const baseUrl = "https://api.doubao.com/v1";
    expect(HARNESS.bodyAt({ baseUrl, model: "doubao-seed-1.6", level: "off" })).toEqual(
      HARNESS.expectedBody("doubao-seed-1.6", { thinking: { type: "disabled" } })
    );
    expect(HARNESS.bodyAt({ baseUrl, model: "doubao-seed-1.6", level: "low" })).toEqual(
      HARNESS.expectedBody("doubao-seed-1.6", { thinking: { type: "enabled" } })
    );
  });

  it("(4) ollama + llama3.2：无上游 preset，unknownClass 兜底发 effort 词汇（off=none）", () => {
    expect(HARNESS.bodyAt({ presetId: "ollama", model: "llama3.2", level: "off" })).toEqual(HARNESS.expectedBody("llama3.2", { reasoning_effort: "none" }));
    expect(HARNESS.bodyAt({ presetId: "ollama", model: "llama3.2", level: "low" })).toEqual(HARNESS.expectedBody("llama3.2", { reasoning_effort: "low" }));
  });

  it("(5) unknown 哨兵：未列模型（自填端点 / openai host 的 gpt-4o）三档都不发思考字段", () => {
    for (const level of ["off", "low", "high"] as const) {
      expect(HARNESS.bodyAt({ baseUrl: "https://api.example.com/v1", model: "vendor-future-1", level }), level).toEqual(
        HARNESS.expectedBody("vendor-future-1", {})
      );
      expect(HARNESS.bodyAt({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o", level }), level).toEqual(HARNESS.expectedBody("gpt-4o", {}));
    }
  });
});

// ModelScope 裸 id 命中模式表（血统声明关思考仅流式）：非流式 off 被 streamOnly 阻断 →
// 级联落开档；与 Messages 通道同源的 qwen3-hybrid-switch-streamonly 事实（Q14A）。
describe("golden（openai）：ModelScope qwen3-32b 关思考仅流式（stream 维度）", () => {
  it("非流式 off → 级联落 enable_thinking:true", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off" })).toEqual(
      HARNESS.expectedBody("qwen3-32b", { enable_thinking: true })
    );
  });

  it("流式 off → 真发 enable_thinking:false", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off", stream: true })).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      enable_thinking: false
    });
  });
});

// token 参数名映射（04 号票）：openai-reasoning 系类声明 tokenParam=
// "max_completion_tokens"（reasoning 模型不认 max_tokens，传了 400），maxTokens
// 写入请求体时随表换名且不得再出现 max_tokens；其余类与 unknown（resolver 不
// 返回 tokenParam）维持 max_tokens 现状不变（OpenRouter 透传上游同理）。
describe("golden：token 参数名映射（maxTokens 按类换名，04 号票）", () => {
  const OPENAI = "https://api.openai.com/v1";
  const DEEPSEEK = "https://api.deepseek.com/v1";
  const QWEN = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const OPENROUTER = "https://openrouter.ai/api/v1";

  it("openai-reasoning（gpt-5.1）+ maxTokens → max_completion_tokens，无 max_tokens", () => {
    const body = HARNESS.bodyAt({ baseUrl: OPENAI, model: "gpt-5.1", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoning_effort: "low",
      max_completion_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("openai-reasoning always 系（o3）+ maxTokens → max_completion_tokens（off 级联 low 同换名）", () => {
    const body = HARNESS.bodyAt({ baseUrl: OPENAI, model: "o3", level: "off", maxTokens: 1 });
    expect(body).toEqual({
      model: "o3",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoning_effort: "low",
      max_completion_tokens: 1
    });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("qwen 混合（qwen3-max）+ maxTokens → 仍 max_tokens（现状不变）", () => {
    const body = HARNESS.bodyAt({ baseUrl: QWEN, model: "qwen3-max", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "qwen3-max",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      enable_thinking: true,
      max_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("deepseek v4（deepseek-v4-pro）+ maxTokens → 仍 max_tokens", () => {
    const body = HARNESS.bodyAt({ baseUrl: DEEPSEEK, model: "deepseek-v4-pro", level: "off", maxTokens: 4096 });
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      thinking: { type: "disabled" },
      max_tokens: 4096
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("unknown 模型 + maxTokens → max_tokens（默认参数名）", () => {
    const body = HARNESS.bodyAt({ baseUrl: "https://api.example.com/v1", model: "vendor-future-1", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "vendor-future-1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("OpenRouter（18 号票起走上游词表投影）+ maxTokens → 仍 max_tokens（spec token 维度）", () => {
    const body = HARNESS.bodyAt({ baseUrl: OPENROUTER, model: "deepseek-v4-pro", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoning_effort: "low",
      max_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
