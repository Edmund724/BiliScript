// scripts/artifacts/gen-matrix-cells.ts
// 请求矩阵 before/after 的逐格 diff 清单：每行一个变化格——platform / model / 列名 /
// before / after / 该格偏好档的 clamp 轨迹（源档 → 实发档 + 原因）。
//
// 输入：
//   06-request-matrix.before.tsv —— 06 号票改造前的历史快照，冻结输入，不由本链路重新生成；
//   06-request-matrix.tsv        —— gen-request-matrix.ts 的当前产物。
// 输出：.scratch/tickets/upstream-model-facts/artifacts/06-request-matrix.cells.tsv
//
// 跑法：pnpm artifacts:sync（编排见 scripts/artifacts/sync.mjs）。

import { readFileSync, writeFileSync } from "node:fs";
import { resolveThinkingAdjustment } from "../../extension/ai/thinking-profiles.js";

const ARTIFACTS = ".scratch/tickets/upstream-model-facts/artifacts";
const BEFORE = `${ARTIFACTS}/06-request-matrix.before.tsv`;
const AFTER = `${ARTIFACTS}/06-request-matrix.tsv`;
const OUT = `${ARTIFACTS}/06-request-matrix.cells.tsv`;

function readMatrix(path: string): { header: string[]; rows: Map<string, string[]> } {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  const header = lines[0].split("\t");
  const rows = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    rows.set(`${cells[0]}\u0001${cells[1]}`, cells);
  }
  return { header, rows };
}

const before = readMatrix(BEFORE);
const after = readMatrix(AFTER);

interface Cell {
  platform: string;
  model: string;
  column: string;
  before: string;
  after: string;
  trace: string;
}

const cells: Cell[] = [];
for (const [key, afterCells] of after.rows) {
  const beforeCells = before.rows.get(key);
  if (!beforeCells) continue;
  const [platform, model] = key.split("\u0001");
  for (let index = 2; index < after.header.length; index += 1) {
    const column = after.header[index];
    if (beforeCells[index] === afterCells[index]) continue;
    // 轨迹：该列对应哪一档偏好（body/res 列名都带档位后缀）。
    const level = column.slice(column.lastIndexOf(":") + 1);
    const adjustment = resolveThinkingAdjustment({ presetId: platform, model, level, stream: false });
    const trace = `偏好 ${adjustment.requestedLevel} → 实发 ${adjustment.effectiveLevel ?? "(不发)"}｜A'={${adjustment.availableLevels.join(",") || "∅"}}｜原因=${adjustment.reason ?? "-"}`;
    cells.push({ platform, model, column, before: beforeCells[index], after: afterCells[index], trace });
  }
}

const HEADER = ["platform", "model", "column", "before", "after", "trace"];
const lines = [HEADER.join("\t")];
for (const cell of cells) {
  lines.push([cell.platform, cell.model, cell.column, cell.before, cell.after, cell.trace].join("\t"));
}
writeFileSync(OUT, `${lines.join("\n")}\n`, "utf8");

const byModel = new Map<string, number>();
for (const cell of cells) {
  byModel.set(`${cell.platform}/${cell.model}`, (byModel.get(`${cell.platform}/${cell.model}`) ?? 0) + 1);
}
console.log(`06-request-matrix.cells.tsv: ${cells.length} 个变化格 / ${byModel.size} 行模型`);
for (const [model, count] of [...byModel].sort()) {
  console.log(`  ${count}\t${model}`);
}
