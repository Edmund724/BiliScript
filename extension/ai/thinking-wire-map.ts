// ai/thinking-wire-map.ts — 线格式映射表（CONTEXT.md「平台协议」域，thinking-wire-map
// 票 01）。三层事实里的**写法层**：回答「这套 OpenAI 词汇在本协议的请求体里长什么样」。
//
// - 平台怪癖词表（compat-vocab.ts）= 名词层：这个平台有哪些怪癖、各自的键叫什么；
// - 模型血统表（thinking-profiles.ts）= 事实层：这个模型属于哪类血统、各档发哪套
//   OpenAI 词汇（reasoning_effort / enable_thinking / thinking:{type}）与 token 参数名事实；
// - 本表 = 写法层：这套词汇在本协议落成哪个字段、值怎么算——Messages 通道的
//   effort 词汇改写、budget_tokens 推算、probe 早退、off 三词汇归一，都在表内逐格写出。
//
// 为什么必须显式成表：同一份血统 patch 经 Messages 通道改写时，低档与高档曾被压成
// 同一个 budget_tokens（塌陷）。塌陷能藏住，正是因为这一层只活在 adapter 的 if 里、
// 没有可审的表。表把「哪一档发什么」变成逐格可审、可被 golden 逐字节钉住的事实：
// Messages 通道的档位词汇按平台在表内逐格登记（含「该平台未登记档位词汇 → 退回按档
// 预算」这一格），不再有靠 maxTokens 隐式推导档位取值的写法。
//
// 纯叶模块：只 type-import 词表叶（AiProtocol）与血统表类型，零运行时依赖（SW 静态
// 图安全）。键以 Record<AiProtocol, …> 强制覆盖（沿 protocol-adapter.ts 的既有纪律）：
// 新增协议必须在本表登记一行；adapter 只做「取血统表 → 取本表 → 并入请求体」，
// 不在 adapter 里回抄任何思考字段名或预算取值（对账测试 tests/ai/thinking-wire-map.test.ts）。
//
// 不引入表达式引擎（票内被否决的备选）：线格式是代码不是字符串——受 TS 类型检查，
// 且表达得了跨越 option 的条件（探针依赖 maxTokens 等）。

import type { AiProtocol } from "./protocol-vocab.js";
import type { ClassRule, ThinkingLevel } from "./thinking-profiles.js";

/** 血统表的 token 上限参数名事实（openai-reasoning 系 = max_completion_tokens）。 */
export type TokenParam = NonNullable<ClassRule["tokenParam"]>;

/**
 * 表入参：**血统 patch（OpenAI 词汇）+ 档位 + 上下文事实 + 平台事实**。
 * 各协议行按需读取（openai 行只读 fields/tokenParam；anthropic 行读
 * fields/probe/maxTokens/level/platformId/effortVocabularyOnly）。
 */
export interface ThinkingWireInput {
  /** 血统表给出的本档 patch（OpenAI 词汇）；空对象 = 无事实，一律不发字段。 */
  fields: Record<string, unknown>;
  /** 归一后的档位：off 级联后的 patch 已落在 fields 里，档位本身供退回按档预算取值。 */
  level: ThinkingLevel;
  /** 本次请求是否流式（血统表的 streamOnly 事实已在 resolver 侧消费）。 */
  stream: boolean;
  /** 探针请求：Messages 通道不发思考字段（怪癖 probeOmitsThinking）。 */
  probe: boolean;
  /** 请求体里实际要发出的 token 上限（Messages 的预算上限判定用；缺省 = 无此事实）。 */
  maxTokens?: number;
  /** 血统表的 token 上限参数名事实；缺省按本协议默认（Messages 恒为 max_tokens）。 */
  tokenParam?: TokenParam;
  /**
   * 平台识别（口径：thinking-profiles 的 PROVIDERS 键空间，adapter 传
   * `resolveThinkingProviderId` 的结果）。Messages 通道的档位词汇按平台登记
   * （MESSAGES_TIER_VOCABULARY）；未登记的平台退回按档分配 budget_tokens。
   */
  platformId?: string;
  /** 平台事实：Messages 通道只认 effort 词汇（怪癖 effortVocabMessages，strict 语义）。 */
  effortVocabularyOnly: boolean;
}

/** 出参：本协议要并入请求体的思考字段 + 本协议的 token 上限参数名。 */
export interface ThinkingWireOutput {
  fields: Record<string, unknown>;
  tokenParam: string;
}

export type ThinkingWireMap = (input: ThinkingWireInput) => ThinkingWireOutput;

// ===== OpenAI chat completions =====
// 血统表的词汇就是本协议的线格式（reasoning_effort / enable_thinking /
// thinking:{type} 三套直写）→ 映射是原样并入；token 上限参数名随血统事实
// （怪癖 maxTokensField：openai-reasoning 系只认 max_completion_tokens）。
// 探针不特化：探针请求照发思考字段（现状不变；probeOmitsThinking 是 Messages 侧事实）。
function openaiWireMap({ fields, tokenParam }: ThinkingWireInput): ThinkingWireOutput {
  return { fields: { ...fields }, tokenParam: tokenParam ?? "max_tokens" };
}

// ===== Anthropic Messages =====
// 怪癖 thinkingBudgetTokens（语义见 compat-vocab）：开思考的 budget_tokens 硬性下限
// （Anthropic 官方要求 ≥1024）与默认预算；budget 计入 max_tokens，必须 < max_tokens。
export const MIN_BUDGET_TOKENS = 1024;
export const DEFAULT_BUDGET_TOKENS = 2048;
// 未文档化平台的按档回退：高档预算（低档保持默认预算不动）。取值依据见
// TIER_BUDGET_BY_LEVEL 的注释。
export const HIGH_BUDGET_TOKENS = 8192;

/**
 * 平台在 Messages 通道登记过的档位词汇形态（平台事实，02 号票）：
 * - "effort"：`output_config.effort` + 显式 thinking 开关（平台官方文档登记了该字段与取值词表）；
 * - "effort-bare"：只发 `output_config.effort`——该平台的 `thinking.type:"enabled"` 必带
 *   budget_tokens，不带 thinking 对象才安全；
 * - "reasoning-effort"：顶层 `reasoning_effort`（该端点未登记 thinking 形状）。
 * 未登记的平台（含完全无文档的网关）= 无此行 → 退回按档分配 budget_tokens。
 */
export type MessagesTierVocabulary = "effort" | "effort-bare" | "reasoning-effort";

// Messages 通道的档位词汇表（02 号票：塌陷格在这里变成显式的一格）。
// 键 = 平台识别，口径见 ThinkingWireInput.platformId（thinking-profiles 的 PROVIDERS 键空间）。
// 与 compat-vocab 的 effortVocabMessages（stepfun / amd，严格只认 output_config.effort）键集
// 不相交：那种平台在 effortVocabularyOnly 分支就返回，走不到本表。取值一律以官方文档为准，
// 血统表算出的档位词（reasoning_effort 值）原样作为平台档位词发出，不另造映射。
const MESSAGES_TIER_VOCABULARY: Record<string, MessagesTierVocabulary> = {
  // deepseek：Anthropic 兼容页只支持 thinking 与 output_config（且 "Only effort is supported"），
  // budget_tokens 被忽略；档位词 low/high/max（默认 high）
  // （api-docs.deepseek.com/guides/anthropic_api、api-docs.deepseek.com/guides/thinking_mode）。
  deepseek: "effort",
  // qwen 百炼：output_config.effort 为平台扩展参数、budget_tokens「即将废弃」；qwen3.8-max
  // 词表 xhigh/medium/low（默认 xhigh，high/max 映射为 xhigh）——血统表的 high 档正是 xhigh
  // （help.aliyun.com/zh/model-studio/anthropic-api-messages）。
  qwen: "effort",
  // zhipu：Coding Plan 页登记 Claude Code 走 thinking.type + output_config.effort；GLM-5.2 的
  // 档位词表 max/xhigh/high/medium/low/minimal/none，但官方明确 low/medium 折成 high、xhigh 折成
  // max，且「low（轻度推理）」作为**生效档位**仅 GLM-5.3 支持——即 GLM-5.2 实际只有
  // 放弃思考(none/minimal) / high / max 三态，low 与 high 在服务端同档（平台侧既有归一化，
  // 本表不代平台改写档位词；缺口见 02 号票 Comments）
  // （docs.bigmodel.cn/cn/guide/capabilities/thinking、docs.bigmodel.cn/cn/coding-plan/latest-model）。
  zhipu: "effort",
  // openrouter：/messages 的 output_config.effort 词表 low/medium/high/xhigh/max；thinking.enabled
  // 分支 required:[type, budget_tokens]（必带预算），故本平台只发 effort、不带 thinking 对象
  // （openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message）。
  openrouter: "effort-bare",
  // sensenova：thinking.type 与 output_config.effort 均登记；词表同页三处冲突，Claude Code FAQ 的
  // 400 文案只允许 low/medium/high（xhigh 被拒）→ 只走这三档（platform.sensenova.cn/docs）。
  sensenova: "effort",
  // moonshot：仓库 base 是 Kimi Code（api.kimi.com/coding），该端点登记的档位词是顶层
  // reasoning_effort low/high/max（k3 默认 high）；该端点的 output_config.effort / budget_tokens
  // 无官方文档（开放平台另一端点才是 output_config.effort，不可混用）
  // （kimi.com/code/docs/kimi-code/models.html）。
  moonshot: "reasoning-effort"
};

// 按档分配的预算（未登记档位词汇的平台的显式回退，02 号票）：低档保持现状默认预算不动，
// 高档取 HIGH_BUDGET_TOKENS。凭据：Anthropic 官方**没有** effort → budget_tokens 的换算表
// （官方 SDK 类型与 AWS 托管文档只给定性说明）；唯一公开公式是 OpenRouter 网关自有策略
// （budget = max(min(max_tokens × ratio, 128000), 1024)，low 0.2 / high 0.8；
// openrouter.ai/docs/guides/best-practices/reasoning-tokens）——不是官方换算，只作档位单调性
// 的旁证。off 档只可能是级联落低档（offFallback:"low"），预算随之取低档。
const TIER_BUDGET_BY_LEVEL: Record<ThinkingLevel, number> = {
  off: DEFAULT_BUDGET_TOKENS,
  low: DEFAULT_BUDGET_TOKENS,
  high: HIGH_BUDGET_TOKENS
};

// Messages 通道的思考档位改写（怪癖 thinkingFormat）：血统表的 chat 形状字段 →
// Anthropic 线格式。三种关思考词汇殊途同归为 thinking:{type:"disabled"}——怪癖
// thinkingDisabledMustBeExplicit：「Anthropic 默认即关、一律不发字段」在默认开思考的
// 网关上不成立（ModelScope Messages 端点实测 2026-09：deepseek-ai/DeepSeek-V4.1-Flash
// 默认开思考、enable_thinking:false 被忽略、思考计入 max_tokens 会把正文挤成空串），
// 只有 thinking:{type:"disabled"} 能真正关掉。
//
// 开思考分两格（02 号票在这里把「档位塌陷」改成显式的一格一格）：
// ① effort 血统：按平台官方登记的档位词汇落线（MESSAGES_TIER_VOCABULARY），档位词由血统表
//    给出、原样透传；平台没有登记档位词汇 → 退回按档分配 budget_tokens（显式回退，
//    注释注明「未文档化」）。
// ② 开关型血统：该通道只有开/关两态、无档位词汇 → low/high 同为开档默认预算（显式登记，
//    依据见各平台官方字段表）。
function anthropicWireMap(input: ThinkingWireInput): ThinkingWireOutput {
  const output: ThinkingWireOutput = { fields: {}, tokenParam: "max_tokens" };
  // 怪癖 probeOmitsThinking：探针不发思考——探针 maxTokens=1，而 budget_tokens ≥1024
  // 且必须 < max_tokens，任何 thinking 字段都会把探针打成 400（探针语义 = 测连通）。
  if (input.probe) return output;
  const { fields } = input;
  // 无事实（unknown 哨兵 / never / always 无档可落）：维持不发——软失败优于硬 400。
  if (!Object.keys(fields).length) return output;

  const off =
    fields.reasoning_effort === "none" ||
    fields.enable_thinking === false ||
    (fields.thinking as { type?: unknown } | undefined)?.type === "disabled";
  if (off) {
    // 查表给出关思考声明 = 该平台此模型可关思考：翻译成 Anthropic 原生
    // thinking:{type:"disabled"} 显式发出，不依赖服务端默认（怪癖
    // thinkingDisabledMustBeExplicit）。严格 effort 词汇平台（怪癖 effortVocabMessages）
    // 不收 thinking 字段：维持不发。
    if (!input.effortVocabularyOnly) {
      output.fields.thinking = { type: "disabled" };
    }
    return output;
  }

  const effort = fields.reasoning_effort;
  const bloodLineEffort = typeof effort === "string" && effort !== "none" ? effort : undefined;

  // 怪癖 effortVocabMessages（stepfun / amd）：只认 output_config.effort，血统的档位词原样
  // 作为 effort 发出；若血统给的是别的开关词汇则不发——软失败优于硬 400。
  if (input.effortVocabularyOnly) {
    if (bloodLineEffort) output.fields.output_config = { effort: bloodLineEffort };
    return output;
  }

  // ① effort 血统：档位在这一格显式落线。
  if (bloodLineEffort) {
    if (!thinkingFitsMaxTokens(input.maxTokens)) return output;
    const vocabulary = input.platformId ? MESSAGES_TIER_VOCABULARY[input.platformId] : undefined;
    if (vocabulary === "effort" || vocabulary === "effort-bare") {
      output.fields.output_config = { effort: bloodLineEffort };
      // "effort" 形态显式带开思考开关（该平台的 thinking.type 不带 budget_tokens 也合法）；
      // "effort-bare" 形态的 thinking.enabled 必带 budget_tokens，故不发 thinking 对象。
      if (vocabulary === "effort") output.fields.thinking = { type: "enabled" };
      return output;
    }
    if (vocabulary === "reasoning-effort") {
      // 该端点登记的档位字段是顶层 reasoning_effort（未登记 thinking 形状）：只发档位词。
      output.fields.reasoning_effort = bloodLineEffort;
      return output;
    }
    // 未登记档位词汇的平台（如 opencodego：官方文档 opencode.ai/docs/go、docs/zen 与
    // /zen/go/v1/models 元数据都没有思考控制参数；modelscope / ollama 等代管平台同理）：
    // 退回按档分配 budget_tokens——档位词无官方文档，预算取值是本扩展的显式选择
    //（依据见 TIER_BUDGET_BY_LEVEL 注释）。
    return openThinking(output, TIER_BUDGET_BY_LEVEL[input.level], input.maxTokens);
  }

  // ② 开关型血统：Messages 通道无档位词汇，low 与 high 同为开档（显式登记的一格）。
  // 依据：GLM-4.5~5.1、kimi-k2.5/k2.6、doubao-seed 等平台的官方字段表只登记开/关两态
  // （docs.bigmodel.cn、platform.kimi.ai、volcengine.com）。
  return openThinking(output, DEFAULT_BUDGET_TOKENS, input.maxTokens);
}

// 开思考记录：{type:"enabled",budget_tokens}，budget 夹在 [1024, max_tokens) 内；调用方
// maxTokens 过小（放不下下限）则不发——软失败优于硬 400（怪癖 thinkingBudgetTokens）。
function openThinking(output: ThinkingWireOutput, tierBudget: number, maxTokens: number | undefined): ThinkingWireOutput {
  if (!thinkingFitsMaxTokens(maxTokens)) return output;
  const budget = Math.min(tierBudget, (maxTokens as number) - 1);
  if (budget < MIN_BUDGET_TOKENS) return output;
  output.fields.thinking = { type: "enabled", budget_tokens: budget };
  return output;
}

// 放得下思考的下限判据：budget 硬性 ≥1024 且必须 < max_tokens ⇒ max_tokens ≥ 1025。
// 无上限事实（调用方没给 max_tokens）同样按「放不下」处理，不发思考字段。
function thinkingFitsMaxTokens(maxTokens: number | undefined): boolean {
  return maxTokens != null && maxTokens - 1 >= MIN_BUDGET_TOKENS;
}

// 键集合必须覆盖词表叶（Record<AiProtocol, …> 是编译期强制：新增协议漏登记即红）。
export const THINKING_WIRE_MAPS: Record<AiProtocol, ThinkingWireMap> = {
  openai: openaiWireMap,
  anthropic: anthropicWireMap
};
