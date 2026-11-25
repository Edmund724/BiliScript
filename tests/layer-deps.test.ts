import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_ROOT = join(process.cwd(), "extension");

const LAYERS = ["shared", "core", "agent-bridge", "ai", "asr", "bilibili", "chat", "live", "notes", "reader", "search", "subtitle", "ui", "youtube", "entry"];

const GENERATED_DIRS = new Set(["chunks", "icons"]);
const GENERATED_FILES = new Set(["content-resident.iife.js"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (GENERATED_DIRS.has(name)) continue;
      walk(full, out);
      continue;
    }
    if (/\.d\.ts$/.test(name)) continue;
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

const STATIC_RE = /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|\n)[ \t]*import\s*["'](\.[^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

function collectEdges(file: string): ImportEdge[] {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
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
    const emptyLayers = LAYERS.filter((layer) => !files.some((file) => layerOf(file) === layer));
    expect(emptyLayers, `分层 ${emptyLayers.join(", ")} 下无源码文件`).toEqual([]);
    expect(edges.some((edge) => layerOf(edge.importer) === "shared")).toBe(true);
    expect(edges.some((edge) => layerOf(edge.target) === "entry")).toBe(true);
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
