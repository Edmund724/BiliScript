// ai/thinking-wire-map.ts — 线格式映射表（CONTEXT.md「平台协议」域，thinking-wire-map
// 票 01）。三层事实里的**写法层**：回答「这套 OpenAI 词汇在本协议的请求体里长什么样」。
//
// - 平台怪癖词表（compat-vocab.ts）= 名词层：这个平台有哪些怪癖、各自的键叫什么；
// - 模型档位事实（ai/catalog/models-dev-thinking.generated.ts 构建期编译产物，由
//   thinking-profiles.ts 解析并补兜底）= 事实层：这个模型属于哪类血统、各档发哪套
//   OpenAI 词汇（reasoning_effort / enable_thinking / thinking:{type}）；token 参数名事实
//   仍由血统表给；
// - 本表 = 写法层：这套词汇在本协议落成哪个字段、值怎么算——Messages 通道的
//   effort 词汇改写、开关型血统的开档形状、probe 早退、off 三词汇归一，都在表内逐格写出。
//
// 为什么必须显式成表：同一份血统 patch 经 Messages 通道改写时，低档与高档曾被压成
// 同一个预算（塌陷）。塌陷能藏住，正是因为这一层只活在 adapter 的 if 里、
// 没有可审的表。表把「哪一档发什么」变成逐格可审、可被 golden 逐字节钉住的事实：
// Messages 通道的档位落线按平台在表内逐格登记（含「该平台未登记线格式出口 → 发裸
// effort 词汇」这一格），不再有靠上限隐式推导取值的写法。档位词的**合法性不在本表**
// （08 号票：词汇主人是 02 值集产物，见 MESSAGES_TIER_VOCABULARY 的头注）。
//
// **硬规则：本表任何一格都不发 `budget_tokens`**——官方没有 effort→预算的换算表，
// 自造预算只会挤占 max_tokens（各平台已实测：思考计入 max_tokens 会把正文挤成
// 空串）。开关型血统的开档因此只发 thinking:{type:"enabled"}（不带上限）。
//
// 纯叶模块：只 type-import 词表叶（AiProtocol）与血统表类型，零运行时依赖（SW 静态
// 图安全）。键以 Record<AiProtocol, …> 强制覆盖（沿 protocol-adapter.ts 的既有纪律）：
// 新增协议必须在本表登记一行；adapter 只做「取血统表 → 取本表 → 并入请求体」，
// 不在 adapter 里回抄任何思考字段名或预算取值（对账测试 tests/ai/thinking-wire-map.test.ts）。
//
// 不引入表达式引擎（票内被否决的备选）：线格式是代码不是字符串——受 TS 类型检查，
// 且表达得了跨越 option 的条件（探针依赖 maxTokens 等）。

import type { AiProtocol } from "./protocol-vocab.js";
import type { ClassRule } from "./thinking-profiles.js";

/** 血统表的 token 上限参数名事实（openai-reasoning 系 = max_completion_tokens）。 */
export type TokenParam = NonNullable<ClassRule["tokenParam"]>;

/**
 * 表入参：**血统 patch（OpenAI 词汇）+ 上下文事实 + 平台事实**。
 * 各协议行按需读取（openai 行只读 fields/tokenParam；anthropic 行读
 * fields/probe/platformId/effortVocabularyOnly）。
 */
export interface ThinkingWireInput {
  /** 血统表给出的本档 patch（OpenAI 词汇）；空对象 = 无事实，一律不发字段。 */
  fields: Record<string, unknown>;
  /** 本次请求是否流式（血统表的 streamOnly 事实已在 resolver 侧消费）。 */
  stream: boolean;
  /** 探针请求：Messages 通道不发思考字段（怪癖 probeOmitsThinking）。 */
  probe: boolean;
  /** 血统表的 token 上限参数名事实；缺省按本协议默认（Messages 恒为 max_tokens）。 */
  tokenParam?: TokenParam;
  /**
   * 平台识别（口径：thinking-profiles 的 PROVIDERS 键空间，adapter 传
   * `resolveThinkingProviderId` 的结果）。Messages 通道的档位落线（线格式出口）按平台登记
   * （MESSAGES_TIER_VOCABULARY）；未登记的平台发裸 `output_config.effort`。
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
// **本行不发 budget_tokens**（硬规则）：官方没有 effort→预算的换算表，自定预算会挤占
// max_tokens 并把正文挤空；开档一律只发档位词汇或裸开关。

/**
 * 平台在 Messages 通道的**线格式出口**（平台事实，02 号票建表；08 号票起命名即历史沿革，
 * 职责按本注读）：只回答「已折好的档位词在这个端点落成哪个字段」，不再回答「这个平台
 * 有哪些合法档位词」：
 * - "effort"：`output_config.effort` + 显式 thinking 开关（平台官方文档登记了该字段与
 *   取值形状）；
 * - "effort-bare"：只发 `output_config.effort`——不带 thinking 对象才安全（openrouter 的
 *   `thinking.type:"enabled"` 必带预算；opencodego / modelscope 的 thinking 形状
 *   无官方文档，只发档位字段不冒硬 400 风险）；
 * - "reasoning-effort"：顶层 `reasoning_effort`（该端点未登记 thinking 形状）。
 * 未登记的平台（含完全无文档的网关）= 无此行 → 发裸 `output_config.effort`
 * （档位词照发，但不下发预算）。
 */
export type MessagesTierVocabulary = "effort" | "effort-bare" | "reasoning-effort";

// Messages 通道的**档位归一化层**（08 号票定职责；02 号票建表，9372c78 / 598f0a9 定型）：
// 键 = 平台识别，口径见 ThinkingWireInput.platformId（thinking-profiles 的 PROVIDERS 键空间）。
// 只持有两件事：① 线格式出口（本表的值，逐格注释带官方出处）；② 平台侧折叠——把内部档位
// 折成该端点的线上词，**只许收敛**（多档折同词，如平台把 low/medium 都折成 high），不许
// **发散**（返回上游值集里没有的词）。
// **不持有「哪些档位词合法」**：合法性一律来自 02 号票的值集产物
// （ai/catalog/models-dev-thinking.generated.ts）——thinking-profiles 的 ruleFromUpstreamFact
// 按逐模型值集物化档位写点，「有写点 = 该档可用」，所以能走到本表的词本就来自该模型的上游
// 值集（静态判据见 tests/ai/thinking-wire-map.test.ts「归一化不发散」）。
// 折叠现状：**所有平台恒等**——上游值集已逐模型物化出真实档位，没有已知需要平台侧折叠的
// 缺口；zhipu 把 low/medium 折成 high 是**服务端**归一化，本表不代平台改写档位词。
// 与 compat-vocab 的 effortVocabMessages（stepfun / amd，严格只认 output_config.effort）键集
// 不相交：那种平台在 effortVocabularyOnly 分支就返回，走不到本表。各格形状一律以官方文档为准，
// 血统表算出的档位词（reasoning_effort 值）原样作为平台档位词发出，不另造映射。
const MESSAGES_TIER_VOCABULARY: Record<string, MessagesTierVocabulary> = {
  // deepseek：Anthropic 兼容页只支持 thinking 与 output_config（且 "Only effort is supported"），
  // budget_tokens 被忽略；档位词 low/high/max（默认 high）
  // （api-docs.deepseek.com/guides/anthropic_api、api-docs.deepseek.com/guides/thinking_mode）。
  deepseek: "effort",
  // qwen 百炼：output_config.effort 为平台扩展参数、budget_tokens「即将废弃」；qwen3.8-max
  // 词表 xhigh/medium/low（默认 xhigh，high/max 映射为 xhigh）——血统表的 high 档正是 xhigh
  // （help.aliyun.com/zh/model-studio/anthropic-api-messages）。
  // qwen3-max **不走本行**：上游值集是 `toggle+b:-81920`（无 effort 词表），low/high 同为
  // 裸开档、塌陷是唯一形状——上游事实，见 anthropicWireMap 的 ② 格注释。
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
  moonshot: "reasoning-effort",
  // opencodego：官方文档（opencode.ai/docs/go、/docs/zen）与 /zen/go/v1/models 元数据都未登记
  // 思考控制参数；按产品裁定该网关 Messages 端点可正常接收档位词（2026-09，用户确认）→ 发
  // output_config.effort（裸形态：thinking.enabled 是否必带 budget_tokens 无文档，不冒硬 400
  // 风险），不再退回自定 budget_tokens。
  opencodego: "effort-bare",
  // modelscope：官方（Beta）Anthropic 兼容端点未登记档位字段；命中 effort 血统的托管模型
  // （如直填 id qwen3.8-max）按同一产品裁定发 output_config.effort（裸形态，
  // api-inference.modelscope.cn）。该端点已实测收 thinking:{type:"disabled"}
  // （怪癖 thinkingDisabledMustBeExplicit），但 enabled 形态无文档 → 只发档位字段。
  modelscope: "effort-bare"
};

// Messages 通道的思考档位改写（怪癖 thinkingFormat）：血统表的 chat 形状字段 →
// Anthropic 线格式。三种关思考词汇殊途同归为 thinking:{type:"disabled"}——怪癖
// thinkingDisabledMustBeExplicit：「Anthropic 默认即关、一律不发字段」在默认开思考的
// 网关上不成立（ModelScope Messages 端点实测 2026-09：deepseek-ai/DeepSeek-V4.1-Flash
// 默认开思考、enable_thinking:false 被忽略、思考计入 max_tokens 会把正文挤成空串），
// 只有 thinking:{type:"disabled"} 能真正关掉。
//
// 开思考分两格（02 号票在这里把「档位塌陷」改成显式的一格一格）：
// ① effort 血统：档位词的合法性主人在 02 值集（逐模型物化，见 thinking-profiles 的
//    ruleFromUpstreamFact），本层只选线格式出口（MESSAGES_TIER_VOCABULARY）并把档位折到线上、
//    原样透传；平台没有登记出口 → 发裸 output_config.effort（档位词照发，不下发预算）。
// ② 开关型血统：该通道只有开/关两态、无档位词汇 → 开档发裸 thinking:{type:"enabled"}
//    （不带上限；依据见各平台官方字段表）。qwen3-max 即此格：上游值集 `toggle+b:-81920`
//    （toggle + budget_tokens max 81920，**没有 effort**）→ 没有档位词可发，low 与 high 同为
//    裸开档——塌陷是上游唯一支持的形状，不是缺陷（塌陷格 04 号票订正）。
// 两格都**不发 budget_tokens**（硬规则，见文件头）。
function anthropicWireMap(input: ThinkingWireInput): ThinkingWireOutput {
  const output: ThinkingWireOutput = { fields: {}, tokenParam: "max_tokens" };
  // 怪癖 probeOmitsThinking：探针是连通性测试，一律不发思考字段——发字段只会给探针
  // 增加 400 变量（部分平台的 enabled 形状要求配套参数），探针语义 = 测连通。
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

  // ① effort 血统：档位词来自 02 值集（合法性主人，逐模型物化）；本格只做归一化（折叠，
  // 现状恒等——只许收敛不许发散）与线格式出口选择，然后把词原样发出。
  if (bloodLineEffort) {
    const wireExit = input.platformId ? MESSAGES_TIER_VOCABULARY[input.platformId] : undefined;
    if (wireExit === "reasoning-effort") {
      // 该端点登记的档位字段是顶层 reasoning_effort（未登记 thinking 形状）：只发档位词。
      output.fields.reasoning_effort = bloodLineEffort;
      return output;
    }
    // "effort" 形态显式带开思考开关（该平台的 thinking.type 不带预算也合法）；
    // "effort-bare" 与「未登记线格式出口」（ollama 的 Messages 通道无思考参数文档、
    // custom 直填端点无平台事实）都只发档位字段——档位词照发，不下发预算。
    output.fields.output_config = { effort: bloodLineEffort };
    if (wireExit === "effort") output.fields.thinking = { type: "enabled" };
    return output;
  }

  // ② 开关型血统：该通道只有开/关两态、无档位词，low 与 high 同为裸开档（显式登记的一格）。
  // 依据：GLM-4.5~5.1、kimi-k2.5/k2.6、doubao-seed 等平台的官方字段表只登记开/关两态
  // （docs.bigmodel.cn、platform.kimi.ai、volcengine.com）；血统表的 enable_thinking /
  // thinking:{type:"enabled"} 都译成该通道的裸开档形状。
  output.fields.thinking = { type: "enabled" };
  return output;
}

// 键集合必须覆盖词表叶（Record<AiProtocol, …> 是编译期强制：新增协议漏登记即红）。
export const THINKING_WIRE_MAPS: Record<AiProtocol, ThinkingWireMap> = {
  openai: openaiWireMap,
  anthropic: anthropicWireMap
};
