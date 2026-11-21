import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BUILD_TARGET } from "./build-guards.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "node_modules/mermaid/package.json");
const sourcePath = path.join(projectRoot, "node_modules/mermaid/dist/mermaid.core.mjs");
const outputPath = path.join(projectRoot, "node_modules/mermaid/dist/mermaid.biliscript.mjs");
const probeDir = path.join(projectRoot, ".scratch/mermaid-build");
const chunksSourceDir = path.join(projectRoot, "node_modules/mermaid/dist/chunks/mermaid.core");
const chunksOutputDir = path.join(projectRoot, "node_modules/mermaid/dist/chunks/mermaid.biliscript");
const iconifyStubPath = path.join(projectRoot, "scripts", "vendor-iconify-stub.mjs");
const markedStubPath = path.join(projectRoot, "scripts", "vendor-marked-stub.mjs");
const d3SlimPath = path.join(projectRoot, "scripts", "vendor-d3-slim.mjs");
const expectedVersion = "12.0.0";
const expectedSourceHash = "07703cb6ec75ac4a0d8b7224676a5a695977981cad8a1c9a82d785377c6ebe64";
const retainedTypes = [
  "flowchart-v2",
  "sequence"
];

const RECALIBRATION_HINT =
  "（若刚升级或更新过 mermaid，这是预期失败：按本文件头注的「版本锁与重校流程」重新校准）";

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
if (pkg.version !== expectedVersion) {
  throw new Error(`Expected Mermaid ${expectedVersion}, got ${pkg.version}${RECALIBRATION_HINT}`);
}

const source = fs.readFileSync(sourcePath, "utf8");
const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
if (sourceHash !== expectedSourceHash) {
  throw new Error(`Unexpected Mermaid source hash: ${sourceHash}${RECALIBRATION_HINT}`);
}

const findChunkByContent = (anchor) => {
  const hits = fs
    .readdirSync(chunksSourceDir)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => fs.readFileSync(path.join(chunksSourceDir, name), "utf8").includes(anchor));
  if (hits.length !== 1) {
    throw new Error(
      `Mermaid chunk lookup by "${anchor}" matched ${hits.length} files: ${hits.join(", ") || "(none)"}${RECALIBRATION_HINT}`
    );
  }
  return hits[0];
};
const layoutChunkName = findChunkByContent("registerDefaultLayoutLoaders");
const mathChunkName = findChunkByContent('await import("katex")');

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

fs.rmSync(chunksOutputDir, { recursive: true, force: true });
fs.cpSync(chunksSourceDir, chunksOutputDir, {
  recursive: true,
  filter: (entry) => entry === chunksSourceDir || entry.endsWith(".mjs")
});
const chunkPrefixOriginal = "./chunks/mermaid.core/";
const chunkPrefixPatched = "./chunks/mermaid.biliscript/";
if (!generated.includes(chunkPrefixOriginal)) {
  throw new Error("Mermaid entry does not reference its chunk directory");
}
generated = generated.split(chunkPrefixOriginal).join(chunkPrefixPatched);

const layoutChunkPatched = path.join(chunksOutputDir, layoutChunkName);
const mathChunkPatched = path.join(chunksOutputDir, mathChunkName);

const replaceOnce = (text, pattern, replacement, label) => {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))];
  if (matches.length !== 1) {
    throw new Error(`Mermaid trim target "${label}" matched ${matches.length} times${RECALIBRATION_HINT}`);
  }
  const next = text.replace(pattern, replacement);
  if (next === text) {
    throw new Error(`Mermaid trim target "${label}" matched but replacement made no change${RECALIBRATION_HINT}`);
  }
  return next;
};

let layoutChunkText = fs.readFileSync(layoutChunkPatched, "utf8");
layoutChunkText = replaceOnce(
  layoutChunkText,
  /^[ \t]*\{\s*name: "swimlane",[^{}]*?\},\r?\n/m,
  "",
  "swimlane loader entry"
);

layoutChunkText = replaceOnce(
  layoutChunkText,
  /\.\.\.true \? \[[\s\S]*?\] : \[\]/,
  "...[]",
  "cose-bilkent loader spread"
);

layoutChunkText = replaceOnce(
  layoutChunkText,
  /^var elkLayoutLoaders = [\s\S]*?\}, "elkLayoutLoaders"\);\r?\n/m,
  "",
  "elkLayoutLoaders declaration"
);
layoutChunkText = replaceOnce(
  layoutChunkText,
  /(?:\/\/ src\/rendering-util\/layout-algorithms\/elk\/algorithms\.ts\r?\n)?var ELK_ALGORITHMS = \[[^\]]*\];\r?\n\r?\n?/,
  "",
  "ELK_ALGORITHMS declaration"
);
fs.writeFileSync(layoutChunkPatched, layoutChunkText);

const katexBlockPattern = / {2}if \(true\) \{\r?\n {4}const \{ default: katex \} = await import\("katex"\);[\s\S]*? {2}return text\.replace\(\r?\n {4}katexRegex,\r?\n {4}"Katex is not supported in @mermaid-js\/tiny\. Please use the full mermaid library\."\r?\n {2}\);/;
const katexBlockReplacement = `  return text.replace(
    katexRegex,
    "MathML is unsupported in this environment."
  );`;
let mathChunkText = fs.readFileSync(mathChunkPatched, "utf8");
mathChunkText = replaceOnce(mathChunkText, katexBlockPattern, katexBlockReplacement, "katex block");
if (mathChunkText.includes('await import("katex")') || mathChunkText.includes("@mermaid-js/tiny")) {
  throw new Error(`Mermaid katex trim incomplete in math chunk${RECALIBRATION_HINT}`);
}
fs.writeFileSync(mathChunkPatched, mathChunkText);

fs.writeFileSync(outputPath, generated);

fs.rmSync(probeDir, { recursive: true, force: true });
const result = await build({
  entryPoints: [outputPath],
  outdir: probeDir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: BUILD_TARGET,
  alias: {
    "@iconify/utils": iconifyStubPath,
    marked: markedStubPath,
    d3: d3SlimPath
  },
  metafile: true
});
for (const stubPath of [markedStubPath, d3SlimPath]) {
  const stubName = path.basename(stubPath);
  if (!Object.keys(result.metafile.inputs).some((input) => input.endsWith(stubName))) {
    throw new Error(`Mermaid slim alias did not apply: ${stubName} not in probe inputs`);
  }
}
const outputNames = Object.keys(result.metafile.outputs);
for (const retained of ["flowDiagram", "sequenceDiagram", "dagre"]) {
  if (!outputNames.some((name) => name.includes(retained))) {
    throw new Error(`Retained output is missing: ${retained}`);
  }
}
for (const excluded of ["architecture", "c4Diagram", "pieDiagram", "gitGraph", "journeyDiagram", "quadrantDiagram", "xychartDiagram", "requirementDiagram", "sankeyDiagram", "blockDiagram", "vennDiagram", "railroadDiagram", "erDiagram", "ganttDiagram", "stateDiagram", "swimlanes", "katex", "elk", "mindmap", "cose-bilkent", "classDiagram", "agentflow", "usecase"]) {
  if (outputNames.some((name) => name.includes(excluded))) {
    throw new Error(`Excluded output remains: ${excluded}${RECALIBRATION_HINT}`);
  }
}
const totalBytes = outputNames.reduce((sum, name) => sum + fs.statSync(name).size, 0);
console.log(`Mermaid slim check: ${outputNames.length} probe files, ${totalBytes} bytes`);
