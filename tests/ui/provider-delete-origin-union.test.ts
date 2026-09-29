// settings-panel 删除路径的 orphan origin 并集来源锁定。
//
// 失效模式（架构评审候选 3 第 0 步）：「origin 由哪些族共用」这条知识散在两处
// 函数体里写死（deleteFromEditor / revokeOriginOnDelete 各拼一次 ai+asr）。
// 分派表 PROVIDER_FAMILY_UI 会提示新增一族，这两处不会——静默漏回收权限。
// 修复后并集只从分派表推导（optionalHostPermission 的族），本文件锁定：
// 1. 两处删除路径的函数体不得再点 loadAiProviders / loadAsrProviders 的名；
// 2. 并集推导必须按 optionalHostPermission 过滤，且不得取反（取反会把静态
//    host 权限的搜索族拉进回收，错收用户仍需要的搜索域权限）；
// 3. 搜索删除路径仍走 optionalHostPermission 分支外（不回收）。
//
// deleteFromEditor / revokeOriginOnDelete 均不导出，且回收判定依赖
// chrome.permissions（jsdom 只有 mock），照 options-save-gesture.test.ts 的
// 先例直接扫源码。断言只认结构、不认变量名/文案，改注释换字段名都不该红。

import { existsSync, readFileSync } from "node:fs";
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

// 取函数体（到第一个顶格右花括号为止，与 options-save-gesture 同款口径）
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `找不到函数：${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `找不到函数体结尾：${signature}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("orphan origin 并集只从分派表推导", () => {
  const source = readSource("../../extension/ui/settings-panel.js");

  it("deleteFromEditor：函数体不点 ai/asr 名，并集经共享 helper", () => {
    const body = functionBody(source, "async function deleteFromEditor(");
    expect(body).not.toContain("loadAiProviders");
    expect(body).not.toContain("loadAsrProviders");
    expect(body).toContain("loadOriginSharingProviders(");
  });

  it("revokeOriginOnDelete：函数体不点 ai/asr 名，并集经共享 helper", () => {
    const revoke = source.indexOf("const revokeOriginOnDelete = async");
    expect(revoke).toBeGreaterThan(-1);
    const end = source.indexOf("\n  };", revoke);
    expect(end).toBeGreaterThan(revoke);
    const body = source.slice(revoke, end);
    expect(body).not.toContain("loadAiProviders");
    expect(body).not.toContain("loadAsrProviders");
    expect(body).toContain("loadOriginSharingProviders(");
  });

  it("helper 按 optionalHostPermission 过滤且不得取反（取反会拉搜索族进回收）", () => {
    const body = functionBody(source, "async function loadOriginSharingProviders(");
    expect(body).toContain("Object.values(PROVIDER_FAMILY_UI)");
    expect(body).toContain("family.optionalHostPermission");
    expect(body).not.toContain("!family.optionalHostPermission");
  });

  it("搜索删除路径仍在 optionalHostPermission 分支外（静态权限不参与回收）", () => {
    const body = functionBody(source, "async function deleteFromEditor(");
    expect(body).toContain("family.optionalHostPermission");
  });
});
