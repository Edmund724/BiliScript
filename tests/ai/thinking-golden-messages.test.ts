// tests/ai/thinking-golden-messages.test.ts
// 思考参数 golden（Anthropic Messages 通道）——07 号票改成**按类断言**：
//   `(valuesetId = 02 值集 id, 档位) → 请求体`，逐字节整 body（不做包含式）。
//
// 用例数据的来源（不手抄）：类与代表平台/模型来自 02 号票产物（ASSIGNMENTS / VALUESETS /
// MODEL_ID_ALIASES），字面片段由 .scratch/.../artifacts/07-gen-golden-tables.ts 生成
// （留痕 artifacts/07-golden-cases.generated.ts），生成器先与 06 请求体矩阵工件
// （artifacts/06-request-matrix.tsv，04-prune-matrix.ts 跑出，371 行）逐格对账，测试期
// 再对一次（F3）。baseUrl 一律走 PRESETS（protocolBaseUrls.anthropic，缺省回落 baseUrl），
// 不在本文件手抄 URL；`max_tokens` 走 adapter 默认 DEFAULT_MAX_TOKENS = 32768，由
// expectedBody 钉住字面值。
//
// 逐平台逐档的旧形状压成「类 × 出口形态」：本文件 66 个类实现（51 个值集全覆盖；18 号票
// 删平台 override 后，原先按平台声明分叉的同值集实现收敛成同一签名，用例数随之下降）。
// 同类的其它平台/模型由 F2 归纳完整性防线扫（产物里每个 (类, 平台) 实现的 7 档行为
// 必须有同签名用例承载）——旧 Messages golden（含 12 号票的 31 行裁决矩阵）的覆盖一行不丢：
// `low-high-max` 的代表实现是 opencodego/deepseek-v4-flash（13 号票 canonical 优先后
// kimi-k3 走同一值集），`toggle+low-medium-xhigh+b:0-262144` 的代表实现是
// opencodego/qwen3.8-max（05 号票的 clamp 分歧值集）。
//
// 先列系统可能失败的方式（每条都有对应防线，注册在 thinking-golden-defenses.ts）：
//   F1 覆盖防线：02 产物新增值集而 golden 没加用例 → 红；
//   F2 归纳完整性：某 (类, 平台) 实现的行为没有用例承载 → 红；
//   F3 来源防线：用例字面值与 06 矩阵工件不一致（runtime 漂移 / 手抄漂移）→ 红；
//   F4 验收工件：07-golden-coverage.tsv 与用例表不符 → 红；
//   F5 表自洽：用例声明的 valuesetId / A' 与实际解析不符 → 红；
//   F6 塌陷：effort 血统 low==high（缺陷），或开关型/budget-only 的正当塌陷被改 → 红。
//
// 出口形态以矩阵为准（Messages 通道实际出现六种，均有用例）：
//   `thinking:{type:"disabled"}` 单独（关思考出口）/ 裸 `thinking:{type:"enabled"}`（开关型开档）/
//   `thinking:{type:"enabled"}` + `output_config.effort`（平台登记了开思考开关的档位出口）/
//   裸 `output_config.effort` / 顶层 `reasoning_effort` / 不发任何字段。
//   **矩阵里没有任何 budget_tokens**（文件头硬规则：本通道任何一格都不发预算）——
//   票面列的「按档 budget_tokens」形态不存在，故无回归钉。
//
// 手工可读用例（票面非目标：不删，转成每方言一条）在本文件压到 7 条：
// deepseek（关思考）/ qwen3-max（开关型开档）/ qwen3.8-max（开关+档位）/
// opencodego（裸档位）/ moonshot（顶层 reasoning_effort）/ budget-only（不发字段）/
// opencodego/kimi-k3（13 号票 canonical 词表 + opencodego 出口，off 级联落 low）。
// 加上 openai 通道的 5 条，两文件合计 12 条精确 body 钉（票面上限）。
// probe（probeOmitsThinking）与 ModelScope streamOnly（Q14A）语义不是方言钉，原样保留。

import { describe, expect, it } from "vitest";
import { channelHarness, type BodyRequest, type ByClassCase } from "./thinking-golden-classes.js";
import { registerByClassDefenses, registerByClassGolden } from "./thinking-golden-defenses.js";
import { MESSAGES_OFF_EXIT, MESSAGES_TIER_EXIT, THINKING_WIRE_MAPS } from "../../extension/ai/thinking-wire-map.js";

const HARNESS = channelHarness("anthropic");

// ===== 按类用例表（生成器产物；勿手改，重跑 07-gen-golden-tables.ts）=====
// 字段序 = AI_THINKING_LEVELS（off/minimal/low/medium/high/xhigh/max）；{} = 不发任何字段。
// 注意两格带票面注记语义：
//   `low-high-max · opencodego/deepseek-v4-flash` = 13 号票 canonical 优先 + 18 号票删平台
//     override：模型侧词表就是上游的 low/high/max（平台不再补档），off 关不掉、级联落 low；
//   `toggle+low-medium-xhigh+b:0-262144 · opencodego/qwen3.8-max` = 05 号票 CLAMP_DIVERGENT：
//     上游词表 low/medium/xhigh 无 high，偏好 high 向下取 medium（实发即 medium）；
//     18 号票后 opencodego 未登记开关形状，值集里的 toggle 不产生 on 写点。
const CASES: readonly ByClassCase[] = [
  { valuesetId: "b", presetId: "openrouter", model: "qwen/qwen3-next-80b-a3b-thinking", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "b:1024-", presetId: "openrouter", model: "anthropic/claude-haiku-4.5", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "b:128-32768", presetId: "openrouter", model: "google/gemini-2.5-pro", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "high", presetId: "openrouter", model: "openai/gpt-5-pro", available: ["high"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "high-xhigh", presetId: "openrouter", model: "sakana/fugu-ultra", available: ["high", "xhigh"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "high-xhigh-max", presetId: "openrouter", model: "sakana/fugu-max", available: ["high", "xhigh", "max"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-high", presetId: "openrouter", model: "google/gemini-3-pro-image", available: ["low", "high"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "low-high-max", presetId: "moonshot", model: "k3-256k", available: ["low", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-high-max", presetId: "opencodego", model: "glm-5.3", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-high-max", presetId: "qwen", model: "glm-5.3", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "low-medium", presetId: "amd", model: "Qwen3.8-27B", available: ["low", "medium"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}] },
  { valuesetId: "low-medium-high", presetId: "opencodego", model: "grok-4.5", available: ["low", "medium", "high"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "low-medium-high+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.5", available: ["low", "medium", "high"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "low-medium-high-max+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.6", available: ["low", "medium", "high", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-medium-high-xhigh", presetId: "opencodego", model: "grok-4.6", available: ["low", "medium", "high", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "low-medium-high-xhigh-max", presetId: "opencodego", model: "space-bunny-free", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-medium-xhigh", presetId: "amd", model: "Qwen3.8-Flash-Next", available: ["low", "medium", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2-pro", available: ["medium", "high", "xhigh"], fields: [{"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "minimal-high", presetId: "openrouter", model: "google/gemini-3.1-flash-image", available: ["minimal", "high"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "minimal-low-medium-high", presetId: "openrouter", model: "google/gemini-3-flash-preview", available: ["minimal", "low", "medium", "high"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "minimal-low-medium-high-xhigh", presetId: "opencodego", model: "muse-spark-1.2-contributor", available: ["minimal", "low", "medium", "high", "xhigh"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "minimal-low-medium-high-xhigh-max", presetId: "openrouter", model: "meta/muse-spark-1.3", available: ["minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "none-high", presetId: "opencodego", model: "hy4-preview", available: ["off", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-low-high", presetId: "opencodego", model: "hy3", available: ["off", "low", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-low-medium-high", presetId: "openrouter", model: "inception/mercury-2", available: ["off", "low", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-low-medium-high", presetId: "sensenova", model: "sensenova-6.8-flash-lite", available: ["off", "low", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "none-low-medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2", available: ["off", "low", "medium", "high", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "none-low-medium-high-xhigh-max", presetId: "opencodego", model: "gpt-5.6-luna", available: ["off", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "none-low-medium-xhigh", presetId: "openrouter", model: "qwen/qwen3.8-omni-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "none-low-medium-xhigh", presetId: "qwen", model: "qwen3.8-omni-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "none-medium-high", presetId: "openrouter", model: "nex-agi/nex-n2.5-mini", available: ["off", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-minimal-low-medium-high", presetId: "openrouter", model: "perceptron/perceptron-mk1.5", available: ["off", "minimal", "low", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-minimal-low-medium-high-max", presetId: "openrouter", model: "thinkingmachines/inkling", available: ["off", "minimal", "low", "medium", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "none-minimal-low-medium-high-xhigh-max", presetId: "openrouter", model: "upstage/solar-mini4", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle", presetId: "mimo", model: "mimo-v2-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle", presetId: "minimax", model: "MiniMax-M3", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b", presetId: "openrouter", model: "meituan/longcat-2.0", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b", presetId: "qwen", model: "qwen3.6-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-131072", presetId: "qwen", model: "glm-5.1", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-262144", presetId: "opencodego", model: "qwen3.7-max", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:-262144", presetId: "qwen", model: "qwen3.7-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-32768", presetId: "qwen", model: "glm-5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-38912", presetId: "qwen", model: "qwen-turbo", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-81920", presetId: "opencodego", model: "qwen3.6-plus", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:-81920", presetId: "qwen", model: "kimi-k2.5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:0-24576", presetId: "openrouter", model: "google/gemini-2.5-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:512-24576", presetId: "openrouter", model: "google/gemini-2.5-flash-lite", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+high-max", presetId: "opencodego", model: "glm-5.2", available: ["high", "max"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle+high-max", presetId: "qwen", model: "glm-5.2", available: ["off", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+high-max", presetId: "sensenova", model: "glm-5.2", available: ["high", "max"], fields: [{"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-high-max", presetId: "amd", model: "DeepSeek-V4-Flash", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle+low-high-max", presetId: "deepseek", model: "deepseek-flash", available: ["off", "low", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-high-max", presetId: "moonshot", model: "kimi-for-coding", available: ["off", "low", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-high-max", presetId: "sensenova", model: "deepseek-v4-flash", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-medium+b", presetId: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b", available: ["low", "medium"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}] },
  { valuesetId: "toggle+low-medium-high", presetId: "openrouter", model: "bytedance-seed/seed-2.0-code", available: ["low", "medium", "high"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "toggle+low-medium-high-xhigh-max", presetId: "openrouter", model: "anthropic/claude-sonnet-5", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle+low-medium-xhigh", presetId: "openrouter", model: "qwen/qwen3.8-27b", available: ["low", "medium", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "opencodego", model: "qwen3.8-flash", available: ["low", "medium", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "qwen", model: "qwen3.8-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "opencodego", model: "qwen3.8-max", available: ["low", "medium", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "qwen", model: "qwen3.8-max", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+medium-high+b", presetId: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b", available: ["medium", "high"], fields: [{"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "toggle+medium-xhigh", presetId: "openrouter", model: "prism-ml/ternary-bonsai-2-27b", available: ["medium", "xhigh"], fields: [{"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "toggle+minimal-low-medium-high", presetId: "openrouter", model: "bytedance-seed/seed-2.0-lite", available: ["minimal", "low", "medium", "high"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
];

registerByClassGolden(HARNESS, CASES);
registerByClassDefenses(HARNESS, CASES);

// ===== 每方言一条逐平台精确 body（真实平台回归钉；≤12 条）=====
describe("golden：每方言一条精确 body（Messages 通道）", () => {
  it("(1) deepseek/deepseek-v4-pro：关思考出口 thinking:{type:disabled}", () => {
    expect(HARNESS.bodyAt({ presetId: "deepseek", model: "deepseek-v4-pro", level: "off" })).toEqual(
      HARNESS.expectedBody("deepseek-v4-pro", { thinking: { type: "disabled" } })
    );
  });

  it("(2) qwen/qwen3-max：开关型开档 = 裸 thinking:{type:enabled}（上游 toggle+budget，无 effort → low==high）", () => {
    // 上游 qwen3-max 的 reasoning_options 是 [toggle, budget_tokens max 81920]：**没有 effort
    // 词表**，所以本通道没有档位词可发，low 与 high 只能是同一个裸开档——塌陷是上游唯一
    // 支持的形状，不是缺陷（08 号票：归一化层只做折叠与出口，不凭空造档位词）。
    const low = HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "low" });
    const high = HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "high" });
    expect(low).toEqual(HARNESS.expectedBody("qwen3-max", { thinking: { type: "enabled" } }));
    expect(high).toEqual(low);
  });

  it("(3) qwen/qwen3.8-max：thinking:{type:enabled} + output_config.effort（high 向下取 medium）", () => {
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3.8-max", level: "low" })).toEqual(
      HARNESS.expectedBody("qwen3.8-max", { thinking: { type: "enabled" }, output_config: { effort: "low" } })
    );
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3.8-max", level: "high" })).toEqual(
      HARNESS.expectedBody("qwen3.8-max", { thinking: { type: "enabled" }, output_config: { effort: "medium" } })
    );
  });

  it("(4) opencodego/deepseek-v4-flash：裸 output_config.effort（网关档位词，不带 thinking 对象）", () => {
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "deepseek-v4-flash", level: "low" })).toEqual(
      HARNESS.expectedBody("deepseek-v4-flash", { output_config: { effort: "low" } })
    );
  });

  it("(5) moonshot/kimi-k3：顶层 reasoning_effort（Kimi Code 端点未登记 thinking 形状）", () => {
    expect(HARNESS.bodyAt({ presetId: "moonshot", model: "kimi-k3", level: "low" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { reasoning_effort: "low" })
    );
  });

  it("(6) qwen/qwen3-next-80b-a3b-thinking：不发任何思考字段（上游只有 budget_tokens，无 toggle 无 effort）", () => {
    for (const level of ["off", "low", "high"] as const) {
      expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-next-80b-a3b-thinking", level }), level).toEqual(
        HARNESS.expectedBody("qwen3-next-80b-a3b-thinking", {})
      );
    }
  });

  it("(7) opencodego/kimi-k3（13 号票 canonical 词表；18 号票起平台不再补档）→ 裸 effort，off 级联落 low", () => {
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "kimi-k3", level: "max" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { output_config: { effort: "max" } })
    );
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "kimi-k3", level: "high" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { output_config: { effort: "high" } })
    );
    // 12 号票的单点裁决（off = thinking:disabled）已删除：canonical 的词表没有 toggle →
    // off 关不掉，级联落最低可用档 low（出口仍是本平台的裸 output_config.effort）。
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "kimi-k3", level: "off" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { output_config: { effort: "low" } })
    );
  });
});

// 探针变体（怪癖 probeOmitsThinking）：探针只测连通，一律不发思考字段——deepseek
// （有档位可发）与 stepfun（严格 effort 词汇）两条路都要钉住。
describe("golden：探针变体（probe 不发思考字段）", () => {
  it("deepseek + deepseek-v4-pro + probe + maxTokens:1 + high → 无 thinking", () => {
    expect(HARNESS.bodyAt({ presetId: "deepseek", model: "deepseek-v4-pro", level: "high", probe: true, maxTokens: 1 })).toEqual({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 1
    });
  });

  it("stepfun + step-3.7-flash + probe + maxTokens:1 + high → 无 output_config", () => {
    expect(HARNESS.bodyAt({ presetId: "stepfun", model: "step-3.7-flash", level: "high", probe: true, maxTokens: 1 })).toEqual({
      model: "step-3.7-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 1
    });
  });
});

// ModelScope + qwen3-32b（裸 id 命中模式表，血统声明关思考仅流式）：off 在非流式被
// streamOnly 阻断 → 级联落开档，只有流式才真发 thinking:disabled。
describe("golden：ModelScope qwen3-32b 关思考仅流式（stream 维度）", () => {
  it("stream:true + off → thinking:disabled", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off", stream: true })).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      max_tokens: 32768,
      thinking: { type: "disabled" }
    });
  });

  it("stream:false + off → 级联落开档（裸 thinking:enabled，无预算）", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off", stream: false })).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 32768,
      thinking: { type: "enabled" }
    });
  });
});

// 塌陷正当性（票面第 4 条）：开关型血统与 budget-only 模型的 low==high 是**上游事实**
// （上游没有 effort 词表可发），不是缺陷；effort 血统的塌陷只有「上游词表里没有该档、
// clamp 向下取到同一档」这一种正当来源（glm-5.2 上游 effort[high,max]：xhigh 折 high；
// D1=A2 补声明后该行 off 可用，low 改折 off，不再是塌陷）。F6 防线在产物全量上机械扫这两侧。
describe("golden：塌陷正当性（上游事实 vs 缺陷）", () => {
  it("zhipu/glm-5.2：上游 effort[high,max] 无 low/xhigh → low 折 off、xhigh 折 high", () => {
    // D1=A2 前该行没有 off 写点，low 只能折 high；补声明后 A' = {off, high, max}，
    // 「档外偏好向下取最近档」这条 clamp 让 low 落 off、xhigh 落 high。
    const low = HARNESS.bodyAt({ presetId: "zhipu", model: "glm-5.2", level: "low" });
    expect(low).toEqual(HARNESS.expectedBody("glm-5.2", { thinking: { type: "disabled" } }));
    const xhigh = HARNESS.bodyAt({ presetId: "zhipu", model: "glm-5.2", level: "xhigh" });
    expect(xhigh).toEqual(HARNESS.bodyAt({ presetId: "zhipu", model: "glm-5.2", level: "high" }));
    expect(xhigh).toEqual(
      HARNESS.expectedBody("glm-5.2", { thinking: { type: "enabled" }, output_config: { effort: "high" } })
    );
  });

  it("qwen/qwen3-max：budget-only（无 effort）→ low==high 同为裸开档（上游唯一形状）", () => {
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "low" })).toEqual(
      HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "high" })
    );
  });

  it("qwen/qwen3-next-80b-a3b-thinking：budget-only → 全档不发（不发预算、不臆造档位）", () => {
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-next-80b-a3b-thinking", level: "low" })).toEqual(
      HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-next-80b-a3b-thinking", level: "high" })
    );
  });
});

// ===== thinking-wire-protocol-split 02 号票：Messages off 出口逐格 golden（表键全覆盖）=====
// 表（ai/thinking-wire-map.ts 的 MESSAGES_OFF_EXIT）逐格钉「off 档实发」：键 = PROVIDERS 键空间，
// 每键配一个**真实可达**的 (presetId, model) 代表——目录内带 off 写点的行，或手写兜底行
// （stepfun / amd 的静默格、ollama / siliconflow 的 unknownClass 格）。02 号票的失败方式 ④
// （只覆盖目录内行、漏掉手写表兜底行）由 stepfun / amd 两格承载：它们在目录内没有 off 写点
// （形状未登记 → Off 走级联），静默格只能由自填 id 走到。
// 唯一没有端到端 off 路径的是 minimax（目录行 toggle 但形状未登记，PROVIDERS 又无 unknownClass
// → 手写兜底落 unknown 哨兵）：那一格只能喂线格式层的合成 off 事实，理由写在该用例里。
const OFF_CELL_REPRESENTATIVES: Readonly<
  Record<string, { presetId: string; baseUrl?: string; model: string; expect: Record<string, unknown>; note: string }>
> = {
  deepseek: { presetId: "deepseek", model: "deepseek-v4-pro", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记" },
  qwen: { presetId: "qwen", model: "qwen3.8-max", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记（enable_thinking）" },
  zhipu: { presetId: "zhipu", model: "glm-5.2", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记（thinking.type 原生参数）" },
  moonshot: { presetId: "moonshot", model: "kimi-for-coding", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记" },
  minimax: { presetId: "minimax", model: "MiniMax-M3", expect: { thinking: { type: "disabled" } }, note: "无端到端 off 路径 → 线格式层合成输入（见下面的用例）" },
  mimo: { presetId: "mimo", model: "mimo-v2-flash", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记（enable_thinking）" },
  openrouter: { presetId: "openrouter", model: "openai/gpt-5.2", expect: { thinking: { type: "disabled" } }, note: "目录行：值集自带 effort-none" },
  opencodego: { presetId: "opencodego", model: "hy3", expect: { thinking: { type: "disabled" } }, note: "目录行：值集自带 effort-none" },
  sensenova: { presetId: "sensenova", model: "sensenova-6.8-flash-lite", expect: { thinking: { type: "disabled" } }, note: "目录行：值集自带 effort-none" },
  modelscope: { presetId: "modelscope", model: "ZhipuAI/GLM-4.6", expect: { thinking: { type: "disabled" } }, note: "目录行 + off 专项实测（怪癖 thinkingDisabledMustBeExplicit）" },
  stepfun: { presetId: "stepfun", model: "gpt-5.2", expect: {}, note: "手写兜底行：静默格（怪癖 effortVocabMessages；目录行无 off 写点）" },
  amd: { presetId: "amd", model: "gpt-5.2", expect: {}, note: "手写兜底行：静默格（怪癖 effortVocabMessages；目录行无 off 写点）" },
  ollama: { presetId: "ollama", model: "llama3.2", expect: { thinking: { type: "disabled" } }, note: "手写兜底行：unknownClass ollama-effort 的 off 写点" },
  siliconflow: {
    presetId: "custom",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "llama3",
    expect: { thinking: { type: "disabled" } },
    note: "custom 直填 baseUrl → host 索引命中 siliconflow，unknownClass siliconflow-switch 的 off 写点"
  }
};

describe("off 出口逐格 golden（thinking-wire-protocol-split 02）：表键全覆盖", () => {
  it("代表格覆盖表键全集（表新增一格而 golden 没跟 → 红）", () => {
    expect(Object.keys(OFF_CELL_REPRESENTATIVES).sort()).toEqual(Object.keys(MESSAGES_OFF_EXIT).sort());
  });

  for (const [platform, rep] of Object.entries(OFF_CELL_REPRESENTATIVES)) {
    if (platform === "minimax") continue;
    it(`${platform}（${rep.note}）：off → 整 body 逐字节`, () => {
      expect(HARNESS.bodyAt({ presetId: rep.presetId, baseUrl: rep.baseUrl, model: rep.model, level: "off" })).toEqual(
        HARNESS.expectedBody(rep.model, rep.expect)
      );
    });
  }

  it("minimax：无端到端 off 路径（形状未登记、无 unknownClass）→ 线格式层合成 off 事实逐字节", () => {
    // 端到端产不出这一格：目录唯一一行 MiniMax-M3 的 toggle 不产生 off 写点（minimax 未登记
    // 开关形状）、手写兜底又落 unknown 哨兵（PROVIDERS.minimax 无 unknownClass）。故本格按
    // 线格式层（anthropicWireMap）的合成输入钉：off 出口表声明 "unresearched" → 原生。
    expect(
      THINKING_WIRE_MAPS.anthropic({
        fields: { reasoning_effort: "none" },
        stream: false,
        probe: false,
        platformId: "minimax",
        effortVocabularyOnly: false
      }).fields
    ).toEqual(OFF_CELL_REPRESENTATIVES.minimax.expect);
  });

  it("表外（custom 直填 api.openai.com / gpt-5.2）：未声明 → 原生，逐字节 body", () => {
    expect(
      HARNESS.bodyAt({ presetId: "custom", baseUrl: "https://api.openai.com/v1", model: "gpt-5.2", level: "off" })
    ).toEqual(HARNESS.expectedBody("gpt-5.2", { thinking: { type: "disabled" } }));
  });
});

// ===== thinking-wire-protocol-split 01 号票：Messages 档位出口逐格 golden（表键全覆盖）=====
// 表（ai/thinking-wire-map.ts 的 MESSAGES_TIER_EXIT）逐格钉「解析层给出 effort 档位词时的实发」：
// 键 = PROVIDERS 键空间，每键配一个**真实可达**的 (presetId, model, 档位) 代表——目录内有 effort
// 档位的行，或手写兜底行。代表入参与实发值来自工件 artifacts/01-tier-matrix.tsv（同命令重跑逐字节
// 一致），不手抄；档位一律取「原样发出、未被 clamp 改写」的那一档，好读也好核。
// 五格（minimax / mimo / modelscope / ollama / siliconflow）的代表是**手写兜底自填 id**：它们的
// 目录行是 toggle 型（无 effort 词表），档位出口只能由 EXCEPTIONS / TAXONOMY 兜底的行走到——
// 与 02 号票的 stepfun / amd 静默格同一条路（01 号票的失败方式 ④：只覆盖目录内行）。
const TIER_CELL_REPRESENTATIVES: Readonly<
  Record<
    string,
    {
      presetId: string;
      baseUrl?: string;
      model: string;
      /** 档位取值即 harness 的入参档位类型（`ThinkingLevel`），不另立字符串口径。 */
      level: BodyRequest["level"];
      expect: Record<string, unknown>;
      note: string;
    }
  >
> = {
  deepseek: {
    presetId: "deepseek",
    model: "deepseek-flash",
    level: "low",
    expect: { output_config: { effort: "low" }, thinking: { type: "enabled" } },
    note: "目录行：上游 effort 档位 + 形状登记 → output_config.effort + 开思考开关"
  },
  qwen: {
    presetId: "qwen",
    model: "deepseek-v4-flash",
    level: "low",
    expect: { output_config: { effort: "low" }, thinking: { type: "enabled" } },
    note: "目录行：百炼 Anthropic 兼容页登记 output_config.effort + thinking"
  },
  zhipu: {
    presetId: "zhipu",
    model: "glm-5.2",
    level: "high",
    expect: { output_config: { effort: "high" }, thinking: { type: "enabled" } },
    note: "目录行：GLM-5.2 词表只有 high/max（low/medium 服务端折成 high）"
  },
  moonshot: {
    presetId: "moonshot",
    model: "k3-256k",
    level: "low",
    expect: { reasoning_effort: "low" },
    note: "目录行：Kimi Code 端点登记的档位出口是顶层 reasoning_effort（无 thinking 形状）"
  },
  minimax: {
    presetId: "minimax",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "手写兜底行（目录唯一一行是 toggle 型）→ 档位出口未研究过，裸 output_config.effort"
  },
  mimo: {
    presetId: "mimo",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "手写兜底行（目录行是 toggle 型）→ Messages 侧档位出口无文档，裸 effort"
  },
  openrouter: {
    presetId: "openrouter",
    model: "~anthropic/claude-fable-latest",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "目录行：/messages 登记 output_config.effort，但 thinking.enabled 必带预算 → 不带 thinking"
  },
  opencodego: {
    presetId: "opencodego",
    model: "deepseek-v4-flash",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "目录行：网关未登记思考控制参数，产品裁定发裸 effort"
  },
  sensenova: {
    presetId: "sensenova",
    model: "deepseek-v4-flash",
    level: "low",
    expect: { output_config: { effort: "low" }, thinking: { type: "enabled" } },
    note: "目录行：thinking.type 与 output_config.effort 均登记"
  },
  stepfun: {
    presetId: "stepfun",
    model: "step-3.5-flash",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "怪癖托管格（effortVocabMessages）：只发裸 output_config.effort，不发 thinking"
  },
  amd: {
    presetId: "amd",
    model: "DeepSeek-V4-Flash",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "怪癖托管格（effortVocabMessages）：网关拒 thinking 形状，只发裸 effort"
  },
  ollama: {
    presetId: "ollama",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "手写兜底行（无上游）：Messages 通道无档位字段文档，裸 effort"
  },
  siliconflow: {
    presetId: "custom",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "custom 直填 baseUrl → host 索引命中 siliconflow（Messages 侧未登记档位字段）"
  },
  modelscope: {
    presetId: "modelscope",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "手写兜底行（目录行是 toggle 型）→ 端点未登记档位字段，产品裁定发裸 effort"
  }
};

describe("档位出口逐格 golden（thinking-wire-protocol-split 01）：表键全覆盖", () => {
  it("代表格覆盖表键全集（表新增一格而 golden 没跟 → 红）", () => {
    expect(Object.keys(TIER_CELL_REPRESENTATIVES).sort()).toEqual(Object.keys(MESSAGES_TIER_EXIT).sort());
  });

  for (const [platform, rep] of Object.entries(TIER_CELL_REPRESENTATIVES)) {
    it(`${platform}（${rep.note}）：${rep.level} → 整 body 逐字节`, () => {
      expect(
        HARNESS.bodyAt({ presetId: rep.presetId, baseUrl: rep.baseUrl, model: rep.model, level: rep.level })
      ).toEqual(HARNESS.expectedBody(rep.model, rep.expect));
    });
  }

  it("表外（custom 直填 api.openai.com / gpt-5.2）：未声明 → 裸 output_config.effort", () => {
    expect(
      HARNESS.bodyAt({ presetId: "custom", baseUrl: "https://api.openai.com/v1", model: "gpt-5.2", level: "low" })
    ).toEqual(HARNESS.expectedBody("gpt-5.2", { output_config: { effort: "low" } }));
  });

  it("同一平台的 off 与档位落在两处不同的写法（两表各自表态；01 号票点名的 moonshot 擦边格）", () => {
    // moonshot：档位走顶层 reasoning_effort，off 却发原生 thinking:{type:"disabled"}——
    // 01 号票开工时第一格核的就是它（同通道内 off 与档位不同形）。
    expect(HARNESS.bodyAt({ presetId: "moonshot", model: "kimi-for-coding", level: "off" })).toEqual(
      HARNESS.expectedBody("kimi-for-coding", { thinking: { type: "disabled" } })
    );
    expect(HARNESS.bodyAt({ presetId: "moonshot", model: "kimi-for-coding", level: "low" })).toEqual(
      HARNESS.expectedBody("kimi-for-coding", { reasoning_effort: "low" })
    );
    // deepseek / qwen / zhipu / sensenova：off 与档位都在 output_config/thinking 这一组形状里。
    expect(HARNESS.bodyAt({ presetId: "deepseek", model: "deepseek-flash", level: "off" })).toEqual(
      HARNESS.expectedBody("deepseek-flash", { thinking: { type: "disabled" } })
    );
  });
});
