// 分层依赖守卫（02 结构收口，静态锁定）。
//
// 背景：2026-09 审阅发现两处逆向依赖——core/content-orchestration-wiring 反向
// import entry 的纯工厂；shared/ui-status 为取一个 DOM id 反向 import 整个
// reader 域，破了 shared 的叶子纪律。两处已在 02 归位（工厂下沉 core、接线归位
// entry、id 表下沉 shared/dom-ids、ui-status 归位 core）。
//
// 本测试把归位结果钉死，防止再次漂回。锁定两条不变量：
//   A. shared 是叶子层——shared/** 的相对 import（静态或动态）若非纯类型引入，
//      必须落在 shared/ 内；
//   B. entry 是组合根——只有 entry/** 可以 import entry/**，其它层一律不得
//      反向或横向指回 entry（那等价于下层依赖装配现场）。
//
// 为什么只锁这两条：仓库的域层（ai/asr/bilibili/chat/notes/reader/subtitle/ui）
// 之间本就允许横向互引（例：ai → subtitle/cache、reader ↔ ui），这是既有惯例而
// 非违规，故不把「域层之间」纳入禁令。core → 域层的两条边（core/context-assembly
// → ai/conversation、bilibili/gateway）经查阅module 头注确认是有意设计，同样放开。
//
// 纯类型引入（import type / export type）在构建后消失，不构成运行时依赖边，
// 故 A 只对非 type-only 的 import 生效（shared/messaging-protocol.ts 即先例）。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_ROOT = join(process.cwd(), "extension");

// 顶层分层（依赖方向自左向右；entry 为组合根）。新增顶层目录必须同步此处，
// 否则第 4 条用例会红——这是有意的：结构变化要显式复核依赖方向。
const LAYERS = ["shared", "core", "ai", "asr", "bilibili", "chat", "notes", "reader", "subtitle", "ui", "entry"];

// 构建产物（两轮 esbuild 输出），不参与源码依赖图。
const GENERATED_DIRS = new Set(["chunks", "icons"]);
const GENERATED_FILES = new Set(["content-main.mjs", "content-bootstrap.iife.js"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (GENERATED_DIRS.has(name)) continue;
      walk(full, out);
      continue;
    }
    if (/\.d\.ts$/.test(name)) continue; // 纯声明，无运行时依赖边
    if (/\.(ts|js)$/.test(name) && !GENERATED_FILES.has(name)) out.push(full);
  }
  return out;
}

interface ImportEdge {
  importer: string;
  spec: string;
  target: string;
  typeOnly: boolean;
  dynamic: boolean;
}

// 静态：import|export <clause> from "<相对路径>"；clause 不许跨过 `;`。
const STATIC_RE = /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g;
// 裸副作用导入：import "<相对路径>"（无 from，同样构成运行时边）。
const SIDE_EFFECT_RE = /(?:^|\n)[ \t]*import\s*["'](\.[^"']+)["']/g;
// 动态：import("<相对路径>")。
const DYNAMIC_RE = /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

function collectEdges(file: string): ImportEdge[] {
  const source = readFileSync(file, "utf8");
  const edges: ImportEdge[] = [];

  for (const match of source.matchAll(STATIC_RE)) {
    const clause = match[1];
    edges.push({
      importer: file,
      spec: match[2],
      target: resolve(dirname(file), match[2]),
      typeOnly: /^\s*type\b/.test(clause) || /^\{\s*type\s/.test(clause),
      dynamic: false
    });
  }

  for (const match of source.matchAll(DYNAMIC_RE)) {
    edges.push({
      importer: file,
      spec: match[1],
      target: resolve(dirname(file), match[1]),
      typeOnly: false,
      dynamic: true
    });
  }

  for (const match of source.matchAll(SIDE_EFFECT_RE)) {
    edges.push({
      importer: file,
      spec: match[1],
      target: resolve(dirname(file), match[1]),
      typeOnly: false,
      dynamic: false
    });
  }

  return edges;
}

function layerOf(file: string): string {
  return relative(EXTENSION_ROOT, file).split(sep)[0];
}

describe("分层依赖守卫", () => {
  const files = walk(EXTENSION_ROOT);
  const edges = files.flatMap(collectEdges);

  it("扫描到源码（守卫自身有效，不是空转）", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(edges.length).toBeGreaterThan(400);
  });

  it("顶层目录全部在已知分层清单内", () => {
    const unknown = [...new Set(files.map(layerOf))].filter((layer) => !LAYERS.includes(layer));
    expect(unknown, `未知顶层分层 ${unknown.join(", ")}——请在 LAYERS 中登记并复核依赖方向`).toEqual([]);
  });

  it("不变量 A：shared 是叶子层（非纯类型的相对 import 不出 shared/）", () => {
    const violations = edges
      .filter((edge) => layerOf(edge.importer) === "shared")
      .filter((edge) => layerOf(edge.target) !== "shared")
      .filter((edge) => !edge.typeOnly)
      .map((edge) => `${relative(EXTENSION_ROOT, edge.importer)} -> ${edge.spec}`);
    expect(violations, `shared 反向依赖：\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("不变量 B：只有 entry 可以 import entry", () => {
    const violations = edges
      .filter((edge) => layerOf(edge.target) === "entry")
      .filter((edge) => layerOf(edge.importer) !== "entry")
      .map((edge) => `${relative(EXTENSION_ROOT, edge.importer)} -> ${edge.spec}`);
    expect(violations, `非 entry 层指向组合根：\n  ${violations.join("\n  ")}`).toEqual([]);
  });
});
