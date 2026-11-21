import { describe, expect, it } from "vitest";
import {
  AI_THINKING_LEVELS,
  availableLevelsOf,
  reasoningEffort,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  ruleFromUpstreamFact,
  upstreamVocabularyOf,
  type ThinkingLevel,
  type ThinkingRuleSource
} from "../../extension/ai/thinking-profiles.js";
import { openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";
import { lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";

const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4";
const KIMI_URL = "https://api.kimi.com/coding/v1";
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MINIMAX_URL = "https://api.minimaxi.com/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENCODEGO_URL = "https://opencode.ai/zen/go/v1";
const SENSENOVA_URL = "https://token.sensenova.cn/v1";
const AMD_URL = "https://developer.amd.com.cn/radeon/api/v1";
const OLLAMA_URL = "http://localhost:11434/v1";
const CUSTOM_URL = "https://api.example.com/v1";

function adjustment(presetId: string, baseUrl: string, model: string, level = "off") {
  return resolveThinkingAdjustment({ presetId, baseUrl, model, level, stream: true });
}

function sent(presetId: string, baseUrl: string, model: string, level: ThinkingLevel) {
  return resolveThinkingProfile({ presetId, baseUrl, model, level, stream: true });
}

describe("chip 集合 = A'（与请求落线同源，不是第二套推导）", () => {
  it("集合内每档都发得出去；集合外的档位绝不会被原样发出", () => {
    const samples: ReadonlyArray<[string, string, string]> = [
      ["deepseek", DEEPSEEK_URL, "deepseek-v4-pro"],
      ["zhipu", ZHIPU_URL, "glm-5.2"],
      ["qwen", QWEN_URL, "glm-5.2"],
      ["qwen", QWEN_URL, "qwen3.8-max"],
      ["sensenova", SENSENOVA_URL, "glm-5.2"]
    ];
    for (const [presetId, baseUrl, model] of samples) {
      const adj = adjustment(presetId, baseUrl, model);
      for (const level of AI_THINKING_LEVELS) {
        const response = sent(presetId, baseUrl, model, level);
        const at = `${presetId}/${model} 偏好 ${level}`;
        if (adj.availableLevels.includes(level)) {
          expect(Object.keys(openaiVocabularyFields(response.vocabulary)).length, at).toBeGreaterThan(0);
        } else {
          expect(
            JSON.stringify(openaiVocabularyFields(response.vocabulary)).includes(`"${level}"`),
            `${at} 不该被原样发出`
          ).toBe(false);
        }
      }
    }
  });

  it("空可用集 = 逐档都不发（qwen 的上游缺口 qwq-32b：手写 always，无档位写点）", () => {
    const adj = adjustment("qwen", QWEN_URL, "qwq-32b");
    expect(adj.availableLevels).toEqual([]);
    expect(adj.effectiveLevel).toBe("default");
    for (const level of AI_THINKING_LEVELS) {
      expect(openaiVocabularyFields(sent("qwen", QWEN_URL, "qwq-32b", level).vocabulary), level).toEqual({});
    }
  });

  it("只显示存在的档位：qwen3.8-max 的 chip 里没有 High（偏好 high 被 clamp 到 medium）", () => {
    const adj = adjustment("qwen", QWEN_URL, "qwen3.8-max", "high");
    expect(adj.availableLevels).toEqual(["off", "low", "medium", "xhigh"]);
    expect(adj.effectiveLevel).toBe("medium");
    expect(adj.reason).toBe("model-vocabulary");
  });

  it("开关型模型（上游词表只有 toggle）的可用集仍是全 7 档：zhipu/glm-4.6 的 on 写点服务所有非 off 档", () => {
    const adj = adjustment("zhipu", ZHIPU_URL, "glm-4.6");
    expect(adj.availableLevels).toEqual([...AI_THINKING_LEVELS]);
    expect(adj.switchOnly).toBe(true);
    expect(adjustment("zhipu", ZHIPU_URL, "glm-5.2").switchOnly).toBe(false);
    expect(adjustment("zhipu", ZHIPU_URL, "glm-5.3").switchOnly).toBe(false);
    expect(adjustment("deepseek", DEEPSEEK_URL, "deepseek-v4-pro").switchOnly).toBe(false);
  });
});

describe("A' = 上游词表在平台已登记方言下可表达的部分（2026-10-04 用户裁定）", () => {
  const cases: Array<[string, string, string, readonly string[], ThinkingRuleSource]> = [
    ["deepseek", DEEPSEEK_URL, "deepseek-v4-pro", ["off", "low", "high", "max"], "upstream"],
    ["zhipu", ZHIPU_URL, "glm-4.6", ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "upstream"],
    ["zhipu", ZHIPU_URL, "glm-5.2", ["off", "high", "max"], "upstream"],
    ["moonshot", KIMI_URL, "kimi-k3", ["low", "high", "max"], "upstream"],
    ["qwen", QWEN_URL, "glm-5.2", ["off", "high", "max"], "upstream"],
    ["ollama", OLLAMA_URL, "llama3.2", ["off", "low", "high"], "handwritten"],
    ["custom", CUSTOM_URL, "deepseek-v4-pro", ["off", "low", "high"], "handwritten"],
    ["moonshot", KIMI_URL, "kimi-k2.7-code", [], "handwritten"],
    ["custom", CUSTOM_URL, "vendor-future-1", [], "unknown"],
    ["openrouter", OPENROUTER_URL, "anthropic/claude-opus-4.5", ["low", "medium", "high"], "upstream"],
    ["sensenova", SENSENOVA_URL, "sensenova-6.8-flash-lite", ["off", "low", "medium", "high"], "upstream"],
    ["amd", AMD_URL, "Qwen3.8-27B", ["low", "medium"], "upstream"],
    ["amd", AMD_URL, "Qwen3.8-Flash-Next", ["low", "medium", "xhigh"], "upstream"],
    ["opencodego", OPENCODEGO_URL, "qwen3.8-flash", ["low", "medium", "xhigh"], "upstream"],
    ["openrouter", OPENROUTER_URL, "deepseek/deepseek-v4-pro-0813", ["low", "high", "max"], "upstream"],
    ["openrouter", OPENROUTER_URL, "z-ai/glm-5.3", ["low", "high", "max"], "upstream"],
    ["opencodego", OPENCODEGO_URL, "glm-5.2", ["high", "max"], "upstream"],
    ["opencodego", OPENCODEGO_URL, "kimi-k3", ["low", "high", "max"], "upstream"],
    ["openrouter", OPENROUTER_URL, "prism-ml/ternary-bonsai-2-27b", ["off", "medium", "xhigh"], "upstream"]
  ];

  for (const [presetId, baseUrl, model, levels, source] of cases) {
    it(`${presetId}/${model} → ${source}，chip = {${levels.join(",")}}`, () => {
      const adj = adjustment(presetId, baseUrl, model);
      expect(adj.source).toBe(source);
      expect(adj.availableLevels).toEqual([...levels]);
    });
  }

  it("写点集 == 上游词表在平台可表达的部分（A' 不改今日口径）", () => {
    const rows: ReadonlyArray<[string, string, string]> = [
      ["deepseek", "deepseek", "deepseek-v4-pro"],
      ["zhipu", "zhipuai", "glm-5.2"],
      ["qwen", "alibaba-cn", "glm-5.2"],
      ["modelscope", "modelscope", "GLM-4.6"],
      ["minimax", "minimax-cn", "MiniMax-M3"],
      ["openrouter", "openrouter", "deepseek/deepseek-v4-pro-0813"],
      ["amd", "amd", "Qwen3.8-Flash-Next"],
      ["sensenova", "sensenova", "glm-5.2"],
      ["opencodego", "opencode-go", "qwen3.8-flash"]
    ];
    for (const [presetId, upstreamId, model] of rows) {
      const fact = lookupThinkingFact(upstreamId, model);
      expect(fact, `${upstreamId}/${model}`).toBeTruthy();
      const projected = availableLevelsOf(ruleFromUpstreamFact(fact!, presetId));
      expect(adjustment(presetId, "", model).availableLevels, `${presetId}/${model}`).toEqual([...projected]);
      const vocabulary = new Set(upstreamVocabularyOf(fact!));
      for (const level of projected) {
        expect(vocabulary.has(level), `${presetId}/${model} · ${level}`).toBe(true);
      }
    }
  });

  it("A' 不收窄成平台声明（18 号票：平台声明已删，写点集即 A'）", () => {
    const rows: ReadonlyArray<[string, string, string, readonly string[]]> = [
      ["opencodego", "opencode-go", "qwen3.8-flash", ["low", "medium", "xhigh"]],
      ["amd", "amd", "Qwen3.8-Flash-Next", ["low", "medium", "xhigh"]],
      ["openrouter", "openrouter", "z-ai/glm-5.3", ["low", "high", "max"]]
    ];
    for (const [presetId, upstreamId, model, expected] of rows) {
      const fact = lookupThinkingFact(upstreamId, model);
      expect(fact, `${upstreamId}/${model}`).toBeTruthy();
      expect(adjustment(presetId, "", model).availableLevels, `${presetId}/${model}`).toEqual([...expected]);
      for (const level of expected) {
        expect(
          Object.keys(openaiVocabularyFields(sent(presetId, "", model, level as ThinkingLevel).vocabulary)).length,
          `${presetId}/${model} · ${level}`
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("off / none 分离（决策 #7）", () => {
  it("off 永远独立成 chip：最多一次、永远排第一", () => {
    const samples: ReadonlyArray<[string, string, string]> = [
      ["deepseek", DEEPSEEK_URL, "deepseek-v4-pro"],
      ["zhipu", ZHIPU_URL, "glm-5.2"],
      ["ollama", OLLAMA_URL, "llama3.2"],
      ["qwen", QWEN_URL, "glm-5.2"],
      ["minimax", MINIMAX_URL, "MiniMax-M3"]
    ];
    for (const [presetId, baseUrl, model] of samples) {
      const levels = adjustment(presetId, baseUrl, model).availableLevels;
      expect(levels.filter((level) => level === "off").length, `${presetId}/${model}`).toBeLessThanOrEqual(1);
      if (levels.includes("off")) {
        expect(levels[0], `${presetId}/${model}`).toBe("off");
      }
    }
  });

  it("上游 none 不物化成档位（sensenova-6.8-flash-lite 的 none-low-medium-high：off 走 effort none，无 none 档位）", () => {
    const fact = lookupThinkingFact("sensenova", "sensenova-6.8-flash-lite");
    expect(fact?.effort).toContain("none");
    const projection = ruleFromUpstreamFact(fact!, "sensenova");
    expect(projection.off).toEqual({ vocabulary: reasoningEffort("none") });
    expect(projection.low).toEqual({ vocabulary: reasoningEffort("low") });
    expect(projection.high).toEqual({ vocabulary: reasoningEffort("high") });
    expect(projection["none" as never]).toBeUndefined();
    expect(adjustment("sensenova", SENSENOVA_URL, "sensenova-6.8-flash-lite").availableLevels).not.toContain("none");
  });

  it("off 可用性三形态：toggle 有开关形状可用 / effort 含 none 可用 / 两者都无则关不掉", () => {
    expect(adjustment("zhipu", ZHIPU_URL, "glm-4.6").availableLevels).toContain("off");
    expect(adjustment("openrouter", OPENROUTER_URL, "mistralai/mistral-medium-3-5").availableLevels).toContain("off");
    expect(adjustment("zhipu", ZHIPU_URL, "glm-5.3").availableLevels).not.toContain("off");
    const boundary = adjustment("opencodego", OPENCODEGO_URL, "hy4-preview", "off");
    expect(boundary.availableLevels).toEqual(["off", "high"]);
    expect(sent("opencodego", OPENCODEGO_URL, "hy4-preview", "off")).toEqual({
      vocabulary: reasoningEffort("none"),
      requestedLevel: "off",
      effectiveLevel: "off",
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "hybrid"
    });
  });
});

describe("验收第一条：none/high 类（13 号票 canonical 优先后剩 3 行，双证据）", () => {
  const UPSTREAM_BY_PRESET: Record<string, string> = {
    opencodego: "opencode-go",
    openrouter: "openrouter",
    sensenova: "sensenova"
  };
  const NONE_HIGH: ReadonlyArray<[string, string, string, readonly ThinkingLevel[]]> = [
    ["opencodego", OPENCODEGO_URL, "hy4-preview", ["off", "high"]],
    ["openrouter", OPENROUTER_URL, "mistralai/mistral-medium-3-5", ["off", "high"]],
    ["openrouter", OPENROUTER_URL, "mistralai/mistral-small-2603", ["off", "high"]]
  ];

  it("3 行的上游值集都是 none-high，上游投影恒为 {off, high}（不含 low/medium）", () => {
    expect(NONE_HIGH).toHaveLength(3);
    for (const [presetId, , model] of NONE_HIGH) {
      const provider = UPSTREAM_BY_PRESET[presetId];
      const fact = lookupThinkingFact(provider, model);
      expect(fact?.valuesetId, `${presetId}/${model}`).toBe("none-high");
      const projection = ruleFromUpstreamFact(fact!, provider);
      const levels = AI_THINKING_LEVELS.filter((level) =>
        level === "off" ? Boolean(projection.off) : Boolean(projection[level])
      );
      expect(levels, `${presetId}/${model}`).toEqual(["off", "high"]);
      expect(upstreamVocabularyOf(fact!), `${presetId}/${model}`).toEqual(["off", "high"]);
    }
  });

  it("UI chip = A'（验收第一条：三行都是 {off,high}，不含 low/medium）", () => {
    for (const [presetId, baseUrl, model, levels] of NONE_HIGH) {
      const adj = adjustment(presetId, baseUrl, model);
      expect(adj.source, `${presetId}/${model}`).toBe("upstream");
      expect(adj.availableLevels, `${presetId}/${model}`).toEqual([...levels]);
      expect(adj.availableLevels).not.toContain("low");
      expect(adj.availableLevels).not.toContain("medium");
    }
  });

  it("偏好 low 的落线格：有 off 写点 → effort none（向下兼容落 none）；无 off → high", () => {
    for (const [presetId, baseUrl, model, levels] of NONE_HIGH) {
      const adj = adjustment(presetId, baseUrl, model, "low");
      const response = sent(presetId, baseUrl, model, "low");
      if (levels.includes("off")) {
        expect(adj.effectiveLevel, `${presetId}/${model}`).toBe("off");
        expect(adj.reason, `${presetId}/${model}`).toBe("model-vocabulary");
        expect(openaiVocabularyFields(response.vocabulary), `${presetId}/${model}`).toEqual({ reasoning_effort: "none" });
      } else {
        expect(adj.effectiveLevel, `${presetId}/${model}`).toBe("high");
        expect(openaiVocabularyFields(response.vocabulary), `${presetId}/${model}`).toEqual({ reasoning_effort: "high" });
      }
    }
    const normal = adjustment("deepseek", DEEPSEEK_URL, "deepseek-v4-pro", "low");
    expect(normal.effectiveLevel).toBe("low");
    expect(normal.reason).toBeNull();
    expect(openaiVocabularyFields(sent("deepseek", DEEPSEEK_URL, "deepseek-v4-pro", "low").vocabulary)).toEqual({
      reasoning_effort: "low"
    });
  });

  it("13 号票 canonical 优先：另外 3 行的模型侧词表已换（18 号票起按各自上游词表）", () => {
    const namazu = adjustment("openrouter", OPENROUTER_URL, "sakana/sakana-namazu");
    expect(lookupThinkingFact("openrouter", "sakana/sakana-namazu")?.valuesetId).toBe("toggle");
    expect(namazu.availableLevels).toEqual([]);
    expect(namazu.source).toBe("upstream");
    expect(
      openaiVocabularyFields(sent("openrouter", OPENROUTER_URL, "sakana/sakana-namazu", "low").vocabulary)
    ).toEqual({});
    const glm = adjustment("sensenova", SENSENOVA_URL, "glm-5.2");
    expect(lookupThinkingFact("sensenova", "glm-5.2")?.valuesetId).toBe("toggle+high-max");
    expect(glm.availableLevels).toEqual(["high", "max"]);
    expect(openaiVocabularyFields(sent("sensenova", SENSENOVA_URL, "glm-5.2", "low").vocabulary)).toEqual({
      reasoning_effort: "high"
    });
    const flash = adjustment("sensenova", SENSENOVA_URL, "deepseek-v4-flash");
    expect(lookupThinkingFact("sensenova", "deepseek-v4-flash")?.valuesetId).toBe("toggle+low-high-max");
    expect(flash.availableLevels).toEqual(["low", "high", "max"]);
    expect(openaiVocabularyFields(sent("sensenova", SENSENOVA_URL, "deepseek-v4-flash", "low").vocabulary)).toEqual({
      reasoning_effort: "low"
    });
  });
});

describe("minimax-cn/minimax-m3：开关型（2026-10-05 裁定登记开关形状后）", () => {
  it("A' = 全部档位 + 开关型：off 真发 disabled（关得掉）、非 off 档发平台开词 adaptive", () => {
    const adj = adjustment("minimax", MINIMAX_URL, "MiniMax-M3");
    expect(adj.availableLevels).toEqual([...AI_THINKING_LEVELS]);
    expect(adj.switchOnly).toBe(true);
    expect(adj.source).toBe("upstream");
    const response = sent("minimax", MINIMAX_URL, "MiniMax-M3", "off");
    expect(response.offUnavailable).toBe(false);
    expect(response.offFallback).toBeNull();
    expect(openaiVocabularyFields(response.vocabulary)).toEqual({ thinking: { type: "disabled" } });
    for (const level of AI_THINKING_LEVELS.filter((candidate) => candidate !== "off")) {
      expect(openaiVocabularyFields(sent("minimax", MINIMAX_URL, "MiniMax-M3", level).vocabulary), level).toEqual({
        thinking: { type: "adaptive" }
      });
    }
    expect(
      openaiVocabularyFields(adjustment("minimax", MINIMAX_URL, "MiniMax-M3", "default").resolution.vocabulary)
    ).toEqual({});
  });

  it("目录外的 M2.x / M3.1 仍走手写兜底：一个档位都没有（不发字段，故也不会发会 400 的 disabled）", () => {
    for (const model of ["MiniMax-M2", "MiniMax-M2.7", "MiniMax-M3.1-Flash-Preview"]) {
      const adj = adjustment("minimax", MINIMAX_URL, model);
      expect(adj.availableLevels, model).toEqual([]);
      expect(adj.source, model).toBe("handwritten");
      expect(adj.effectiveLevel, model).toBe("default");
      for (const level of AI_THINKING_LEVELS) {
        expect(
          openaiVocabularyFields(sent("minimax", MINIMAX_URL, model, level).vocabulary),
          `${model} · ${level}`
        ).toEqual({});
      }
    }
  });
});

describe("无上游平台仍显示今日三档（ollama / custom）", () => {
  it("ollama：未列模型走手写 unknownClass（ollama-effort）→ {off, low, high}", () => {
    const adj = adjustment("ollama", OLLAMA_URL, "llama3.2");
    expect(adj.source).toBe("handwritten");
    expect(adj.availableLevels).toEqual(["off", "low", "high"]);
  });

  it("ollama：模式表命中的模型按模式表（deepseek-r1:8b → deepseek-reasoner-always，隐藏档位）", () => {
    const adj = adjustment("ollama", OLLAMA_URL, "deepseek-r1:8b");
    expect(adj.source).toBe("handwritten");
    expect(adj.availableLevels).toEqual([]);
  });

  it("custom：模式表命中的模型仍三档；模式表也不命中的模型隐藏档位", () => {
    expect(adjustment("custom", CUSTOM_URL, "gpt-5.1").availableLevels).toEqual(["off", "low", "high"]);
    const unknown = adjustment("custom", CUSTOM_URL, "vendor-future-1");
    expect(unknown.source).toBe("unknown");
    expect(unknown.availableLevels).toEqual([]);
  });
});

describe("边界：A' = ∅ 的零档行（openrouter 5 行 + 18 号票新增的 toggle-only 行，fail-closed）", () => {
  const EMPTY: ReadonlyArray<[string, string, string]> = [
    ["openrouter", OPENROUTER_URL, "google/gemini-2.5-pro"],
    ["openrouter", OPENROUTER_URL, "google/gemini-2.5-pro-preview"],
    ["openrouter", OPENROUTER_URL, "qwen/qwen3-next-80b-a3b-thinking"],
    ["openrouter", OPENROUTER_URL, "anthropic/claude-haiku-4.5"],
    ["openrouter", OPENROUTER_URL, "anthropic/claude-sonnet-4.5"],
    ["openrouter", OPENROUTER_URL, "sakana/sakana-namazu"]
  ];

  it("零档行 chip 为空、逐档都不发（不再有平台声明照发；实发 default）", () => {
    for (const [presetId, baseUrl, model] of EMPTY) {
      const adj = adjustment(presetId, baseUrl, model);
      expect(adj.availableLevels, `${presetId}/${model}`).toEqual([]);
      expect(adj.effectiveLevel, `${presetId}/${model}`).toBe("default");
      for (const level of AI_THINKING_LEVELS) {
        expect(
          openaiVocabularyFields(sent(presetId, baseUrl, model, level).vocabulary),
          `${presetId}/${model} · ${level}`
        ).toEqual({});
      }
    }
  });
});

describe("canonical 优先（13 号票）：opencodego/kimi-k3 = canonical 词表的写点集", () => {
  it("chip 集合 = {low, high, max}，来源层 = upstream", () => {
    const adj = adjustment("opencodego", OPENCODEGO_URL, "kimi-k3");
    expect(adj.source).toBe("upstream");
    expect(adj.availableLevels).toEqual(["low", "high", "max"]);
  });

  it("逐档落线（chat 通道）：off 关不掉 → 级联落 low；low/high/max → 顶层 reasoning_effort", () => {
    const expected: Array<[string, Record<string, unknown>]> = [
      ["off", { reasoning_effort: "low" }],
      ["minimal", { reasoning_effort: "low" }],
      ["low", { reasoning_effort: "low" }],
      ["medium", { reasoning_effort: "low" }],
      ["high", { reasoning_effort: "high" }],
      ["xhigh", { reasoning_effort: "high" }],
      ["max", { reasoning_effort: "max" }]
    ];
    for (const [level, fields] of expected) {
      expect(
        openaiVocabularyFields(sent("opencodego", OPENCODEGO_URL, "kimi-k3", level as ThinkingLevel).vocabulary),
        level
      ).toEqual(fields);
    }
    const off = sent("opencodego", OPENCODEGO_URL, "kimi-k3", "off");
    expect(off.offUnavailable).toBe(true);
    expect(off.offFallback).toBe("low");
    expect(off.thinkingClass).toBe("always");
  });

  it("与上游 canonical 同源：模型侧词表 == canonical 目标（moonshotai/kimi-k3）的事实", () => {
    expect(lookupThinkingFact("opencode-go", "kimi-k3")?.valuesetId).toBe("low-high-max");
    expect(lookupThinkingFact("opencode-go", "kimi-k3")?.effort).toEqual(["low", "high", "max"]);
    expect(lookupThinkingFact("moonshotai", "kimi-k3")).toBeNull();
    expect(adjustment("moonshot", KIMI_URL, "kimi-k3").availableLevels).toEqual(["low", "high", "max"]);
    expect(adjustment("moonshot", KIMI_URL, "kimi-k3").source).toBe("upstream");
  });

  it("范围锁：opencodego 其它模型与其它平台的 kimi 托管行都不受影响", () => {
    const others: Array<[string, readonly string[]]> = [
      ["glm-5.2", ["high", "max"]],
      ["hy4-preview", ["off", "high"]],
      ["qwen3.8-flash", ["low", "medium", "xhigh"]],
      ["qwen3.8-max", ["low", "medium", "xhigh"]]
    ];
    for (const [model, levels] of others) {
      const adj = adjustment("opencodego", OPENCODEGO_URL, model);
      expect(adj.source, model).toBe("upstream");
      expect(adj.availableLevels, model).toEqual([...levels]);
    }
    for (const [presetId, baseUrl, model] of [
      ["modelscope", "https://api-inference.modelscope.cn/v1", "kimi-k3"],
      ["qwen", QWEN_URL, "kimi-k3"]
    ] as ReadonlyArray<[string, string, string]>) {
      expect(["handwritten", "upstream", "unknown"], `${presetId}/${model}`).toContain(
        adjustment(presetId, baseUrl, model).source
      );
    }
  });
});
