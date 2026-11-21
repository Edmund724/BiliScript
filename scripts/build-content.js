const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { build, context } = require("esbuild");
const {
  createLocalImportGuard,
  sourcesFromMap,
  findForbiddenInputs,
  diffDualInstanceAllowlist,
  resolveTargetPlatform,
  getEsbuildTarget,
} = require("./build-guards.js");

const targetPlatform = resolveTargetPlatform(process.argv);
const esbuildTarget = getEsbuildTarget(targetPlatform);

const watchMode = process.argv.includes("--watch");

const extensionRoot = path.join(__dirname, "..", "extension");
const vendorMermaidSlimScript = path.join(__dirname, "vendor-mermaid-slim.mjs");
const slimMermaidEntry = path.join(
  __dirname,
  "..",
  "node_modules",
  "mermaid",
  "dist",
  "mermaid.biliscript.mjs"
);
const entry = path.join(extensionRoot, "entry", "content.ts");
const bootstrapEntry = path.join(extensionRoot, "entry", "content-bootstrap.ts");
const outDir = path.join(extensionRoot, "entry");
const mainOutfile = path.join(outDir, "content-main.mjs");
const bootstrapOutfile = path.join(outDir, "content-bootstrap.iife.js");
const chunksDir = path.join(outDir, "chunks");
const workletEntry = path.join(extensionRoot, "live", "pcm-capture-worklet.ts");
const workletOutfile = path.join(chunksDir, "pcm-capture-worklet.mjs");
const legacyOutfile = path.join(outDir, "content-classic.js");

const lazyTargets = [
  { name: "player-ai", source: "ai/player-ai.ts" },
  { name: "player-interpret", source: "live/player-interpret.ts" },
  { name: "script-button", source: "ui/script-button.ts" },
  { name: "live-room", source: "live/live-room-entry.ts" },
  { name: "ui-renderer", source: "ui/ui-renderer.ts" },
  { name: "reader", source: "reader/index.ts" },
  { name: "chat-tab", source: "reader/chat-tab.ts" },
  { name: "presentation", source: "reader/presentation.ts" },
  { name: "shell", source: "reader/shell.ts" },
  { name: "fetcher", source: "subtitle/fetcher.ts" },
  { name: "ui", source: "subtitle/ui.ts" },
  { name: "asr-translation", source: "subtitle/asr-translation.ts" },
  { name: "gateway", source: "bilibili/gateway.ts" },
  { name: "agent-bridge-subtitles", source: "agent-bridge/content-subtitles.ts" },
  { name: "agent-bridge-frame", source: "agent-bridge/frame.ts" },
  { name: "settings-panel", source: "ui/settings-panel.ts" },
  { name: "provider-editor", source: "ui/provider-editor.ts" },
  { name: "explain", source: "ai/explain.ts" },
  { name: "pipeline", source: "asr/pipeline.ts" },
  { name: "playback-rate", source: "bilibili/playback-rate.ts" },
  { name: "fallback", source: "asr/fallback.ts" },
  { name: "analysis", source: "ai/analysis.ts" },
  { name: "model-catalog", source: "ai/model-catalog.ts" },
  { name: "mermaid-render", source: "ui/mermaid-render.ts" },
  { name: "math-render", source: "ui/math-render.ts" },
  { name: "onboarding", source: "entry/onboarding.ts" },
];
const lazyTargetExternals = new Map(
  lazyTargets.map(({ name, source }) => [
    path.join(extensionRoot, source),
    `./chunks/${name}.mjs`,
  ])
);

const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");
const versionTsPath = path.join(__dirname, "..", "extension", "core", "version.ts");

const manifestVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
const versionTsText = fs.readFileSync(versionTsPath, "utf8");
const versionTsMatch = /export const BILISCRIPT_VERSION = "([^"]+)"/.exec(versionTsText);
const versionTsVersion = versionTsMatch ? versionTsMatch[1] : null;

if (!versionTsVersion || versionTsVersion !== manifestVersion) {
  console.error(
    `Version mismatch: ${manifestPath} has "version": ${manifestVersion}, ` +
      `but ${versionTsPath} declares BILISCRIPT_VERSION = ${versionTsVersion ?? "(unparseable)"}`
  );
  process.exit(1);
}

if (targetPlatform === "chromium") {
  const manifestMinimumChromeVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).minimum_chrome_version;
  const buildTargetChromeVersion = esbuildTarget.replace(/^chrome/, "");
  if (manifestMinimumChromeVersion !== buildTargetChromeVersion) {
    console.error(
      `Minimum-Chrome mismatch: ${manifestPath} has "minimum_chrome_version": ${manifestMinimumChromeVersion}, ` +
        `but BUILD_TARGET (${esbuildTarget}) implies ${buildTargetChromeVersion}`
    );
    process.exit(1);
  }
}

const REQUIRED_MARKER = "__BILISCRIPT_CONTENT_SCRIPT_LOADED__";
const MAIN_MODULE_BASENAME = "content-main.mjs";

const localImportGuard = createLocalImportGuard(extensionRoot);

const mermaidPackageFile = /(?:[\\/]node_modules[\\/]mermaid[\\/]|[\\/]mermaid@[^\\/]+[\\/]node_modules[\\/]mermaid[\\/])/;
const mermaidSlimAlias = {
  name: "mermaid-slim-round-b-only",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^marked$/ }, (args) => {
      if (!mermaidPackageFile.test(args.importer)) {
        return undefined;
      }
      return { path: path.join(__dirname, "..", "scripts", "vendor-marked-stub.mjs") };
    });
    buildApi.onResolve({ filter: /^d3$/ }, (args) => {
      if (!mermaidPackageFile.test(args.importer)) {
        return undefined;
      }
      return { path: path.join(__dirname, "..", "scripts", "vendor-d3-slim.mjs") };
    });
    buildApi.onResolve({ filter: /^mermaid$/ }, (args) => {
      const importer = path.resolve(args.importer);
      const mermaidRenderSource = path.join(extensionRoot, "ui", "mermaid-render.ts");
      if (args.path !== "mermaid" || importer !== mermaidRenderSource) {
        return undefined;
      }
      return { path: fs.realpathSync(slimMermaidEntry) };
    });
    buildApi.onResolve({ filter: /^@iconify\/utils$/ }, () => ({
      path: path.join(__dirname, "..", "scripts", "vendor-iconify-stub.mjs"),
    }));
  },
};

const lazyTargetExternal = {
  name: "lazy-target-external",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^\.\.?\// }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      const candidates = [resolved];
      if (resolved.endsWith(".js")) {
        candidates.push(resolved.slice(0, -3) + ".ts");
      }
      for (const candidate of candidates) {
        const externalPath = lazyTargetExternals.get(candidate);
        if (externalPath) return { path: externalPath, external: true };
      }
      return undefined;
    });
  },
};

function cleanPreviousOutput() {
  for (const stale of [legacyOutfile, mainOutfile, bootstrapOutfile]) {
    fs.rmSync(stale, { force: true });
  }
  fs.rmSync(chunksDir, { recursive: true, force: true });
}

function syntaxCheck(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

function sizeInBytes(file) {
  return fs.statSync(file).size;
}

const lazyChunkOptions = {
  entryPoints: Object.fromEntries(
    lazyTargets.map(({ name, source }) => [name, path.join(extensionRoot, source)])
  ),
  outdir: chunksDir,
  entryNames: "[name]",
  chunkNames: "[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  minify: true,
  sourcemap: true,
  metafile: true,
  target: esbuildTarget,
  plugins: [localImportGuard, mermaidSlimAlias],
};

const mainPackageOptions = {
  entryPoints: { "content-main": entry },
  outdir: outDir,
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "browser",
  minify: true,
  sourcemap: true,
  target: esbuildTarget,
  plugins: [localImportGuard, lazyTargetExternal],
};

const bootstrapOptions = {
  entryPoints: [bootstrapEntry],
  outfile: bootstrapOutfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  minify: true,
  sourcemap: true,
  target: esbuildTarget,
  plugins: [localImportGuard],
};

const workletOptions = {
  entryPoints: [workletEntry],
  outfile: workletOutfile,
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "browser",
  minify: true,
  sourcemap: true,
  target: esbuildTarget,
  plugins: [localImportGuard],
};

const watchRebuildLog = {
  name: "watch-rebuild-log",
  setup(buildApi) {
    let first = true;
    buildApi.onEnd((result) => {
      if (first) {
        first = false;
        return;
      }
      if (result.errors.length > 0) return;
      console.log(`[watch] content rebuilt at ${new Date().toLocaleTimeString()}`);
    });
  },
};

async function main() {
  execFileSync(process.execPath, [vendorMermaidSlimScript], { stdio: "inherit" });
  cleanPreviousOutput();
  if (!watchMode) {
    const lazyResult = await build(lazyChunkOptions);
    await build(workletOptions);
    await build(mainPackageOptions);
    await build(bootstrapOptions);
    if (!selfCheck()) {
      return;
    }
    report(lazyResult.metafile);
    return;
  }
  const lazyCtx = await context({
    ...lazyChunkOptions,
    plugins: [...lazyChunkOptions.plugins, watchRebuildLog],
  });
  const workletCtx = await context({
    ...workletOptions,
    plugins: [...workletOptions.plugins, watchRebuildLog],
  });
  const mainCtx = await context({
    ...mainPackageOptions,
    plugins: [...mainPackageOptions.plugins, watchRebuildLog],
  });
  const bootstrapCtx = await context({
    ...bootstrapOptions,
    plugins: [...bootstrapOptions.plugins, watchRebuildLog],
  });
  const lazyRebuild = await lazyCtx.rebuild();
  await workletCtx.rebuild();
  await mainCtx.rebuild();
  await bootstrapCtx.rebuild();
  if (!selfCheck()) {
    process.exit(1);
  }
  report(lazyRebuild.metafile);
  await Promise.all([lazyCtx.watch(), workletCtx.watch(), mainCtx.watch(), bootstrapCtx.watch()]);
  console.log("[watch] build-content watching for changes...");
}

function selfCheck() {
  syntaxCheck(bootstrapOutfile);
  const bootstrapText = fs.readFileSync(bootstrapOutfile, "utf8");
  if (!bootstrapText.includes(REQUIRED_MARKER)) {
    console.error(
      `Self-check failed: ${bootstrapOutfile} is missing required marker ${REQUIRED_MARKER}`
    );
    process.exitCode = 1;
    return false;
  }
  if (!bootstrapText.includes(MAIN_MODULE_BASENAME)) {
    console.error(
      `Self-check failed: ${bootstrapOutfile} does not reference ${MAIN_MODULE_BASENAME}`
    );
    process.exitCode = 1;
    return false;
  }

  syntaxCheck(mainOutfile);
  if (fs.existsSync(chunksDir)) {
    for (const chunkFile of fs.readdirSync(chunksDir)) {
      if (chunkFile.endsWith(".mjs")) {
        syntaxCheck(path.join(chunksDir, chunkFile));
      }
    }
  }

  if (!fs.existsSync(workletOutfile)) {
    console.error(`Self-check failed: missing AudioWorklet output ${workletOutfile}`);
    process.exitCode = 1;
    return false;
  }
  const workletText = fs.readFileSync(workletOutfile, "utf8");
  if (!workletText.includes("registerProcessor") || /\b(?:window|document)\b/.test(workletText)) {
    console.error(
      `Self-check failed: ${workletOutfile} 缺少 registerProcessor 或包含主线程 DOM 全局符号`
    );
    process.exitCode = 1;
    return false;
  }

  const mainText = fs.readFileSync(mainOutfile, "utf8");
  if (!mainText.includes("import(")) {
    console.error(
      `Self-check failed: ${mainOutfile} 不含动态 import(，懒加载边界被内联`
    );
    process.exitCode = 1;
    return false;
  }
  const mainTextWithoutDynamicImports = mainText.replace(
    /import\s*\(\s*"[^"]*"\s*\)/g,
    ""
  );
  if (/"\.\/chunks\//.test(mainTextWithoutDynamicImports)) {
    console.error(
      `Self-check failed: ${mainOutfile} 静态引用 chunks/——常驻图必须保持` +
        `单文件（2 请求），懒加载目标只能经动态 import() 按需装载`
    );
    process.exitCode = 1;
    return false;
  }
  return (
    assertSharedSlotsInBothRegions() &&
    assertMermaidStubsApplied() &&
    assertDualInstanceAllowlist()
  );
}

const MERMAID_STUB_SOURCES = ["vendor-marked-stub.mjs", "vendor-d3-slim.mjs"];
const MERMAID_CLOSURE_ENTRY = "mermaid-render.mjs";

function collectMermaidClosureFiles() {
  const files = new Set();
  const queue = [MERMAID_CLOSURE_ENTRY];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    const full = path.join(chunksDir, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const match of text.matchAll(
      /import\s*(?:[\w${},*\s]+\s*from\s*)?["'](\.\/[^"']+)["']/g
    )) {
      queue.push(path.posix.basename(match[1]));
    }
  }
  return files;
}

function assertMermaidStubsApplied() {
  const closureFiles = collectMermaidClosureFiles();
  const sources = new Set();
  for (const file of closureFiles) {
    const mapFile = path.join(chunksDir, `${file}.map`);
    if (!fs.existsSync(mapFile)) continue;
    for (const source of JSON.parse(fs.readFileSync(mapFile, "utf8")).sources ?? []) {
      sources.add(source);
    }
  }
  const basename = (source) => source.split(/[\\/]/).pop() ?? source;
  for (const stub of MERMAID_STUB_SOURCES) {
    if (![...sources].some((source) => basename(source) === stub)) {
      console.error(
        `Self-check failed: mermaid 闭包未包含体积替身 ${stub}——` +
          "build-content.js 的 marked/d3 alias 可能已失效"
      );
      process.exitCode = 1;
      return false;
    }
  }
  for (const source of sources) {
    if (/[\\/]marked[\\/]/.test(source) || /[\\/]node_modules[\\/]d3[\\/]/.test(source)) {
      console.error(
        `Self-check failed: mermaid 闭包 sourcemap 含 umbrella 依赖 ${source}——` +
          "marked/d3 体积替身被绕过"
      );
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}

const SLOT_KEY_DECLARATION = /\b[A-Z_]*SLOT_KEY\s*=\s*"(__BILISCRIPT_[A-Z_]+__)"/g;

function collectSlotKeys() {
  const keys = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) {
        continue;
      }
      const text = fs.readFileSync(full, "utf8");
      for (const match of text.matchAll(SLOT_KEY_DECLARATION)) {
        keys.set(match[1], path.relative(extensionRoot, full));
      }
    }
  };
  walk(extensionRoot);
  return keys;
}

function assertSharedSlotsInBothRegions() {
  const slotKeys = collectSlotKeys();
  if (slotKeys.size === 0) {
    console.error(
      'Self-check failed: 未发现任何跨实例共享槽声明（*_SLOT_KEY = "__BILISCRIPT_...__"）' +
        "——约定见本函数头注，槽全没了意味着跨实例状态没挂共享槽"
    );
    process.exitCode = 1;
    return false;
  }
  const mainText = fs.readFileSync(mainOutfile, "utf8");
  const chunkTexts = fs.existsSync(chunksDir)
    ? fs
        .readdirSync(chunksDir)
        .filter((file) => file.endsWith(".mjs"))
        .map((file) => fs.readFileSync(path.join(chunksDir, file), "utf8"))
    : [];
  const missing = [];
  for (const [key, source] of slotKeys) {
    if (!mainText.includes(key)) {
      missing.push(`${key}（${source}）不在常驻包 ${MAIN_MODULE_BASENAME}`);
    } else if (!chunkTexts.some((text) => text.includes(key))) {
      missing.push(`${key}（${source}）不在任何懒加载区 chunk`);
    }
  }
  if (missing.length > 0) {
    console.error(
      "Self-check failed: 跨实例共享槽未两侧落位——两轮构建下共享底座在常驻包与" +
        "懒加载区各一份实例，槽必须两侧都挂（shared/messaging.ts 先例）：\n  " +
        missing.join("\n  ")
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

const DUAL_INSTANCE_STATEFUL_MARKER = "BILISCRIPT_DUAL_INSTANCE_STATEFUL";

const DUAL_INSTANCE_ALLOWLIST = [
  { source: "core/state.ts", mutable: true },
  { source: "reader/reader-bus.ts", mutable: true },
  { source: "reader/state.ts", mutable: true },
  { source: "shared/content-event-bus.ts", mutable: true },
  { source: "shared/lazy-import.ts", mutable: true },
  { source: "shared/logging.ts", mutable: true },
  { source: "shared/messaging.ts", mutable: true },
  { source: "shared/style-injector.ts", mutable: true },
  { source: "shared/watch-storage-keys.ts", mutable: true },
  { source: "ai/lazy-player-ai.ts", mutable: true },
  { source: "reader/lazy-reader.ts", mutable: true },
  { source: "reader/lazy-shell.ts", mutable: true },
  { source: "subtitle/lazy.ts", mutable: true },
  { source: "ui/lazy-ui.ts", mutable: true },
  { source: "bilibili/host-selectors.ts", mutable: false },
  { source: "bilibili/video-id-shared.ts", mutable: false },
  { source: "core/defaults.ts", mutable: false },
  { source: "core/runtime.ts", mutable: false },
  { source: "reader/presentation-fields.ts", mutable: false },
  { source: "shared/dom-ids.ts", mutable: false },
  { source: "shared/error-helpers.ts", mutable: false },
  { source: "shared/typed-event-bus.ts", mutable: false },
  { source: "shared/utils.ts", mutable: false },
  { source: "bilibili/video-probe.ts", mutable: true },
  { source: "subtitle/subtitle-in-hand.ts", mutable: false },
  { source: "subtitle/kick-subtitle-fetch.ts", mutable: false }
];

function readMapExtensionSources(mapFile) {
  const mapJson = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  return sourcesFromMap(mapJson, path.dirname(mapFile), extensionRoot);
}

function collectDualInstanceSources() {
  const mainSources = new Set(readMapExtensionSources(`${mainOutfile}.map`));
  const chunkMaps = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((file) => file.endsWith(".map"))
    : [];
  const lazySources = new Set();
  for (const chunkMap of chunkMaps) {
    for (const source of readMapExtensionSources(path.join(chunksDir, chunkMap))) {
      lazySources.add(source);
    }
  }
  return [...mainSources].filter((source) => lazySources.has(source));
}

function assertDualInstanceAllowlist() {
  const { unexpected, missing } = diffDualInstanceAllowlist(
    collectDualInstanceSources(),
    DUAL_INSTANCE_ALLOWLIST.map((entry) => entry.source)
  );
  const markerMismatches = [];
  for (const entry of DUAL_INSTANCE_ALLOWLIST) {
    const text = fs.readFileSync(path.join(extensionRoot, entry.source), "utf8");
    const hasMarker = text.includes(DUAL_INSTANCE_STATEFUL_MARKER);
    if (entry.mutable && !hasMarker) {
      markerMismatches.push(
        `${entry.source}：清单标 mutable: true，头注缺少 ${DUAL_INSTANCE_STATEFUL_MARKER} 标记`
      );
    } else if (!entry.mutable && hasMarker) {
      markerMismatches.push(
        `${entry.source}：头注声明了 ${DUAL_INSTANCE_STATEFUL_MARKER}，清单未标 mutable: true`
      );
    }
  }
  if (unexpected.length + missing.length + markerMismatches.length === 0) {
    return true;
  }
  const details = [];
  for (const source of unexpected) {
    details.push(
      `${source} 变成了双实例但不在清单——若含模块级可变状态，先评估两侧安全性，` +
        `入清单（mutable: true + 头注 ${DUAL_INSTANCE_STATEFUL_MARKER} 标记），否则标 mutable: false`
    );
  }
  for (const source of missing) {
    details.push(`${source} 在清单里但构建产物中已不双实例——从清单移除`);
  }
  details.push(...markerMismatches);
  console.error(
    "Self-check failed: 双实例纪律对账未过（约定见 docs/adr/0004-content-two-round-build-and-reader-gate.md）：\n  " +
      details.join("\n  ")
  );
  process.exitCode = 1;
  return false;
}

function assertAnalysisNotInReaderGraph(meta) {
  const violations = findForbiddenInputs(meta, {
    seed: "reader/lifecycle.ts",
    forbidden: ["ai/analysis.ts"],
    outputExtensions: [".mjs"]
  });
  for (const { output } of violations) {
    console.error(
      `build-content.js: reader 装载图 ${output} 含 ai/analysis.ts——` +
        `概览管线必须经 startOverviewRun 动态 import 按需装载`
    );
  }
  if (violations.length > 0) {
    process.exit(1);
  }
}

const SCRIPT_BUTTON_FORBIDDEN_INPUTS = [
  "reader/shell.ts",
  "reader/quote-share-export.ts",
  "reader/quote-share-modal.ts"
];

function assertScriptButtonSlim(meta) {
  const violations = findForbiddenInputs(meta, {
    seed: "ui/script-button.ts",
    forbidden: SCRIPT_BUTTON_FORBIDDEN_INPUTS,
    outputExtensions: [".mjs"]
  });
  for (const { output, hits } of violations) {
    console.error(
      `build-content.js: script-button 装载图 ${output} 静态包含禁区模块 ${hits.join(", ")}——` +
        `完好性判定必须走 reader/shell-intact.ts 叶子模块`
    );
  }
  if (violations.length > 0) {
    process.exit(1);
  }
}

const PLAYER_AI_FORBIDDEN_INPUTS = [
  "live/player-interpret.ts",
  "subtitle/cache.ts",
  "ai/l0-bm25.ts"
];

function assertPlayerAiSlim(meta) {
  const violations = findForbiddenInputs(meta, {
    seed: "ai/player-ai.ts",
    forbidden: PLAYER_AI_FORBIDDEN_INPUTS,
    outputExtensions: [".mjs"]
  });
  for (const { output, hits } of violations) {
    console.error(
      `build-content.js: player-ai 装载图 ${output} 静态包含禁区模块 ${hits.join(", ")}——` +
        `同传菜单与控制器必须经动态 import("../live/player-interpret.js") 按需装载`
    );
  }
  if (violations.length > 0) {
    process.exit(1);
  }
}

function report(lazyMeta) {
  assertAnalysisNotInReaderGraph(lazyMeta);
  assertScriptButtonSlim(lazyMeta);
  assertPlayerAiSlim(lazyMeta);
  const bootstrapSize = sizeInBytes(bootstrapOutfile);
  const mainSize = sizeInBytes(mainOutfile);
  const chunkFiles = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((f) => f.endsWith(".mjs")).sort()
    : [];
  const lazyNames = new Set(lazyTargets.map(({ name }) => name));
  const lazyChunkFiles = chunkFiles.filter((f) =>
    lazyNames.has(f.replace(/\.mjs$/, ""))
  );
  const sharedChunkFiles = chunkFiles.filter(
    (f) => !lazyNames.has(f.replace(/\.mjs$/, ""))
  );
  const lazyChunkTotal = lazyChunkFiles.reduce(
    (sum, f) => sum + sizeInBytes(path.join(chunksDir, f)),
    0
  );
  const sharedChunkTotal = sharedChunkFiles.reduce(
    (sum, f) => sum + sizeInBytes(path.join(chunksDir, f)),
    0
  );

  console.log(`Wrote ${bootstrapOutfile} (classic IIFE bootstrap, minified: true, ${bootstrapSize} bytes)`);
  console.log(`Wrote ${mainOutfile} (ESM main package, single-file resident graph, minified: true, ${mainSize} bytes)`);
  if (chunkFiles.length === 0) {
    console.log("No chunks produced (no import boundaries in the module graph).");
  } else {
    for (const chunkFile of lazyChunkFiles) {
      console.log(
        `Wrote ${path.join(chunksDir, chunkFile)} (lazy entry chunk, on-demand, ${sizeInBytes(path.join(chunksDir, chunkFile))} bytes)`
      );
    }
    for (const chunkFile of sharedChunkFiles) {
      console.log(
        `Wrote ${path.join(chunksDir, chunkFile)} (shared chunk, on-demand, ${sizeInBytes(path.join(chunksDir, chunkFile))} bytes)`
      );
    }
    console.log(
      `Lazy entry chunks (on-demand): ${lazyChunkTotal} bytes across ${lazyChunkFiles.length} file(s)`
    );
    console.log(
      `Shared chunks (on-demand): ${sharedChunkTotal} bytes across ${sharedChunkFiles.length} file(s)`
    );
  }
  const residentTotal = bootstrapSize + mainSize;
  console.log(`Resident requests (bootstrap + main): 2`);
  console.log(
    `Resident total (bootstrap + main): ${residentTotal} bytes`
  );

  const MAX_RESIDENT_BYTES = 40960;
  if (residentTotal > MAX_RESIDENT_BYTES) {
    console.error(
      `build-content.js: Content 常驻体积超限！当前 ${residentTotal} B > 预算上限 ${MAX_RESIDENT_BYTES} B`
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
