import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SITES = ["extension/ai/thinking-profiles.ts", "scripts/build.js"];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function normalizedBody(rel: string): string {
  const source = read(rel);
  const match = /function\s+escapeRegExp\s*\(\s*([A-Za-z_$][\w$]*)/.exec(source);
  expect(match, `${rel} 未找到 escapeRegExp 声明`).not.toBe(null);
  const param = (match as RegExpExecArray)[1];
  const body = /function\s+escapeRegExp\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*([\s\S]*?)\n\}/.exec(source);
  expect(body, `${rel} 未取到 escapeRegExp 函数体`).not.toBe(null);
  return (body as RegExpExecArray)[1]
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim()
    .replace(new RegExp(`\\b${param}\\b`), "v");
}

describe("escapeRegExp 双份实现同步守卫", () => {
  it("两处都仍有实现（删除任一侧即红）", () => {
    for (const rel of SITES) {
      expect(normalizedBody(rel).length, `${rel} 的实现为空`).toBeGreaterThan(0);
    }
  });

  it("extension 侧与 build 脚本侧实现逐字一致", () => {
    const [extensionBody, buildBody] = SITES.map(normalizedBody);
    expect(buildBody).toBe(extensionBody);
  });
});
