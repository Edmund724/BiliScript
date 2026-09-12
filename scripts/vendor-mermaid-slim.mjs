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
const expectedVersion = "11.17.2";
const expectedSourceHash = "19f24f8cd5bf77ef366f63698b45377ffe6b346e78e6ed0ee5ba121f7b42ed7c";
const retainedTypes = [
  "flowchart-elk",
  "flowchart-v2",
  "flowchart",
  "sequence",
  "class",
  "classDiagram",
  "state",
  "stateDiagram",
  "er",
  "gantt",
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
for (const retained of ["flowDiagram", "sequenceDiagram", "classDiagram", "stateDiagram", "erDiagram", "ganttDiagram", "mindmap"]) {
  if (!outputNames.some((name) => name.includes(retained))) {
    throw new Error(`Retained output is missing: ${retained}`);
  }
}
for (const excluded of ["architecture", "c4Diagram", "pieDiagram", "gitGraph", "journeyDiagram", "quadrantDiagram", "xychartDiagram", "requirementDiagram", "sankeyDiagram", "blockDiagram", "vennDiagram", "railroadDiagram"]) {
  if (outputNames.some((name) => name.includes(excluded))) {
    throw new Error(`Excluded output remains: ${excluded}`);
  }
}
const totalBytes = outputNames.reduce((sum, name) => sum + fs.statSync(name).size, 0);
console.log(`Mermaid slim check: ${outputNames.length} probe files, ${totalBytes} bytes`);
