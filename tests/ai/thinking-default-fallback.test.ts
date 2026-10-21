// tests/ai/thinking-default-fallback.test.ts
// 票 thinking-seam-tightening/01 第 3 项（2026-10-05 用户裁定两轮）：`thinkingLevel` 的
// **缺省或无法识别的脏值**一律归 `default`（不干预）——线上不发任何思考字段；显式 `off`
// 语义不变。第二轮把**存储 / 面板侧**同口径归过来（同一个 `normalizeThinkingLevel`，
// 不再有「请求侧归 default、值域归 off」的分叉）。裁决记录见
// docs/adr/0015-thinking-default-tier.md 文末的 2026-10-05 修订块。
//
// 先列失败方式（每条都有对应用例；括号 = 判据所在）：
//   F1 脏值 / 缺省被静默映射到某个具体档（旧实现 = off）而非 default → 线上实发关思考字段
//      （「缺省 / 脏值 = 不发言：F1」四条：两条链 + 解析入口 + token 上限事实无关）；
//   F2 显式 off 被吞或漂移 → 同一行显式 off 仍走该平台关思考写点（F1/F2 用例逐字节对照）；
//   F3 两条探针链表现不一致 → openai 缝与 Messages 缝在 probe 下的思考字段集合相同
//      （「两条探针链对齐：F3」）；
//   F4 default 档误发思考字段 → 缺省 / 脏值 / 显式 default 三者逐字节同体且无思考字段
//      （「三者等价：F4」；本档逐行钉在 tests/ai/thinking-default-level.test.ts）；
//   F5 既有 golden 漂移 → 7 档逐档实发仍与解析层投影同源、且都不等于缺省体
//      （「有效档位不受影响：F5」；逐字节整 body 的主体仍是 tests/ai/thinking-golden*.test.ts）；
//   F6 归一化的其它调用点被波及 / 两处口径分叉 → 唯一归一化逐值不变，存储侧
//      （core/validators 再导出，守卫在 tests/core/shared-defaults-thinking.test.ts）
//      与请求侧解析入口对脏值给同一个答案（「归一化同口径：F6」）。
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

// 两条链的代表行：同一行既有「显式 off 的关思考写点」，也能被缺省/脏值命中的平台×模型。
const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
const ROW_MODEL = "deepseek-v4-pro";
// 脏值集合：上游词表的 `none`、大小写错、空串、编造词（都在端口载荷里真实可到）。
const DIRTY = ["none", "Default", "", "ultra"] as const;

// openai 缝的思考字段（去掉三个公共键后的余量）：与逐字节整 body 断言同源。
// 思考线格式产出由装配边算好注入（生产唯一调用点是 completion.ts 的 fetch 点，
// 本文件直接驱动请求构造的用例按同一口径先跑装配边）。
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

// Messages 缝的思考字段（去掉公共键后的余量）：probe=false，其余同 golden 的 adapter 调用形状。
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
    // gpt-5.1 = openai-reasoning 系（off 写点是 reasoning_effort none）：缺省档不发言，
    // 但 token 上限参数名仍须跟着血统走，否则探针/请求会落到严格 400 的 max_tokens。
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

    // 判据对称：两条链的余量都是空集（不是「一条空、一条带关思考字段」）。
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
      // 该行 A' = {off,low,high,max}：7 档都应落下非空字段（clamp 向下取），与缺省体互不混淆。
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
    // 存储侧消费者：core/validators 的再导出（settings-store / chat/providers 的读回落与落盘）。
    expect(normalizeAiThinkingLevel("bogus")).toBe(THINKING_DEFAULT_LEVEL);
    expect(normalizeAiThinkingLevel(undefined)).toBe(THINKING_DEFAULT_LEVEL);
    // 请求侧消费者：解析入口（UI 提示面 requestedLevel / 实发档）。
    expect(resolveThinkingAdjustment({ presetId: "deepseek", model: ROW_MODEL, level: "bogus", stream: true }).requestedLevel).toBe(
      THINKING_DEFAULT_LEVEL
    );
    expect(resolveThinkingAdjustment({ presetId: "deepseek", model: ROW_MODEL, level: undefined, stream: true }).requestedLevel).toBe(
      normalizeAiThinkingLevel(undefined)
    );
  });
});
