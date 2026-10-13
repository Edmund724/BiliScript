// ai/plan-thinking.ts — 思考装配边（CONTEXT.md「平台协议」域）。
//
// 「取档位事实 → 按本协议算行入参 → 取线格式映射表 → 并入请求体」的第一段落点：
// 唯一入口 `planThinkingWire(原始请求事实)` 收**协议无关**的请求事实，出参与线格式映射表
// 同形（`ThinkingWireOutput`：本协议的思考字段 + 本协议的输出上限参数名）。适配器只剩
// 「取本边产出 → 并入本协议请求体」——装配知识（哪些平台事实喂给本协议行）不再散在
// 每个 adapter 里，第三个协议不会把它抄第三遍。
//
// 本边只有两件事：
//   ① 调一次档位事实解析（`resolveThinkingProfile`，归一施加点仍在那一层，本边不预归一）；
//   ② 按 `Record<AiProtocol, …>` 分发给逐协议装配行——新增协议漏登记是编译期红
//      （与 `PROTOCOL_ADAPTERS` / `THINKING_WIRE_MAPS` 同纪律）。
// 逐协议装配行只做「把本行真正读得到的平台事实算出来，交给线格式映射表对应行」：
//   - openai 行只传中转词汇与 token 上限参数名事实；
//   - anthropic 行传中转词汇、probe，以及两个**各按自己键空间**识别的平台事实
//     （思考平台识别 `resolveThinkingProviderId`：PROVIDERS 键空间；怪癖词表识别
//     `resolvePlatformQuirkId`：PLATFORM_QUIRKS 键空间，`PROVIDERS ⊋ PLATFORM_QUIRKS`，
//     故两个识别器不合并、也不引入第三份识别规则）。
//
// **写法不下沉**：逐协议行的 switch（off 三词汇归一 / 探针早退 / 档位出口 / 开词出口）
// 仍只在线格式映射表（ai/thinking-wire-map.ts）内——本文件不出现任何线格式字面量，
// 映射表也不因此被注入运行时依赖（它仍是零运行时 import 的纯叶，本边是另一个模块）。
//
// **输出上限参数名的唯一主人**是映射表的出参 `tokenParam`：openai 链用它写输出上限字段，
// anthropic 链用它写自己必填的上限字段（不再另写 `max_tokens` 字面量）。
//
// 本模块属协议栈（运行时依赖档位事实与怪癖词表），登记在 scripts/build.js 的
// SW 静态图禁止清单里，与 adapters / thinking-profiles / thinking-wire-map 同列。

import { hasPlatformQuirk } from "./compat-vocab.js";
import { resolvePlatformQuirkId } from "./platform-quirk-id.js";
import { resolveThinkingProfile, resolveThinkingProviderId, type ThinkingResolution } from "./thinking-profiles.js";
import { THINKING_WIRE_MAPS, type ThinkingWireOutput } from "./thinking-wire-map.js";
import type { AiProtocol } from "./protocol-vocab.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";

/** 装配边的入参：协议无关的请求事实（协议是分发键，档位是未归一的外部值）。 */
export interface ThinkingRequestFacts {
  protocol: AiProtocol;
  model: string;
  presetId?: string;
  baseUrl?: string;
  /** 未归一的档位外部值——本边原样交给解析层，归一施加点在那里。 */
  level?: ThinkingLevelInput;
  stream: boolean;
  probe: boolean;
}

/** 逐协议装配行的入参：请求事实 + 本边唯一那一次档位事实解析的结果。 */
interface ThinkingPlanInput {
  facts: ThinkingRequestFacts;
  thinking: ThinkingResolution;
}

// openai 行：本行只读得到的平台事实就是中转词汇与 token 上限参数名（怪癖 maxTokensField）。
// probe 与两条平台识别都不传——它们对 openai 行无意义：本链「探针不发思考字段」靠的是
// 请求侧归一（探针不传档位 → `default` 不干预 → 空 patch），probeOmitsThinking 是
// Messages 侧事实（那一行另有早退）。
function planOpenAiRow({ thinking }: ThinkingPlanInput): ThinkingWireOutput {
  return THINKING_WIRE_MAPS.openai({ vocabulary: thinking.vocabulary, tokenParam: thinking.tokenParam });
}

// 本行真读的平台事实之一：该平台在 Messages 通道是否只认 effort 词汇（怪癖
// effortVocabMessages，stepfun / amd）。查表口径是怪癖词表的唯一识别器
// `resolvePlatformQuirkId`——键空间是 PLATFORM_QUIRKS，与 thinking 的平台识别不同，
// 故两者分别调用、不合并（口径差异见 ai/platform-quirk-id.ts 头注）。
function usesEffortVocabulary(presetId?: string, baseUrl?: string): boolean {
  return hasPlatformQuirk(resolvePlatformQuirkId(presetId, baseUrl), "effortVocabMessages");
}

// anthropic（Messages）行：中转词汇 + probe + 两个平台事实（思考平台识别 + 怪癖词表识别）。
// 本边只算事实、不问写法——「这套词汇在本通道长什么样」逐格在线格式映射表的 anthropic 行里。
function planAnthropicRow({ facts, thinking }: ThinkingPlanInput): ThinkingWireOutput {
  return THINKING_WIRE_MAPS.anthropic({
    vocabulary: thinking.vocabulary,
    probe: facts.probe,
    platformId: resolveThinkingProviderId(facts.presetId, facts.baseUrl),
    effortVocabularyOnly: usesEffortVocabulary(facts.presetId, facts.baseUrl)
  });
}

// 分发以协议为键：`Record<AiProtocol, …>` 编译期强制覆盖（新增协议漏登记即红）。
const PLANNING_ROWS: Record<AiProtocol, (input: ThinkingPlanInput) => ThinkingWireOutput> = {
  openai: planOpenAiRow,
  anthropic: planAnthropicRow
};

/**
 * 装配边唯一入口：原始请求事实 → 本协议的思考字段 + 本协议的输出上限参数名。
 * 档位偏好的归一仍在 `resolveThinkingProfile`（请求侧归一的施加点）；本边不判、不归、不拒。
 */
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
