#!/usr/bin/env node
// 真机场景分发器：`pnpm harness:scenario <name> [-- <场景自己的参数>]`。
//
// 场景是一个个独立的 .mjs（scripts/browser-harness/scenarios/<name>.mjs），自己起浏览器、
// 自己断言、自己收摊；本文件只做「名字 → 文件」的映射与退出码透传，不 import 任何场景
// （每个场景的进程边界因此是干净的：argv、退出码、Ctrl-C 都直通）。
//
//   pnpm harness:scenario --list
//   pnpm harness:scenario bilingual-subtitles -- --fixture-only
//   pnpm harness:scenario bilingual-subtitles -- --headed
//
// `--` 之后的参数原样交给场景；退出码原样返回（非零 = 有 FAIL 断言）。

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(HERE, "scenarios");

function listScenarios() {
  if (!existsSync(SCENARIO_DIR)) return [];
  return readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => path.basename(file, ".mjs"))
    .sort();
}

const argv = process.argv.slice(2);
const name = argv[0];
const scenarios = listScenarios();

if (!name || name.startsWith("-")) {
  console.error("用法：pnpm harness:scenario <name> [-- <场景参数>]");
  console.error(`可用场景（${scenarios.length}）：${scenarios.join(", ") || "（无）"}`);
  process.exit(1);
}

const file = path.join(SCENARIO_DIR, `${name}.mjs`);
if (!existsSync(file)) {
  console.error(`没有这个场景：${name}`);
  console.error(`可用场景（${scenarios.length}）：${scenarios.join(", ") || "（无）"}`);
  process.exit(1);
}

const child = spawn(process.execPath, [file, ...argv.slice(1)], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`起不来场景 ${name}：${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
