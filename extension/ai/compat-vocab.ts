import type { AiProtocol } from "./protocol-vocab.js";

export interface CompatQuirkSpec {
  summary: string;
  protocols: readonly AiProtocol[];
  wire?: string;
}

export const COMPAT_QUIRKS = {
  maxTokensField: {
    summary: "token 上限参数名随平台/模型血统变（max_tokens ↔ max_completion_tokens），随表事实来自 thinking-profiles 的 tokenParam；该字段是手写表独有写点，上游产物刻意不产（2026-10-05 用户裁定，登记项 ②）。",
    protocols: ["openai"],
    wire: "max_completion_tokens"
  },
  thinkingFormat: {
    summary: "思考控制字段的词汇随平台变：reasoning_effort（档位）、thinking:{type}（开关）、enable_thinking（开关）三套并存。",
    protocols: ["openai", "anthropic"]
  },
  streamingOnlyThinkingOff: {
    summary: "关思考声明仅流式可用；非流式请求遇此规则按无事实处理（走 off 级联或缺档不发）。",
    protocols: ["openai"]
  },
  effortVocabMessages: {
    summary: "Anthropic Messages 通道只认新式 output_config.effort：发 thinking 字段直接 400（stepfun 官方字段表未列 thinking；amd 对 thinking 形状报「not supported」）。",
    protocols: ["anthropic"]
  },
  thinkingDisabledMustBeExplicit: {
    summary: "平台默认开思考且忽略 enable_thinking:false，只有显式的 thinking:{type:\"disabled\"} 能真正关掉；依赖服务端默认会把正文挤成空串。",
    protocols: ["anthropic"]
  },
  probeOmitsThinking: {
    summary: "探针请求不发思考字段——探针是连通性测试，部分平台的 thinking 形状要求配套参数（如 enabled 必带预算），发字段只会把探针打成 400。",
    protocols: ["anthropic"]
  },
  maxTokensRequired: {
    summary: "max_tokens 是必填参数且平台不给默认值，调用方未传时由 adapter 兜底（OpenAI 系此时干脆不发字段、由平台自行决定）。",
    protocols: ["anthropic"],
    wire: "max_tokens"
  },
  sessionHeader: {
    summary: "平台要求每个对话带一个稳定的会话 id 请求头（供平台路由与 prompt 缓存），不带则请求不被接受。",
    protocols: ["openai"],
    wire: "x-opencode-session"
  },

  systemOutOfBand: {
    summary: "messages 数组不接受 system 角色：system 消息须剥出为顶层参数，多条按出现顺序以空行拼接。",
    protocols: ["anthropic"]
  },
  toolResultInUserMessage: {
    summary: "没有 tool 角色：工具结果须合并进 user 消息的 tool_result 块（连续多条合并进同一条），且须紧跟对应的 assistant(tool_use)。",
    protocols: ["anthropic"]
  },
  stopReasonVocabulary: {
    summary: "结束原因词表与 OpenAI 不同（end_turn/tool_use/max_tokens…），须映射回编排层精确匹配的 OpenAI 词表。",
    protocols: ["anthropic"]
  },

  noDoneSentinel: {
    summary: "流尾没有 [DONE] 哨兵，读完即收束；收束信号由调用方单发，不在流内吐。",
    protocols: ["anthropic"]
  },
  thinkingSignatureNotReplayed: {
    summary: "思考块带 signature 且必须原样回传历史，而本场景不把它存进 ChatMessage——多轮回传思考会 400，故有意的缺口。",
    protocols: ["anthropic"]
  },
  parallelToolUseFlattened: {
    summary: "并行 tool_use 被按协议压平（tool_choice 带 disable_parallel_tool_use），未来要并行时聚合层按 index 已天然支持。",
    protocols: ["anthropic"]
  },
  serverToolsNotTranslated: {
    summary: "Anthropic 原生服务端工具（名字带日期版本后缀，如 web_search_20250305）不走 tool 循环，adapter 只翻译客户端 function 工具。",
    protocols: ["anthropic"]
  },

  contentPartsAsArray: {
    summary: "带图消息的 content 须翻成块数组（text + 每图一个块），无图消息保持字符串；空 text 块部分兼容端点会 400。",
    protocols: ["openai", "anthropic"]
  },
  toolCallFragmentsByIndex: {
    summary: "流内工具调用逐 chunk 分片（id/name/arguments 跨 chunk 拼接），须按 index 聚合成完整调用。",
    protocols: ["openai"]
  },

  authHeaderScheme: {
    summary: "鉴权头不是 Bearer：x-api-key + 必带的 anthropic-version 版本头。",
    protocols: ["anthropic"],
    wire: "x-api-key"
  },
  bearerOptionalWithoutKey: {
    summary: "apiKey 缺失时不注入 Authorization 头（平台允许空 key 的本地/免鉴权部署）。",
    protocols: ["openai"],
    wire: "Authorization"
  }
} as const satisfies Record<string, CompatQuirkSpec>;

export type CompatQuirk = keyof typeof COMPAT_QUIRKS;

export const PLATFORM_QUIRKS: Readonly<Record<string, readonly CompatQuirk[]>> = {
  opencodego: ["sessionHeader"],
  stepfun: ["effortVocabMessages"],
  amd: ["effortVocabMessages"],
  modelscope: ["thinkingDisabledMustBeExplicit"]
};

export function hasPlatformQuirk(platformId: string | undefined, quirk: CompatQuirk): boolean {
  return (PLATFORM_QUIRKS[String(platformId || "").trim()] ?? []).includes(quirk);
}

export function quirkWireValue(platformId: string | undefined, quirk: CompatQuirk): string | undefined {
  if (!hasPlatformQuirk(platformId, quirk)) return undefined;
  const spec: CompatQuirkSpec = COMPAT_QUIRKS[quirk];
  return spec.wire;
}

export interface CompatVocabTables {
  quirks?: Record<string, CompatQuirkSpec>;
  platforms?: Readonly<Record<string, readonly CompatQuirk[]>>;
  consumes: Readonly<Record<AiProtocol, readonly CompatQuirk[]>>;
  platformProtocols?: Readonly<Record<string, readonly AiProtocol[]>>;
}

export function validateCompatVocab({ quirks = COMPAT_QUIRKS, platforms = PLATFORM_QUIRKS, consumes, platformProtocols }: CompatVocabTables): string[] {
  const errors: string[] = [];

  for (const [quirk, spec] of Object.entries(quirks)) {
    for (const protocol of spec.protocols) {
      if (!consumes[protocol]?.includes(quirk as CompatQuirk)) {
        errors.push(`${quirk}: 词表声明适用协议 ${protocol}，但 ${protocol} adapter 未接纳`);
      }
    }
    for (const protocol of Object.keys(consumes) as AiProtocol[]) {
      if (consumes[protocol].includes(quirk as CompatQuirk) && !spec.protocols.includes(protocol)) {
        errors.push(`${quirk}: ${protocol} adapter 接纳，但词表未声明适用该协议`);
      }
    }
  }

  const protocols = Object.keys(consumes) as AiProtocol[];
  for (const [platform, declared] of Object.entries(platforms)) {
    const served = platformProtocols?.[platform];
    if (platformProtocols && !served) {
      errors.push(`PLATFORM_QUIRKS.${platform}: 平台 id 不在 core/presets.ts 的 AI 预设词表里`);
    }
    for (const quirk of declared) {
      if (!quirks[quirk]) {
        errors.push(`PLATFORM_QUIRKS.${platform}: 怪癖键 "${quirk}" 不在词表 COMPAT_QUIRKS 中`);
        continue;
      }
      if (!protocols.some((protocol) => consumes[protocol].includes(quirk))) {
        errors.push(`PLATFORM_QUIRKS.${platform}: 怪癖键 "${quirk}" 没有任何协议 adapter 接纳（死声明）`);
      }
      if (served && !quirks[quirk].protocols.some((protocol) => served.includes(protocol))) {
        errors.push(
          `PLATFORM_QUIRKS.${platform}: 怪癖键 "${quirk}" 只适用于 ${quirks[quirk].protocols.join(" / ")}，` +
            `但该平台未登记这些协议的端点（构造性死声明）`
        );
      }
    }
  }

  return errors;
}
