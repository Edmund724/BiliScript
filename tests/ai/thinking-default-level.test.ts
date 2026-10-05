// tests/ai/thinking-default-level.test.ts
// 2026-10-05 用户裁定：新增「不干预」档 `default` —— 所有模型都可选、都可发；落线 = 不发任何
// 思考字段（与 off「显式发关思考字段」不同：off 可能被平台忽略 / 400）。
// 本文件钉住四件事（对应票面 .scratch/tickets/thinking-default-level/spec.md 的设计要点）：
//   1. 词表分层：default **不进**强度阶梯 AI_THINKING_LEVELS——那个数组同时是 clamp 的档位序，
//      混进去会把它当成最小强度档参与级联，把「关不掉 → 落最小思考档」的裁定悄悄推翻；
//   2. 落线：偏好 default → 空 patch（chat 与 Messages 两条通道都如此），02 指派表逐行验证 + 工件；
//   3. 级联目标不变：off / 强度档落不下来时仍落阶梯里的最小可用档，**不被 default 抢走**；
//      只有「没有可表达的强度档」（A' = ∅）才落到 default；
//   4. 出厂/重置默认偏好 = default（core/defaults 与 chat-state 同源，只影响新装/重置）。
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSIGNMENTS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { chatSessionState, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import {
  AI_THINKING_LEVELS,
  AI_THINKING_LEVEL_VALUES,
  THINKING_DEFAULT_LEVEL,
  UPSTREAM_PROVIDER_BY_PRESET,
  clampThinkingLevel,
  normalizeThinkingLevel,
  resolveThinkingAdjustment,
  resolveThinkingProfile
} from "../../extension/ai/thinking-profiles.js";
import { THINKING_WIRE_MAPS, openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";

// 指派表 provider → 本仓 preset（与 tests/ai/thinking-wire-map.test.ts 同一处桥接）。
const PRESET_BY_UPSTREAM: Record<string, string> = Object.fromEntries(
  Object.entries(UPSTREAM_PROVIDER_BY_PRESET).map(([presetId, upstreamId]) => [upstreamId, presetId])
);

describe("default 词表分层（不进强度阶梯）", () => {
  it("可选值 = default + 7 档；强度阶梯里没有 default", () => {
    expect(AI_THINKING_LEVEL_VALUES[0]).toBe("default");
    expect([...AI_THINKING_LEVEL_VALUES]).toEqual(["default", ...AI_THINKING_LEVELS]);
    expect((AI_THINKING_LEVELS as readonly string[]).includes("default")).toBe(false);
    expect(THINKING_DEFAULT_LEVEL).toBe("default");
  });

  it("归一化：default 合法（原样）；非法值仍回落 off", () => {
    expect(normalizeThinkingLevel("default")).toBe("default");
    for (const level of AI_THINKING_LEVELS) {
      expect(normalizeThinkingLevel(level), level).toBe(level);
    }
    for (const bogus of ["none", "Default", "", null, undefined, 7]) {
      expect(normalizeThinkingLevel(bogus), String(bogus)).toBe("off");
    }
  });

  it("clamp：偏好 default 恒为 default（不参与向下取）；A' = ∅ 也落 default", () => {
    expect(clampThinkingLevel("default", [])).toBe("default");
    expect(clampThinkingLevel("default", ["off", "low", "high"])).toBe("default");
    expect(clampThinkingLevel("high", [])).toBe("default");
  });
});

describe("级联目标不被 default 抢走（用户早前裁定：关不掉 → 落最小思考档）", () => {
  const SENSENOVA_URL = "https://token.sensenova.cn/v1";

  it("偏好 off + A' = {high,max}（关不掉）→ 实发 high，不是 default；A' 无最小档可落才落 default", () => {
    const cascade = resolveThinkingAdjustment({
      presetId: "sensenova",
      baseUrl: SENSENOVA_URL,
      model: "glm-5.2",
      level: "off",
      stream: true
    });
    expect(cascade.availableLevels).toEqual(["high", "max"]);
    expect(cascade.effectiveLevel).toBe("high");
    expect(openaiVocabularyFields(cascade.resolution.vocabulary)).toEqual({ reasoning_effort: "high" });

    // A' = ∅（budget-only 的零档行，如 openrouter/anthropic/claude-haiku-4.5）：没有强度档可落
    // → default（不发字段）。**不再拿 minimax/MiniMax-M3 当范例**：2026-10-05 登记开关形状
    // 之后它有 off/on 写点，是开关型、不是零档行。
    const noTiers = resolveThinkingAdjustment({
      presetId: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      level: "off",
      stream: true
    });
    expect(noTiers.availableLevels).toEqual([]);
    expect(noTiers.effectiveLevel).toBe("default");
    expect(openaiVocabularyFields(noTiers.resolution.vocabulary)).toEqual({});
  });

  it("强度档 clamp 仍向下取（preference high、A' = {off,low,medium,xhigh} → medium）", () => {
    const clamped = resolveThinkingAdjustment({ presetId: "qwen", model: "qwen3.8-max", level: "high", stream: true });
    expect(clamped.effectiveLevel).toBe("medium");
    expect(openaiVocabularyFields(clamped.resolution.vocabulary)).toEqual({ reasoning_effort: "medium" });
    expect(clamped.reason).toBe("model-vocabulary");
  });

  it("偏好 default：不报「被调整」（用户没被降档，只是不说话）", () => {
    const r = resolveThinkingAdjustment({ presetId: "qwen", model: "qwen3.8-max", level: "default", stream: true });
    expect(r.effectiveLevel).toBe("default");
    expect(r.reason).toBe(null);
    expect(openaiVocabularyFields(r.resolution.vocabulary)).toEqual({});
    expect(r.resolution.offUnavailable).toBe(false);
  });
});

describe("default 落线 = 空 patch（02 指派表逐行 + 两条通道）", () => {
  it("每一行 × 偏好 default：chat 侧字段为空、Messages 侧出口也为空（工件可重跑）", () => {
    const lines: string[] = [
      "# default 档落线工件（由 tests/ai/thinking-default-level.test.ts 生成）",
      "# 列：preset·model | 偏好=default 的 chat 侧 fields | 过 Messages 出口后的 fields",
      "# 判据：两侧都是 {}（不干预 = 不发任何思考字段）；02 指派表逐行，无例外",
      "# preset\tmodel\tchat_fields\tmessages_fields"
    ];
    let rows = 0;
    for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
      const presetId = PRESET_BY_UPSTREAM[upstreamId];
      expect(presetId, `指派表 provider ${upstreamId} 没有 preset 桥接`).toBeTruthy();
      for (const model of Object.keys(table)) {
        for (const stream of [true, false]) {
          const profile = resolveThinkingProfile({ presetId, model, level: "default", stream });
          expect(openaiVocabularyFields(profile.vocabulary), `${presetId}/${model} · stream=${stream}`).toEqual({});
          const messages = THINKING_WIRE_MAPS.anthropic({
            vocabulary: profile.vocabulary,
            probe: false,
            effortVocabularyOnly: false,
            platformId: presetId
          });
          expect(messages.fields, `${presetId}/${model} · stream=${stream}（Messages）`).toEqual({});
        }
        rows += 1;
        lines.push([presetId, model, "{}", "{}"].join("\t"));
      }
    }
    // 口径自检：循环不许空转（02 产物 359 条指派）。
    expect(rows).toBeGreaterThanOrEqual(359);
    expect(lines.length).toBe(rows + 4);

    const dir = join(process.cwd(), ".scratch", "tickets", "thinking-default-level", "artifacts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-default-empty-bodies.tsv"), `${lines.join("\n")}\n`);
  });
});

describe("出厂 / 重置默认偏好 = default", () => {
  it("DEFAULT_SETTINGS 与初始 chatSessionState 同源写 default", () => {
    expect(DEFAULT_SETTINGS.aiThinkingLevel).toBe("default");
    resetChatSessionStateForTests();
    expect(chatSessionState.aiThinkingLevel).toBe("default");
  });
});
