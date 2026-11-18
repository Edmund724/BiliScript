// tests/ai/thinking-golden-defenses.ts
// 按类 golden 的**断言注册件**：按类 golden 主体 + 四道防线。
// 三条通道（openai chat / anthropic messages / gemini generateContent）共用这一份，
// 避免防线代码各抄一遍；纯数据口径在 thinking-golden-classes.ts（那边不 import vitest，
// 同步脚本也要用）。
//
// 防线清单：
//   F1 覆盖防线   产物新增 valuesetId 而没加用例 → 红（值集表集合 == 用例覆盖集合；
//                 gemini 通道只看自家预设落地的那部分值集）；
//   F2 归纳完整性 某个 (类, 平台) 实现的行为没有同签名用例承载 → 红；
//   F5 表自洽     用例声明的类不是该 (平台, 模型) 实际命中的值集 / A' 与解析结果不符 → 红；
//   F6 塌陷区分   effort 血统 low≠high；开关型与 budget-only 的 low==high 是上游事实 → 两侧都钉。

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

/** golden 主体：每个 (类 × 出口形态) 组合一条用例，内部 7 档逐字节整 body。 */
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

/** 四道防线。 */
export function registerByClassDefenses(harness: ChannelHarness, cases: readonly ByClassCase[]): void {
  const channel = harness.channel;

  // F1 覆盖防线：产物新增类而没加用例即红。
  describe(`07 防线（${channel}）：覆盖`, () => {
    it("golden 覆盖的 valuesetId 集合 == 该通道落地值集（值集表无孤儿）", () => {
      const covered = coveredValuesetIds(cases);
      expect(covered).toEqual(channelValuesetIds(channel));
      // 全平台通道（openai / anthropic）还要与指派表全集对齐；gemini 只落自家预设。
      if (channel !== "gemini") expect(covered).toEqual(assignedValuesetIds());
      expect(allValuesetIds().length).toBeGreaterThan(0);
    });
  });

  // F5 表自洽：类声明与 A' 都必须与 runtime 的解析一致。
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

  // F2 归纳完整性：产物里每个 (类, 平台) 实现的行为都必须有同签名用例承载——
  // 「逐平台 × 档位」的覆盖一行不丢，只是改成按类承载。
  // 一个 (类, 平台) 对取排序首个模型即可：规则只由「值集 × 平台」决定
  // （ruleFor → ruleFromUpstreamFact(fact, providerId)），同平台同类的其它模型行为相同；
  // 「每个模型都等于上游投影」另由 thinking-upstream-facts.test.ts 逐行钉住。
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

  // F6 塌陷区分：effort 血统（有 effort 词表且 low/high 都在 A'）不允许塌陷；
  // 开关型血统与 budget-only（无 effort 词表）的 low==high 是上游唯一支持的形状，不是缺陷。
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
      // gemini 通道的 effort 值集只有 3 类（low-high / low-medium-high / minimal-high）；
      // 其余通道是全平台汇聚，门槛维持原来的体量。
      expect(checked).toBeGreaterThanOrEqual(channel === "gemini" ? 2 : 10);
    });

    it("开关型 / budget-only 血统：low==high 是上游事实（无 effort 词表可发）", () => {
      let checked = 0;
      for (const realization of productRealizationsFor(channel)) {
        if (channel === "anthropic" && MESSAGES_TIER_EXIT[realization.presetId as PlatformKey]?.kind === "non-messages") continue;
        if (VALUESETS[realization.valuesetId]?.effort) continue;
        // 18 号票删平台声明后没有例外平台：toggle 值集只在已登记开关形状的平台上产生
        // 写点（未登记的 → A' = ∅，被下面的 available 判据跳过）。
        const available = availableOf(harness, realization.presetId, realization.model);
        if (!available.includes("low") || !available.includes("high")) continue;
        const low = fieldsAt(harness, realization.presetId, realization.model, "low");
        const high = fieldsAt(harness, realization.presetId, realization.model, "high");
        const label = `${realization.valuesetId} · ${realization.presetId}/${realization.model}`;
        expect(JSON.stringify(low), `${label}：开关型/budget-only 的 low/high 应同为上游唯一形状`).toBe(JSON.stringify(high));
        checked += 1;
      }
      // gemini 没有登记开关形状：toggle / budget-only 值集在 A' 里一个档都不可表达，
      // 上面两条判据会跳过全部实现——本通道这一格是空集，不做体量断言。
      if (channel !== "gemini") expect(checked).toBeGreaterThanOrEqual(5);
    });
  });
}
