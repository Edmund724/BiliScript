// host 权限代申请的「用户手势」不变式测试（S2 收紧 host_permissions）。
//
// chrome.permissions.request 只在渲染进程仍持有用户手势时才允许弹窗；从手势
// 事件到 request 之间只要多插一个 await，Chrome 就以「缺少用户手势」拒绝，
// 表现为点保存/切平台永远弹不出授权框。这个约束没法在 jsdom 里跑
// （chrome.permissions 是真实扩展 API，测试环境只有 mock），所以这里照
// tests/entry/message-handler-signature.test.ts 的先例直接扫源码。
//
// 代申请已收口为 core/host-permissions.ts 的单一实现
// requestProviderOriginsViaBackground（content script 语境无 chrome.permissions
// API，经 request-provider-origins 消息由 SW 代为申请；扩展页面语境直调）。
// 本文件锁定两段源码级不变量：
// 1. 调用方：从手势函数入口到代申请调用之间零先行 await。provider-editor 三处
//    （runTest / runModelTest / openFetchDialog）与保存事务 upsertProvider 的等价
//    判据已改为接口驱动的行为断言（点击/调用后同步观察权限发起），不再扫源码：
//      - tests/ui/provider-editor-session.test.ts（S5 同步观察 pendingPermission）
//      - tests/ui/provider-editor.test.ts（点击后同步断言权限消息已出站）
//      - tests/ui/provider-transaction.test.ts（T2 同步断言 requestOrigins 已调用）
//    仍留在本文件的 model-picker 是当前唯一没有等价行为入口的调用方（下拉箭头
//    的权限发起先于网络，jsdom 无法同步观察），继续扫源码。
// 2. SW 处理器（handleRequestProviderOrigins）：从入口到
//    chrome.permissions.request 之间零 await——手势经一次 runtime 消息传导，
//    SW 侧垫任何 await 都会让弹窗被 Chrome 拒绝。
//
// 另锁一条设置面板侧的既有契约：provider-master-detail/02 起 saveSettings 不再
// 申请平台权限（平台授权收口在 provider-editor Modal 的单平台事务 /
// 探针与模型列表预检链路），平铺行「测试连接」自动保存与预设切换代申请随之退役。
//
// 断言刻意只认「await 的位置」而不认变量名/文案，改注释、换字段名都不该红。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 去块注释与行注释（与既有源码扫描测试同一口径），避免注释里的 await 误判
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// 注意：URL 参数必须走变量传入，不能写 new URL("<字面量>", import.meta.url)——
// Vite 会把字面量形式改写成资源 URL，jsdom 下解析成 https:// 开头而 fileURLToPath 报错。
// 源文件已是 .ts；写法上保留 existsSync 双后缀回退（与 tests/core/
// message-handler-signature.test.js 的 readSource 同一口径）。
function readSource(relativePath: string) {
  const jsUrl = new URL(relativePath, import.meta.url);
  const url = existsSync(fileURLToPath(jsUrl))
    ? jsUrl
    : new URL(relativePath.replace(/\.js$/, ".ts"), import.meta.url);
  return stripComments(readFileSync(fileURLToPath(url), "utf8"));
}

// extension/ 下全部 .ts/.js 源文件（相对 tests/ui/ 的 ../../extension 前缀）
function listExtensionSources() {
  // 根路径同样走变量传入（同 readSource：字面量会被 Vite 改写成资源 URL）
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

    // 箭头点击即用户手势本体：申请之前垫任何 await（哪怕读一次 DOM 之外的
    // 异步值）都会让 Chrome 以「缺少用户手势」拒掉授权弹窗，必须红。
    const prefix = source.slice(start, request);
    expect(/(?:^|[\s(=])await\s*$/.test(prefix), "requestProviderOriginsViaBackground 应被直接 await").toBe(true);
    const before = prefix.replace(/\s*await\s*$/, "");
    expect(before.match(/\bawait\b/g) || [], "申请权限之前不得有先行 await").toEqual([]);
  });
});

describe("SW 处理器零 await（手势经 runtime 消息传导的最后一环）", () => {
  it("handleRequestProviderOrigins：入口到 chrome.permissions.request 之间零 await", () => {
    const source = readSource("../../extension/entry/background.js");
    const start = source.indexOf("function handleRequestProviderOrigins(");
    const request = source.indexOf(".request({ origins })", start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);

    const prefix = source.slice(start, request);
    expect(prefix.match(/\bawait\b/g) || [], "SW 处理器在申请权限前不得有 await").toEqual([]);
  });
});

// 说明：原「设置面板保存链的既有契约」是 saveSettings 的 functionBody 切片
//（函数体不得出现 requestProviderOriginsViaBackground / providers-save）。
// owner 3 把平台保存整体搬进 provider-transaction 之后，等价判据已由
// tests/ui/settings-panel-save.test.ts「saveSettings 保存链（保存按钮手势）」经
// 真实点击驱动：报文里只许有 save-settings，不得出现 request-provider-origins /
// ai-providers-save / asr-providers-save。按「replace 不 layer」删除源码切片。

