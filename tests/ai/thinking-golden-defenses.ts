// tests/ai/thinking-golden-defenses.ts
// 07 号票（golden 按类重构）的**断言注册件**：按类 golden 主体 + 六道防线。
// 两条通道（openai chat / anthropic messages）共用这一份，避免防线代码各抄一遍；
// 纯数据口径在 thinking-golden-classes.ts（那边不 import vitest，生成器也要用）。
//
// 防线清单（票面「先列失败方式」的对应）：
//   F1 覆盖防线   产物新增 valuesetId 而没加用例 → 红（值集表集合 == 用例覆盖集合）；
//   F2 归纳完整性 某个 (类, 平台) 实现的行为没有同签名用例承载 → 红；
//   F3 来源防线   用例数据与 06 请求体矩阵工件（371 行）不一致（runtime 漂移 / 手抄漂移）→ 红；
//   F4 验收工件   07-golden-coverage.tsv 的（valuesetId × 通道 × 档位出口形态 → 用例）不符 → 红；
//   F5 表自洽     用例声明的类不是该 (平台, 模型) 实际命中的值集 / A' 与解析结果不符 → 红；
//   F6 塌陷区分   effort 血统 low≠high；开关型与 budget-only 的 low==high 是上游事实 → 两侧都钉。
// 工件缺失时跳过对账：判定读 tests/helpers/artifacts.ts 的登记表（缺席状态由
// tests/ai/artifact-preflight.test.ts 显式报出），同 thinking-chips.test.ts /
// models-dev-catalog-check.test.ts 先例。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasArtifact } from "../helpers/artifacts.js";
import { VALUESETS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { AI_THINKING_LEVELS, UPSTREAM_PROVIDER_BY_PRESET, resolveThinkingAdjustment, type ThinkingLevel } from "../../extension/ai/thinking-profiles.js";
import {
  COVERAGE_HEADER,
  COVERAGE_MATRIX,
  REQUEST_MATRIX,
  allValuesetIds,
  assignedValuesetIds,
  baseUrlFor,
  coverageRows,
  coveredValuesetIds,
  exitFormOf,
  fieldsSignature,
  productRealizations,
  readRequestMatrix,
  thinkingFragment,
  thinkingFragmentOfCell,
  valuesetOf,
  type ByClassCase,
  type Channel,
  type ChannelHarness
} from "./thinking-golden-classes.js";

function fieldsAt(harness: ChannelHarness, presetId: string, model: string, level: ThinkingLevel): Record<string, unknown> {
  return thinkingFragment(harness.bodyAt({ presetId, model, level }));
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

/** 六道防线。 */
export function registerByClassDefenses(harness: ChannelHarness, cases: readonly ByClassCase[]): void {
  const channel = harness.channel;

  // F1 覆盖防线：产物新增类而没加用例即红。
  describe(`07 防线（${channel}）：覆盖`, () => {
    it("golden 覆盖的 valuesetId 集合 == 02 产物全部值集（值集表无孤儿）", () => {
      const covered = coveredValuesetIds(cases);
      expect(covered).toEqual(allValuesetIds());
      expect(covered).toEqual(assignedValuesetIds());
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
      const keys = new Set(productRealizations().map((r) => `${r.valuesetId}\u0001${r.presetId}\u0001${r.model}`));
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
      const realizations = productRealizations();
      expect(realizations.length).toBeGreaterThanOrEqual(80);
      for (const realization of realizations) {
        const actual = AI_THINKING_LEVELS.map((level) => fieldsAt(harness, realization.presetId, realization.model, level));
        const label = `${realization.valuesetId} · ${realization.presetId}/${realization.model}`;
        expect(signatures.get(realization.valuesetId)?.has(fieldsSignature(actual)), `${label}：${fieldsSignature(actual)}`).toBe(true);
      }
    });
  });

  // F3 来源防线：用例数据 == 06 请求体矩阵工件（371 行，04-prune-matrix.ts 产物，只读）。
  // 工件只含 off/low/high 三列——余下 4 档由用例字面 + 02 上游投影用例（thinking-upstream-facts）承接。
  describe.skipIf(!hasArtifact(REQUEST_MATRIX))(`07 防线（${channel}）：来源（06 请求体矩阵工件）`, () => {
    it("每条用例的代表行都在矩阵里，且 off/low/high 的思考字段逐字节相同", () => {
      const matrix = readRequestMatrix(REQUEST_MATRIX);
      expect(matrix.rows.size).toBeGreaterThanOrEqual(370);
      let compared = 0;
      for (const case_ of cases) {
        const cells = matrix.rows.get(`${case_.presetId}\u0001${case_.model}`);
        expect(cells, `${case_.presetId}/${case_.model} 不在矩阵工件里`).toBeTruthy();
        for (const level of ["off", "low", "high"] as const) {
          const column = matrix.header.indexOf(`${channel}:${level}`);
          expect(column, `矩阵缺列 ${channel}:${level}`).toBeGreaterThanOrEqual(0);
          expect(thinkingFragmentOfCell(cells![column]), `${case_.valuesetId} · ${case_.presetId}/${case_.model} · ${level}`).toEqual(
            case_.fields[AI_THINKING_LEVELS.indexOf(level)]
          );
          compared += 1;
        }
      }
      expect(compared).toBe(cases.length * 3);
    });
  });

  // F4 验收工件：07-golden-coverage.tsv = valuesetId × 通道 × 档位（出口形态）→ 用例归属。
  describe.skipIf(!hasArtifact(COVERAGE_MATRIX))(`07 防线（${channel}）：验收工件 07-golden-coverage.tsv`, () => {
    it("工件行 == 用例表逐档推导的覆盖矩阵", () => {
      const lines = readFileSync(COVERAGE_MATRIX, "utf8").split("\n").filter((line) => line.length > 0);
      expect(lines[0].split("\t")).toEqual([...COVERAGE_HEADER]);
      const all = lines.slice(1);
      // 通道列只有两条通道（防止工件多出第三条通道却无人对账——每个文件只看自己那半）。
      expect([...new Set(all.map((line) => line.split("\t")[1]))].sort()).toEqual(["anthropic", "openai"]);
      expect(all.filter((line) => line.split("\t")[1] === channel)).toEqual(coverageRows(channel, cases));
    });
  });

  // F6 塌陷区分：effort 血统（有 effort 词表且 low/high 都在 A'）不允许塌陷；
  // 开关型血统与 budget-only（无 effort 词表）的 low==high 是上游唯一支持的形状，不是缺陷。
  describe(`07 防线（${channel}）：塌陷区分`, () => {
    it("effort 血统：low/high 都在 A' 时请求体必须不同（不允许塌陷）", () => {
      let checked = 0;
      for (const realization of productRealizations()) {
        if (!VALUESETS[realization.valuesetId]?.effort) continue;
        const available = availableOf(harness, realization.presetId, realization.model);
        if (!available.includes("low") || !available.includes("high")) continue;
        const low = fieldsAt(harness, realization.presetId, realization.model, "low");
        const high = fieldsAt(harness, realization.presetId, realization.model, "high");
        const label = `${realization.valuesetId} · ${realization.presetId}/${realization.model}`;
        expect(JSON.stringify(low), `${label}：effort 血统塌陷（low 与 high 同落 ${exitFormOf(low)}）`).not.toBe(JSON.stringify(high));
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(10);
    });

    it("开关型 / budget-only 血统：low==high 是上游事实（无 effort 词表可发）", () => {
      let checked = 0;
      for (const realization of productRealizations()) {
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
      expect(checked).toBeGreaterThanOrEqual(5);
    });
  });
}
