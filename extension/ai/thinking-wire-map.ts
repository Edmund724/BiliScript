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
// 没有可审的表。表把「哪一档发什么」变成逐格可审、可被 golden 逐字节钉住的事实。
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
 * 表入参：**血统 patch（OpenAI 词汇）+ 档位 + 上下文事实**。
 * 各协议行按需读取（openai 行只读 fields/tokenParam；anthropic 行读
 * fields/probe/maxTokens/effortVocabularyOnly，02 号票起再读 level）。
 */
export interface ThinkingWireInput {
  /** 血统表给出的本档 patch（OpenAI 词汇）；空对象 = 无事实，一律不发字段。 */
  fields: Record<string, unknown>;
  /** 归一后的档位。off 级联后的 patch 已落在 fields 里，档位本身只表用户意图。 */
  level: ThinkingLevel;
  /** 本次请求是否流式（血统表的 streamOnly 事实已在 resolver 侧消费）。 */
  stream: boolean;
  /** 探针请求：Messages 通道不发思考字段（怪癖 probeOmitsThinking）。 */
  probe: boolean;
  /** 请求体里实际要发出的 token 上限（Messages 的预算上限判定用；缺省 = 无此事实）。 */
  maxTokens?: number;
  /** 血统表的 token 上限参数名事实；缺省按本协议默认（Messages 恒为 max_tokens）。 */
  tokenParam?: TokenParam;
  /** 平台事实：Messages 通道只认 effort 词汇（怪癖 effortVocabMessages）。 */
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

// Messages 通道的思考档位改写（怪癖 thinkingFormat）：血统表的 chat 形状字段 →
// Anthropic 线格式。三种关思考词汇殊途同归为 thinking:{type:"disabled"}——怪癖
// thinkingDisabledMustBeExplicit：「Anthropic 默认即关、一律不发字段」在默认开思考的
// 网关上不成立（ModelScope Messages 端点实测 2026-09：deepseek-ai/DeepSeek-V4.1-Flash
// 默认开思考、enable_thinking:false 被忽略、思考计入 max_tokens 会把正文挤成空串），
// 只有 thinking:{type:"disabled"} 能真正关掉。
// 只认新式 output_config.effort 的平台（怪癖 effortVocabMessages；表成员与语义见
// compat-vocab 的 PLATFORM_QUIRKS，adapter 只把平台事实传进来）走 effort 分支：
// 血统表给的 reasoning_effort 原样作为 effort 发出，别的开关词汇不发——软失败优于硬 400。
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
    // thinkingDisabledMustBeExplicit）。effort 词汇平台不收 thinking 字段：维持不发。
    if (!input.effortVocabularyOnly) {
      output.fields.thinking = { type: "disabled" };
    }
    return output;
  }

  if (input.effortVocabularyOnly) {
    const effort = fields.reasoning_effort;
    if (typeof effort === "string" && effort !== "none") {
      output.fields.output_config = { effort };
    }
    return output;
  }

  // 开思考（怪癖 thinkingBudgetTokens）：{type:"enabled",budget_tokens}。budget 夹在
  // [1024, max_tokens) 内，调用方 maxTokens 过小则不发——软失败优于硬 400。
  //
  // **塌陷格（02 号票的修复锚点）**：现状的 budget 只由 maxTokens 决定，档位的值不
  // 参与计算，故血统为 effort 的模型在 low 与 high 之间同值（deepseek / zhipu /
  // moonshot / qwen 等在 Messages 通道拉高档位无效果）。本票有意保持该值逐字节不变，
  // Messages golden 把它钉死；02 号票在这一格上做显式翻转。
  const maxTokens = input.maxTokens;
  if (maxTokens == null) return output;
  const budget = Math.min(DEFAULT_BUDGET_TOKENS, maxTokens - 1);
  if (budget < MIN_BUDGET_TOKENS) return output;
  output.fields.thinking = { type: "enabled", budget_tokens: budget };
  return output;
}

// 键集合必须覆盖词表叶（Record<AiProtocol, …> 是编译期强制：新增协议漏登记即红）。
export const THINKING_WIRE_MAPS: Record<AiProtocol, ThinkingWireMap> = {
  openai: openaiWireMap,
  anthropic: anthropicWireMap
};
