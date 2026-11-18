// scripts/sync-thinking-golden.mjs
// 同步三条协议通道按类 golden 用例表（pnpm catalog:sync:golden）。
// 因包为 CommonJS，这里用 esbuild 将 scripts/sync-thinking-golden.ts 现场打进临时目录后执行，
// 结束后立即清理临时文件，不在仓库或 .scratch/ 留下中间产物。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(tmpdir(), "sync-thinking-golden-"));
const bundle = path.join(tempDir, "sync-thinking-golden.mjs");

try {
  buildSync({
    entryPoints: [path.join(rootDir, "scripts/sync-thinking-golden.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [bundle], {
    cwd: rootDir,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
