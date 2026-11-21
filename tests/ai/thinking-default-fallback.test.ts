import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { buildChatRequestBody } from "../../extension/ai/adapters/openai.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import {
  AI_THINKING_LEVELS,
  THINKING_DEFAULT_LEVEL,
  normalizeThinkingLevel,
  resolveThinkingAdjustment,
  resolveThinkingProfile
} from "../../extension/ai/thinking-profiles.js";
import { openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";
import { normalizeAiThinkingLevel } from "../../extension/core/validators.js";

const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
const ROW_MODEL = "deepseek-v4-pro";
const DIRTY = ["none", "Default", "", "ultra"] as const;

function openaiThoughtFields(thinkingLevel?: string): Record<string, unknown> {
  const { model, messages, stream, ...rest } = buildChatRequestBody({
    model: ROW_MODEL,
    messages: [],
    stream: true,
    thinkingWire: planThinkingWire({
      protocol: "openai",
      model: ROW_MODEL,
      baseUrl: DEEPSEEK_URL,
      level: thinkingLevel,
      stream: true,
      probe: false
    })
  });
  expect({ model, messages, stream }).toEqual({ model: ROW_MODEL, messages: [], stream: true });
  return rest;
}

function messagesThoughtFields(thinkingLevel?: string): Record<string, unknown> {
  const { model, messages, stream, max_tokens, ...rest } = anthropicAdapter.buildBody({
    model: ROW_MODEL,
    messages: [],
    stream: false,
    thinkingWire: planThinkingWire({
      protocol: "anthropic",
      model: ROW_MODEL,
      presetId: "deepseek",
      baseUrl: DEEPSEEK_ANTHROPIC_URL,
      level: thinkingLevel,
      stream: false,
      probe: false
    })
  });
  expect({ model, messages, stream, max_tokens }).toEqual({ model: ROW_MODEL, messages: [], stream: false, max_tokens: 32768 });
  return rest;
}

describe("缺省 / 脏值 = 不发言：F1（缺省/脏值不得落到某个具体档）", () => {
  it("openai 链：缺省与每个脏值都无思考字段（旧实现发 thinking:{type:disabled}）", () => {
    expect(openaiThoughtFields()).toEqual({});
    for (const dirty of DIRTY) {
      expect(openaiThoughtFields(dirty), `thinkingLevel=${JSON.stringify(dirty)}`).toEqual({});
    }
  });

  it("Messages 链：缺省与每个脏值都无思考字段（旧实现发 thinking:{type:disabled}）", () => {
    expect(messagesThoughtFields()).toEqual({});
    for (const dirty of DIRTY) {
      expect(messagesThoughtFields(dirty), `thinkingLevel=${JSON.stringify(dirty)}`).toEqual({});
    }
  });

  it("解析入口：缺省 / 脏值（含非字符串）解析为 default —— noFields 词汇、无 off 级联标记、不报「被调整」", () => {
    for (const level of [undefined, null, "", "none", "Default", "ultra", 7, {}] as unknown[]) {
      const profile = resolveThinkingProfile({ presetId: "deepseek", model: ROW_MODEL, level, stream: true });
      expect(openaiVocabularyFields(profile.vocabulary), `level=${String(level)}`).toEqual({});
      expect(profile.offUnavailable, `level=${String(level)}`).toBe(false);
      expect(profile.offFallback, `level=${String(level)}`).toBe(null);

      const adjustment = resolveThinkingAdjustment({ presetId: "deepseek", model: ROW_MODEL, level, stream: true });
      expect(adjustment.requestedLevel, `level=${String(level)}`).toBe(THINKING_DEFAULT_LEVEL);
      expect(adjustment.effectiveLevel, `level=${String(level)}`).toBe(THINKING_DEFAULT_LEVEL);
      expect(adjustment.reason, `level=${String(level)}`).toBe(null);
    }
  });

  it("token 上限参数名事实与档位无关：缺省档仍按血统发 max_completion_tokens（换名不靠思考字段存在）", () => {
    const omitted = buildChatRequestBody({
      model: "gpt-5.1",
      messages: [],
      stream: false,
      thinkingWire: planThinkingWire({
        protocol: "openai",
        model: "gpt-5.1",
        baseUrl: "https://api.openai.com/v1",
        level: undefined,
        stream: false,
        probe: false
      }),
      maxTokens: 1
    });
    expect(omitted).toEqual({ model: "gpt-5.1", messages: [], stream: false, max_completion_tokens: 1 });
  });
});

describe("显式 off 语义不变：F2（不得被吞、不得漂移）", () => {
  it("openai 链：显式 off 走平台关思考写点，与缺省/脏值逐字节不同", () => {
    expect(openaiThoughtFields("off")).toEqual({ thinking: { type: "disabled" } });
    for (const other of [undefined, ...DIRTY]) {
      expect(openaiThoughtFields(other), `thinkingLevel=${String(other)}`).not.toEqual(openaiThoughtFields("off"));
    }
  });

  it("Messages 链：显式 off 走平台关思考写点，与缺省/脏值逐字节不同", () => {
    expect(messagesThoughtFields("off")).toEqual({ thinking: { type: "disabled" } });
    for (const other of [undefined, ...DIRTY]) {
      expect(messagesThoughtFields(other), `thinkingLevel=${String(other)}`).not.toEqual(messagesThoughtFields("off"));
    }
  });
});

describe("两条探针链对齐：F3", () => {
  it("probe + 不传档位：两条链都不发思考字段（openai 不再发 reasoning_effort:none）", () => {
    const openaiProbe = buildChatRequestBody({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      thinkingWire: planThinkingWire({
        protocol: "openai",
        model: "gpt-5.1",
        baseUrl: "https://api.openai.com/v1",
        level: undefined,
        stream: false,
        probe: true
      }),
      maxTokens: 1
    });
    expect(openaiProbe).toEqual({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_completion_tokens: 1
    });

    const messagesProbe = anthropicAdapter.buildBody({
      model: "claude-x",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      thinkingWire: planThinkingWire({
        protocol: "anthropic",
        model: "claude-x",
        baseUrl: "https://api.anthropic.com",
        level: undefined,
        stream: false,
        probe: true
      }),
      maxTokens: 1
    });
    expect(messagesProbe).toEqual({
      model: "claude-x",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1
    });

    const thoughtKeys = ["thinking", "reasoning_effort", "enable_thinking", "output_config"];
    for (const body of [openaiProbe, messagesProbe]) {
      for (const key of thoughtKeys) {
        expect(body, `${key} 不该出现在探针请求体里`).not.toHaveProperty(key);
      }
    }
  });
});

describe("缺省 / 脏值 / 显式 default 三者等价：F4", () => {
  it("两条链上三者逐字节同体（default 档不因入口不同而多发字段）", () => {
    const openaiDefault = openaiThoughtFields(THINKING_DEFAULT_LEVEL);
    expect(openaiDefault).toEqual({});
    expect(openaiThoughtFields()).toEqual(openaiDefault);
    expect(openaiThoughtFields("none")).toEqual(openaiDefault);

    const messagesDefault = messagesThoughtFields(THINKING_DEFAULT_LEVEL);
    expect(messagesDefault).toEqual({});
    expect(messagesThoughtFields()).toEqual(messagesDefault);
    expect(messagesThoughtFields("none")).toEqual(messagesDefault);
  });
});

describe("有效档位不受影响：F5", () => {
  it("7 档逐档实发 = 解析层投影（缺省/脏值的归一不污染有效档）", () => {
    for (const level of AI_THINKING_LEVELS) {
      const profile = resolveThinkingProfile({ presetId: "deepseek", model: ROW_MODEL, level, stream: true });
      expect(openaiThoughtFields(level), `openai · ${level}`).toEqual(openaiVocabularyFields(profile.vocabulary));
      expect(openaiThoughtFields(level), `openai · ${level} 不该等于缺省体`).not.toEqual({});
    }
  });
});

describe("归一化同口径：F6（其它调用点不被波及，也不各说各话）", () => {
  it("唯一归一化：8 个可选值原样，缺省 / 脏值回落 default", () => {
    for (const value of [THINKING_DEFAULT_LEVEL, ...AI_THINKING_LEVELS]) {
      expect(normalizeThinkingLevel(value), value).toBe(value);
    }
    for (const dirty of ["none", "Default", "ultra", "", null, undefined, 7, {}]) {
      expect(normalizeThinkingLevel(dirty), String(dirty)).toBe(THINKING_DEFAULT_LEVEL);
    }
  });

  it("存储 / 面板侧（core/validators 再导出）与请求侧解析入口同口径：脏值两处都归 default", () => {
    expect(normalizeAiThinkingLevel("bogus")).toBe(THINKING_DEFAULT_LEVEL);
    expect(normalizeAiThinkingLevel(undefined)).toBe(THINKING_DEFAULT_LEVEL);
    expect(resolveThinkingAdjustment({ presetId: "deepseek", model: ROW_MODEL, level: "bogus", stream: true }).requestedLevel).toBe(
      THINKING_DEFAULT_LEVEL
    );
    expect(resolveThinkingAdjustment({ presetId: "deepseek", model: ROW_MODEL, level: undefined, stream: true }).requestedLevel).toBe(
      normalizeAiThinkingLevel(undefined)
    );
  });
});
