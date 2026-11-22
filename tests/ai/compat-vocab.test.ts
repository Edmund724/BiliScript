import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AI_PROTOCOLS, type AiProtocol } from "../../extension/ai/protocol-vocab.js";
import {
  COMPAT_QUIRKS,
  PLATFORM_QUIRKS,
  hasPlatformQuirk,
  quirkWireValue,
  validateCompatVocab,
  type CompatQuirk
} from "../../extension/ai/compat-vocab.js";
import { resolvePlatformQuirkId } from "../../extension/ai/platform-quirk-id.js";
import { PROTOCOL_ADAPTERS } from "../../extension/ai/protocol-adapter.js";
import { PRESETS } from "../../extension/core/presets.js";
import { presetRequestHeaders, sessionIdFor } from "../../extension/ai/preset-headers.js";

function adapterConsumes(): Record<AiProtocol, readonly CompatQuirk[]> {
  return {
    openai: PROTOCOL_ADAPTERS.openai.consumes,
    anthropic: PROTOCOL_ADAPTERS.anthropic.consumes,
    gemini: PROTOCOL_ADAPTERS.gemini.consumes
  };
}

const DEFAULT_PROTOCOL: AiProtocol = "openai";

function presetProtocols(): Record<string, AiProtocol[]> {
  const out: Record<string, AiProtocol[]> = {};
  for (const preset of PRESETS) {
    const served: AiProtocol[] = [];
    for (const protocol of AI_PROTOCOLS) {
      const defaultProto = preset.protocol ?? DEFAULT_PROTOCOL;
      const endpoint = protocol === defaultProto ? preset.baseUrl : preset.protocolBaseUrls?.[protocol];
      if (endpoint) served.push(protocol);
    }
    out[preset.id] = served;
  }
  return out;
}


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
    expect(
      validateCompatVocab({
        consumes: adapterConsumes(),
        platforms: { broken: ["unknownQuirk" as CompatQuirk] }
      })
    ).toContain('PLATFORM_QUIRKS.broken: 怪癖键 "unknownQuirk" 不在词表 COMPAT_QUIRKS 中');

    expect(
      validateCompatVocab({
        consumes: { openai: [], anthropic: [], gemini: [] },
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

  it("怪癖绑定的协议该平台没登记端点 → 构造性死声明（合成：只登记 openai 端点的平台）", () => {
    expect(
      validateCompatVocab({
        consumes: adapterConsumes(),
        platformProtocols: { ...presetProtocols(), ollama: ["openai"] },
        platforms: { ollama: ["thinkingDisabledMustBeExplicit"] }
      })
    ).toContain(
      'PLATFORM_QUIRKS.ollama: 怪癖键 "thinkingDisabledMustBeExplicit" 只适用于 anthropic，但该平台未登记这些协议的端点（构造性死声明）'
    );
  });

  it("跨协议声明不算违规：判据是端点存不存在，不是记录当前选了哪个协议", () => {
    expect([...presetProtocols().stepfun].sort()).toEqual(["anthropic", "openai"]);
    expect(
      validateCompatVocab({
        consumes: adapterConsumes(),
        platformProtocols: presetProtocols(),
        platforms: { stepfun: ["effortVocabMessages"] }
      })
    ).toEqual([]);
  });
});

describe("平台声明派生（词表是唯一主人，adapter/preset-headers 不再自建名单）", () => {
  it("hasPlatformQuirk：effort 词汇平台 = stepfun / amd（anthropic Messages 通道）", () => {
    expect(hasPlatformQuirk("stepfun", "effortVocabMessages")).toBe(true);
    expect(hasPlatformQuirk("amd", "effortVocabMessages")).toBe(true);
    expect(PLATFORM_QUIRKS.stepfun).toEqual(["effortVocabMessages"]);
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

describe("resolvePlatformQuirkId（词表查表的唯一识别口径）", () => {
  it("presetId 直中：词表成员原样返回（trim 后判定）", () => {
    expect(resolvePlatformQuirkId("opencodego")).toBe("opencodego");
    expect(resolvePlatformQuirkId("  stepfun  ")).toBe("stepfun");
  });

  it("presetId 未命中（custom/未知值）时按 baseUrl host 兜底", () => {
    expect(resolvePlatformQuirkId("custom", "https://opencode.ai/zen/go/v1")).toBe("opencodego");
    expect(resolvePlatformQuirkId("", "https://api.stepfun.com/step_plan")).toBe("stepfun");
  });

  it("兜底不成立 → undefined：无 baseUrl / host 不认识 / host 命中非词表平台", () => {
    expect(resolvePlatformQuirkId("custom")).toBeUndefined();
    expect(resolvePlatformQuirkId("custom", "not a url")).toBeUndefined();
    expect(resolvePlatformQuirkId("custom", "https://unknown.example.com/v1")).toBeUndefined();
    expect(resolvePlatformQuirkId("custom", "https://api.deepseek.com/v1")).toBeUndefined();
  });

  it("键空间是 PLATFORM_QUIRKS 而非 PROVIDERS：siliconflow 有思考档位但无怪癖 → undefined", () => {
    expect(resolvePlatformQuirkId("siliconflow", "https://api.siliconflow.cn/v1")).toBeUndefined();
    expect(resolvePlatformQuirkId("deepseek", "https://api.deepseek.com/v1")).toBeUndefined();
  });

  it("presetId 命中已知平台时不穿透 baseUrl host：避免非怪癖预设手改域名误触发怪癖", () => {
    expect(resolvePlatformQuirkId("deepseek", "https://api.stepfun.com/step_plan")).toBeUndefined();
    expect(resolvePlatformQuirkId("deepseek", "https://opencode.ai/zen/go/v1")).toBeUndefined();
    expect(resolvePlatformQuirkId("stepfun", "http://localhost:8080/v1")).toBe("stepfun");
  });
});
