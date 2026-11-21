import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function readSource(relativePath: string) {
  const jsUrl = new URL(relativePath, import.meta.url);
  const url = existsSync(fileURLToPath(jsUrl))
    ? jsUrl
    : new URL(relativePath.replace(/\.js$/, ".ts"), import.meta.url);
  return stripComments(readFileSync(fileURLToPath(url), "utf8"));
}

function listExtensionSources() {
  const relativeRoot = "../../extension";
  const root = fileURLToPath(new URL(relativeRoot, import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|js)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

describe("host 权限代申请：单一实现", () => {
  it("requestProviderOriginsViaBackground 只在 core/host-permissions.ts 定义（ui/ 的重复实现已退役）", () => {
    const core = readSource("../../extension/core/host-permissions.js");
    expect(core).toContain("export async function requestProviderOriginsViaBackground(");
    for (const file of listExtensionSources()) {
      if (file.endsWith("/core/host-permissions.ts") || file.endsWith("/core/host-permissions.js")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      expect(
        /function requestProviderOriginsViaBackground\s*\(/.test(source),
        `requestProviderOriginsViaBackground 不得在他处重复定义：${file}`
      ).toBe(false);
    }
  });
});

describe("调用方手势同步链（调用前零先行 await）", () => {
  it("model-picker 下拉箭头 click：函数体开头到权限申请调用之间没有先行 await", () => {
    const source = readSource("../../extension/ui/model-picker.js");
    const start = source.indexOf('.addEventListener("click", async');
    const request = source.indexOf("requestProviderOriginsViaBackground(", start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);

    const prefix = source.slice(start, request);
    expect(/(?:^|[\s(=])await\s*$/.test(prefix), "requestProviderOriginsViaBackground 应被直接 await").toBe(true);
    const before = prefix.replace(/\s*await\s*$/, "");
    expect(before.match(/\bawait\b/g) || [], "申请权限之前不得有先行 await").toEqual([]);
  });
});

describe("SW 处理器零 await（手势经 runtime 消息传导的最后一环）", () => {
  it("handleRequestProviderOrigins：入口到 permissions.request 之间零 await", () => {
    const source = readSource("../../extension/core/host-permission-handlers.js");
    const start = source.indexOf("function handleRequestProviderOrigins(");
    const request = source.indexOf(".request({ origins })", start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);

    const prefix = source.slice(start, request);
    expect(prefix.match(/\bawait\b/g) || [], "SW 处理器在申请权限前不得有 await").toEqual([]);
  });
});

