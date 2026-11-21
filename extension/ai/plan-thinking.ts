import { hasPlatformQuirk } from "./compat-vocab.js";
import { resolvePlatformQuirkId } from "./platform-quirk-id.js";
import { resolveThinkingProfile, resolveThinkingProviderId, type ThinkingResolution } from "./thinking-profiles.js";
import { THINKING_WIRE_MAPS, type ThinkingWireOutput } from "./thinking-wire-map.js";
import type { AiProtocol } from "./protocol-vocab.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";

export interface ThinkingRequestFacts {
  protocol: AiProtocol;
  model: string;
  presetId?: string;
  baseUrl?: string;
  level?: ThinkingLevelInput;
  stream: boolean;
  probe: boolean;
}

interface ThinkingPlanInput {
  facts: ThinkingRequestFacts;
  thinking: ThinkingResolution;
}

function planOpenAiRow({ thinking }: ThinkingPlanInput): ThinkingWireOutput {
  return THINKING_WIRE_MAPS.openai({ vocabulary: thinking.vocabulary, tokenParam: thinking.tokenParam });
}

function usesEffortVocabulary(presetId?: string, baseUrl?: string): boolean {
  return hasPlatformQuirk(resolvePlatformQuirkId(presetId, baseUrl), "effortVocabMessages");
}

function planAnthropicRow({ facts, thinking }: ThinkingPlanInput): ThinkingWireOutput {
  return THINKING_WIRE_MAPS.anthropic({
    vocabulary: thinking.vocabulary,
    probe: facts.probe,
    platformId: resolveThinkingProviderId(facts.presetId, facts.baseUrl),
    effortVocabularyOnly: usesEffortVocabulary(facts.presetId, facts.baseUrl)
  });
}

function planGeminiRow({ thinking }: ThinkingPlanInput): ThinkingWireOutput {
  return THINKING_WIRE_MAPS.gemini({
    vocabulary: thinking.vocabulary,
    requestedLevel: thinking.requestedLevel
  });
}

const PLANNING_ROWS: Record<AiProtocol, (input: ThinkingPlanInput) => ThinkingWireOutput> = {
  openai: planOpenAiRow,
  anthropic: planAnthropicRow,
  gemini: planGeminiRow
};

export function planThinkingWire(facts: ThinkingRequestFacts): ThinkingWireOutput {
  const thinking = resolveThinkingProfile({
    presetId: facts.presetId,
    baseUrl: facts.baseUrl,
    model: facts.model,
    level: facts.level,
    stream: facts.stream
  });
  return PLANNING_ROWS[facts.protocol]({ facts, thinking });
}
