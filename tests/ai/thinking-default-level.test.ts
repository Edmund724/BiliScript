import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSIGNMENTS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { chatSessionState, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import {
  AI_THINKING_LEVELS,
  AI_THINKING_LEVEL_VALUES,
    UPSTREAM_PROVIDER_BY_PRESET,
  clampThinkingLevel,
  normalizeThinkingLevel,
  resolveThinkingAdjustment,
  resolveThinkingProfile
} from "../../extension/ai/thinking-profiles.js";
import { THINKING_WIRE_MAPS, openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";

const PRESET_BY_UPSTREAM: Record<string, string> = Object.fromEntries(
  Object.entries(UPSTREAM_PROVIDER_BY_PRESET).map(([presetId, upstreamId]) => [upstreamId, presetId])
);

describe("default 词表分层（不进强度阶梯）", () => {
  it("可选值 = default + 7 档；强度阶梯里没有 default", () => {
    expect([...AI_THINKING_LEVEL_VALUES]).toEqual(["default", ...AI_THINKING_LEVELS]);
    expect((AI_THINKING_LEVELS as readonly string[]).includes("default")).toBe(false);
  });

  it("归一化：8 个可选值原样；缺省 / 脏值回落 default（不干预）", () => {
    expect(normalizeThinkingLevel("default")).toBe("default");
    for (const level of AI_THINKING_LEVELS) {
      expect(normalizeThinkingLevel(level), level).toBe(level);
    }
    for (const bogus of ["none", "Default", "", null, undefined, 7]) {
      expect(normalizeThinkingLevel(bogus), String(bogus)).toBe("default");
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
            platformId: presetId
          });
          expect(messages.fields, `${presetId}/${model} · stream=${stream}（Messages）`).toEqual({});
        }
        rows += 1;
        lines.push([presetId, model, "{}", "{}"].join("\t"));
      }
    }
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
