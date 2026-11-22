import type { CompatQuirk } from "./compat-vocab.js";
import type { PlatformKey } from "./platform-identity-vocab.js";
import type { AiProtocol } from "./protocol-vocab.js";
import type { ClassRule, ThinkingVocabulary } from "./thinking-profiles.js";
import type { ThinkingLevelValue } from "./thinking-levels.js";

export type TokenParam = NonNullable<ClassRule["tokenParam"]>;

export interface ThinkingWireInput {
  vocabulary: ThinkingVocabulary;
}

export interface OpenAiWireInput extends ThinkingWireInput {
  tokenParam?: TokenParam;
}

export interface AnthropicWireInput extends ThinkingWireInput {
  probe: boolean;
  platformId?: string;
}

export interface GeminiWireInput extends ThinkingWireInput {
  requestedLevel: ThinkingLevelValue;
}

export interface ThinkingWireInputs {
  openai: OpenAiWireInput;
  anthropic: AnthropicWireInput;
  gemini: GeminiWireInput;
}

export interface ThinkingWireOutput {
  fields: Record<string, unknown>;
  tokenParam: string;
}

export type ThinkingWireMap<K extends AiProtocol> = (input: ThinkingWireInputs[K]) => ThinkingWireOutput;

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

function openaiWireMap({ vocabulary, tokenParam }: OpenAiWireInput): ThinkingWireOutput {
  return { fields: openaiVocabularyFields(vocabulary), tokenParam: tokenParam ?? "max_tokens" };
}

export interface MessagesExitProvenance {
  level: "实测" | "文档" | "推断" | "构造性不适用";
  source: string;
}

export type MessagesTierVocabulary = "effort" | "effort-bare" | "reasoning-effort";

export type MessagesTierExitKind = MessagesTierVocabulary | "unresearched" | "non-messages";

export interface MessagesTierExitCell {
  kind: MessagesTierExitKind;
  owner?: CompatQuirk;
  provenance: MessagesExitProvenance;
}

export const MESSAGES_TIER_EXIT: Record<PlatformKey, MessagesTierExitCell> = {
  deepseek: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "api-docs.deepseek.com/guides/anthropic_api（Anthropic 兼容页只登记 thinking 与 output_config，Only effort is supported）+ /guides/thinking_mode（档位词 low/high/max，默认 high）"
    }
  },
  qwen: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "help.aliyun.com/zh/model-studio/anthropic-api-messages（output_config.effort 为平台扩展参数、旧式思考预算参数即将废弃；qwen3.8-max 词表 xhigh/medium/low，high/max 映射为 xhigh）"
    }
  },
  zhipu: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "docs.bigmodel.cn/cn/guide/capabilities/thinking + docs.bigmodel.cn/cn/coding-plan/latest-model（Claude Code 走 thinking.type + output_config.effort；GLM-5.2 服务端把 low/medium 折成 high、xhigh 折成 max）"
    }
  },
  openrouter: {
    kind: "effort-bare",
    provenance: {
      level: "文档",
      source:
        "openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message（/messages 的 output_config.effort 词表 low/medium/high/xhigh/max；thinking.enabled 分支的 required 里含思考预算字段 → 不带 thinking 对象）"
    }
  },
  sensenova: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "platform.sensenova.cn/docs（thinking.type 与 output_config.effort 均登记；Claude Code FAQ 的 400 文案只允许 low/medium/high，xhigh 被拒）"
    }
  },
  moonshot: {
    kind: "reasoning-effort",
    provenance: {
      level: "文档",
      source:
        "kimi.com/code/docs/kimi-code/models.html（Kimi Code 端点登记的档位词是顶层 reasoning_effort low/high/max；该端点 output_config.effort 与思考预算字段无官方文档）"
    }
  },
  opencodego: {
    kind: "effort-bare",
    provenance: {
      level: "推断",
      source:
        "opencode.ai/docs/go、opencode.ai/docs/zen 与 /zen/go/v1/models 元数据都未登记思考控制参数；按产品裁定（2026-09 用户确认）该网关 Messages 端点可接收档位词 → 发裸 output_config.effort"
    }
  },
  modelscope: {
    kind: "effort-bare",
    provenance: {
      level: "推断",
      source:
        "官方（Beta）Anthropic 兼容端点 api-inference.modelscope.cn 未登记档位字段（该端点只有 off 专项实测）；命中 effort 血统的托管模型按产品裁定发裸 output_config.effort"
    }
  },
  stepfun: {
    kind: "effort-bare",
    owner: "effortVocabMessages",
    provenance: {
      level: "文档",
      source:
        "stepfun 官方字段表未列 thinking（负证据，不主张 400）：platform.stepfun.com 模型协议页；语义见 compat-vocab 的 effortVocabMessages（只认 output_config.effort）"
    }
  },
  amd: {
    kind: "effort-bare",
    owner: "effortVocabMessages",
    provenance: {
      level: "实测",
      source:
        "2026-09 实测：网关对 thinking 形状报 not supported、提示改用 effort 词汇（developer.amd.com.cn；原始记录见 thinking-profiles 的 PROVIDERS.amd 注，仓库无响应体留档）；语义见 compat-vocab 的 effortVocabMessages"
    }
  },
  minimax: {
    kind: "effort",
    provenance: {
      level: "文档",
      source:
        "platform.minimax.io/docs/api-reference/text-anthropic-api：output_config.effort 为 Fully Supported（仅 MiniMax-M3.1-Flash-Preview，low/medium/high/xhigh/max，none 报 400）；thinking 为同一参数表登记的原生参数"
    }
  },
  mimo: {
    kind: "unresearched",
    provenance: {
      level: "推断",
      source:
        "aliyun.com 百炼代售页只登记 OpenAI 通道的开关（enable_thinking，同 CLASSES.mimo-hybrid-switch）；Messages 侧档位出口无文档 → 未研究过"
    }
  },
  ollama: {
    kind: "unresearched",
    provenance: {
      level: "推断",
      source: "docs.ollama.com（OpenAI 兼容；Messages 通道无思考参数文档）→ 未研究过，按未登记出口回落裸 output_config.effort"
    }
  },
  siliconflow: {
    kind: "unresearched",
    provenance: {
      level: "推断",
      source:
        "docs.siliconflow.cn（Messages 侧未登记思考参数；手写兜底 siliconflow-switch 的 off 走 enable_thinking:false）→ 未研究过"
    }
  },
  gemini: {
    kind: "non-messages",
    provenance: {
      level: "构造性不适用",
      source: "Gemini 采用原生 generateContent 协议，构造性不适用 Anthropic Messages 档位出口表（ADR-0009）"
    }
  }
};

export const UNRESEARCHED_TIER_EXIT: MessagesTierExitCell = {
  kind: "unresearched",
  provenance: { level: "推断", source: "platformId 未识别（表外）→ 按未登记出口回落裸 output_config.effort" }
};

function ownExitCell<K extends string, V>(table: Readonly<Record<K, V>>, id: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id as K] : undefined;
}

export function messagesTierExitCell(platformId: string | undefined): MessagesTierExitCell {
  return ownExitCell(MESSAGES_TIER_EXIT, String(platformId || "").trim()) ?? UNRESEARCHED_TIER_EXIT;
}

export type MessagesOffExitKind = "native" | "silent" | "word" | "unresearched" | "non-messages";

export interface MessagesOffExitCell {
  kind: MessagesOffExitKind;
  owner?: CompatQuirk;
  reason?: string;
  fields?: Record<string, unknown>;
  provenance: MessagesExitProvenance;
}

export const MESSAGES_OFF_EXIT: Record<PlatformKey, MessagesOffExitCell> = {
  deepseek: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "上游形状表 toggle 的 off = thinking:{type:disabled}；api-docs.deepseek.com/guides/anthropic_api（Messages 侧未实测）"
    }
  },
  qwen: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "上游形状表 toggle 的 off = enable_thinking:false；help.aliyun.com/zh/model-studio/anthropic-api-messages 只登记档位出口"
    }
  },
  zhipu: {
    kind: "native",
    provenance: { level: "文档", source: "docs.bigmodel.cn/cn/guide/capabilities/thinking：thinking.type 为原生参数" }
  },
  moonshot: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "kimi.com/code/docs/kimi-code/models.html：该端点未登记 thinking 形状，仅顶层 reasoning_effort"
    }
  },
  minimax: {
    kind: "native",
    provenance: {
      level: "文档",
      source:
        "platform.minimax.io/docs/api-reference/text-anthropic-api 的 Thinking Control 表：MiniMax-M3 的 thinking:{type:disabled} = thinking stays off（thinking 为该页 Fully Supported 的原生参数；M2.x 收下但忽略、M3.1 报 400）"
    }
  },
  mimo: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "上游形状表 toggle 的 off = enable_thinking:false（aliyun.com 百炼代售页；Messages 侧未实测）"
    }
  },
  openrouter: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "值集自带 effort-none；openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message（Messages 侧未实测）"
    }
  },
  opencodego: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "值集自带 effort-none；opencode.ai/docs/zen 未登记思考控制参数（2026-09 产品裁定）"
    }
  },
  sensenova: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "值集自带 effort-none（platform.sensenova.cn/docs；Messages 侧未实测）"
    }
  },
  stepfun: {
    kind: "silent",
    owner: "effortVocabMessages",
    reason: "该端点只认 output_config.effort，发 thinking 字段直接 400（怪癖 effortVocabMessages）",
    provenance: {
      level: "文档",
      source: "stepfun 官方字段表未列 thinking（负证据，不主张 400）：platform.stepfun.com 模型协议页；语义见 compat-vocab 的 effortVocabMessages"
    }
  },
  amd: {
    kind: "silent",
    owner: "effortVocabMessages",
    reason: "网关对 thinking 形状报 not supported、只收 output_config.effort（怪癖 effortVocabMessages）",
    provenance: {
      level: "实测",
      source: "2026-09 实测：网关对 thinking 形状报 not supported 并提示改用 reasoning_effort（developer.amd.com.cn；原始记录见 thinking-profiles 的 PROVIDERS.amd 注，仓库无响应体留档）"
    }
  },
  ollama: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "手写兜底 unknownClass ollama-effort 的 off = reasoning_effort:none（docs.ollama.com；Messages 侧未实测）"
    }
  },
  siliconflow: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "手写兜底 unknownClass siliconflow-switch 的 off = enable_thinking:false（docs.siliconflow.cn；Messages 侧未实测）"
    }
  },
  modelscope: {
    kind: "native",
    provenance: {
      level: "实测",
      source: "2026-09 ModelScope Messages 端点实测：enable_thinking:false 被忽略、思考计入 max_tokens 挤空正文，只有 thinking:{type:disabled} 生效（原始记录见 compat-vocab 的 thinkingDisabledMustBeExplicit，仓库无响应体留档）"
    }
  },
  gemini: {
    kind: "non-messages",
    provenance: {
      level: "构造性不适用",
      source: "Gemini 采用原生 generateContent 协议，构造性不适用 Anthropic Messages off 出口表（ADR-0009）"
    }
  }
};

export const UNRESEARCHED_OFF_EXIT: MessagesOffExitCell = {
  kind: "unresearched",
  provenance: { level: "推断", source: "platformId 未识别（表外）→ 按 Anthropic 原生默认" }
};

export function messagesOffExitCell(platformId: string | undefined): MessagesOffExitCell {
  return ownExitCell(MESSAGES_OFF_EXIT, String(platformId || "").trim()) ?? UNRESEARCHED_OFF_EXIT;
}

export type MessagesOnExitKind = "native" | "silent" | "word" | "unresearched" | "non-messages";

export interface MessagesOnExitCell {
  kind: MessagesOnExitKind;
  owner?: CompatQuirk;
  reason?: string;
  fields?: Record<string, unknown>;
  provenance: MessagesExitProvenance;
}

export const MESSAGES_ON_EXIT: Record<PlatformKey, MessagesOnExitCell> = {
  deepseek: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "api-docs.deepseek.com/guides/anthropic_api（Anthropic 兼容页登记 thinking 开关；开档走原生 enabled，与建表前逐字节相同）"
    }
  },
  qwen: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "help.aliyun.com/zh/model-studio/anthropic-api-messages（登记 thinking.type，开档词无专项 → 原生 enabled，与建表前逐字节相同）"
    }
  },
  zhipu: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "docs.bigmodel.cn/cn/guide/capabilities/thinking + /cn/coding-plan/latest-model（Claude Code 走 thinking.type，开档原生 enabled）"
    }
  },
  sensenova: {
    kind: "native",
    provenance: {
      level: "文档",
      source: "platform.sensenova.cn/docs（thinking.type 与 output_config.effort 均登记；开档走原生 enabled，与建表前逐字节相同）"
    }
  },
  minimax: {
    kind: "word",
    fields: { thinking: { type: "adaptive" } },
    provenance: {
      level: "文档",
      source:
        "platform.minimax.io/docs/api-reference/text-anthropic-api（Thinking Control 表：{type:adaptive} = thinking on；{type:disabled} = M3 保持关、M3.1 报 400）"
    }
  },
  mimo: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "aliyun.com 百炼代售页只登记 OpenAI 通道的 enable_thinking；Messages 侧开词无文档 → 按原生 enabled（与建表前逐字节相同）"
    }
  },
  moonshot: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "kimi.com/code/docs/kimi-code/models.html：该端点未登记 thinking 形状、开关形状也未登记 → 开词出口今天无路径，按原生 enabled"
    }
  },
  openrouter: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message（thinking.enabled 必带预算 → 本仓不发；开关形状未登记、档位出口 effort-bare → 开词出口今天无路径，按原生登记）"
    }
  },
  opencodego: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "opencode.ai/docs/zen 未登记思考控制参数（2026-09 产品裁定只登记档位词）；开关形状未登记 → 开词出口今天无路径，按原生"
    }
  },
  stepfun: {
    kind: "silent",
    owner: "effortVocabMessages",
    reason: "该端点只认 output_config.effort，发 thinking 字段直接 400（怪癖 effortVocabMessages）",
    provenance: {
      level: "文档",
      source: "platform.stepfun.com 官方字段表未列 thinking（负证据）；该端点由怪癖 effortVocabMessages 只认 output_config.effort，开档静默不发 thinking"
    }
  },
  amd: {
    kind: "silent",
    owner: "effortVocabMessages",
    reason: "网关对 thinking 形状报 not supported、只收 output_config.effort（怪癖 effortVocabMessages）",
    provenance: {
      level: "实测",
      source: "2026-09 实测：网关对 thinking 形状报 not supported、只收 effort 词汇（developer.amd.com.cn；原始记录见 thinking-profiles 的 PROVIDERS.amd 注），开档静默不发 thinking"
    }
  },
  ollama: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "docs.ollama.com（OpenAI 兼容；Messages 通道无思考参数文档）→ 开词出口今天无路径，按原生"
    }
  },
  siliconflow: {
    kind: "native",
    provenance: {
      level: "推断",
      source: "docs.siliconflow.cn（Messages 侧未登记思考参数）→ 开词出口今天无路径，按原生"
    }
  },
  modelscope: {
    kind: "native",
    provenance: {
      level: "实测",
      source:
        "2026-11-22 实测（https://api-inference.modelscope.cn/v1/messages，模型 deepseek-ai/DeepSeek-V4.1-Flash-1017，请求头 x-api-key + anthropic-version: 2023-06-01，max_tokens: 1024，未传思考预算参数）：传 thinking:{type:\"enabled\"} 返回 thinking + text 块（HTTP 200，output_tokens: 20，不要求思考预算）；传 enable_thinking:true 返回 thinking 块（HTTP 200，output_tokens: 21）；省略思考字段默认开启并返回 thinking 块（HTTP 200，output_tokens: 23）→ 保持原生 enabled（kind: \"native\"）"
    }
  },
  gemini: {
    kind: "non-messages",
    provenance: {
      level: "构造性不适用",
      source: "Gemini 采用原生 generateContent 协议，构造性不适用 Anthropic Messages on 出口表（ADR-0009）"
    }
  }
};

export const UNRESEARCHED_ON_EXIT: MessagesOnExitCell = {
  kind: "unresearched",
  provenance: { level: "推断", source: "platformId 未识别（表外）→ 按 Anthropic 原生默认（thinking:{type:enabled}）" }
};

export function messagesOnExitCell(platformId: string | undefined): MessagesOnExitCell {
  return ownExitCell(MESSAGES_ON_EXIT, String(platformId || "").trim()) ?? UNRESEARCHED_ON_EXIT;
}

function onThinkingFields(platformId: string | undefined): Record<string, unknown> {
  const cell = messagesOnExitCell(platformId);
  if (cell.kind === "non-messages" || cell.kind === "silent") return {};
  if (cell.kind === "word" && cell.fields) return { ...cell.fields };
  return { thinking: { type: "enabled" } };
}

type VocabularyWireForm =
  | { form: "off" }
  | { form: "effort"; word: string }
  | { form: "on" }
  | { form: "none" };

function vocabularyWireForm(vocabulary: ThinkingVocabulary): VocabularyWireForm {
  switch (vocabulary.kind) {
    case "reasoningEffort":
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

function anthropicWireMap(input: AnthropicWireInput): ThinkingWireOutput {
  const output: ThinkingWireOutput = { fields: {}, tokenParam: "max_tokens" };
  if (input.probe) return output;
  if (messagesTierExitCell(input.platformId).kind === "non-messages") return output;
  const form = vocabularyWireForm(input.vocabulary);
  if (form.form === "none") return output;

  if (form.form === "off") {
    const cell = messagesOffExitCell(input.platformId);
    if (cell.kind === "non-messages" || cell.kind === "silent") return output;
    if (cell.kind === "word" && cell.fields) {
      Object.assign(output.fields, cell.fields);
      return output;
    }
    output.fields.thinking = { type: "disabled" };
    return output;
  }

  if (form.form === "effort") {
    const cell = messagesTierExitCell(input.platformId);
    if (cell.kind === "non-messages") return output;
    if (cell.kind === "reasoning-effort") {
      output.fields.reasoning_effort = form.word;
      return output;
    }
    output.fields.output_config = { effort: form.word };
    if (cell.kind === "effort") Object.assign(output.fields, onThinkingFields(input.platformId));
    return output;
  }

  Object.assign(output.fields, onThinkingFields(input.platformId));
  return output;
}

function googleThinkingLevelOf(level: string): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | null {
  switch (level) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    case "xhigh":
    case "max":
      return "HIGH";
    default:
      return null;
  }
}

function geminiWireMap(input: GeminiWireInput): ThinkingWireOutput {
  const thinkingLevel =
    input.vocabulary.kind === "reasoningEffort" ? googleThinkingLevelOf(input.vocabulary.level) : null;
  if (!thinkingLevel) {
    return {
      fields: {},
      tokenParam: "maxOutputTokens"
    };
  }
  return {
    fields: {
      thinkingConfig: {
        thinkingLevel,
        includeThoughts: input.requestedLevel !== "off"
      }
    },
    tokenParam: "maxOutputTokens"
  };
}

export const THINKING_WIRE_MAPS: { [K in AiProtocol]: ThinkingWireMap<K> } = {
  openai: openaiWireMap,
  anthropic: anthropicWireMap,
  gemini: geminiWireMap
};

