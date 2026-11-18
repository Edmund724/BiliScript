// scripts/sync-thinking-golden.ts
// 同步三条协议通道的按类 golden 用例表：
// 从运行时（thinking-golden-classes.ts 的 productRealizationsFor + channelHarness +
// resolveThinkingAdjustment）直接算出 `CASES` 字面表，并原地写回三个 golden 测试文件。
//
// 跑法：pnpm catalog:sync:golden（由 scripts/sync-thinking-golden.mjs 经 esbuild 打包运行）。

import { readFileSync, writeFileSync } from "node:fs";
import { AI_THINKING_LEVELS, resolveThinkingAdjustment } from "../extension/ai/thinking-profiles.js";
import {
  baseUrlFor,
  channelHarness,
  fieldsSignature,
  productRealizationsFor,
  type ByClassCase,
  type Channel
} from "../tests/ai/thinking-golden-classes.js";

const TARGETS: ReadonlyArray<{ readonly path: string; readonly channel: Channel }> = [
  { path: "tests/ai/thinking-golden.test.ts", channel: "openai" },
  { path: "tests/ai/thinking-golden-messages.test.ts", channel: "anthropic" },
  { path: "tests/ai/thinking-golden-gemini.test.ts", channel: "gemini" }
];

const CASES_START = "const CASES: readonly ByClassCase[] = [";

/** 按 (值集类, 出口形态签名) 归纳该通道全部产物实现的代表用例。 */
function buildCases(channel: Channel): ByClassCase[] {
  const harness = channelHarness(channel);
  const byClass = new Map<string, ByClassCase[]>();
  const signatures = new Map<string, Set<string>>();

  for (const realization of productRealizationsFor(channel)) {
    const fields = AI_THINKING_LEVELS.map((level) =>
      harness.fragmentOf(harness.bodyAt({ presetId: realization.presetId, model: realization.model, level }))
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
  }

  const cases: ByClassCase[] = [];
  for (const valuesetId of [...byClass.keys()].sort()) {
    cases.push(...byClass.get(valuesetId)!);
  }
  return cases;
}

function formatCaseLine(case_: ByClassCase): string {
  const fields = case_.fields.map((fields_) => JSON.stringify(fields_)).join(", ");
  const available = case_.available.map((level) => JSON.stringify(level)).join(", ");
  return `  { valuesetId: ${JSON.stringify(case_.valuesetId)}, presetId: ${JSON.stringify(case_.presetId)}, model: ${JSON.stringify(case_.model)}, available: [${available}], fields: [${fields}] },`;
}

function formatCasesBlock(cases: readonly ByClassCase[]): string[] {
  return [CASES_START, ...cases.map(formatCaseLine), "];"];
}

function replaceCasesInFile(filePath: string, cases: readonly ByClassCase[]): { prev: number; next: number } {
  const text = readFileSync(filePath, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((line) => line.startsWith(CASES_START));
  if (open < 0) {
    throw new Error(`${filePath}: 未找到 "${CASES_START}"`);
  }
  const close = lines.findIndex((line, index) => index > open && line === "];");
  if (close < 0) {
    throw new Error(`${filePath}: CASES 块缺少闭合 "];"`);
  }
  const fresh = formatCasesBlock(cases);
  const updated = [...lines.slice(0, open), ...fresh, ...lines.slice(close + 1)];
  writeFileSync(filePath, updated.join(eol), "utf8");
  return { prev: close - open - 1, next: cases.length };
}

for (const target of TARGETS) {
  const cases = buildCases(target.channel);
  const classCount = new Set(cases.map((case_) => case_.valuesetId)).size;
  const { prev, next } = replaceCasesInFile(target.path, cases);
  console.log(`${target.path} (${target.channel}): ${classCount} 类, ${prev} → ${next} 条用例`);
}
