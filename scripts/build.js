const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { build, context } = require("esbuild");
const {
  createLocalImportGuard,
  sourcesFromMap,
  findForbiddenInputs,
  resolveTargetPlatform,
  getEsbuildTarget,
} = require("./build-guards.js");
const { deriveFirefoxManifest, loadExtensionPresets } = require("./firefox-manifest.js");

const targetPlatform = resolveTargetPlatform(process.argv);
const esbuildTarget = getEsbuildTarget(targetPlatform);
const distDirName = targetPlatform === "firefox" ? "dist-firefox" : "dist";

const watchMode = process.argv.includes("--watch");

const root = path.join(__dirname, "..");
process.chdir(root);

const extensionRoot = path.join(root, "extension");
const distDir = path.join(root, distDirName);

const jsEntries = [
  "entry/background.ts",
  "entry/permission-grant.ts",
];

const stylesDir = path.join(extensionRoot, "entry/styles");
const cssEntries = fs
  .readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .sort()
  .map((name) => `entry/styles/${name}`);

const copyFiles = [
  "manifest.json",
  "onboarding.html",
  "entry/offscreen.html",
  "entry/permission-grant.html",
  "entry/theme-init.js",
  "entry/content-bootstrap.iife.js",
  "entry/content-bootstrap.iife.js.map",
  "entry/content-main.mjs",
  "entry/content-main.mjs.map",
];

const copyDirs = ["icons", "entry/chunks", "_locales"];

const BACKGROUND_JS_MAX_KB = 256;

const localImportGuard = createLocalImportGuard(extensionRoot);

function cleanDist() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
}

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
      console.log(`[watch] dist rebuilt at ${new Date().toLocaleTimeString()}`);
    });
  },
};

function runContentBuild() {
  const args = [path.join(root, "scripts", "build-content.js")];
  if (targetPlatform !== "chromium") {
    args.push(`--target=${targetPlatform}`);
  }
  execFileSync(process.execPath, args, {
    stdio: "inherit",
  });
}

function writeTargetManifest() {
  const src = path.join(extensionRoot, "manifest.json");
  if (!fs.existsSync(src)) {
    console.error("build.js: missing expected file: extension/manifest.json");
    process.exit(1);
  }
  const dest = path.join(distDir, "manifest.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (targetPlatform === "firefox") {
    const chromiumManifest = JSON.parse(fs.readFileSync(src, "utf8"));
    const presetsData = loadExtensionPresets(path.join(extensionRoot, "core", "presets.ts"));
    const firefoxManifest = deriveFirefoxManifest(chromiumManifest, presetsData);
    fs.writeFileSync(dest, JSON.stringify(firefoxManifest, null, 2) + "\n", "utf8");
  } else {
    fs.copyFileSync(src, dest);
  }
}

function copyStaticAssets() {
  for (const rel of copyFiles) {
    if (rel === "manifest.json") {
      writeTargetManifest();
      continue;
    }
    const src = path.join(extensionRoot, rel);
    if (!fs.existsSync(src)) {
      console.error(`build.js: missing expected file: extension/${rel}`);
      process.exit(1);
    }
    const dest = path.join(distDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  for (const dir of copyDirs) {
    const src = path.join(extensionRoot, dir);
    if (!fs.existsSync(src)) {
      console.error(`build.js: missing expected directory: extension/${dir}`);
      process.exit(1);
    }
    copyDirRecursive(src, path.join(distDir, dir));
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function restJsOptions() {
  return {
    entryPoints: jsEntries.map((rel) => path.join(extensionRoot, rel)),
    outbase: extensionRoot,
    outdir: distDir,
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "browser",
    minify: true,
    sourcemap: true,
    target: esbuildTarget,
    metafile: true,
    logLevel: "warning",
    plugins: [localImportGuard],
  };
}

function offscreenOptions() {
  return {
    entryPoints: [path.join(extensionRoot, "entry/offscreen.ts")],
    outbase: extensionRoot,
    outdir: distDir,
    bundle: true,
    splitting: true,
    format: "esm",
    chunkNames: "entry/offscreen-chunks/[name]-[hash]",
    platform: "browser",
    minify: true,
    sourcemap: true,
    target: esbuildTarget,
    metafile: true,
    logLevel: "warning",
    plugins: [localImportGuard],
  };
}

function cssOptions() {
  return {
    entryPoints: cssEntries.map((rel) => path.join(extensionRoot, rel)),
    outbase: extensionRoot,
    outdir: distDir,
    bundle: true,
    minify: true,
    sourcemap: true,
    metafile: true,
    loader: { ".woff2": "copy" },
    assetNames: "fonts/[name]",
    logLevel: "warning",
    plugins: [localImportGuard],
  };
}

function syntaxCheckEsm(file) {
  execFileSync(process.execPath, ["--input-type=module", "--check"], {
    input: fs.readFileSync(file),
    stdio: ["pipe", "ignore", "inherit"],
  });
}

function assertManifestReferences() {
  const manifestPath = path.join(distDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`build.js: dist/manifest.json is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  const distFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else distFiles.push(path.relative(distDir, full).split(path.sep).join("/"));
    }
  })(distDir);

  const refs = [];
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
  if (Array.isArray(manifest.background?.scripts)) refs.push(...manifest.background.scripts);

  const wildcardHostPatterns = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"];
  const residentWildcards = (manifest.host_permissions || []).filter((p) => wildcardHostPatterns.includes(p));
  if (residentWildcards.length > 0) {
    console.error(
      `build.js: manifest host_permissions 含通配符 ${residentWildcards.join(", ")}，` +
        `必须移入 optional_host_permissions（按需申请）`
    );
    process.exit(1);
  }

  for (const p of Object.values(manifest.icons ?? {})) refs.push(p);
  if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
  for (const p of Object.values(manifest.action?.default_icon ?? {})) refs.push(p);
  if (manifest.options_page) refs.push(manifest.options_page);
  for (const cs of manifest.content_scripts ?? []) {
    refs.push(...(cs.js ?? []), ...(cs.css ?? []));
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    refs.push(...(war.resources ?? []));
  }

  const missing = [];
  for (const ref of refs) {
    if (ref.includes("*")) {
      const re = new RegExp("^" + ref.split("*").map(escapeRegExp).join(".*") + "$");
      if (!distFiles.some((f) => re.test(f))) missing.push(ref);
    } else if (!distFiles.includes(ref)) {
      missing.push(ref);
    }
  }
  if (missing.length > 0) {
    console.error(
      `build.js: dist/manifest.json references missing files:\n` +
        missing.map((m) => `  - ${m}`).join("\n")
    );
    process.exit(1);
  }
  return refs;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertBackgroundBundleSize() {
  const backgroundPath = path.join(distDir, "entry", "background.js");
  const bytes = fs.statSync(backgroundPath).size;
  const maxBytes = BACKGROUND_JS_MAX_KB * 1024;
  if (bytes > maxBytes) {
    console.error(
      `build.js: dist/entry/background.js 体积为 ${bytes} B (${(bytes / 1024).toFixed(1)} KB)，` +
        `超过上限 ${BACKGROUND_JS_MAX_KB} KB（${maxBytes} B）`
    );
    process.exit(1);
  }
}

const BACKGROUND_FORBIDDEN_STATIC_SOURCES = [
  /(^|\/)ai\/adapters\//,
  /(^|\/)ai\/thinking-profiles\.ts$/,
  /(^|\/)ai\/plan-thinking\.ts$/,
  /(^|\/)ai\/sse-parser\.ts$/,
  /(^|\/)ai\/protocol-adapter\.ts$/,
  /(^|\/)ai\/catalog\/models-dev-catalog\.generated\.ts$/,
  /(^|\/)ai\/catalog\/models-dev-thinking\.generated\.ts$/,
  /(^|\/)ai\/model-catalog\.ts$/,
];
function assertBackgroundStaticGraphSlim() {
  const mapPath = path.join(distDir, "entry", "background.js.map");
  const sources = sourcesFromMap(
    JSON.parse(fs.readFileSync(mapPath, "utf8")),
    path.dirname(mapPath),
    extensionRoot
  );
  const leaked = sources.filter((source) =>
    BACKGROUND_FORBIDDEN_STATIC_SOURCES.some((re) => re.test(source))
  );
  if (leaked.length > 0) {
    console.error(
      "build.js: SW 静态图包含禁止的模块（协议栈须留在词表叶后 / 模型目录只能懒加载）：\n" +
        leaked.map((source) => `  - ${source}`).join("\n")
    );
    process.exit(1);
  }
}

function assertHtmlReferences() {
  const htmlFiles = copyFiles.filter((f) => f.endsWith(".html"));
  const missing = [];
  for (const rel of htmlFiles) {
    const text = fs.readFileSync(path.join(distDir, rel), "utf8");
    const baseDir = path.dirname(path.join(distDir, rel));
    for (const match of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = match[1];
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith("#") || ref.startsWith("data:")) {
        continue;
      }
      const resolved = path.relative(distDir, path.resolve(baseDir, ref)).split(path.sep).join("/");
      if (!fs.existsSync(path.join(distDir, resolved))) {
        missing.push(`${rel} -> ${ref}`);
      }
    }
  }
  if (missing.length > 0) {
    console.error(
      `build.js: dist html files reference missing files:\n` +
        missing.map((m) => `  - ${m}`).join("\n")
    );
    process.exit(1);
  }
}

const LADDER_CHUNK_FORBIDDEN_INPUTS = [
  "notes/render.ts",
  "subtitle/selection.ts",
  "core/validators.ts",
  "core/cache-lru.ts",
  "ai/segment-cache.ts",
  "subtitle/cache.ts"
];

function assertLadderChunkSlim(meta) {
  const violations = findForbiddenInputs(meta, {
    seed: "ai/ladder.ts",
    forbidden: LADDER_CHUNK_FORBIDDEN_INPUTS,
    outputExtensions: [".js"]
  });
  for (const { output, hits } of violations) {
    console.error(
      `build.js: ladder chunk ${output} 含 ${hits.join(", ")}——` +
        `prompt 组装走 notes/section-lines 与 subtitle/chapters 窄叶子；段缓存经 segment-cache-proxy 消息到 SW，存储层不进 chunk`
    );
  }
  if (violations.length > 0) {
    process.exit(1);
  }
}

function formatBytes(n) {
  return `${String(n).padStart(7)} B`;
}

function sumRawBytes(meta) {
  return Object.keys(meta.inputs).reduce(
    (sum, input) => sum + fs.statSync(path.resolve(root, input)).size,
    0
  );
}

function printEntryReport(result, label) {
  const outputs = Object.entries(result.metafile.outputs)
    .filter(([file]) => !file.endsWith(".map"));
  console.log(`== ${label} ==`);
  let totalRaw = 0;
  let totalMin = 0;
  for (const [outfile, meta] of outputs) {
    const raw = sumRawBytes(meta);
    const min = meta.bytes;
    const ratio = raw > 0 ? `-${((1 - min / raw) * 100).toFixed(1)}%` : "n/a";
    const relOut = path.relative(root, path.resolve(root, outfile));
    console.log(
      `${relOut.padEnd(34)} raw ${formatBytes(raw).padEnd(12)} -> min ${formatBytes(min).padEnd(12)} (${ratio})`
    );
    totalRaw += raw;
    totalMin += min;
  }
  const ratio = totalRaw > 0 ? `-${((1 - totalMin / totalRaw) * 100).toFixed(1)}%` : "n/a";
  console.log(
    `${"subtotal".padEnd(34)} raw ${formatBytes(totalRaw).padEnd(12)} -> min ${formatBytes(totalMin).padEnd(12)} (${ratio})`
  );
  return { totalRaw, totalMin };
}

function printOffscreenSplitReport(result) {
  const outputs = Object.entries(result.metafile.outputs)
    .filter(([file]) => !file.endsWith(".map"));
  let entryRaw = 0;
  let entryMin = 0;
  let chunkRaw = 0;
  let chunkMin = 0;
  let chunkCount = 0;
  for (const [outfile, meta] of outputs) {
    const raw = sumRawBytes(meta);
    const min = meta.bytes;
    if (path.basename(outfile) === "offscreen.js") {
      entryRaw = raw;
      entryMin = min;
    } else {
      chunkRaw += raw;
      chunkMin += min;
      chunkCount += 1;
    }
  }
  console.log("== offscreen 拆分（dist/entry，splitting） ==");
  console.log(
    `${"  entry/offscreen.js（常驻 wiring）".padEnd(38)} raw ${formatBytes(entryRaw).padEnd(12)} -> min ${formatBytes(entryMin).padEnd(12)}`
  );
  console.log(
    `${`  entry/offscreen-chunks/*（动态 x${chunkCount}）`.padEnd(38)} raw ${formatBytes(chunkRaw).padEnd(12)} -> min ${formatBytes(chunkMin).padEnd(12)}`
  );
  return { entryRaw, entryMin, chunkRaw, chunkMin, chunkCount };
}

const DIST_RUNTIME_MAX_BYTES = 3900000;

function printDistSummary() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  })(distDir);
  const total = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  const runtimeFiles = files.filter((f) => !f.endsWith(".map"));
  const runtimeTotal = runtimeFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  console.log(`== dist 总量 ==`);
  console.log(`all files: ${files.length}, total bytes: ${total} B (${(total / 1024).toFixed(1)} KB)`);
  console.log(`runtime files (no .map): ${runtimeFiles.length}, runtime bytes: ${runtimeTotal} B (${(runtimeTotal / 1024).toFixed(1)} KB)`);

  if (runtimeTotal > DIST_RUNTIME_MAX_BYTES) {
    console.error(
      `build.js: dist 运行时体积超限！当前 ${runtimeTotal} B > 预算上限 ${DIST_RUNTIME_MAX_BYTES} B`
    );
    process.exit(1);
  }
}

async function main() {
  cleanDist();
  runContentBuild();
  copyStaticAssets();

  const jobOptions = [restJsOptions(), offscreenOptions(), cssOptions()];
  let jsResult, offscreenResult, cssResult;
  let esbuildContexts = null;
  if (watchMode) {
    esbuildContexts = await Promise.all(
      jobOptions.map((opts) => context({ ...opts, plugins: [...opts.plugins, watchRebuildLog] }))
    );
    [jsResult, offscreenResult, cssResult] = await Promise.all(
      esbuildContexts.map((ctx) => ctx.rebuild())
    );
  } else {
    [jsResult, offscreenResult, cssResult] = await Promise.all(
      jobOptions.map((opts) => build(opts))
    );
  }

  const outputs = [jsResult, offscreenResult]
    .flatMap((result) => Object.keys(result.metafile.outputs))
    .filter((f) => f.endsWith(".js") || f.endsWith(".ts"));
  for (const outfile of outputs) {
    syntaxCheckEsm(path.resolve(root, outfile));
  }
  assertManifestReferences();
  assertHtmlReferences();
  assertBackgroundBundleSize();
  assertBackgroundStaticGraphSlim();
  assertLadderChunkSlim(offscreenResult.metafile);

  const offscreenDist = fs.readFileSync(path.join(distDir, "entry", "offscreen.js"), "utf8");
  if (!offscreenDist.includes("import(")) {
    console.error("build.js: dist/entry/offscreen.js 不含动态 import(，offscreen splitting 失效");
    process.exit(1);
  }

  console.log("");
  printEntryReport(jsResult, `多入口 bundle（${distDirName}/，单文件、无 splitting）`);
  console.log("");
  const offscreenSplit = printOffscreenSplitReport(offscreenResult);
  if (offscreenSplit.chunkCount === 0) {
    console.error("build.js: offscreen splitting 未产出任何动态 chunk");
    process.exit(1);
  }
  console.log("");
  printEntryReport(cssResult, `CSS minify（${distDirName}/）`);
  console.log("");
  printDistSummary();
  console.log("");
  console.log(`${distDirName}/ assembled at ${distDir}`);

  if (watchMode) {
    await startWatch(esbuildContexts);
  }
}

async function startWatch(esbuildContexts) {
  const watchArgs = [path.join(root, "scripts", "build-content.js"), "--watch"];
  if (targetPlatform !== "chromium") {
    watchArgs.push(`--target=${targetPlatform}`);
  }
  const child = spawn(
    process.execPath,
    watchArgs,
    { stdio: "inherit" }
  );
  const shutdown = () => {
    child.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => child.kill());

  let recopyTimer = null;
  const scheduleRecopy = () => {
    if (recopyTimer) clearTimeout(recopyTimer);
    recopyTimer = setTimeout(() => {
      recopyTimer = null;
      const contentArtifactsReady =
        copyFiles.every((rel) => fs.existsSync(path.join(extensionRoot, rel))) &&
        copyDirs.every((dir) => fs.existsSync(path.join(extensionRoot, dir)));
      if (!contentArtifactsReady) return;
      copyStaticAssets();
      console.log(`[watch] static/content assets re-copied at ${new Date().toLocaleTimeString()}`);
    }, 150);
  };

  fs.watch(extensionRoot, (event, filename) => {
    if (filename === "manifest.json") scheduleRecopy();
  });
  for (const dir of copyDirs) {
    fs.watch(path.join(extensionRoot, dir), scheduleRecopy);
  }
  fs.watch(path.join(extensionRoot, "entry"), (event, filename) => {
    if (filename && copyFiles.includes(`entry/${filename}`)) scheduleRecopy();
  });

  await Promise.all(esbuildContexts.map((ctx) => ctx.watch()));
  console.log("[watch] watching for changes... (load dist/ unpacked; reload the extension after rebuilds)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
