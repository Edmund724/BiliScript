#!/usr/bin/env node

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

if (name === "--list" || name === "-l") {
  for (const scenario of scenarios) console.log(scenario);
  process.exit(0);
}

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
