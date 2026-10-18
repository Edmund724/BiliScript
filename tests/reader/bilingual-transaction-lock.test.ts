// 双语副轨的结构锁（bilingual-subtitles/08 号票）：把「谁写、谁通知、谁渲染」三条纪律
// 钉在源码扫描上——票面写了、注释写了，但纪律本身必须能被测试打红。
//
// 这里不重复行为锁（那些在别处）：
//   - 双语关时渲染/搜索与现状逐字相同 ⇒ tests/reader/bilingual-list.test.ts（冻结模板对拍）
//   - 双语关时导出/复制逐字相同 ⇒ tests/subtitle/dual-export.test.ts（冻结字面量）
//   - 04 的配对边界 ⇒ tests/subtitle/alignment.test.ts（15 例）
//   - 两级语言匹配 ⇒ tests/subtitle/selection.test.ts
//   - 主轨事务本身的纪律 ⇒ tests/subtitle/reset-fetch-runid.test.ts 等既有锁
//
// 本文件锁四件事（先列失败方式）：
//   a. **第二个 body 的写手漂移**：副轨槽的 body 只许经接受事务写。若哪天有人在别处
//      `clipState.applySecondarySubtitle(...)`（或在弹层/生命周期里直接拼槽），
//      「渲染只经事务通知」立刻破产，且不会有任何行为测试报警。
//   b. **通知 kind 单点发射 / 单点接收**：第二个 kind 一旦被第二处发射或接收，
//      副轨到站就会触发两套副作用（或漏掉重渲）。接收侧是 reader/lifecycle 的一 kind
//      一格接收表，副轨那一格只装自己的函数体——「副轨到站顺手带上主轨那串副作用」
//      （概览生成 / 快捷问题预热 / 播放同步重启）在结构上已不可能，无需另锁。
//   c. **渲染绕道**：调用方直调 `renderReadingView()` 是双渲染的先例（GLOSSARY.md
//      硬事实：渲染只经通知）。副轨这条路径上，弹层与列表渲染器都不得自绘。
//   e. **notes 渲染层从纯函数退化成读 state**：07 的接缝是注入解析器；若渲染层直接
//      读 state 或 import alignment，单轨路径的零参与保证与可单测性同时消失。
//
// 扫描口径：只扫 `extension/**/*.ts` 源码，**不扫注释**——注释里提到某个名字是文档，
// 不是调用点，因此「唯一调用点」一律按**带括号的调用形式**匹配，并按需要剥掉块注释。

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function sourceFiles(): string[] {
  // 手写递归：测试环境的 node:fs 桩只收 `{ withFileTypes: true }`（不认 recursive）。
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk("extension");
  return out;
}

// 行注释与块注释都要剥：本仓大量「注释里点名调用者」的写法（例如
// `// 副轨到站的 "secondary-subtitle-ready" 通知驱动 renderReadingView 重渲`），
// 不剥会把这些文档行误判成调用点。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

// 出现某个「带括号调用」的文件清单（相对路径，去重升序）
function filesCalling(token: string): string[] {
  const pattern = new RegExp(`${token}\\s*\\(`);
  return sourceFiles()
    .filter((file) => pattern.test(stripComments(read(file))))
    .map((file) => relative(ROOT, join(ROOT, file)).replace(/\\/g, "/"))
    .sort();
}

describe("双语副轨结构锁（写手 / 通知 / 渲染）", () => {
  it("副轨 body 的唯一写手 = 接受事务（别处写槽即破产）", () => {
    // state.ts 是声明 + 实现（原语的唯一属主），原语 clipState.applySecondarySubtitle 的唯一调用点收敛在 slot.ts。
    const callers = filesCalling("clipState\\.applySecondarySubtitle");
    expect(callers).toEqual(["extension/subtitle/slot.ts"]);

    const allMentioning = sourceFiles()
      .filter((file) => stripComments(read(file)).includes("applySecondarySubtitle"))
      .map((file) => file.replace(/\\/g, "/"));
    expect(allMentioning.sort()).toEqual(["extension/core/state.ts", "extension/subtitle/slot.ts"]);

    // slot.installSecondary 动词的唯一调用点锁定在 commit.ts 事务
    const installSecondaryCallers = filesCalling("slot\\.installSecondary");
    expect(installSecondaryCallers).toEqual(["extension/subtitle/commit.ts"]);
  });

  it("新通知 kind 单点发射 + 单点接收（第二处即双副作用/漏重渲）", () => {
    const emitters = sourceFiles()
      .filter((file) => stripComments(read(file)).includes('notifyReaderPresenter({ kind: "secondary-subtitle-ready" })'))
      .map((file) => file.replace(/\\/g, "/"));
    expect(emitters).toEqual(["extension/subtitle/commit.ts"]);

    // 接收点是 reader/lifecycle 接收表里那一格（表成员写法 `"<kind>"() {`）。
    const receivers = sourceFiles()
      .filter((file) => /"secondary-subtitle-ready"\(\)\s*\{/.test(stripComments(read(file))))
      .map((file) => file.replace(/\\/g, "/"));
    expect(receivers).toEqual(["extension/reader/lifecycle.ts"]);
  });

  it("渲染只经通知：renderReadingView() 的调用点唯一在 reader/lifecycle.ts", () => {
    // 弹层（subtitle-tab-ui）、列表渲染器（batched-render）、搜索（subtitle-search）、
    // 总结链（subtitle/**）一律不得自绘列表——它们只发/收通知。
    expect(filesCalling("renderReadingView")).toEqual(["extension/reader/lifecycle.ts"]);
  });

  it("notes 渲染层保持纯函数：不读 state、不 import 配对模块", () => {
    for (const rel of ["extension/notes/render.ts", "extension/notes/section-lines.ts"]) {
      const body = stripComments(read(rel));
      expect(body, `${rel} 读了 state`).not.toMatch(/\bstate\.(clip|settings|reader)\b/);
      expect(body, `${rel} import 了 alignment`).not.toContain("alignment.js");
      // 注入的解析器是唯一副轨来源：必须是可选参数（双语关 ⇒ undefined ⇒ 零参与）
      expect(body, `${rel} 丢了可选解析器入参`).toMatch(/secondaryFor\?/);
    }
  });
});
