import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "node_modules/mermaid/package.json");
const sourcePath = path.join(projectRoot, "node_modules/mermaid/dist/mermaid.core.mjs");
const outputPath = path.join(projectRoot, "node_modules/mermaid/dist/mermaid.boc.mjs");
const probeDir = path.join(projectRoot, ".scratch/mermaid-build");
const chunksSourceDir = path.join(projectRoot, "node_modules/mermaid/dist/chunks/mermaid.core");
const chunksOutputDir = path.join(projectRoot, "node_modules/mermaid/dist/chunks/mermaid.boc");
const layoutChunkSource = path.join(chunksSourceDir, "chunk-TLUHSLCS.mjs");
const mathChunkSource = path.join(chunksSourceDir, "chunk-DU6HZSFF.mjs");
const layoutChunkPatched = path.join(chunksOutputDir, "chunk-TLUHSLCS.mjs");
const mathChunkPatched = path.join(chunksOutputDir, "chunk-DU6HZSFF.mjs");
const expectedVersion = "11.17.2";
const expectedSourceHash = "19f24f8cd5bf77ef366f63698b45377ffe6b346e78e6ed0ee5ba121f7b42ed7c";
const expectedLayoutChunkHash = "08158f63a7d3572dca0a880b2012577f3da9ea53ce4968c118c7ecc949752f56";
const expectedMathChunkHash = "3e097dc503ef753116bb327d93a8592e3dbbcaa9cc2a3696e552a982c6a41bb6";
const retainedTypes = [
  "flowchart-v2",
  "flowchart",
  "sequence",
  "class",
  "classDiagram",
  "mindmap"
];

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
if (pkg.version !== expectedVersion) {
  throw new Error(`Expected Mermaid ${expectedVersion}, got ${pkg.version}`);
}

const source = fs.readFileSync(sourcePath, "utf8");
const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
if (sourceHash !== expectedSourceHash) {
  throw new Error(`Unexpected Mermaid source hash: ${sourceHash}`);
}

// 布局引擎 chunk（registerDefaultLayoutLoaders）与数学渲染 chunk（katex 动态
// import）的 sha256 锁：这两个文件是下方复制 + 文本裁剪的目标，版本漂移导致
// 目标文本变化时在此失败，而不是裁剪出错或静默裁不动。
const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const [file, expected] of [
  [layoutChunkSource, expectedLayoutChunkHash],
  [mathChunkSource, expectedMathChunkHash],
]) {
  const actual = hashFile(file);
  if (actual !== expected) {
    throw new Error(`Unexpected Mermaid chunk hash for ${path.basename(file)}: ${actual}`);
  }
}

const sourceMarkers = [...source.matchAll(/^\/\/ src\/[^\n]+$/gm)];
const detectorMarkers = [...source.matchAll(/^\/\/ src\/diagrams\/[^\n]*[dD]etector[^/]*\.ts$/gm)];
const declarations = new Map();
const segments = detectorMarkers.map((marker, index) => {
  const start = marker.index;
  const end = sourceMarkers.find((candidate) => candidate.index > start)?.index ?? source.length;
  const segment = source.slice(start, end);
  const idMatch = /^var\s+(id\d*)\s*=\s*"([^"]+)";$/m.exec(segment);
  const pluginMatch = /^var\s+(\w+)\s*=\s*\{[\s\S]*?^\};$/m.exec(segment);
  if (!idMatch || !pluginMatch) {
    throw new Error(`Unable to parse Mermaid detector declaration at offset ${start}`);
  }
  const tail = segment.slice(pluginMatch.index + pluginMatch[0].length);
  const exportMatch = /^var\s+(\w+)\s*=\s*(\w+);$/m.exec(tail);
  const type = idMatch[2];
  const plugin = pluginMatch[1];
  const declaration = {
    type,
    idVariable: idMatch[1],
    plugin,
    exportName: exportMatch?.[1] ?? null,
    start,
    end,
    order: index
  };
  if (declarations.has(type) || [...declarations.values()].some((item) => item.plugin === plugin)) {
    throw new Error(`Duplicate Mermaid detector declaration: ${type}`);
  }
  if (exportMatch && exportMatch[2] !== plugin) {
    throw new Error(`Mermaid export for ${type} does not reference its plugin`);
  }
  declarations.set(type, declaration);
  return declaration;
});

for (const type of retainedTypes) {
  const declaration = declarations.get(type);
  if (!declaration?.exportName) {
    throw new Error(`Missing retained Mermaid detector declaration: ${type}`);
  }
}

const registrationBlock = /if \(true\) \{\s*registerLazyLoadedDiagrams\(([^;]*)\);\s*\}\s*registerLazyLoadedDiagrams\(([\s\S]*?)\);/;
const registrationMatch = registrationBlock.exec(source);
if (!registrationMatch) {
  throw new Error("Mermaid diagram registration layout changed");
}
const parseRegistration = (text) => text.split(",").map((name) => name.trim());
const originalFast = parseRegistration(registrationMatch[1]);
const originalAll = parseRegistration(registrationMatch[2]);
const isKnownRegistration = (name) => [...declarations.values()].some((declaration) =>
  declaration.plugin === name || declaration.exportName === name
);
for (const plugin of [...originalFast, ...originalAll]) {
  if (!isKnownRegistration(plugin)) {
    throw new Error(`Registration references an unknown Mermaid plugin: ${plugin}`);
  }
}

const isRetainedExport = (name) => retainedTypes.some((type) => declarations.get(type)?.exportName === name);
const nextFast = originalFast.filter(isRetainedExport);
const nextAll = originalAll.filter(isRetainedExport);
const registrationReplacement = `if (true) {\n    registerLazyLoadedDiagrams(${nextFast.join(", ")});\n  }\n  registerLazyLoadedDiagrams(${nextAll.join(", ")});`;
let generated = `${source.slice(0, registrationMatch.index)}${registrationReplacement}${source.slice(registrationMatch.index + registrationMatch[0].length)}`;
const retainedSet = new Set(retainedTypes);
for (const segment of segments.toReversed()) {
  if (!retainedSet.has(segment.type)) {
    generated = generated.slice(0, segment.start) + generated.slice(segment.end);
  }
}
if (generated === source || generated.length >= source.length) {
  throw new Error("Mermaid detector trimming made no change");
}

// 精简入口指向 mermaid.boc 副本 chunk 区：swimlane 布局加载器与 katex 数学渲染
// 不在 mermaid.core.mjs 本体里，而在它静态引用的 chunk 文件里（前者在
// chunk-TLUHSLCS 的 registerDefaultLayoutLoaders，后者在 chunk-DU6HZSFF 的
// renderKatexUnsanitized）。裁剪必须作用在「可达图内唯一」的模块实例上——直接
// 原地改 node_modules 会污染安装包，而只复制个别 chunk 又会与原始路径形成两个
// 模块实例（注册表写入 A 实例、render 读 B 实例）。因此整目录复制出 mermaid.boc
// 副本区（只 .mjs），把精简入口的 specifier 全部重定向过去，再对副本做文本
// 裁剪；所有跨 chunk 引用在副本区内相对解析，天然单一实例。7.9MB 级本地复制，
// 每次构建重建，node_modules 内不入库。
fs.rmSync(chunksOutputDir, { recursive: true, force: true });
fs.cpSync(chunksSourceDir, chunksOutputDir, {
  recursive: true,
  filter: (entry) => entry === chunksSourceDir || entry.endsWith(".mjs")
});
const chunkPrefixOriginal = "./chunks/mermaid.core/";
const chunkPrefixPatched = "./chunks/mermaid.boc/";
if (!generated.includes(chunkPrefixOriginal)) {
  throw new Error("Mermaid entry does not reference its chunk directory");
}
generated = generated.split(chunkPrefixOriginal).join(chunkPrefixPatched);

// 裁剪 1：swimlane 布局加载器（flowchart 实验特性，~113KB / ~42KB gzip）。
// registerDefaultLayoutLoaders 少了 swimlane 后，flowchart 请求该算法时走
// getRegisteredLayoutAlgorithm 内置的 fallback:"dagre"（mermaid 11.17.2 源码
// 语义已核对，仅 log.warn 降级，非硬失败）。dagre / cose-bilkent 保留：
// dagre 是 flowchart 回退，cose-bilkent 是 mindmap 的 fallback。
const swimlaneLoaderEntry = `    {
      name: "swimlane",
      loader: /* @__PURE__ */ __name(async () => await import("./swimlanes-42K2YHIH.mjs"), "loader")
    },
`;
const layoutChunkText = fs.readFileSync(layoutChunkPatched, "utf8");
if (!layoutChunkText.includes(swimlaneLoaderEntry)) {
  throw new Error("Mermaid swimlane loader entry not found in layout chunk");
}
fs.writeFileSync(layoutChunkPatched, layoutChunkText.replace(swimlaneLoaderEntry, ""));

// 裁剪 2：katex 数学渲染（~268KB / ~77KB gzip）。mermaid 的 math 渲染由标签
// 里的 $$...$$ 触发（hasKatex），无配置项可整体关闭；此处把 renderKatexUnsanitized
// 里无条件 import("katex") 的 if (true) 块整体替换为「MathML 不支持」的既有
// 降级路径——$$...$$ 文本不再走 KaTeX 排版，而是替换为占位说明，import 站点
// 消失后 katex 包（mermaid 依赖，产品侧无其他使用方）不再被打包。
const katexBlock = `  if (true) {
    const { default: katex } = await import("katex");
    const outputMode = config2.forceLegacyMathML || !isMathMLSupported() && config2.legacyMathML ? "htmlAndMathml" : "mathml";
    return text.split(lineBreakRegex).map(
      (line) => hasKatex(line) ? \`<div style="display: flex; align-items: center; justify-content: center; white-space: nowrap;">\${line}</div>\` : \`<div>\${line}</div>\`
    ).join("").replace(
      katexRegex,
      (_, c) => katex.renderToString(c, {
        throwOnError: true,
        displayMode: true,
        output: outputMode
      }).replace(/\\n/g, " ").replace(/<annotation.*<\\/annotation>/g, "")
    );
  }
  return text.replace(
    katexRegex,
    "Katex is not supported in @mermaid-js/tiny. Please use the full mermaid library."
  );`;
const katexBlockReplacement = `  return text.replace(
    katexRegex,
    "MathML is unsupported in this environment."
  );`;
const mathChunkText = fs.readFileSync(mathChunkPatched, "utf8");
if (!mathChunkText.includes(katexBlock)) {
  throw new Error("Mermaid katex block not found in math chunk");
}
fs.writeFileSync(mathChunkPatched, mathChunkText.replace(katexBlock, katexBlockReplacement));

fs.writeFileSync(outputPath, generated);

fs.rmSync(probeDir, { recursive: true, force: true });
const result = await build({
  entryPoints: [outputPath],
  outdir: probeDir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  metafile: true
});
const outputNames = Object.keys(result.metafile.outputs);
for (const retained of ["flowDiagram", "sequenceDiagram", "classDiagram", "mindmap", "dagre", "cose-bilkent"]) {
  if (!outputNames.some((name) => name.includes(retained))) {
    throw new Error(`Retained output is missing: ${retained}`);
  }
}
// "elk"：flowchart-elk 探测器已裁剪（bundle 从无 elk 布局加载器），若未来
// 版本把 elk 布局器/加载器带进 bundle，在此失败而不是静默混入。
for (const excluded of ["architecture", "c4Diagram", "pieDiagram", "gitGraph", "journeyDiagram", "quadrantDiagram", "xychartDiagram", "requirementDiagram", "sankeyDiagram", "blockDiagram", "vennDiagram", "railroadDiagram", "erDiagram", "ganttDiagram", "stateDiagram", "swimlanes", "katex", "elk"]) {
  if (outputNames.some((name) => name.includes(excluded))) {
    throw new Error(`Excluded output remains: ${excluded}`);
  }
}
const totalBytes = outputNames.reduce((sum, name) => sum + fs.statSync(name).size, 0);
console.log(`Mermaid slim check: ${outputNames.length} probe files, ${totalBytes} bytes`);
