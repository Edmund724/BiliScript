import { THINKING_WIRE_MAPS, type AnthropicWireInput, type OpenAiWireInput } from "../../extension/ai/thinking-wire-map.js";
import { enableThinking, reasoningEffort } from "../../extension/ai/thinking-profiles.js";

export function assertThinkingWireInputSplit(): void {
  // @ts-expect-error stream 是死字段（写法层全文无人读；档位规则的 streamOnly 在 resolver 侧消费）
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), stream: false });
  // @ts-expect-error 同上（Messages 行：探针早退与流式无关）
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low"), probe: false, stream: true });

  // @ts-expect-error effortVocabularyOnly 已从入参移除：Messages 行按单一 platformId 查出口表分派
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), effortVocabularyOnly: false });
  // @ts-expect-error effortVocabularyOnly 已从入参移除：Messages 行按单一 platformId 查出口表分派
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low"), probe: false, effortVocabularyOnly: false });
  // @ts-expect-error probe 不是 openai 行的入参：本链探针不发思考字段靠请求侧归一（缺省 → default），不靠这一行早退
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), probe: true });
  // @ts-expect-error 三张出口表按平台识别，openai 行不查表
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), platformId: "deepseek" });

  // @ts-expect-error token 参数名事实（max_completion_tokens）是 OpenAI 通道的（Messages 行恒 max_tokens）
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low"), probe: false, tokenParam: "max_completion_tokens" });
  // @ts-expect-error probe 必填：探针早退是 Messages 行的行为分支
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low") });
  // @ts-expect-error vocabulary 是公共必填入参（分型的公共部分）
  THINKING_WIRE_MAPS.anthropic({ probe: false });

  const legalOpenAi: OpenAiWireInput = { vocabulary: enableThinking(true), tokenParam: "max_completion_tokens" };
  const legalAnthropic: AnthropicWireInput = {
    vocabulary: enableThinking(true),
    probe: false,
    platformId: "deepseek"
  };
  THINKING_WIRE_MAPS.openai(legalOpenAi);
  THINKING_WIRE_MAPS.anthropic(legalAnthropic);
}
