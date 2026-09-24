// escapeRegExp 双份实现的同步守卫（02 复制粘贴收口）。
//
// 为什么不用单份共享模块：两份分处两个不可互引的世界——
//   - extension/ 是 ESM + TS，scripts/build-content.js 的 localImportGuard 禁止
//     它的相对 import 越出 extension/；
//   - scripts/build.js 是 CommonJS Node 脚本（require），从不引入 extension/。
// 因此保留两处物理副本，由本测试锁死「实现必须逐字相同」：任一侧单独改动
// （换字符类、换替换串）即红，防漂移强度等价于单份实现。
//
// 比对方式：抽出函数体里的 return 语句，把接收者标识符统一成一个占位名后
// 比对文本——只压行尾空白，不做 token 级解析，字面差异一律现形。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SITES = ["extension/ai/thinking-profiles.ts", "scripts/build.js"];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

// 取 escapeRegExp 函数体的 return 语句，接收者标识符归一为 v。
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
