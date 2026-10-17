// scripts/artifacts/sync.mjs
// 工件同步入口：一条命令从仓库根重跑 06/07 来源对账工件链（pnpm artifacts:sync）。
//
// 链（顺序即依赖序，任一步失败即停）：
//   1. gen-request-matrix.ts  → 06-request-matrix.tsv（请求体矩阵）
//   2. gen-chip-source.ts     → 06-chip-source.tsv / 06-chip-sets.tsv / 06-chip-changes.tsv
//   3. gen-matrix-cells.ts    → 06-request-matrix.cells.tsv（before 是冻结输入，不重生成）
//   4. gen-golden-tables.ts   → 07-golden-coverage.tsv / 07-golden-cases.generated.ts
//   5. replace-cases.mjs      → 把最新 CASES 字面表拼回两个 golden 测试文件
//
// TS 生成器用 esbuild 现场 bundle 到 node_modules/.artifacts-sync/（一次性构建产物，
// 不进库；.scratch 只留工件输出）。preset → 上游 provider 映射由
// scripts/models-dev-upstream-providers.mjs 单源提供，漏配 catalogProvider 在生成期直接报错。
//
// 冻结输入（不由本链生成，缺席即报错）：
//   .scratch/tickets/upstream-model-facts/artifacts/02-valueset-matrix.tsv
//   .scratch/tickets/upstream-model-facts/artifacts/06-request-matrix.before.tsv

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACTS = ".scratch/tickets/upstream-model-facts/artifacts";
const BUNDLES = path.join(rootDir, "node_modules/.artifacts-sync");

const FROZEN_INPUTS = [`${ARTIFACTS}/02-valueset-matrix.tsv`, `${ARTIFACTS}/06-request-matrix.before.tsv`];
for (const input of FROZEN_INPUTS) {
  if (!existsSync(path.join(rootDir, input))) {
    console.error(`artifacts:sync: 冻结输入缺席：${input} —— 它是 01/02 同步链的产物，不由本链生成。`);
    process.exit(1);
  }
}

mkdirSync(BUNDLES, { recursive: true });

function runTs(name, args = []) {
  const bundle = path.join(BUNDLES, `${name}.mjs`);
  buildSync({
    entryPoints: [path.join(rootDir, "scripts/artifacts", `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [bundle, ...args], {
    cwd: rootDir,
    stdio: "inherit",
    // bundle 里 import.meta.url 锚点失效：单源模块靠这个变量找仓库根。
    env: { ...process.env, BILISCRIPT_REPO_ROOT: rootDir }
  });
  if (result.status !== 0) {
    console.error(`artifacts:sync: ${name} 失败（退出码 ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

function runJs(name) {
  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts/artifacts", name)], {
    cwd: rootDir,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    console.error(`artifacts:sync: ${name} 失败（退出码 ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

runTs("gen-request-matrix", ["--out", `${ARTIFACTS}/06-request-matrix.tsv`]);
runTs("gen-chip-source");
runTs("gen-matrix-cells");
runTs("gen-golden-tables");
runJs("replace-cases.mjs");

console.log("artifacts:sync: 完成（06/07 工件已重跑，CASES 表已拼回 golden 文件）");
