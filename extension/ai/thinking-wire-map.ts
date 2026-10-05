// ai/thinking-wire-map.ts — 线格式映射表（CONTEXT.md「平台协议」域，thinking-wire-map
// 票 01）。三层事实里的**写法层**：回答「这套 OpenAI 词汇在本协议的请求体里长什么样」。
//
// - 平台怪癖词表（compat-vocab.ts）= 名词层：这个平台有哪些怪癖、各自的键叫什么；
// - 模型档位事实（ai/catalog/models-dev-thinking.generated.ts 构建期编译产物，由
//   thinking-profiles.ts 解析并补兜底）= 事实层：各档发**哪套**词汇，出口是封闭判别联合
//   `ThinkingVocabulary`（reasoningEffort / enableThinking / thinkingType + 两个哨兵）；
//   这个模型属于哪类血统（thinkingClass 三态）由 thinking-profiles.ts 解析时定；
//   token 参数名事实仍由解析层给；
// - 本表 = 写法层：这套词汇在本协议落成哪个字段、值怎么算——**线格式词汇字面量
//   （reasoning_effort / enable_thinking / thinking:{type} / output_config）只在本文件出现**，
//   事实层不写字段名（封闭联合 + seam 类型由 tsc 兜住，不再扫源码文本对账）。
//   Messages 通道的 effort 词汇改写、开关型血统的开档形状、probe 早退、off 三词汇归一，
//   都在本表内按 vocabulary.kind 逐格写出。
//
// 为什么必须显式成表：同一份档位规则 patch 经 Messages 通道改写时，低档与高档曾被压成
// 同一个预算（塌陷）。塌陷能藏住，正是因为这一层只活在 adapter 的 if 里、
// 没有可审的表。表把「哪一档发什么」变成逐格可审、可被 golden 逐字节钉住的事实：
// Messages 通道的档位落线按平台在表内逐格登记（含「该平台未登记线格式出口 → 发裸
// effort 词汇」这一格），不再有靠上限隐式推导取值的写法。档位词的**合法性不在本表**
// （08 号票：词汇主人是 02 值集产物，见 MESSAGES_TIER_EXIT 的头注）。
//
// **硬规则：本表任何一格都不发 `budget_tokens`**——官方没有 effort→预算的换算表，
// 自造预算只会挤占 max_tokens（各平台已实测：思考计入 max_tokens 会把正文挤成
// 空串）。开关型血统的开档因此只发开词本身（**开词不是恒为 `enabled`**：minimax 的 enum
// 只有 disabled / adaptive），不带上限；开词也逐格登记——档位出口 MESSAGES_TIER_EXIT、
// 关词出口 MESSAGES_OFF_EXIT、开词出口 MESSAGES_ON_EXIT 三张同形表各答一件事。
//
// 纯叶模块：只 type-import 词表叶（AiProtocol / CompatQuirk）与 thinking-profiles.ts 类型，零运行时
// 依赖（SW 静态图安全）。键以 Record<AiProtocol, …> 强制覆盖（沿 protocol-adapter.ts 的既有纪律）：
// 新增协议必须在本表登记一行；adapter 只做「取档位规则 → 取本表 → 并入请求体」，
// 不在 adapter 里回抄任何思考字段名或预算取值（对账测试 tests/ai/thinking-wire-map.test.ts）。
//
// 不引入表达式引擎（票内被否决的备选）：线格式是代码不是字符串——受 TS 类型检查，
// 且表达得了跨越 option 的条件（探针依赖 maxTokens 等）。

import type { CompatQuirk } from "./compat-vocab.js";
import type { AiProtocol } from "./protocol-vocab.js";
import type { ClassRule, ThinkingVocabulary } from "./thinking-profiles.js";

/** 档位规则的 token 上限参数名事实（openai-reasoning 系 = max_completion_tokens）。 */
export type TokenParam = NonNullable<ClassRule["tokenParam"]>;

/**
 * 表入参：**事实层的中转词汇（封闭判别联合）+ 上下文事实 + 平台事实**。
 * 各协议行按需读取（openai 行只读 vocabulary/tokenParam；anthropic 行读
 * vocabulary/probe/platformId/effortVocabularyOnly）。
 */
export interface ThinkingWireInput {
  /** 档位规则给出的本档中转词汇；哨兵（noFields / unknown）= 无事实，一律不发字段。 */
  vocabulary: ThinkingVocabulary;
  /** 本次请求是否流式（档位规则的 streamOnly 事实已在 resolver 侧消费）。 */
  stream: boolean;
  /** 探针请求：Messages 通道不发思考字段（怪癖 probeOmitsThinking）。 */
  probe: boolean;
  /** 档位规则的 token 上限参数名事实；缺省按本协议默认（Messages 恒为 max_tokens）。 */
  tokenParam?: TokenParam;
  /**
   * 平台识别（口径：thinking-profiles 的 PROVIDERS 键空间，adapter 传
   * `resolveThinkingProviderId` 的结果）。Messages 通道的档位落线（线格式出口）按平台逐格登记
   * （MESSAGES_TIER_EXIT）；未登记的平台发裸 `output_config.effort`。
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

// ===== 中转词汇 → OpenAI 通道的线格式字段（本文件唯一的词汇投影）=====
// 事实层给的是封闭联合（哪套词汇、载荷是什么），「这套词汇的字段名与形状」在本文件落字：
// 三个载荷成员各对应一套 OpenAI 词汇，两个哨兵（noFields / unknown）一个字段都不发。
// 导出供事实层的结构用例按同一投影对账（openai 行即本投影，见 ADR-0014 决定/补注；
// 逐格行为另由 golden 逐字节钉住）。
export function openaiVocabularyFields(vocabulary: ThinkingVocabulary): Record<string, unknown> {
  switch (vocabulary.kind) {
    case "reasoningEffort":
      return { reasoning_effort: vocabulary.level };
    case "enableThinking":
      return { enable_thinking: vocabulary.on };
    case "thinkingType":
      return { thinking: { type: vocabulary.type } };
    case "noFields":
    case "unknown":
      return {};
  }
}

// ===== OpenAI chat completions =====
// 档位规则的词汇就是本协议的线格式（reasoning_effort / enable_thinking /
// thinking:{type} 三套直写）→ 映射是上一条投影原样并入；token 上限参数名随档位规则事实
// （怪癖 maxTokensField：openai-reasoning 系只认 max_completion_tokens）。
// 探针不特化：探针请求照发思考字段（现状不变；probeOmitsThinking 是 Messages 侧事实）。
function openaiWireMap({ vocabulary, tokenParam }: ThinkingWireInput): ThinkingWireOutput {
  return { fields: openaiVocabularyFields(vocabulary), tokenParam: tokenParam ?? "max_tokens" };
}

// ===== Anthropic Messages =====
// **本行不发 budget_tokens**（硬规则）：官方没有 effort→预算的换算表，自定预算会挤占
// max_tokens 并把正文挤空；开档一律只发档位词汇或裸开关。

// ===== 两张出口表（档位 01 / off 02）共用的出处形状 =====
// 一格一条出处，三级取值（票面口径，每格必填）：实测（HTTP 状态 + 日期 + 请求体）/ 文档
// （厂商文档 URL）/ 推断（未研究过或不含专项 → 按本轮默认）。本仓与本机没有任何平台 API key
// （既有票已确认），拿不到实测的格子一律如实标「推断」；**负证据**（官方字段表未列某字段，
// 如 stepfun 那格）保留三级取值、在 source 里写明「未列（负证据，不主张 400）」并给 URL——
// 不新增第四态，避免为一种措辞多养一个枚举。
export interface MessagesExitProvenance {
  level: "实测" | "文档" | "推断";
  source: string;
}

/**
 * 平台在 Messages 通道的**线格式出口形态**（平台事实，02 号票建表；08 号票起命名即历史沿革，
 * 职责按本注读）：只回答「已折好的档位词在这个端点落成哪个字段」，不再回答「这个平台
 * 有哪些合法档位词」：
 * - "effort"：`output_config.effort` + 显式 thinking 开关（平台官方文档登记了该字段与
 *   取值形状）；
 * - "effort-bare"：只发 `output_config.effort`——不带 thinking 对象才安全（openrouter 的
 *   `thinking.type:"enabled"` 必带预算；opencodego / modelscope 的 thinking 形状
 *   无官方文档，只发档位字段不冒硬 400 风险）；
 * - "reasoning-effort"：顶层 `reasoning_effort`（该端点未登记 thinking 形状）。
 */
export type MessagesTierVocabulary = "effort" | "effort-bare" | "reasoning-effort";

/**
 * 档位出口的第四态（thinking-wire-protocol-split 01）：**没人研究过**该端点的档位字段 →
 * 按「未登记出口」回落成裸 `output_config.effort`（与建表前的隐式默认逐字节相同）。
 * 与 "effort-bare"（有依据地声明只发档位字段）在类型与静态对账上必须可区分：新增平台不表态
 * 会被键集对账拦下，而不是静默继承默认——02 号票对 off 那格立的同一条规矩。
 */
export type MessagesTierExitKind = MessagesTierVocabulary | "unresearched";

export interface MessagesTierExitCell {
  kind: MessagesTierExitKind;
  /**
   * 该格出口的判据主人（怪癖词表键）。有值时本表只声明归属、判据取该怪癖的**活值**
   * （`effortVocabularyOnly`），不复制它的平台键集（对账测试钉住两者一一对应）。
   */
  owner?: CompatQuirk;
  provenance: MessagesExitProvenance;
}

// Messages 通道的**档位出口表**（thinking-wire-protocol-split 01 建表；职责同 08 号票的归一化层）。
// 键 = 平台识别，口径见 ThinkingWireInput.platformId（thinking-profiles 的 PROVIDERS 键空间），
// **要求全覆盖**：新增平台不在本表表态 → tests/ai/thinking-wire-map.test.ts 红（02 号票对 off
// 那格立的同一条键集纪律）。表外（platformId 未识别：custom 直填未入 host 索引的端点）= 未声明
// → 裸 effort，见 messagesTierExitCell。
// 只持有两件事：① 线格式出口（kind，逐格注释带官方出处）；② 平台侧折叠——把内部档位折成该
// 端点的线上词，**只许收敛**（多档折同词，如平台把 low/medium 都折成 high），不许**发散**
// （返回上游值集里没有的词）。
// **不持有「哪些档位词合法」**：合法性一律来自 02 号票的值集产物
// （ai/catalog/models-dev-thinking.generated.ts）——thinking-profiles 的 ruleFromUpstreamFact
// 按逐模型值集物化档位写点，「有写点 = 该档可用」，所以能走到本表的词本就来自该模型的上游
// 值集（静态判据见 tests/ai/thinking-wire-map.test.ts「归一化不发散」）。
// 折叠现状：**所有平台恒等**——上游值集已逐模型物化出真实档位，没有已知需要平台侧折叠的
// 缺口；zhipu 把 low/medium 折成 high 是**服务端**归一化，本表不代平台改写档位词。
// stepfun / amd 两格是怪癖 effortVocabMessages 的托管格：本表声明归属（owner），判据取该怪癖的
// 活值（只发裸 output_config.effort）——见 anthropicWireMap 的怪癖支。各格形状一律以官方文档
// 为准，档位规则算出的档位词（reasoning_effort 值）原样作为平台档位词发出，不另造映射。
export const MESSAGES_TIER_EXIT: Record<string, MessagesTierExitCell> = {
  // deepseek：Anthropic 兼容页只支持 thinking 与 output_config（且 "Only effort is supported"），
  // budget_tokens 被忽略；档位词 low/high/max（默认 high）
  // （api-docs.deepseek.com/guides/anthropic_api、api-docs.deepseek.com/guides/thinking_mode）。
  deepseek: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "api-docs.deepseek.com/guides/anthropic_api（Anthropic 兼容页只登记 thinking 与 output_config，Only effort is supported）+ /guides/thinking_mode（档位词 low/high/max，默认 high）"
    }
  },
  // qwen 百炼：output_config.effort 为平台扩展参数、budget_tokens「即将废弃」；qwen3.8-max
  // 词表 xhigh/medium/low（默认 xhigh，high/max 映射为 xhigh）——档位规则的 high 档正是 xhigh
  // （help.aliyun.com/zh/model-studio/anthropic-api-messages）。
  // qwen3-max **不走本行**：上游值集是 `toggle+b:-81920`（无 effort 词表），low/high 同为
  // 裸开档、塌陷是唯一形状——上游事实，见 anthropicWireMap 的 ② 格注释。
  qwen: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "help.aliyun.com/zh/model-studio/anthropic-api-messages（output_config.effort 为平台扩展参数、旧式思考预算参数即将废弃；qwen3.8-max 词表 xhigh/medium/low，high/max 映射为 xhigh）"
    }
  },
  // zhipu：Coding Plan 页登记 Claude Code 走 thinking.type + output_config.effort；GLM-5.2 的
  // 档位词表 max/xhigh/high/medium/low/minimal/none，但官方明确 low/medium 折成 high、xhigh 折成
  // max，且「low（轻度推理）」作为**生效档位**仅 GLM-5.3 支持——即 GLM-5.2 实际只有
  // 放弃思考(none/minimal) / high / max 三态，low 与 high 在服务端同档（平台侧既有归一化，
  // 本表不代平台改写档位词；缺口见 02 号票 Comments）
  // （docs.bigmodel.cn/cn/guide/capabilities/thinking、docs.bigmodel.cn/cn/coding-plan/latest-model）。
  zhipu: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "docs.bigmodel.cn/cn/guide/capabilities/thinking + docs.bigmodel.cn/cn/coding-plan/latest-model（Claude Code 走 thinking.type + output_config.effort；GLM-5.2 服务端把 low/medium 折成 high、xhigh 折成 max）"
    }
  },
  // openrouter：/messages 的 output_config.effort 词表 low/medium/high/xhigh/max；thinking.enabled
  // 分支 required:[type, budget_tokens]（必带预算），故本平台只发 effort、不带 thinking 对象
  // （openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message）。
  openrouter: {
    kind: "effort-bare",
    provenance: {
      level: "文档",
      source:
        "openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message（/messages 的 output_config.effort 词表 low/medium/high/xhigh/max；thinking.enabled 分支的 required 里含思考预算字段 → 不带 thinking 对象）"
    }
  },
  // sensenova：thinking.type 与 output_config.effort 均登记；词表同页三处冲突，Claude Code FAQ 的
  // 400 文案只允许 low/medium/high（xhigh 被拒）→ 只走这三档（platform.sensenova.cn/docs）。
  sensenova: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "platform.sensenova.cn/docs（thinking.type 与 output_config.effort 均登记；Claude Code FAQ 的 400 文案只允许 low/medium/high，xhigh 被拒）"
    }
  },
  // moonshot：仓库 base 是 Kimi Code（api.kimi.com/coding），该端点登记的档位词是顶层
  // reasoning_effort low/high/max（k3 默认 high）；该端点的 output_config.effort / budget_tokens
  // 无官方文档（开放平台另一端点才是 output_config.effort，不可混用）
  // （kimi.com/code/docs/kimi-code/models.html）。
  moonshot: {
    kind: "reasoning-effort",
    provenance: {
      level: "文档",
      source:
        "kimi.com/code/docs/kimi-code/models.html（Kimi Code 端点登记的档位词是顶层 reasoning_effort low/high/max；该端点 output_config.effort 与思考预算字段无官方文档）"
    }
  },
  // opencodego：官方文档（opencode.ai/docs/go、/docs/zen）与 /zen/go/v1/models 元数据都未登记
  // 思考控制参数；按产品裁定该网关 Messages 端点可正常接收档位词（2026-09，用户确认）→ 发
  // output_config.effort（裸形态：thinking.enabled 是否必带 budget_tokens 无文档，不冒硬 400
  // 风险），不再退回自定 budget_tokens。
  opencodego: {
    kind: "effort-bare",
    provenance: {
      level: "推断",
      source:
        "opencode.ai/docs/go、opencode.ai/docs/zen 与 /zen/go/v1/models 元数据都未登记思考控制参数；按产品裁定（2026-09 用户确认）该网关 Messages 端点可接收档位词 → 发裸 output_config.effort"
    }
  },
  // modelscope：官方（Beta）Anthropic 兼容端点未登记档位字段；命中 effort 血统的托管模型
  // （如直填 id qwen3.8-max）按同一产品裁定发 output_config.effort（裸形态，
  // api-inference.modelscope.cn）。该端点已实测收 thinking:{type:"disabled"}
  // （怪癖 thinkingDisabledMustBeExplicit），但 enabled 形态无文档 → 只发档位字段。
  modelscope: {
    kind: "effort-bare",
    provenance: {
      level: "推断",
      source:
        "官方（Beta）Anthropic 兼容端点 api-inference.modelscope.cn 未登记档位字段（该端点只有 off 专项实测）；命中 effort 血统的托管模型按产品裁定发裸 output_config.effort"
    }
  },
  // ===== 怪癖托管格与未研究过的格（01 号票起显式表态，建表前靠隐式默认）=====
  // stepfun：Messages 通道只认 output_config.effort，发 thinking 字段直接 400 —— 怪癖
  // effortVocabMessages 是判据主人（compat-vocab 词表），本格只声明归属。
  // 证据是**负证据**：stepfun 官方字段表未列 thinking（platform.stepfun.com 模型协议页）。
  stepfun: {
    kind: "effort-bare",
    owner: "effortVocabMessages",
    provenance: {
      level: "文档",
      source:
        "stepfun 官方字段表未列 thinking（负证据，不主张 400）：platform.stepfun.com 模型协议页；判据取 compat-vocab 的 effortVocabMessages 活值（只认 output_config.effort）"
    }
  },
  // amd：网关对 thinking 形状报 not supported、提示改用 effort 词汇（2026-09 实测，
  // 见 PROVIDERS.amd 注）——同样由怪癖 effortVocabMessages 定，本格只声明归属。
  amd: {
    kind: "effort-bare",
    owner: "effortVocabMessages",
    provenance: {
      level: "实测",
      source:
        "2026-09 实测：网关对 thinking 形状报 not supported、提示改用 effort 词汇（developer.amd.com.cn；原始记录见 thinking-profiles 的 PROVIDERS.amd 注，仓库无响应体留档）；判据取怪癖 effortVocabMessages 的活值"
    }
  },
  // minimax：Anthropic 兼容页登记 output_config.effort（Fully Supported，但**只对
  // `MiniMax-M3.1-Flash-Preview` 生效**，词表 low/medium/high/xhigh/max、none 报 400）与
  // thinking（同页 Thinking Control 表；开词是 adaptive，见 MESSAGES_ON_EXIT）。目录内没有
  // M3.1 行（minimax-cn 的思考事实只有 MiniMax-M3 一行 toggle）→ 本格今天没有端到端档位
  // 路径：登记是让「凭什么」可审，不是新增行为。
  minimax: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "platform.minimax.io/docs/api-reference/text-anthropic-api：output_config.effort 为 Fully Supported（仅 MiniMax-M3.1-Flash-Preview，low/medium/high/xhigh/max，none 报 400）；thinking 为同一参数表登记的原生参数"
    }
  },
  // mimo：百炼代售页只登记 OpenAI 通道的开关（enable_thinking，同 CLASSES.mimo-hybrid-switch），
  // Messages 侧的档位出口没有文档。
  mimo: {
    kind: "unresearched",
    provenance: {
      level: "推断",
      source:
        "aliyun.com 百炼代售页只登记 OpenAI 通道的开关（enable_thinking，同 CLASSES.mimo-hybrid-switch）；Messages 侧档位出口无文档 → 未研究过"
    }
  },
  // ollama（本地）：OpenAI 兼容文档只讲 OpenAI 通道（手写兜底 unknownClass ollama-effort 的 off
  // 走 reasoning_effort:"none"），Messages 侧无思考参数文档。
  ollama: {
    kind: "unresearched",
    provenance: {
      level: "推断",
      source: "docs.ollama.com（OpenAI 兼容；Messages 通道无思考参数文档）→ 未研究过，按未登记出口回落裸 output_config.effort"
    }
  },
  // siliconflow：手写兜底 unknownClass siliconflow-switch 的 off 走 enable_thinking:false
  // （docs.siliconflow.cn）；Messages 侧未登记思考参数。
  siliconflow: {
    kind: "unresearched",
    provenance: {
      level: "推断",
      source:
        "docs.siliconflow.cn（Messages 侧未登记思考参数；手写兜底 siliconflow-switch 的 off 走 enable_thinking:false）→ 未研究过"
    }
  }
};

// 表外 / platformId 未识别（custom 直填未入 host 索引的端点）：与"unresearched"同态（→ 裸 effort），
// 但它是**兜底**而不是某平台的一格，故不进 MESSAGES_TIER_EXIT 的键集（键集对账会红）。
export const UNRESEARCHED_TIER_EXIT: MessagesTierExitCell = {
  kind: "unresearched",
  provenance: { level: "推断", source: "platformId 未识别（表外）→ 按未登记出口回落裸 output_config.effort" }
};

/** 该平台在 Messages 通道的档位出口（表外 / 未识别 → 未声明）。 */
export function messagesTierExitCell(platformId: string | undefined): MessagesTierExitCell {
  const id = String(platformId || "").trim();
  if (id && Object.prototype.hasOwnProperty.call(MESSAGES_TIER_EXIT, id)) return MESSAGES_TIER_EXIT[id];
  return UNRESEARCHED_TIER_EXIT;
}

// ===== Messages 通道的 off 出口表（thinking-wire-protocol-split 02；行为中立）=====
// 本表落地前，「关思考」在本通道只有一个隐式判据：全局归一成 `thinking:{type:"disabled"}`，
// 除非怪癖 effortVocabMessages（stepfun / amd）命中就什么都不发。那条「全局默认 + 一个
// 布尔例外」不可审：① 调用方答不出「每个平台的 off 出口是什么、凭什么」；②「未研究过」
// 与「有依据地声明为原生」在代码里是同一个 falsy 状态，新增平台会自动继承默认而不表态；
// ③「明确不发」那一格（stepfun / amd）只活在 if 里，没有一行让人看见。
// 本表把这一格变成逐格可审的显式声明，取值四态（ADR-0014 决定 5 的实施形态；键形仍是平台——
// 写法层本来就以协议为键，这张表就长在 anthropic 行里，见 docs/adr/0014 的第二条补注）：
// - "native"      = Anthropic 原生 `thinking:{type:"disabled"}`（**必须显式写出**，不靠缺省）；
// - "word"        = 平台自有词（显式字段载荷；本仓今天没有实例，类型上可表达）；
// - "silent"      = 明确不发（带 reason）；owner 有值时该格的判据是 compat-vocab 的怪癖活值；
// - "unresearched"= 没人研究过 → 按原生默认（与 "native" 在类型/静态对账上可区分）。
// 键集纪律：本表键 = thinking-profiles 的 PROVIDERS 键空间（与 MESSAGES_TIER_EXIT 同口径的
// 平台识别，但本表**要求全覆盖**：新增平台不表态 → tests/ai/thinking-wire-map.test.ts 红）。
// 表外（platformId 未识别：custom 直填未入 host 索引的端点）= 未声明 → 原生，见 messagesOffExitCell。
// provenance 每格必填，三级取值与用法见 MessagesExitProvenance 头注（两张出口表共用）。
export type MessagesOffExitKind = "native" | "silent" | "word" | "unresearched";

export interface MessagesOffExitCell {
  kind: MessagesOffExitKind;
  /**
   * 该格「明确不发」的判据主人（怪癖词表键）。有值时本表只声明归属、判据取该怪癖的活值，
   * 不复制它的平台键集（对账测试钉住两者一一对应）。
   */
  owner?: CompatQuirk;
  /** kind="silent" 的依据文案（给人读；出处见 provenance）。 */
  reason?: string;
  /** kind="word"：平台自有词的字段载荷（本仓今天无实例）。 */
  fields?: Record<string, unknown>;
  provenance: MessagesExitProvenance;
}

export const MESSAGES_OFF_EXIT: Record<string, MessagesOffExitCell> = {
  // 上游形状表登记 thinking:{type} 开关（UPSTREAM_TOGGLE_SHAPES），off 写点 = thinking:{type:"disabled"}；
  // 该端点只支持 thinking 与 output_config（api-docs.deepseek.com/guides/anthropic_api）。
  // Messages 侧未实测 → 推断。
  deepseek: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "上游形状表 toggle 的 off = thinking:{type:disabled}；api-docs.deepseek.com/guides/anthropic_api（Messages 侧未实测）"
    }
  },
  // 上游形状表 off = enable_thinking:false；百炼 Anthropic 兼容页只登记档位出口、无 off 专项
  // （help.aliyun.com/zh/model-studio/anthropic-api-messages）→ 推断。
  qwen: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "上游形状表 toggle 的 off = enable_thinking:false；help.aliyun.com/zh/model-studio/anthropic-api-messages 只登记档位出口"
    }
  },
  // Coding Plan 页登记 Claude Code 走 thinking.type：thinking.type 是该端点原生参数
  // （docs.bigmodel.cn/cn/guide/capabilities/thinking）。
  zhipu: {
    kind: "native",
    provenance: { level: "文档", source: "docs.bigmodel.cn/cn/guide/capabilities/thinking：thinking.type 为原生参数" }
  },
  // Kimi Code 端点（api.kimi.com/coding）只登记顶层 reasoning_effort、未登记 thinking 形状
  // （kimi.com/code/docs/kimi-code/models.html）→ 推断（跨方言等价无官方支撑，ADR-0014 后果节已登记）。
  moonshot: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "kimi.com/code/docs/kimi-code/models.html：该端点未登记 thinking 形状，仅顶层 reasoning_effort"
    }
  },
  // Anthropic 兼容页的 Thinking Control 表登记 `thinking` 为该端点原生参数，且
  // `MiniMax-M3` 的 `{type:"disabled"}` =「thinking stays off」（省略也关）。2026-10-05 用户
  // 裁定：「关不了」只适用于 M2.x（收下但忽略）与 `MiniMax-M3.1-Flash-Preview`（发 disabled
  // 直接 400）；后两者不在 02 指派表 → 今天没有 400 路径。形状登记见 UPSTREAM_TOGGLE_SHAPES.minimax。
  minimax: {
    kind: "native",
    provenance: {
      level: "文档",
      source:
        "platform.minimax.io/docs/api-reference/text-anthropic-api 的 Thinking Control 表：MiniMax-M3 的 thinking:{type:disabled} = thinking stays off（thinking 为该页 Fully Supported 的原生参数；M2.x 收下但忽略、M3.1 报 400）"
    }
  },
  // 上游形状表 off = enable_thinking:false（aliyun.com 百炼代售页；同 CLASSES.mimo-hybrid-switch）→ 推断。
  mimo: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "上游形状表 toggle 的 off = enable_thinking:false（aliyun.com 百炼代售页；Messages 侧未实测）"
    }
  },
  // 值集自带 effort-none（reasoning_effort:"none"）；/messages 的 effort 词表见官方参考页。
  // reasoning:{exclude} 语义是「藏思考」不是「关思考」，不用于 off（PROVIDERS.openrouter 注）→ 推断。
  openrouter: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "值集自带 effort-none；openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message（Messages 侧未实测）"
    }
  },
  // 值集自带 effort-none；网关无思考参数文档，2026-09 产品裁定该 Messages 端点可接收档位词
  // （opencode.ai/docs/zen）→ 推断。
  opencodego: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "值集自带 effort-none；opencode.ai/docs/zen 未登记思考控制参数（2026-09 产品裁定）"
    }
  },
  // 商汤 Token Plan：值集自带 effort-none（token.sensenova.cn/v1；platform.sensenova.cn/docs）
  // → 推断。
  sensenova: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "值集自带 effort-none（platform.sensenova.cn/docs；Messages 侧未实测）"
    }
  },
  // stepfun：Messages 通道只认 output_config.effort，发 thinking 字段直接 400 —— 怪癖
  // effortVocabMessages 是语义主人（compat-vocab 词表），本格只声明归属。
  // 证据是**负证据**：stepfun 官方字段表未列 thinking（platform.stepfun.com 模型协议页）。
  stepfun: {
    kind: "silent",
    owner: "effortVocabMessages",
    reason: "该端点只认 output_config.effort，发 thinking 字段直接 400（怪癖 effortVocabMessages）",
    provenance: {
      level: "文档",
      source: "stepfun 官方字段表未列 thinking（负证据，不主张 400）：platform.stepfun.com 模型协议页；语义见 compat-vocab 的 effortVocabMessages"
    }
  },
  // amd：网关对 thinking 形状报 not supported、提示改用 reasoning_effort（2026-09 实测，
  // 见 PROVIDERS.amd 注）——同样由怪癖 effortVocabMessages 定，本格只声明归属。
  amd: {
    kind: "silent",
    owner: "effortVocabMessages",
    reason: "网关对 thinking 形状报 not supported、只收 output_config.effort（怪癖 effortVocabMessages）",
    provenance: {
      level: "实测",
      source: "2026-09 实测：网关对 thinking 形状报 not supported 并提示改用 reasoning_effort（developer.amd.com.cn；原始记录见 thinking-profiles 的 PROVIDERS.amd 注，仓库无响应体留档）"
    }
  },
  // ollama（本地）：手写兜底 unknownClass ollama-effort 的 off = reasoning_effort:"none"
  // （docs.ollama.com OpenAI 兼容：thinking/enable_thinking 被静默忽略）；Messages 侧未实测 → 推断。
  ollama: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "手写兜底 unknownClass ollama-effort 的 off = reasoning_effort:none（docs.ollama.com；Messages 侧未实测）"
    }
  },
  // siliconflow：手写兜底 unknownClass siliconflow-switch 的 off = enable_thinking:false
  // （docs.siliconflow.cn）；Messages 侧未实测 → 推断。
  siliconflow: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "手写兜底 unknownClass siliconflow-switch 的 off = enable_thinking:false（docs.siliconflow.cn；Messages 侧未实测）"
    }
  },
  // modelscope 是唯一有 off 专项实测的格子（怪癖 thinkingDisabledMustBeExplicit）：该端点默认开
  // 思考、enable_thinking:false 被忽略、思考计入 max_tokens 会把正文挤成空串，只有
  // thinking:{type:"disabled"} 能真正关掉。
  modelscope: {
    kind: "native",
    provenance: {
      level: "实测",
      source: "2026-09 ModelScope Messages 端点实测：enable_thinking:false 被忽略、思考计入 max_tokens 挤空正文，只有 thinking:{type:disabled} 生效（原始记录见 compat-vocab 的 thinkingDisabledMustBeExplicit，仓库无响应体留档）"
    }
  }
};

// 表外 / platformId 未识别（custom 直填未入 host 索引的端点）：与「未研究过」同态（→ 原生），
// 但它是**兜底**而不是某平台的一格，故不进 MESSAGES_OFF_EXIT 的键集（键集对账会红）。
export const UNRESEARCHED_OFF_EXIT: MessagesOffExitCell = {
  kind: "unresearched",
  provenance: { level: "推断", source: "platformId 未识别（表外）→ 按 Anthropic 原生默认" }
};

/** 该平台在 Messages 通道的 off 出口（表外 / 未识别 → 未声明）。 */
export function messagesOffExitCell(platformId: string | undefined): MessagesOffExitCell {
  const id = String(platformId || "").trim();
  if (id && Object.prototype.hasOwnProperty.call(MESSAGES_OFF_EXIT, id)) return MESSAGES_OFF_EXIT[id];
  return UNRESEARCHED_OFF_EXIT;
}

// ===== Messages 通道的开词出口表（2026-10-05 用户裁定：形态 A「逐格显式声明开词」）=====
// 本表落地前，本通道的「开思考」只有一个隐式写法：开档一律**硬写**
// `thinking:{type:"enabled"}`（档位出口 kind="effort" 的显式开关与开关型血统的裸开档两处）。
// 对登记了 Anthropic 原生方言的平台这没错，但对枚举词不是 enabled 的平台（minimax 只有
// disabled / adaptive）就是替平台发明词——写死的那一行也说不清「凭什么」。本表把开词逐格
// 显式登记，与 MESSAGES_TIER_EXIT（档位出口）/ MESSAGES_OFF_EXIT（关词出口）同形同纪律，
// 是决定 5 逐格落地的**第二张**表（第一张是 off 表；协议键形见 ADR-0014 的第二条补注）：
// - "native"      = Anthropic 原生 `thinking:{type:"enabled"}`（建表前的硬写值，行为中立）；
// - "word"        = 平台自有开词（显式字段载荷；今天只有 minimax 的 adaptive）；
// - "unresearched"= 没人研究过该端点的开词 → 按原生（与 "native" 在类型/静态对账上可区分）。
// 键集纪律与两张姊妹表相同：表 = PROVIDERS 键空间、要求全覆盖（新增平台不表态 → 测试红）；
// 表外（platformId 未识别：custom 直填未入 host 索引的端点）= 未声明 → 原生，见
// messagesOnExitCell。provenance 每格必填（三态取值与用法见 MessagesExitProvenance 头注）。
// 三件事**不在本表**：关词（MESSAGES_OFF_EXIT）、档位词（MESSAGES_TIER_EXIT）、以及
// 「哪一档可用」的合法性（02 值集）。本表只回答「开档那个 thinking 开关在这个端点写什么词」。
// 怪癖托管格（stepfun / amd）不需要 owner：strict effort 词汇那一支在到达开词之前就返回
// （开关词汇不透传），两格永远走不到本表——对账测试断言这条不可达性。
export type MessagesOnExitKind = "native" | "word" | "unresearched";

export interface MessagesOnExitCell {
  kind: MessagesOnExitKind;
  /** kind="word"：平台自有「开」词的字段载荷（只许是不带预算的开关形状，见文件头硬规则）。 */
  fields?: Record<string, unknown>;
  provenance: MessagesExitProvenance;
}

export const MESSAGES_ON_EXIT: Record<string, MessagesOnExitCell> = {
  // 该端点只支持 thinking 与 output_config（Anthropic 兼容页登记 thinking 开关）→ 开档原生 enabled。
  deepseek: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "api-docs.deepseek.com/guides/anthropic_api（Anthropic 兼容页登记 thinking 开关；开档走原生 enabled，与建表前逐字节相同）"
    }
  },
  // 百炼 Anthropic 兼容页登记 thinking.type 与 output_config.effort；开档词无专项 → 按原生。
  qwen: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "help.aliyun.com/zh/model-studio/anthropic-api-messages（登记 thinking.type，开档词无专项 → 原生 enabled，与建表前逐字节相同）"
    }
  },
  // Claude Code 走 thinking.type（该端点原生参数）→ 开档原生 enabled。
  zhipu: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "docs.bigmodel.cn/cn/guide/capabilities/thinking + /cn/coding-plan/latest-model（Claude Code 走 thinking.type，开档原生 enabled）"
    }
  },
  // Token Plan 端点登记 thinking.type 与 output_config.effort；开档走原生 enabled。
  sensenova: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "platform.sensenova.cn/docs（thinking.type 与 output_config.effort 均登记；开档走原生 enabled，与建表前逐字节相同）"
    }
  },
  // minimax 的 enum 只有 disabled / adaptive（没有 enabled）→ 开词是 adaptive。两通道同词，
  // 事实层也用 adaptive（UPSTREAM_TOGGLE_SHAPES.minimax），本格是 Messages 侧的写法事实
  // （档位出口 kind="effort" 与开关型裸开档两条路都读它）。
  minimax: {
    kind: "word",
    fields: { thinking: { type: "adaptive" } },
    provenance: {
      level: "文档",
      source:
        "platform.minimax.io/docs/api-reference/text-anthropic-api（Thinking Control 表：{type:adaptive} = thinking on；{type:disabled} = M3 保持关、M3.1 报 400）"
    }
  },
  // 百炼代售页只登记 OpenAI 通道的 enable_thinking；Messages 侧开词无文档 → 按原生。
  // 今天无路径：mimo 的开关形状开词是 enable_thinking，但 Messages 通道的开关型格按原生发。
  mimo: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "aliyun.com 百炼代售页只登记 OpenAI 通道的 enable_thinking；Messages 侧开词无文档 → 按原生 enabled（与建表前逐字节相同）"
    }
  },
  // Kimi Code 端点（api.kimi.com/coding）只登记顶层 reasoning_effort、未登记 thinking 形状；
  // 该端点今天也没有开写点（开关形状未登记）→ 开词出口无路径，按原生。
  moonshot: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "kimi.com/code/docs/kimi-code/models.html：该端点未登记 thinking 形状、开关形状也未登记 → 开词出口今天无路径，按原生 enabled"
    }
  },
  // /messages 的 thinking.enabled 分支 required 里含预算字段（本仓不发预算）→ 今天无路径：
  // 该网关既未登记开关形状（无开写点），档位出口又是 effort-bare（不显式发开关）。
  openrouter: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message（thinking.enabled 必带预算 → 本仓不发；开关形状未登记、档位出口 effort-bare → 开词出口今天无路径，按原生登记）"
    }
  },
  // 网关文档未登记思考参数（2026-09 产品裁定可收档位词）→ 无开写点（开关形状未登记），按原生。
  opencodego: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "opencode.ai/docs/zen 未登记思考控制参数（2026-09 产品裁定只登记档位词）；开关形状未登记 → 开词出口今天无路径，按原生"
    }
  },
  // strict effort 词汇格（怪癖 effortVocabMessages）：开分支在到达本表之前就返回，永不读本格。
  stepfun: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "platform.stepfun.com 官方字段表未列 thinking（负证据）；该端点由怪癖 effortVocabMessages 只认 output_config.effort → 本格不可达，按原生登记"
    }
  },
  // 同 stepfun：网关对 thinking 形状报 not supported（2026-09 实测）→ 本格不可达。
  amd: {
    kind: "native",
    provenance: {
      level: "实测",
      source: "2026-09 实测：网关对 thinking 形状报 not supported、只收 effort 词汇（developer.amd.com.cn；原始记录见 thinking-profiles 的 PROVIDERS.amd 注）→ 本格不可达，按原生登记"
    }
  },
  // Messages 侧无思考参数文档；档位出口 unresearched（裸 effort）→ 开词出口今天无路径。
  ollama: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "docs.ollama.com（OpenAI 兼容；Messages 通道无思考参数文档）→ 开词出口今天无路径，按原生"
    }
  },
  // Messages 侧未登记思考参数 → 开词出口今天无路径（档位出口 unresearched）。
  siliconflow: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "docs.siliconflow.cn（Messages 侧未登记思考参数）→ 开词出口今天无路径，按原生"
    }
  },
  // **可达格**：modelscope 登记了开关形状（on = enable_thinking:true），开关型血统的开档会走
  // 本格 → 发原生 enabled。该端点只实测过 off 侧（thinking:{type:disabled} 生效、enabled 形态
  // 无文档）——这条既存张力登记在此，不在本票改行为（票 thinking-wire-protocol-split 的边界条）。
  modelscope: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "官方（Beta）Anthropic 兼容端点 api-inference.modelscope.cn 只实测收 thinking:{type:disabled}、enabled 形态无文档；开关型血统开档按原生 enabled（与建表前逐字节相同）"
    }
  }
};

// 表外 / platformId 未识别（custom 直填未入 host 索引的端点）：与「未研究过」同态（→ 原生），
// 但它是**兜底**而不是某平台的一格，故不进 MESSAGES_ON_EXIT 的键集（键集对账会红）。
export const UNRESEARCHED_ON_EXIT: MessagesOnExitCell = {
  kind: "unresearched",
  provenance: { level: "推断", source: "platformId 未识别（表外）→ 按 Anthropic 原生默认（thinking:{type:enabled}）" }
};

/** 该平台在 Messages 通道的开词出口（表外 / 未识别 → 未声明）。 */
export function messagesOnExitCell(platformId: string | undefined): MessagesOnExitCell {
  const id = String(platformId || "").trim();
  if (id && Object.prototype.hasOwnProperty.call(MESSAGES_ON_EXIT, id)) return MESSAGES_ON_EXIT[id];
  return UNRESEARCHED_ON_EXIT;
}

// 开档的 thinking 开关载荷：逐格查 MESSAGES_ON_EXIT（word → 平台自有词；native / unresearched /
// 表外 → Anthropic 原生 enabled）。**只发开关形状**，不带上限（文件头硬规则）。
function onThinkingFields(platformId: string | undefined): Record<string, unknown> {
  const cell = messagesOnExitCell(platformId);
  if (cell.kind === "word" && cell.fields) return { ...cell.fields };
  return { thinking: { type: "enabled" } };
}

// 中转词汇 → 本行的四态写法（off / effort 档位词 / 开档 / 无事实）。
// **按 kind 分支**是这次改造的要害：改造前 off 判定是在 `fields` 记录上嗅探三个字面量
// （reasoning_effort==="none" / enable_thinking===false / thinking.type==="disabled"），
// 词汇形状一旦发散就静默漏判；判别联合把这件事变成编译器看得见的穷尽 switch。
type VocabularyWireForm =
  | { form: "off" }
  | { form: "effort"; word: string }
  | { form: "on" }
  | { form: "none" };

function vocabularyWireForm(vocabulary: ThinkingVocabulary): VocabularyWireForm {
  switch (vocabulary.kind) {
    case "reasoningEffort":
      // "none" 是 off 的一种线值实现（决策 #7），不是档位词：它走 off 出口；
      // 其余档位词（low/medium/xhigh/…）原样透传本通道。
      return vocabulary.level === "none" ? { form: "off" } : { form: "effort", word: vocabulary.level };
    case "enableThinking":
      return vocabulary.on ? { form: "on" } : { form: "off" };
    case "thinkingType":
      return vocabulary.type === "disabled" ? { form: "off" } : { form: "on" };
    case "noFields":
    case "unknown":
      return { form: "none" };
  }
}

// Messages 通道的思考档位改写（怪癖 thinkingFormat）：档位规则的 chat 形状字段 →
// Anthropic 线格式。三种关思考词汇的出口逐格登记在 MESSAGES_OFF_EXIT（thinking-wire-protocol-split 02）——默认
// thinking:{type:"disabled"}（怪癖 thinkingDisabledMustBeExplicit：「Anthropic 默认即关、
// 一律不发字段」在默认开思考的网关上不成立：ModelScope Messages 端点实测 2026-09，
// deepseek-ai/DeepSeek-V4.1-Flash 默认开思考、enable_thinking:false 被忽略、思考计入
// max_tokens 会把正文挤成空串），只有 thinking:{type:"disabled"} 能真正关掉；
// stepfun / amd 那两格由怪癖 effortVocabMessages 定为不发。
//
// 开思考分两格（02 号票在这里把「档位塌陷」改成显式的一格一格）：
// ① effort 血统：档位词的合法性主人在 02 值集（逐模型物化，见 thinking-profiles 的
//    ruleFromUpstreamFact），本层只选线格式出口（MESSAGES_TIER_EXIT）并把档位折到线上、
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
  const form = vocabularyWireForm(input.vocabulary);
  // 无事实（两个哨兵：unknown = 没有解析结论 / noFields = 本档不发言）：维持不发——
  // 软失败优于硬 400。
  if (form.form === "none") return output;

  if (form.form === "off") {
    // 关思考出口 = MESSAGES_OFF_EXIT 逐格（thinking-wire-protocol-split 02）：「原生 / 平台自有词 / 明确不发 / 未声明」
    // 显式登记，「未研究过」不再靠 falsy 默认表达；表外（platformId 未识别）按未声明 → 原生。
    const cell = messagesOffExitCell(input.platformId);
    // ①「明确不发」：静态声明的格（owner 缺省）恒不发；声明了怪癖 owner 的格（stepfun / amd）
    //    判据取 compat-vocab 词表的怪癖活值——本表只声明归属、不复制它的平台键集。
    if (cell.kind === "silent" && (cell.owner == null || input.effortVocabularyOnly)) return output;
    // ② owner 的活值对表外/未声明格同样生效：旧实现的 off 判据是**不分格**的全局怪癖布尔，
    //    这一支保证「presetId 与 baseUrl 手改指向不同厂」（档位词表按 presetId、怪癖按 host）
    //    这类既存身份矛盾也与旧实现逐字节相同（thinking-wire-protocol-split 02 的行为中立验收）。
    if (cell.kind !== "silent" && input.effortVocabularyOnly) return output;
    // ③ 平台自有词的格（今天无实例）：显式载荷原样发出。
    if (cell.kind === "word" && cell.fields) {
      Object.assign(output.fields, cell.fields);
      return output;
    }
    // ④ 其余（native / unresearched / 表外 / owner 未开的 silent 格）= 翻译成 Anthropic 原生
    //    thinking:{type:"disabled"} 显式发出，不依赖服务端默认（怪癖 thinkingDisabledMustBeExplicit）。
    output.fields.thinking = { type: "disabled" };
    return output;
  }

  // 怪癖 effortVocabMessages（stepfun / amd）：只认 output_config.effort，解析层的档位词原样
  // 作为 effort 发出；若档位规则给的是别的开关词汇则不发——软失败优于硬 400。
  // 这一支**不分格**（与建表前的全局布尔实现逐字节相同）：MESSAGES_TIER_EXIT 里那两格用 owner
  // 声明归属，判据取该怪癖的活值——「presetId 与 baseUrl 手改指向不同厂」这类既存身份矛盾也走
  // 这里（与 02 号票 off 分支的 ② 支同一条规矩）。
  if (input.effortVocabularyOnly) {
    if (form.form === "effort") output.fields.output_config = { effort: form.word };
    return output;
  }

  // ① effort 血统：档位词来自 02 值集（合法性主人，逐模型物化）；本格只做归一化（折叠，
  // 现状恒等——只许收敛不许发散）与线格式出口选择，然后把词原样发出。出口逐格查
  // MESSAGES_TIER_EXIT（thinking-wire-protocol-split 01）。
  if (form.form === "effort") {
    const cell = messagesTierExitCell(input.platformId);
    if (cell.kind === "reasoning-effort") {
      // 该端点登记的档位字段是顶层 reasoning_effort（未登记 thinking 形状）：只发档位词。
      output.fields.reasoning_effort = form.word;
      return output;
    }
    // "effort" 形态显式带开思考开关（该平台的 thinking.type 不带预算也合法），开词逐格查
    // MESSAGES_ON_EXIT（minimax 的 enum 没有 enabled，开词是 adaptive）；
    // "effort-bare" 与 "unresearched"（含表外：ollama 的 Messages 通道无思考参数文档、
    // custom 直填端点无平台事实）都只发档位字段——档位词照发，不下发预算。
    output.fields.output_config = { effort: form.word };
    if (cell.kind === "effort") Object.assign(output.fields, onThinkingFields(input.platformId));
    return output;
  }

  // ② 开关型血统：该通道只有开/关两态、无档位词，low 与 high 同为裸开档（显式登记的一格）。
  // 依据：GLM-4.5~5.1、kimi-k2.5/k2.6、doubao-seed 等平台的官方字段表只登记开/关两态
  // （docs.bigmodel.cn、platform.kimi.ai、volcengine.com）；档位规则的 enable_thinking /
  // thinking:{type:"enabled"} 都译成该通道的裸开档形状。开词逐格查 MESSAGES_ON_EXIT
  // （minimax 的 enum 没有 enabled，开词是 adaptive），不再硬写。
  Object.assign(output.fields, onThinkingFields(input.platformId));
  return output;
}

// 键集合必须覆盖词表叶（Record<AiProtocol, …> 是编译期强制：新增协议漏登记即红）。
export const THINKING_WIRE_MAPS: Record<AiProtocol, ThinkingWireMap> = {
  openai: openaiWireMap,
  anthropic: anthropicWireMap
};
