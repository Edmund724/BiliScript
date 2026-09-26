// mermaid 体积裁剪管线：从 mermaid.core.mjs 裁掉未保留的图表类型，只保留
// flowchart-v2 / sequence，产出精简入口 mermaid.biliscript.mjs 与
// mermaid.biliscript chunk 副本区，再由探针构建验证替身生效与保留/排除集合。
//
// —— 内容锚点而非文件名 ——
// 布局 chunk（registerDefaultLayoutLoaders）、数学 chunk（katex 动态 import）
// 与 swimlane 加载器项的文件名是上游每次构建重新生成的 hash 抖动，写死则每个
// mermaid 版本都要打补丁，故一律按内容锚点定位、命中数 ≠ 1 即抛错。锚点选择
// 依据（11.17.2 与 12.0.0 实测均恰好命中 1 个 chunk 文件）：
// registerDefaultLayoutLoaders 只在布局 chunk 定义；await import("katex") 只在
// 数学渲染 chunk；name: "swimlane" 只在布局 chunk 的加载器表里——
// name: "cose-bilkent" 会命中 2 个文件（布局 chunk + cose-bilkent 本体 chunk），
// 不能当锚点。
//
// —— 版本锁与重校流程（mermaid-12-upgrade/04） ——
// package.json 是 caret（^12.0.0），lockfile 钉死具体版本；caret 只在有人显式
// pnpm update mermaid 时生效，而那正是触发重校的时刻。锁只剩 expectedVersion +
// expectedSourceHash 两个常量。升级 mermaid 后构建一定先在本脚本失败，这是预期：
// 1. pnpm install（或 pnpm update mermaid@^12）。
// 2. node scripts/vendor-mermaid-slim.mjs（探针轮），按报错逐条处理：只
//    expectedSourceHash 变 = 上游改了无关代码，重校就是改这一个常量；锚点 /
//    字面量报错 = 上游真动了裁剪目标，必须人看（把被删的构造补回 excluded 或
//    改裁剪逻辑），不能只改常量糊过去。可能失效的三处：katex 块（已正则化）、
//    swimlane 加载器项的形状、ELK_ALGORITHMS 声明边界。
// 3. pnpm build:content 过自检 → pnpm test → pnpm typecheck。
// 4. node scripts/mermaid-smoke/serve.mjs，经 kimi-webbridge 打开打印的 URL，
//    真实 Chrome 冒烟。
// 5. 体积人工比对（不加构建期门禁）：从 extension/entry/chunks/mermaid-render.mjs
//    沿 import 走图收集懒闭包求和，对基线（11.17.2 = 621,113 B / 11 文件，
//    12.0.0 = 592,728 B / 10 文件；常驻 24,981 B / 2 请求为硬门槛）。
// 6. unsupported 图类型仍落「保留源码 + 提示」而非 error。
//
// —— target 与浏览器地板（mermaid-12-upgrade/08） ——
// mermaid 12 自称产物目标 ES2024，但裁剪后保留闭包（flowchart-v2/sequence）实测
// 未沾任何 post-Chrome-120 内建（Promise.withResolvers / Object.groupBy /
// Iterator helpers 等全部 absent；产物里最现代的内建是 dayjs 的 URL.canParse，
// 恰为 Chrome 120，零余量但准确）；且全部 chunk 在 target chrome120 与 esnext
// 下 esbuild.transform 逐字节相同——该 target 对当前产物完全惰性。重校时若要
// 重新怀疑这一点，重做 08 的对照实验，别只看上游 release notes。

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
// retainedTypes 不再有 "flowchart"（mermaid-12-upgrade/03）：12.0.0 上游已删
// v1 flowchart 探测器——v1 只在 defaultRenderer:"dagre-d3" 下触发，该字符串在
// 12 产物中一处不剩；graph 关键字由 v2 吸收。
const retainedTypes = [
  "flowchart-v2",
  "sequence"
];

// 指向重校的报错后缀（mermaid-12-upgrade/04）：版本 / source hash / 内容锚点 /
// 裁剪字面量与正则 / excluded 守卫五类失败统一带上——读作「该重校裁剪」，
// 而不是「构建坏了」。
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

// 布局 chunk（registerDefaultLayoutLoaders）与数学 chunk（katex 动态 import）
// 按内容锚点定位（理由见头注）：这两个文件是下方复制 + 文本裁剪的目标，版本
// 漂移导致锚点漂移时在此失败，而不是裁剪出错或静默裁不动。
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

// 精简入口指向 mermaid.biliscript 副本 chunk 区：swimlane 布局加载器与 katex 数学渲染
// 不在 mermaid.core.mjs 本体里，而在它静态引用的 chunk 文件里（前者在布局 chunk
// 的 registerDefaultLayoutLoaders，后者在数学 chunk 的 renderKatexUnsanitized）。
// 裁剪必须作用在「可达图内唯一」的模块实例上——直接原地改 node_modules 会污染
// 安装包，而只复制个别 chunk 又会与原始路径形成两个模块实例（注册表写入 A 实例、
// render 读 B 实例）。因此整目录复制出 mermaid.biliscript 副本区（只 .mjs），把
// 精简入口的 specifier 全部重定向过去，再对副本做文本裁剪；所有跨 chunk 引用在
// 副本区内相对解析，天然单一实例。7.9MB 级本地复制，每次构建重建，node_modules
// 内不入库。
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

// 替换前断言命中数恰为 1（命中 0 是上游动了裁剪目标，命中 > 1 是锚点不再唯一），
// 再断言替换真的改了文本——防止「正则匹配但 replace 没生效」的静默不裁。
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

// 裁剪 1：swimlane 布局加载器（flowchart 实验特性，~113KB / ~42KB gzip）。
// registerDefaultLayoutLoaders 少了 swimlane 后，flowchart 请求该算法时走
// getRegisteredLayoutAlgorithm 内置的 fallback:"dagre"（mermaid 12.0.0 源码
// 语义已核对，仅 log.warn 降级，非硬失败）。dagre 保留：它是 flowchart 回退。
// 加载器项按内容定位（name: "swimlane"，见头注），import 路径里的 hash 不锁。
let layoutChunkText = fs.readFileSync(layoutChunkPatched, "utf8");
layoutChunkText = replaceOnce(
  layoutChunkText,
  /^[ \t]*\{\s*name: "swimlane",[^{}]*?\},\r?\n/m,
  "",
  "swimlane loader entry"
);

// 裁剪 1b：cose-bilkent 默认布局加载器（registerDefaultLayoutLoaders 的
// ...true ? [...] : [] spread，~514KB / ~150KB gzip）。cose-bilkent 原是
// mindmap 的默认 layoutAlgorithm，mindmap 已裁（retainedTypes 去掉 mindmap、
// 探测器段删除），flowchart/sequence 走 dagre，加载站点消失后整个
// cytoscape 族不再打包；同 swimlane 机制，防回混校验在下方 excluded 列表。
// spread 整体替换成 ...[]（12.0.0 起 cose-bilkent 与 ELK 挤在同一 spread 里，
// 无法独立裁剪），非贪婪正则对 spread 内部形状与 chunk 文件名 hash 免疫。
layoutChunkText = replaceOnce(
  layoutChunkText,
  /\.\.\.true \? \[[\s\S]*?\] : \[\]/,
  "...[]",
  "cose-bilkent loader spread"
);

// 裁剪 1c（12.0.0 起）：ELK 加载器声明。上面的 spread 换掉后，
// elkLayoutLoaders 成了未用声明，但 esbuild 不移除 __name 包装下的未用 var，
// 其动态 import 仍被判为可达，elk chunk 会照进产物——必须显式删声明
//（import 路径里的 hash 不锁）。ELK_ALGORITHMS 随之成为未用数组，一并删。
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

// 裁剪 2：katex 数学渲染（~268KB / ~77KB gzip）。mermaid 的 math 渲染由标签
// 里的 $$...$$ 触发（hasKatex），无配置项可整体关闭；此处把 renderKatexUnsanitized
// 里无条件 import("katex") 的 if (true) 块连同其后的 tiny-build fallback return
// 整体替换为「MathML 不支持」的降级文案——$$...$$ 文本不再走 KaTeX 排版，而是
// 替换为占位说明，import 站点消失后 katex 包（mermaid 依赖，产品侧无其他使用方）
// 不再被打包。12.0.0 特有的坑（mermaid-12-upgrade/04）：katex 块前面新插了
// isMathMLSupported() 守卫，Chrome 里为真会放行，所以只删 if (true) 块会落到
// 下面那句 @mermaid-js/tiny fallback——而我们不是 tiny build；正则必须从
// if (true) { 一路吃到那个 fallback return 结束。
const katexBlockPattern = / {2}if \(true\) \{\r?\n {4}const \{ default: katex \} = await import\("katex"\);[\s\S]*? {2}return text\.replace\(\r?\n {4}katexRegex,\r?\n {4}"Katex is not supported in @mermaid-js\/tiny\. Please use the full mermaid library\."\r?\n {2}\);/;
const katexBlockReplacement = `  return text.replace(
    katexRegex,
    "MathML is unsupported in this environment."
  );`;
let mathChunkText = fs.readFileSync(mathChunkPatched, "utf8");
mathChunkText = replaceOnce(mathChunkText, katexBlockPattern, katexBlockReplacement, "katex block");
// 不变量：替换后产物不得残留 katex 动态 import 站点，也不得出现 tiny-build 文案。
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
  // @iconify/utils 替身（体积裁剪）：mermaid icons.ts 只用五个导出，产品不注册
  // 图标包，降级路径见 vendor-iconify-stub.mjs 头注。探针轮与产品轮 B 同一 alias。
  // marked / d3 替身同理（见 vendor-marked-stub.mjs / vendor-d3-slim.mjs 头注）：
  // marked 运行时零调用、d3 保留闭包只用 select + d3-shape 曲线族。
  alias: {
    "@iconify/utils": iconifyStubPath,
    marked: markedStubPath,
    d3: d3SlimPath
  },
  metafile: true
});
// 替身落地守卫：alias 静默失效（路径写错、filter 漂移）时替身不进 inputs，
// 在此失败而不是悄悄把 ~300KB 的 marked+d3 umbrella 打回 bundle。
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
// "elk"：12.0.0 起上游注释声称排除、实际未排除（裁剪 1b/1c 处理），若未来版本
// 把 elk 布局器/加载器带进 bundle，在此失败而不是静默混入。"agentflow" /
// "usecase" 是 12.0.0 新增的 beta 门控类型，现有裁剪已顺带裁掉，列入纯保险。
for (const excluded of ["architecture", "c4Diagram", "pieDiagram", "gitGraph", "journeyDiagram", "quadrantDiagram", "xychartDiagram", "requirementDiagram", "sankeyDiagram", "blockDiagram", "vennDiagram", "railroadDiagram", "erDiagram", "ganttDiagram", "stateDiagram", "swimlanes", "katex", "elk", "mindmap", "cose-bilkent", "classDiagram", "agentflow", "usecase"]) {
  if (outputNames.some((name) => name.includes(excluded))) {
    throw new Error(`Excluded output remains: ${excluded}${RECALIBRATION_HINT}`);
  }
}
const totalBytes = outputNames.reduce((sum, name) => sum + fs.statSync(name).size, 0);
console.log(`Mermaid slim check: ${outputNames.length} probe files, ${totalBytes} bytes`);
