// scripts/artifacts/gen-golden-tables.ts
// golden 用例表与覆盖工件生成器：把「按类 × 出口形态」的 golden 用例表与覆盖矩阵算出来，
// 字面值来自运行时与 06 请求体矩阵工件（不手抄）。
//
// 输入：02 产物（ASSIGNMENTS / VALUESETS / MODEL_ID_ALIASES）+ thinking-profiles 的解析结果
//       + 06-request-matrix.tsv（gen-request-matrix.ts 跑出的矩阵，只读）。
// 输出：
//   A. .scratch/.../artifacts/07-golden-coverage.tsv —— valuesetId × 通道 × 档位（出口形态）
//      → 用例归属；
//   B. .scratch/.../artifacts/07-golden-cases.generated.ts —— 由 replace-cases.mjs 拼进
//      两个 golden 文件的用例表（生成留痕，便于 diff 审读；两个 golden 文件里的字面表
//      与它逐字一致）。
//
// 对账（生成期硬失败）：每个用例代表行在矩阵工件里必须存在，且 off/low/high 的思考字段
// 逐字节相同——生成器自己先过一遍来源防线，粘进测试的字面表不可能是手抄漂移。
//
// 跑法：pnpm artifacts:sync（编排见 scripts/artifacts/sync.mjs）。

import { writeFileSync } from "node:fs";
import {
  AI_THINKING_LEVELS,
  resolveThinkingAdjustment
} from "../../extension/ai/thinking-profiles.js";
import {
  COVERAGE_HEADER,
  COVERAGE_MATRIX,
  REQUEST_MATRIX,
  baseUrlFor,
  channelHarness,
  coverageRows,
  fieldsSignature,
  productRealizations,
  readRequestMatrix,
  thinkingFragment,
  thinkingFragmentOfCell,
  type ByClassCase,
  type Channel
} from "../../tests/ai/thinking-golden-classes.js";

const LEVELS = ["off", "low", "high"] as const;

/** 产物实现 → 按 (类, 出口形态签名) 归纳的用例：类内按签名首次出现序，代表取首个实现。 */
function buildCases(channel: Channel, matrix: ReturnType<typeof readRequestMatrix>): ByClassCase[] {
  const harness = channelHarness(channel);
  const byClass = new Map<string, ByClassCase[]>();
  const signatures = new Map<string, Set<string>>();
  for (const realization of productRealizations()) {
    const fields = AI_THINKING_LEVELS.map((level) =>
      thinkingFragment(harness.bodyAt({ presetId: realization.presetId, model: realization.model, level }))
    );
    const signature = fieldsSignature(fields);
    if (!signatures.has(realization.valuesetId)) signatures.set(realization.valuesetId, new Set());
    if (signatures.get(realization.valuesetId)!.has(signature)) continue;
    signatures.get(realization.valuesetId)!.add(signature);
    const available = resolveThinkingAdjustment({
      presetId: realization.presetId,
      baseUrl: baseUrlFor(channel, realization.presetId),
      model: realization.model,
      level: "high",
      stream: false
    }).availableLevels;
    if (!byClass.has(realization.valuesetId)) byClass.set(realization.valuesetId, []);
    byClass.get(realization.valuesetId)!.push({
      valuesetId: realization.valuesetId,
      presetId: realization.presetId,
      model: realization.model,
      available: [...available],
      fields
    });
    // 生成期来源对账：矩阵工件（off/low/high 三列）必须与该用例字面片段相同。
    const cells = matrix.rows.get(`${realization.presetId}\u0001${realization.model}`);
    if (!cells) throw new Error(`${realization.presetId}/${realization.model} 不在矩阵工件里`);
    for (const level of LEVELS) {
      const column = matrix.header.indexOf(`${channel}:${level}`);
      if (column < 0) throw new Error(`矩阵缺列 ${channel}:${level}`);
      const actual = JSON.stringify(thinkingFragmentOfCell(cells[column]));
      const expected = JSON.stringify(fields[AI_THINKING_LEVELS.indexOf(level)]);
      if (actual !== expected) {
        throw new Error(
          `来源防线失败：${realization.valuesetId} · ${realization.presetId}/${realization.model} · ${level}\n  矩阵=${actual}\n  用例=${expected}`
        );
      }
    }
  }
  const cases: ByClassCase[] = [];
  for (const valuesetId of [...byClass.keys()].sort()) cases.push(...byClass.get(valuesetId)!);
  return cases;
}

function literalCase(case_: ByClassCase): string {
  const fields = case_.fields.map((fields_) => JSON.stringify(fields_)).join(", ");
  return `  { valuesetId: ${JSON.stringify(case_.valuesetId)}, presetId: ${JSON.stringify(case_.presetId)}, model: ${JSON.stringify(case_.model)}, available: [${case_.available
    .map((level) => JSON.stringify(level))
    .join(", ")}], fields: [${fields}] },`;
}

const matrix = readRequestMatrix(REQUEST_MATRIX);
const casesByChannel: Record<Channel, ByClassCase[]> = {
  openai: buildCases("openai", matrix),
  anthropic: buildCases("anthropic", matrix)
};

// A. 覆盖工件
const coverageLines: string[] = [COVERAGE_HEADER.join("\t")];
for (const channel of ["openai", "anthropic"] as const) coverageLines.push(...coverageRows(channel, casesByChannel[channel]));
writeFileSync(COVERAGE_MATRIX, `${coverageLines.join("\n")}\n`, "utf8");

// B. 用例表留痕
const out: string[] = [];
out.push("// 由 scripts/artifacts/gen-golden-tables.ts 生成（勿手改；两组字面表与两个 golden 文件里的一致）。");
out.push("// fields 序 = AI_THINKING_LEVELS（off/minimal/low/medium/high/xhigh/max），{} = 不发字段。");
for (const channel of ["openai", "anthropic"] as const) {
  out.push("");
  out.push(`// ===== ${channel} 通道：${casesByChannel[channel].length} 个（类 × 出口形态）用例 =====`);
  out.push("const CASES: readonly ByClassCase[] = [");
  for (const case_ of casesByChannel[channel]) out.push(literalCase(case_));
  out.push("];");
}
writeFileSync(COVERAGE_MATRIX.replace("07-golden-coverage.tsv", "07-golden-cases.generated.ts"), `${out.join("\n")}\n`, "utf8");

console.log(`矩阵工件行数: ${matrix.rows.size}`);
for (const channel of ["openai", "anthropic"] as const) {
  const cases = casesByChannel[channel];
  console.log(`${channel}: 类数 ${new Set(cases.map((c) => c.valuesetId)).size}，用例数 ${cases.length}`);
}
console.log(`07-golden-coverage.tsv: ${coverageLines.length - 1} 行`);
