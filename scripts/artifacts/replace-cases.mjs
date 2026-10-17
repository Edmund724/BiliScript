// scripts/artifacts/replace-cases.mjs
// 用 07-golden-cases.generated.ts 的最新字面表，替换两个 golden 测试文件里的 CASES 块。
// 跑法：pnpm artifacts:sync（编排见 scripts/artifacts/sync.mjs）；单跑：node scripts/artifacts/replace-cases.mjs
import { readFileSync, writeFileSync } from "node:fs";

const A = ".scratch/tickets/upstream-model-facts/artifacts";
const generated = readFileSync(`${A}/07-golden-cases.generated.ts`, "utf8").split("\n");

function block(channel) {
  const start = generated.findIndex((line) => line.includes(`===== ${channel} 通道`));
  const open = generated.findIndex((line, index) => index > start && line.startsWith("const CASES"));
  const close = generated.findIndex((line, index) => index > open && line === "];");
  return generated.slice(open, close + 1);
}

const targets = [
  ["tests/ai/thinking-golden.test.ts", "openai"],
  ["tests/ai/thinking-golden-messages.test.ts", "anthropic"]
];

for (const [path, channel] of targets) {
  // Windows 工作副本是 CRLF：按 \r?\n 切分、按原样 EOL 回写（否则 `line === "];"` 永远不成立，
  // 且拼接后文件会混入 LF 行）。
  const text = readFileSync(path, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((line) => line.startsWith("const CASES: readonly ByClassCase[] = ["));
  if (open < 0) {
    console.log(`${path}: 没找到 CASES 块，跳过`);
    continue;
  }
  const close = lines.findIndex((line, index) => index > open && line === "];");
  if (close < 0) {
    console.log(`${path}: CASES 块没有闭合，跳过`);
    continue;
  }
  const fresh = block(channel).map((line) => line.replace(/\r$/, ""));
  const next = [...lines.slice(0, open), ...fresh, ...lines.slice(close + 1)];
  writeFileSync(path, next.join(eol), "utf8");
  console.log(`${path}: 旧 ${close - open - 1} 条 → 新 ${fresh.length - 2} 条`);
}
