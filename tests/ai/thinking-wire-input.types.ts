// tests/ai/thinking-wire-input.types.ts — 写法层**入参分型**的编译期断言
//（票 thinking-seam-tightening/issues/01 第 1、2 项）。
//
// 本文件不是 vitest 用例（文件名不匹配 vitest 的 test/spec glob），由 `pnpm typecheck`
//（tsc --noEmit，include tests/**/*.ts）执行：
// - 每条 `@ts-expect-error` 断言的直写都必须编译失败；若哪天某协议行重新收下它不读的字段、
//   或必填事实变成可选，tsc 会报 "Unused '@ts-expect-error' directive"，断言随即失败；
// - 末尾的正向对照证明合法入参照常通过（防止断言写成「谁都传不进」）。
//
// 为什么用类型而不是运行期用例：入参分型的收益正是「漏传 / 多传由编译器抓」——运行期看不出来，
// 多余字段会被行静默忽略、缺的必填事实会静默走 falsy 支（旧实现在 off 分支就吃过这个亏）。

import { THINKING_WIRE_MAPS, type AnthropicWireInput, type OpenAiWireInput } from "../../extension/ai/thinking-wire-map.js";
import { enableThinking, reasoningEffort } from "../../extension/ai/thinking-profiles.js";

export function assertThinkingWireInputSplit(): void {
  // ===== 第 1 项：stream 从表入参删除，任何一行都不收 =====
  // @ts-expect-error stream 是死字段（写法层全文无人读；档位规则的 streamOnly 在 resolver 侧消费）
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), stream: false });
  // @ts-expect-error 同上（Messages 行：探针早退与流式无关）
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low"), probe: false, effortVocabularyOnly: false, stream: true });

  // ===== 第 2 项：openai 行只收 vocabulary + tokenParam（平台事实与探针都不传） =====
  // @ts-expect-error effortVocabularyOnly 是 Messages 通道的平台事实（怪癖 effortVocabMessages）
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), effortVocabularyOnly: false });
  // @ts-expect-error probeOmitsThinking 是 Messages 侧事实（OpenAI 通道探针照发思考字段）
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), probe: true });
  // @ts-expect-error 三张出口表按平台识别，openai 行不查表
  THINKING_WIRE_MAPS.openai({ vocabulary: reasoningEffort("low"), platformId: "deepseek" });

  // ===== 第 2 项：anthropic 行不收 tokenParam，必填事实漏传即红 =====
  // @ts-expect-error token 参数名事实（max_completion_tokens）是 OpenAI 通道的（Messages 行恒 max_tokens）
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low"), probe: false, effortVocabularyOnly: false, tokenParam: "max_completion_tokens" });
  // @ts-expect-error probe 必填：探针早退是 Messages 行的行为分支
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low"), effortVocabularyOnly: false });
  // @ts-expect-error effortVocabularyOnly 必填：怪癖活值由调用方一次算好
  THINKING_WIRE_MAPS.anthropic({ vocabulary: reasoningEffort("low"), probe: false });
  // @ts-expect-error vocabulary 是公共必填入参（分型的公共部分）
  THINKING_WIRE_MAPS.anthropic({ probe: false, effortVocabularyOnly: false });

  // ===== 正向对照：合法入参照常通过（断言不是「谁都传不进」） =====
  const legalOpenAi: OpenAiWireInput = { vocabulary: enableThinking(true), tokenParam: "max_completion_tokens" };
  const legalAnthropic: AnthropicWireInput = {
    vocabulary: enableThinking(true),
    probe: false,
    platformId: "deepseek",
    effortVocabularyOnly: false
  };
  THINKING_WIRE_MAPS.openai(legalOpenAi);
  THINKING_WIRE_MAPS.anthropic(legalAnthropic);
}
