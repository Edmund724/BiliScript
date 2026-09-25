// ai/compat-vocab.ts 词表单测（compat-vocab 票）：
// 词表是平台怪癖命名与语义的单源（借 pi-ai compat 的词表设计，见 ADR-0009
// 「借」清单；不借其数据，产物不带 compat）。三件事在此钉死：
// 1. 词表叶：零运行时 import，只 type-import 词表叶 AiProtocol；
// 2. 二次校验层（票第 4 条）：词表声明的适用协议 ⟺ 该协议 adapter 接纳的
//    怪癖键集，两侧对账；违规表副本注入后校验器必须报错；
// 3. 平台声明表：每个平台声明的怪癖键必须在词表里，且被至少一个 adapter 接纳
//    ——「一处声明」不会声明出没人消费的死键。
// 行为零变化由既有 adapter/preset-headers 测试钉住，本文件只加两条派生用例：
// anthropic 的 effort 词汇平台与 preset-headers 的会话头均改从词表派生。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AI_PROTOCOLS, type AiProtocol } from "../../extension/ai/protocol-vocab.js";
import {
  COMPAT_QUIRKS,
  hasPlatformQuirk,
  quirkWireValue,
  validateCompatVocab,
  type CompatQuirk
} from "../../extension/ai/compat-vocab.js";
import { PROTOCOL_ADAPTERS } from "../../extension/ai/protocol-adapter.js";
import { PRESETS } from "../../extension/core/presets.js";
import { presetRequestHeaders, sessionIdFor } from "../../extension/ai/preset-headers.js";

// adapter 侧的自陈「我接纳这些怪癖」，与词表声明的适用协议对账用。
function adapterConsumes(): Record<AiProtocol, readonly CompatQuirk[]> {
  return {
    openai: PROTOCOL_ADAPTERS.openai.consumes,
    anthropic: PROTOCOL_ADAPTERS.anthropic.consumes
  };
}

// 协议缺省就是 openai（resolveAdapter 兜底），它的端点恒为 preset.baseUrl；
// 其余协议须由 protocolBaseUrls 登记了端点，才算该平台真能服务这条通道。
const DEFAULT_PROTOCOL: AiProtocol = "openai";

// 每个平台实际登记了端点的协议（由 core/presets.ts 推导，词表叶保持零 import）。
function presetProtocols(): Record<string, AiProtocol[]> {
  const out: Record<string, AiProtocol[]> = {};
  for (const preset of PRESETS) {
    const served: AiProtocol[] = [];
    for (const protocol of AI_PROTOCOLS) {
      const endpoint = protocol === DEFAULT_PROTOCOL ? preset.baseUrl : preset.protocolBaseUrls?.[protocol];
      if (endpoint) served.push(protocol);
    }
    out[preset.id] = served;
  }
  return out;
}

describe("compat-vocab 词表叶", () => {
  it("纯叶：模块无值 import（零运行时依赖，不拖入 adapters/分发表）", () => {
    const source = readFileSync("extension/ai/compat-vocab.ts", "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)/m);
  });

  it("键集合稳定：键名与顺序是契约（改语义可，改键名须同步迁移消费点）", () => {
    expect(Object.keys(COMPAT_QUIRKS)).toEqual([
      "maxTokensField",
      "thinkingFormat",
      "streamingOnlyThinkingOff",
      "overrideEffortVocabulary",
      "effortVocabMessages",
      "thinkingDisabledMustBeExplicit",
      "probeOmitsThinking",
      "maxTokensRequired",
      "thinkingBudgetTokens",
      "sessionHeader",
      "systemOutOfBand",
      "toolResultInUserMessage",
      "stopReasonVocabulary",
      "noDoneSentinel",
      "thinkingSignatureNotReplayed",
      "parallelToolUseFlattened",
      "serverToolsNotTranslated",
      "contentPartsAsArray",
      "toolCallFragmentsByIndex",
      "authHeaderScheme",
      "bearerOptionalWithoutKey"
    ]);
  });

  it("每条怪癖都有非空语义与合法适用协议（protocols 只能是词表叶的 AiProtocol）", () => {
    for (const [key, spec] of Object.entries(COMPAT_QUIRKS)) {
      expect(spec.summary.trim().length, key).toBeGreaterThan(0);
      expect(spec.protocols.length, key).toBeGreaterThan(0);
      for (const protocol of spec.protocols) {
        expect(AI_PROTOCOLS, `${key} → ${protocol}`).toContain(protocol);
      }
    }
  });
});

describe("二次校验层（声明与接纳对账）", () => {
  it("真实表零违规：词表声明的适用协议 ⟺ adapter 接纳的怪癖键集", () => {
    expect(validateCompatVocab({ consumes: adapterConsumes() })).toEqual([]);
  });

  it("真实表零违规（含端点对账）：平台 id 是真预设，且绑定的协议该平台有端点", () => {
    expect(validateCompatVocab({ consumes: adapterConsumes(), platformProtocols: presetProtocols() })).toEqual([]);
  });

  it("adapter 漏接纳（少认一个键）→ 报错，指出缺哪个协议", () => {
    const real = adapterConsumes();
    const errors = validateCompatVocab({
      consumes: { ...real, openai: real.openai.filter((key) => key !== "maxTokensField") }
    });
    expect(errors).toContain("maxTokensField: 词表声明适用协议 openai，但 openai adapter 未接纳");
  });

  it("adapter 多接纳（多认一个键）→ 报错，指出多认了谁", () => {
    const real = adapterConsumes();
    const errors = validateCompatVocab({
      consumes: { ...real, openai: [...real.openai, "systemOutOfBand"] }
    });
    expect(errors).toContain("systemOutOfBand: openai adapter 接纳，但词表未声明适用该协议");
  });

  it("平台声明的怪癖键必须存在，且必须被至少一个 adapter 接纳（不声明死键）", () => {
    // 拼错的键 → 不在词表中
    expect(
      validateCompatVocab({
        consumes: adapterConsumes(),
        platforms: { broken: ["unknownQuirk" as CompatQuirk] }
      })
    ).toContain('PLATFORM_QUIRKS.broken: 怪癖键 "unknownQuirk" 不在词表 COMPAT_QUIRKS 中');

    // 词表里有、但没有 adapter 接纳的键 → 死声明
    expect(
      validateCompatVocab({
        consumes: { openai: [], anthropic: [] },
        platforms: { broken: ["maxTokensField"] }
      })
    ).toContain('PLATFORM_QUIRKS.broken: 怪癖键 "maxTokensField" 没有任何协议 adapter 接纳（死声明）');
  });

  it("平台 id 必须是真实 AI 预设（防手滑打错）", () => {
    expect(
      validateCompatVocab({
        consumes: adapterConsumes(),
        platformProtocols: presetProtocols(),
        platforms: { opencodgo: ["sessionHeader"] }
      })
    ).toContain("PLATFORM_QUIRKS.opencodgo: 平台 id 不在 core/presets.ts 的 AI 预设词表里");
  });

  it("怪癖绑定的协议该平台没登记端点 → 构造性死声明（anthropic-only 怪癖给了 ollama）", () => {
    // ollama 只登记了 openai 端点（http://localhost:11434/v1），没有
    // protocolBaseUrls.anthropic：UI 里选 anthropic 会回落 baseUrl 拼出
    // /v1/v1/messages，那条声明永远走不到——但"某 adapter 接纳"这道查不出来。
    expect(presetProtocols().ollama).toEqual(["openai"]);
    expect(
      validateCompatVocab({
        consumes: adapterConsumes(),
        platformProtocols: presetProtocols(),
        platforms: { ollama: ["thinkingDisabledMustBeExplicit"] }
      })
    ).toContain(
      'PLATFORM_QUIRKS.ollama: 怪癖键 "thinkingDisabledMustBeExplicit" 只适用于 anthropic，但该平台未登记这些协议的端点（构造性死声明）'
    );
  });

  it("跨协议声明不算违规：判据是端点存不存在，不是记录当前选了哪个协议", () => {
    // stepfun 两种端点都登记了：effortVocabMessages 绑 anthropic、
    // overrideEffortVocabulary 绑 openai，两条在同一张表里共存——设置 UI 的协议
    // 下拉对任何预设都无条件渲染两种协议，怪癖按通道各自生效。stepfun 的 openai
    // 通道正是它的主通道，绑在 anthropic 上的那条只是不生效，不是违规。
    expect([...presetProtocols().stepfun].sort()).toEqual(["anthropic", "openai"]);
    expect(
      validateCompatVocab({
        consumes: adapterConsumes(),
        platformProtocols: presetProtocols(),
        platforms: { stepfun: ["effortVocabMessages", "overrideEffortVocabulary"] }
      })
    ).toEqual([]);
  });
});

describe("平台声明派生（词表是唯一主人，adapter/preset-headers 不再自建名单）", () => {
  it("hasPlatformQuirk：effort 词汇平台 = stepfun / amd（anthropic Messages 通道）", () => {
    expect(hasPlatformQuirk("stepfun", "effortVocabMessages")).toBe(true);
    expect(hasPlatformQuirk("amd", "effortVocabMessages")).toBe(true);
    // 未知/缺省平台不开任何怪癖（软失败优于硬 400）
    expect(hasPlatformQuirk("openrouter", "effortVocabMessages")).toBe(false);
    expect(hasPlatformQuirk("", "effortVocabMessages")).toBe(false);
    expect(hasPlatformQuirk(undefined, "effortVocabMessages")).toBe(false);
  });

  it("quirkWireValue：会话头名取自词表（Opencode Go 的 x-opencode-session）", () => {
    expect(quirkWireValue("opencodego", "sessionHeader")).toBe("x-opencode-session");
    expect(quirkWireValue("deepseek", "sessionHeader")).toBeUndefined();
  });

  it("preset-headers 改从词表派生后行为不变（Opencode Go 补头，其余平台不补）", () => {
    const headers = presetRequestHeaders({ presetId: "opencodego", sessionId: "conv_a1" });
    expect(headers["x-opencode-session"]).toBe(sessionIdFor("conv_a1"));
    expect(presetRequestHeaders({ presetId: "deepseek", sessionId: "conv_a1" })).toEqual({});
  });
});
