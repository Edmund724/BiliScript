import { describe, expect, it } from "vitest";
import { VALUESETS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { AI_THINKING_LEVELS, UPSTREAM_PROVIDER_BY_PRESET, resolveThinkingAdjustment, type ThinkingLevel } from "../../extension/ai/thinking-profiles.js";
import { MESSAGES_TIER_EXIT } from "../../extension/ai/thinking-wire-map.js";
import type { PlatformKey } from "../../extension/ai/platform-identity-vocab.js";
import {
  allValuesetIds,
  assignedValuesetIds,
  baseUrlFor,
  channelValuesetIds,
  coveredValuesetIds,
  exitFormOf,
  fieldsSignature,
  productRealizationsFor,
  valuesetOf,
  type ByClassCase,
  type Channel,
  type ChannelHarness
} from "./thinking-golden-classes.js";

function fieldsAt(harness: ChannelHarness, presetId: string, model: string, level: ThinkingLevel): Record<string, unknown> {
  return harness.fragmentOf(harness.bodyAt({ presetId, model, level }));
}

function availableOf(harness: ChannelHarness, presetId: string, model: string): readonly ThinkingLevel[] {
  return resolveThinkingAdjustment({
    presetId,
    baseUrl: baseUrlFor(harness.channel, presetId),
    model,
    level: "high",
    stream: false
  }).availableLevels;
}

export function registerByClassGolden(harness: ChannelHarness, cases: readonly ByClassCase[]): void {
  describe(`golden（${harness.channel}）：按类 × 出口形态 → 请求体（${cases.length} 个类实现）`, () => {
    for (const case_ of cases) {
      const forms = AI_THINKING_LEVELS.map((level) => exitFormOf(case_.fields[AI_THINKING_LEVELS.indexOf(level)]));
      it(`${case_.valuesetId} · ${case_.presetId}/${case_.model}（A'=${case_.available.join(",") || "∅"}）`, () => {
        expect(case_.fields.length, "用例必须有 7 档片段").toBe(AI_THINKING_LEVELS.length);
        for (const [index, level] of AI_THINKING_LEVELS.entries()) {
          const label = `${case_.valuesetId} · ${level} · 出口形态 ${forms[index]}（${case_.presetId}/${case_.model}）`;
          expect(harness.bodyAt({ presetId: case_.presetId, model: case_.model, level }), label).toEqual(
            harness.expectedBody(case_.model, case_.fields[index])
          );
        }
      });
    }
  });
}

export function registerByClassDefenses(harness: ChannelHarness, cases: readonly ByClassCase[]): void {
  const channel = harness.channel;

  describe(`07 防线（${channel}）：覆盖`, () => {
    it("golden 覆盖的 valuesetId 集合 == 该通道落地值集（值集表无孤儿）", () => {
      const covered = coveredValuesetIds(cases);
      expect(covered).toEqual(channelValuesetIds(channel));
      if (channel !== "gemini") expect(covered).toEqual(assignedValuesetIds());
      expect(allValuesetIds().length).toBeGreaterThan(0);
    });
  });

  describe(`07 防线（${channel}）：用例表自洽`, () => {
    it("每条用例的 valuesetId == 指派表命中值集，available == resolver 的 A'", () => {
      for (const case_ of cases) {
        const upstreamId = UPSTREAM_PROVIDER_BY_PRESET[case_.presetId];
        expect(upstreamId, `${case_.presetId} 不在 preset→上游桥接表`).toBeTruthy();
        expect(valuesetOf(upstreamId, case_.model), `${case_.presetId}/${case_.model}`).toBe(case_.valuesetId);
        expect([...availableOf(harness, case_.presetId, case_.model)], `${case_.valuesetId} · ${case_.presetId}/${case_.model}`).toEqual([
          ...case_.available
        ]);
      }
    });

    it("用例代表模型都是产物实现（不是手挑的编外 id）", () => {
      const keys = new Set(productRealizationsFor(channel).map((r) => `${r.valuesetId}\u0001${r.presetId}\u0001${r.model}`));
      for (const case_ of cases) {
        expect(keys.has(`${case_.valuesetId}\u0001${case_.presetId}\u0001${case_.model}`), `${case_.valuesetId} · ${case_.presetId}/${case_.model}`).toBe(true);
      }
    });
  });

  describe(`07 防线（${channel}）：归纳完整性`, () => {
    it("每个产物实现（类 × 平台）的 7 档行为都有同签名用例承载", () => {
      const signatures = new Map<string, Set<string>>();
      for (const case_ of cases) {
        if (!signatures.has(case_.valuesetId)) signatures.set(case_.valuesetId, new Set());
        signatures.get(case_.valuesetId)!.add(fieldsSignature(case_.fields));
      }
      const realizations = productRealizationsFor(channel).filter((r) => {
        if (channel === "anthropic") {
          return MESSAGES_TIER_EXIT[r.presetId as PlatformKey]?.kind !== "non-messages";
        }
        return true;
      });
      expect(realizations.length, `${channel} 通道实现数过少`).toBeGreaterThanOrEqual(channel === "gemini" ? 5 : 80);
      for (const realization of realizations) {
        const actual = AI_THINKING_LEVELS.map((level) => fieldsAt(harness, realization.presetId, realization.model, level));
        const label = `${realization.valuesetId} · ${realization.presetId}/${realization.model}`;
        expect(signatures.get(realization.valuesetId)?.has(fieldsSignature(actual)), `${label}：${fieldsSignature(actual)}`).toBe(true);
      }
    });
  });

  describe(`07 防线（${channel}）：塌陷区分`, () => {
    it("effort 血统：low/high 都在 A' 时请求体必须不同（不允许塌陷）", () => {
      let checked = 0;
      for (const realization of productRealizationsFor(channel)) {
        if (channel === "anthropic" && MESSAGES_TIER_EXIT[realization.presetId as PlatformKey]?.kind === "non-messages") continue;
        if (!VALUESETS[realization.valuesetId]?.effort) continue;
        const available = availableOf(harness, realization.presetId, realization.model);
        if (!available.includes("low") || !available.includes("high")) continue;
        const low = fieldsAt(harness, realization.presetId, realization.model, "low");
        const high = fieldsAt(harness, realization.presetId, realization.model, "high");
        const label = `${realization.valuesetId} · ${realization.presetId}/${realization.model}`;
        expect(JSON.stringify(low), `${label}：effort 血统塌陷（low 与 high 同落 ${exitFormOf(low)}）`).not.toBe(JSON.stringify(high));
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(channel === "gemini" ? 2 : 10);
    });

    it("开关型 / budget-only 血统：low==high 是上游事实（无 effort 词表可发）", () => {
      let checked = 0;
      for (const realization of productRealizationsFor(channel)) {
        if (channel === "anthropic" && MESSAGES_TIER_EXIT[realization.presetId as PlatformKey]?.kind === "non-messages") continue;
        if (VALUESETS[realization.valuesetId]?.effort) continue;
        const available = availableOf(harness, realization.presetId, realization.model);
        if (!available.includes("low") || !available.includes("high")) continue;
        const low = fieldsAt(harness, realization.presetId, realization.model, "low");
        const high = fieldsAt(harness, realization.presetId, realization.model, "high");
        const label = `${realization.valuesetId} · ${realization.presetId}/${realization.model}`;
        expect(JSON.stringify(low), `${label}：开关型/budget-only 的 low/high 应同为上游唯一形状`).toBe(JSON.stringify(high));
        checked += 1;
      }
      if (channel !== "gemini") expect(checked).toBeGreaterThanOrEqual(5);
    });
  });
}
