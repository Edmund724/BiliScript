const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { build, context } = require("esbuild");
const {
  createLocalImportGuard,
  sourcesFromMap,
  diffDualInstanceAllowlist,
  resolveTargetPlatform,
  getEsbuildTarget,
  getTargetDefine,
} = require("./build-guards.js");
const { collectStaticInputs, computeSharedModules } = require("./b2-shared-closure.js");

const targetPlatform = resolveTargetPlatform(process.argv);
const esbuildTarget = getEsbuildTarget(targetPlatform);
const targetDefine = getTargetDefine(targetPlatform);
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
const outDir = path.join(extensionRoot, "entry");
const residentOutfile = path.join(outDir, "content-resident.iife.js");
const chunksDir = path.join(outDir, "chunks");
const workletEntry = path.join(extensionRoot, "live", "pcm-capture-worklet.ts");
const workletOutfile = path.join(chunksDir, "pcm-capture-worklet.mjs");

const legacyFiles = [
  path.join(outDir, "content-classic.js"),
  path.join(outDir, "content-main.mjs"),
  path.join(outDir, "content-main.mjs.map"),
  path.join(outDir, "content-bootstrap.iife.js"),
  path.join(outDir, "content-bootstrap.iife.js.map"),
];

const RESIDENT_RT_EXPORTS = [
  {
    id: "core/state.ts",
    names: [
      "state",
      "clipState",
      "uiState",
      "getReaderShellState",
      "transitionReaderShell",
      "triggerSubtitleSessionBoundary",
      "emptySecondarySubtitle",
      "registerSubtitleSessionBoundaryHooks",
    ],
  },
  {
    id: "shared/logging.ts",
    names: ["logInfo", "logWarn", "logWarnAlways"],
  },
  {
    id: "shared/messaging.ts",
    names: [
      "sendRuntimeMessage",
      "sendRuntimeMessagePromise",
      "sendOffloadMessage",
      "registerContentScriptDispatcher",
      "dispatchContentScriptMessage",
      "safePostMessage",
      "consumeRuntimeLastError",
    ],
  },
  {
    id: "shared/content-event-bus.ts",
    names: ["contentEventBus", "getCurrentClipScope"],
  },
  {
    id: "shared/lazy-import.ts",
    names: ["createLazyLoader"],
  },
  {
    id: "shared/watch-storage-keys.ts",
    names: ["watchStorageKeys"],
  },
  {
    id: "ai/lazy-player-ai.ts",
    names: ["loadPlayerAi", "isPlayerAiLoaded"],
  },
  {
    id: "reader/lazy-reader.ts",
    names: ["ensureReaderDomain"],
  },
  {
    id: "reader/lazy-shell.ts",
    names: ["ensureReaderShell"],
  },
  {
    id: "subtitle/lazy.ts",
    names: ["ensureSummarizeChain"],
  },
  {
    id: "ui/lazy-ui.ts",
    names: ["ensureUiReady"],
  },
];

const ALL_GROUPS = {
  "g-buttons": {
    entries: [
      "ui/script-button.ts",
      "youtube/host-adapter.ts",
      "ai/player-ai.ts",
      "bilibili/playback-rate.ts",
    ],
  },
  "g-app": {
    entries: [
      "ui/ui-renderer.ts",
      "reader/shell.ts",
      "reader/presentation.ts",
      "reader/index.ts",
      "reader/overview-coordinator.ts",
      "ui/confirm-dialog.ts",
      "subtitle/fetcher.ts",
      "subtitle/ui.ts",
      "subtitle/asr-translation.ts",
      "youtube/gateway.ts",
      "bilibili/gateway.ts",
      "asr/active-fallback.ts",
      "asr/pipeline.ts",
      "asr/fallback.ts",
      "ai/subtitle-translate.ts",
      "reader/chat-tab.ts",
      "ai/analysis.ts",
      "ai/explain.ts",
      "ai/completion.ts",
      "ai/active-provider.ts",
      "chat/conversation-storage.ts",
      "chat/chat-state.ts",
      "core/provider-http-offscreen.ts",
      "live/live-companion-session.ts",
      "live/player-interpret.ts",
      "agent-bridge/content.ts",
      "agent-bridge/content-subtitles.ts",
      "agent-bridge/frame.ts",
      "ui/settings-panel.ts",
      "ui/provider-editor.ts",
      "ai/model-catalog.ts",
    ],
  },
  "g-mermaid": {
    entries: ["ui/mermaid-render.ts"],
  },
  "g-math": {
    entries: ["ui/math-render.ts"],
  },
  "g-live-room": {
    entries: [
      "live/live-room-entry.ts",
      "live/live-room-settings.ts",
      "ui/provider-editor.ts",
      "ai/model-catalog.ts",
    ],
    chromiumOnly: true,
  },
};

const ACTIVE_GROUPS = Object.fromEntries(
  Object.entries(ALL_GROUPS).filter(([, cfg]) => !(targetPlatform === "firefox" && cfg.chromiumOnly))
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

const localImportGuard = createLocalImportGuard(extensionRoot);

const mermaidPackageFile = /(?:[\\/]node_modules[\\/]mermaid[\\/]|[\\/]mermaid@[^\\/]+[\\/]node_modules[\\/]mermaid[\\/])/;
const lodashEsPackageFile = /(?:[\\/]node_modules[\\/]lodash-es[\\/]|[\\/]lodash-es@[^\\/]+[\\/]node_modules[\\/]lodash-es[\\/])/;
const mermaidSlimAlias = {
  name: "mermaid-slim-round-b-only",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^marked$/ }, (args) => {
      if (!mermaidPackageFile.test(args.importer)) return undefined;
      return { path: path.join(__dirname, "..", "scripts", "vendor-marked-stub.mjs") };
    });
    buildApi.onResolve({ filter: /^d3$/ }, (args) => {
      if (!mermaidPackageFile.test(args.importer)) return undefined;
      return { path: path.join(__dirname, "..", "scripts", "vendor-d3-slim.mjs") };
    });
    buildApi.onResolve({ filter: /^mermaid$/ }, (args) => {
      const importer = path.resolve(args.importer);
      const mermaidRenderSource = path.join(extensionRoot, "ui", "mermaid-render.ts");
      if (args.path !== "mermaid" || importer !== mermaidRenderSource) return undefined;
      return { path: fs.realpathSync(slimMermaidEntry) };
    });
    buildApi.onResolve({ filter: /^@iconify\/utils$/ }, () => ({
      path: path.join(__dirname, "..", "scripts", "vendor-iconify-stub.mjs"),
    }));
    buildApi.onResolve({ filter: /^\.\/_root\.js$/ }, (args) => {
      if (!lodashEsPackageFile.test(args.importer)) return undefined;
      return { path: path.join(__dirname, "..", "scripts", "vendor-lodash-root-stub.mjs") };
    });
  },
};

const liveCompanionSessionSource = path.join(extensionRoot, "live", "live-companion-session.ts");
const liveCompanionFirefoxStubSource = path.join(extensionRoot, "live", "live-companion-firefox-stub.ts");
const firefoxLiveCompanionStubPlugin = {
  name: "firefox-live-companion-stub",
  setup(buildApi) {
    buildApi.onResolve({ filter: /live-companion-session/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      const candidates = [resolved];
      if (resolved.endsWith(".js")) candidates.push(resolved.slice(0, -3) + ".ts");
      else if (!resolved.endsWith(".ts")) candidates.push(resolved + ".ts");
      if (candidates.includes(liveCompanionSessionSource)) {
        return { path: liveCompanionFirefoxStubSource };
      }
      return undefined;
    });
  },
};

function resolveCandidates(resolveDir, importPath) {
  const resolved = path.resolve(resolveDir, importPath);
  const candidates = [resolved];
  if (resolved.endsWith(".js")) {
    candidates.push(resolved.slice(0, -3) + ".ts");
  } else if (!resolved.endsWith(".ts")) {
    candidates.push(resolved + ".ts");
  }
  return candidates;
}

const residentRtMap = new Map(
  RESIDENT_RT_EXPORTS.map((item) => [path.join(extensionRoot, item.id), item.id])
);

const targetToGroup = new Map();
for (const [groupName, cfg] of Object.entries(ACTIVE_GROUPS)) {
  for (const rel of cfg.entries) {
    const key = path.join(extensionRoot, rel);
    if (!targetToGroup.has(key)) {
      targetToGroup.set(key, { group: groupName, id: rel });
    }
  }
}

function buildLoadChunkRuntimeSnippet() {
  return `
const __bsChunks = (globalThis.__BILISCRIPT_CHUNKS__ = globalThis.__BILISCRIPT_CHUNKS__ || {});
const __bsInflight = (globalThis.__BILISCRIPT_CHUNK_INFLIGHT__ = globalThis.__BILISCRIPT_CHUNK_INFLIGHT__ || {});
function __bsSendChunkLoad(id) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "content-chunk-load", chunkId: id }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp?.error || "chunk load failed: " + id));
      resolve();
    });
  });
}
function __bsEnsurePrereq(flagKey, chunkId) {
  if (globalThis[flagKey]) return Promise.resolve();
  if (!__bsInflight[chunkId]) {
    __bsInflight[chunkId] = __bsSendChunkLoad(chunkId).catch((err) => {
      delete __bsInflight[chunkId];
      throw err;
    });
  }
  return __bsInflight[chunkId];
}
globalThis.__BILISCRIPT_LOAD_CHUNK__ = function(groupId, moduleId, needsShared) {
  if (__bsChunks[moduleId]) return Promise.resolve(__bsChunks[moduleId]);
  const key = groupId;
  if (!__bsInflight[key]) {
    __bsInflight[key] = (async () => {
      if (needsShared) await __bsEnsurePrereq("__BILISCRIPT_SHARED_READY__", "g-shared");
      await __bsSendChunkLoad(groupId);
    })().catch((err) => {
      delete __bsInflight[key];
      throw err;
    });
  }
  return __bsInflight[key].then(() => {
    const mod = __bsChunks[moduleId];
    if (!mod) throw new Error("Chunk loaded but module missing: " + moduleId);
    return mod;
  });
};
`;
}

function createDynamicGroupBridgePlugin(currentGroupName, options = {}) {
  const {
    shimResidentRt = false,
    sharedModuleMap = null,
    shimSharedSync = Boolean(sharedModuleMap),
    shimSharedDyn = Boolean(sharedModuleMap),
    sharedGroupActive = Boolean(sharedModuleMap),
  } = options;
  return {
    name: `b2-bridge-${currentGroupName}`,
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.?\// }, (args) => {
        const candidates = resolveCandidates(args.resolveDir, args.path);
        if (args.kind === "dynamic-import") {
          for (const c of candidates) {
            if (shimSharedDyn && sharedModuleMap && sharedModuleMap.has(c)) {
              return { path: sharedModuleMap.get(c), namespace: "b2-shared-dyn" };
            }
            if (targetToGroup.has(c)) {
              const info = targetToGroup.get(c);
              if (info.group === currentGroupName) {
                return { path: info.id, namespace: "b2-same-group" };
              }
              return { path: `${info.group}::${info.id}`, namespace: "b2-remote-group" };
            }
            if (shimResidentRt && residentRtMap.has(c)) {
              return { path: residentRtMap.get(c), namespace: "b2-rt-dyn" };
            }
          }
          return undefined;
        }
        if (shimSharedSync && sharedModuleMap) {
          for (const c of candidates) {
            if (sharedModuleMap.has(c)) {
              return { path: sharedModuleMap.get(c), namespace: "b2-shared-sync", sideEffects: false };
            }
          }
        }
        if (shimResidentRt) {
          for (const c of candidates) {
            if (residentRtMap.has(c)) {
              return { path: residentRtMap.get(c), namespace: "b2-rt-sync", sideEffects: false };
            }
          }
        }
        return undefined;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "b2-rt-sync" }, (args) => ({
        contents: `module.exports = globalThis.__BILISCRIPT_RT__[${JSON.stringify(args.path)}];`,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "b2-rt-dyn" }, (args) => ({
        contents: `module.exports = Promise.resolve(globalThis.__BILISCRIPT_RT__[${JSON.stringify(args.path)}]);`,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "b2-shared-sync" }, (args) => ({
        contents: `module.exports = globalThis.__BILISCRIPT_SHARED__[${JSON.stringify(args.path)}];`,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "b2-shared-dyn" }, (args) => ({
        contents: `module.exports = Promise.resolve(globalThis.__BILISCRIPT_SHARED__[${JSON.stringify(args.path)}]);`,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "b2-same-group" }, (args) => ({
        contents: `module.exports = Promise.resolve(globalThis.__BILISCRIPT_CHUNKS__[${JSON.stringify(args.path)}]);`,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "b2-remote-group" }, (args) => {
        const [g, id] = args.path.split("::");
        const needsShared = Boolean(sharedGroupActive && (g === "g-app" || g === "g-live-room"));
        return {
          contents: `module.exports = globalThis.__BILISCRIPT_LOAD_CHUNK__(${JSON.stringify(g)}, ${JSON.stringify(id)}, ${needsShared});`,
          loader: "js",
        };
      });
    },
  };
}

function cleanPreviousOutput() {
  for (const stale of [...legacyFiles, residentOutfile, residentOutfile + ".map"]) {
    fs.rmSync(stale, { force: true });
  }
  fs.rmSync(chunksDir, { recursive: true, force: true });
  fs.mkdirSync(chunksDir, { recursive: true });
}

function syntaxCheck(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

function sizeInBytes(file) {
  return fs.statSync(file).size;
}

function readMapExtensionSources(mapFile) {
  const mapJson = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  return sourcesFromMap(mapJson, path.dirname(mapFile), extensionRoot);
}

function collectContentRegionSources() {
  const residentSources = new Set(readMapExtensionSources(`${residentOutfile}.map`));
  const chunkMaps = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((file) => file.endsWith(".iife.js.map")).sort()
    : [];
  const chunkSources = new Set();
  for (const chunkMap of chunkMaps) {
    for (const source of readMapExtensionSources(path.join(chunksDir, chunkMap))) {
      chunkSources.add(source);
    }
  }
  return { residentSources, chunkSources };
}

function collectDualInstanceSources() {
  const { residentSources, chunkSources } = collectContentRegionSources();
  return [...residentSources].filter((source) => chunkSources.has(source));
}

const DUAL_INSTANCE_STATEFUL_MARKER = "BILISCRIPT_DUAL_INSTANCE_STATEFUL";

const DUAL_INSTANCE_ALLOWLIST = [
  { source: "core/state.ts", mutable: true, chromiumOnly: true },
  { source: "reader/reader-bus.ts", mutable: true },
  { source: "reader/state.ts", mutable: true },
  { source: "shared/active-host.ts", mutable: true },
  { source: "shared/content-event-bus.ts", mutable: true, chromiumOnly: true },
  { source: "shared/lazy-import.ts", mutable: true, chromiumOnly: true },
  { source: "shared/logging.ts", mutable: true },
  { source: "shared/messaging.ts", mutable: true },
  { source: "shared/style-injector.ts", mutable: true },
  { source: "shared/watch-storage-keys.ts", mutable: true, chromiumOnly: true },
  { source: "bilibili/video-id-shared.ts", mutable: false },
  { source: "core/defaults.ts", mutable: false },
  { source: "core/runtime.ts", mutable: false },
  { source: "core/version.ts", mutable: false },
  { source: "reader/presentation-fields.ts", mutable: false },
  { source: "shared/dom-ids.ts", mutable: false },
  { source: "shared/error-helpers.ts", mutable: false },
  { source: "shared/site.ts", mutable: false },
  { source: "shared/typed-event-bus.ts", mutable: false },
  { source: "shared/utils.ts", mutable: false },
  { source: "subtitle/subtitle-in-hand.ts", mutable: false },
  { source: "subtitle/kick-subtitle-fetch.ts", mutable: false },
];

function assertDualInstanceAllowlist() {
  const activeAllowlist =
    targetPlatform === "firefox"
      ? DUAL_INSTANCE_ALLOWLIST.filter((entry) => !entry.chromiumOnly)
      : DUAL_INSTANCE_ALLOWLIST;
  const { unexpected, missing } = diffDualInstanceAllowlist(
    collectDualInstanceSources(),
    activeAllowlist.map((entry) => entry.source)
  );
  const markerMismatches = [];
  for (const entry of activeAllowlist) {
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
    "Self-check failed: 双实例纪律对账未过：\n  " + details.join("\n  ")
  );
  process.exitCode = 1;
  return false;
}

const SLOT_KEY_DECLARATION = /\b[A-Z_]*SLOT_KEY\s*=\s*"(__BILISCRIPT_[A-Z_]+__)"/g;
const RESIDENT_ONLY_SLOT_KEYS = new Set(["__BILISCRIPT_CONTENT_SCRIPT_DISPATCHER__"]);

function assertSharedSlotsInBothRegions() {
  const dualSources = new Set(collectDualInstanceSources());
  const keys = new Map();
  for (const relSource of dualSources) {
    const text = fs.readFileSync(path.join(extensionRoot, relSource), "utf8");
    for (const match of text.matchAll(SLOT_KEY_DECLARATION)) {
      keys.set(match[1], relSource);
    }
  }
  if (keys.size === 0) {
    console.error(
      'Self-check failed: 双实例模块集合未发现任何共享槽声明（*_SLOT_KEY = "__BILISCRIPT_...__"）'
    );
    process.exitCode = 1;
    return false;
  }
  const residentText = fs.readFileSync(residentOutfile, "utf8");
  const chunkFiles = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((file) => file.endsWith(".iife.js"))
    : [];
  const chunkTexts = chunkFiles.map((file) => fs.readFileSync(path.join(chunksDir, file), "utf8"));
  const missing = [];
  for (const [key, source] of keys) {
    if (!residentText.includes(key)) {
      missing.push(`${key}（${source}）不在常驻包 content-resident.iife.js`);
    } else if (!RESIDENT_ONLY_SLOT_KEYS.has(key) && !chunkTexts.some((text) => text.includes(key))) {
      missing.push(`${key}（${source}）不在任何业务分组 chunk`);
    }
  }
  if (missing.length > 0) {
    console.error(
      "Self-check failed: 跨实例共享槽未两侧落位：\n  " + missing.join("\n  ")
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

const MERMAID_STUB_SOURCES = ["vendor-marked-stub.mjs", "vendor-d3-slim.mjs"];

function assertMermaidStubsApplied() {
  const mapFile = path.join(chunksDir, "g-mermaid.iife.js.map");
  if (!fs.existsSync(mapFile)) {
    console.error("Self-check failed: 缺少 g-mermaid.iife.js.map");
    process.exitCode = 1;
    return false;
  }
  const sources = JSON.parse(fs.readFileSync(mapFile, "utf8")).sources ?? [];
  const basename = (source) => source.split(/[\\/]/).pop() ?? source;
  for (const stub of MERMAID_STUB_SOURCES) {
    if (!sources.some((source) => basename(source) === stub)) {
      console.error(
        `Self-check failed: g-mermaid 闭包未包含体积替身 ${stub}——marked/d3 alias 可能已失效`
      );
      process.exitCode = 1;
      return false;
    }
  }
  for (const source of sources) {
    if (/[\\/]marked[\\/]/.test(source) || /[\\/]node_modules[\\/]d3[\\/]/.test(source)) {
      console.error(
        `Self-check failed: g-mermaid sourcemap 含 umbrella 依赖 ${source}——marked/d3 体积替身被绕过`
      );
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}

function assertLodashRootStubApplied() {
  const chunkMaps = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((file) => file.endsWith(".iife.js.map")).sort()
    : [];
  const basename = (source) => source.split(/[\\/]/).pop() ?? source;
  let foundStub = false;
  for (const mapFile of chunkMaps) {
    const mapJson = JSON.parse(fs.readFileSync(path.join(chunksDir, mapFile), "utf8"));
    for (const source of mapJson.sources ?? []) {
      if (basename(source) === "vendor-lodash-root-stub.mjs") {
        foundStub = true;
      }
      if (/[\\/]lodash-es[\\/]_root\.js$/.test(source)) {
        console.error(
          `Self-check failed: ${mapFile} sourcemap 含 ${source}——lodash-es _root.js alias 失效`
        );
        process.exitCode = 1;
        return false;
      }
    }
  }
  if (!foundStub) {
    console.error(
      "Self-check failed: chunks/ sourcemap 未包含 vendor-lodash-root-stub.mjs——lodash-es _root.js alias 未生效"
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

const FIREFOX_FORBIDDEN_LIVE_SOURCES = new Set([
  "live/live-room-entry.ts",
  "live/live-room-settings.ts",
  "live/fullscreen-live-overlay.ts",
  "live/liquid-glass-lens.ts",
  "live/live-companion-session.ts",
]);

function assertFirefoxLivePruned() {
  if (targetPlatform !== "firefox") {
    return true;
  }
  for (const excludedFile of ["g-live-room.iife.js", "pcm-capture-worklet.mjs"]) {
    if (fs.existsSync(path.join(chunksDir, excludedFile))) {
      console.error(`Self-check failed: Firefox 构建产物不应包含 ${excludedFile}`);
      process.exitCode = 1;
      return false;
    }
  }
  const residentText = fs.readFileSync(residentOutfile, "utf8");
  if (residentText.includes('"g-live-room"')) {
    console.error("Self-check failed: Firefox content-resident.iife.js 仍引用 g-live-room");
    process.exitCode = 1;
    return false;
  }
  const chunkMaps = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((file) => file.endsWith(".iife.js.map")).sort()
    : [];
  for (const mapFile of chunkMaps) {
    const sources = readMapExtensionSources(path.join(chunksDir, mapFile));
    const leaked = sources.filter((source) => FIREFOX_FORBIDDEN_LIVE_SOURCES.has(source));
    if (leaked.length > 0) {
      console.error(
        `Self-check failed: Firefox chunk ${mapFile} 仍包含已门控的 live 模块：${leaked.join(", ")}`
      );
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}

const SCRIPT_BUTTON_FORBIDDEN_INPUTS = [
  "reader/shell.ts",
  "reader/quote-share-export.ts",
  "reader/quote-share-modal.ts",
];

const PLAYER_AI_FORBIDDEN_INPUTS = [
  "live/player-interpret.ts",
  "subtitle/cache.ts",
  "ai/l0-bm25.ts",
];

async function assertStaticSeedGuards(groupResults) {
  const probePlugins = [
    localImportGuard,
    mermaidSlimAlias,
    ...(targetPlatform === "firefox" ? [firefoxLiveCompanionStubPlugin] : []),
  ];
  const [readerInputs, scriptBtnInputs, playerAiInputs] = await Promise.all([
    collectStaticInputs({
      entries: ["reader/lifecycle.ts"],
      extensionRoot,
      targetPlatform,
      esbuildTarget,
      targetDefine,
      plugins: probePlugins,
    }),
    collectStaticInputs({
      entries: ["ui/script-button.ts"],
      extensionRoot,
      targetPlatform,
      esbuildTarget,
      targetDefine,
      plugins: probePlugins,
    }),
    collectStaticInputs({
      entries: ["ai/player-ai.ts"],
      extensionRoot,
      targetPlatform,
      esbuildTarget,
      targetDefine,
      plugins: probePlugins,
    }),
  ]);

  if (readerInputs.has("ai/analysis.ts")) {
    console.error(
      "build-content.js: reader/lifecycle.ts 静态图含 ai/analysis.ts——概览管线必须经 startOverviewRun 动态 import 按需装载"
    );
    process.exit(1);
  }

  const buttonsSources = new Set(readMapExtensionSources(`${groupResults["g-buttons"].outfile}.map`));
  const scriptBtnHits = SCRIPT_BUTTON_FORBIDDEN_INPUTS.filter(
    (item) => scriptBtnInputs.has(item) || buttonsSources.has(item)
  );
  if (scriptBtnHits.length > 0) {
    console.error(
      `build-content.js: script-button 装载图静态包含禁区模块 ${scriptBtnHits.join(", ")}——完好性判定必须走 reader/shell-intact.ts 叶子模块`
    );
    process.exit(1);
  }

  const playerAiHits = PLAYER_AI_FORBIDDEN_INPUTS.filter(
    (item) => playerAiInputs.has(item) || buttonsSources.has(item)
  );
  if (playerAiHits.length > 0) {
    console.error(
      `build-content.js: player-ai 装载图静态包含禁区模块 ${playerAiHits.join(", ")}——同传菜单与控制器必须经动态 import("../live/player-interpret.js") 按需装载`
    );
    process.exit(1);
  }
}

function selfCheck(groupResults) {
  syntaxCheck(residentOutfile);
  for (const gInfo of Object.values(groupResults)) {
    syntaxCheck(gInfo.outfile);
  }
  const residentText = fs.readFileSync(residentOutfile, "utf8");
  if (!residentText.includes("globalThis.__BILISCRIPT_RT__") && !residentText.includes("__BILISCRIPT_RT__")) {
    console.error(`Self-check failed: ${residentOutfile} 未写入 __BILISCRIPT_RT__`);
    process.exitCode = 1;
    return false;
  }
  if (!residentText.includes("__BILISCRIPT_LOAD_CHUNK__")) {
    console.error(`Self-check failed: ${residentOutfile} 未挂载 __BILISCRIPT_LOAD_CHUNK__`);
    process.exitCode = 1;
    return false;
  }
  if (residentText.includes("import(")) {
    console.error(`Self-check failed: ${residentOutfile} 仍残留 ESM import(，经典 IIFE 运行时将报错`);
    process.exitCode = 1;
    return false;
  }
  for (const [gName, gInfo] of Object.entries(groupResults)) {
    const text = fs.readFileSync(gInfo.outfile, "utf8");
    if (text.includes("import(")) {
      console.error(`Self-check failed: ${gInfo.outfile} 仍残留 ESM import(`);
      process.exitCode = 1;
      return false;
    }
    if (gName === "g-shared" && text.includes('"g-live-room"')) {
      console.error(`Self-check failed: ${gInfo.outfile} 不应包含 g-live-room 远端加载`);
      process.exitCode = 1;
      return false;
    }
  }
  if (!assertLodashRootStubApplied() || !assertFirefoxLivePruned()) {
    return false;
  }
  return (
    assertSharedSlotsInBothRegions() &&
    assertMermaidStubsApplied() &&
    assertDualInstanceAllowlist()
  );
}

async function computeCurrentSharedModules() {
  const excludeSet = new Set(RESIDENT_RT_EXPORTS.map((item) => item.id));
  return await computeSharedModules({
    appEntries: ACTIVE_GROUPS["g-app"].entries,
    liveEntries: ALL_GROUPS["g-live-room"].entries,
    onboardingEntries: ["entry/onboarding-entry.ts"],
    excludeModules: excludeSet,
    extensionRoot,
    targetPlatform,
    esbuildTarget,
    targetDefine,
    plugins: [
      localImportGuard,
      ...(targetPlatform === "firefox" ? [firefoxLiveCompanionStubPlugin] : []),
    ],
  });
}

function getResidentOptions(sharedGroupActive) {
  const rtImports = RESIDENT_RT_EXPORTS.map(
    (item) => `import { ${item.names.join(", ")} } from "./${item.id}";`
  ).join("\n");
  const rtAssignments =
    "const rt = (globalThis.__BILISCRIPT_RT__ = globalThis.__BILISCRIPT_RT__ || {});\n" +
    RESIDENT_RT_EXPORTS.map(
      (item) => `rt[${JSON.stringify(item.id)}] = { ${item.names.join(", ")} };`
    ).join("\n");
  const mergedCode = `
import "./entry/content.ts";
${rtImports}
${rtAssignments}
${buildLoadChunkRuntimeSnippet()}
`;
  return {
    stdin: { contents: mergedCode, resolveDir: extensionRoot, loader: "ts", sourcefile: "content-resident-entry.ts" },
    outfile: residentOutfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    minify: true,
    sourcemap: true,
    metafile: true,
    target: esbuildTarget,
    define: targetDefine,
    plugins: [
      localImportGuard,
      createDynamicGroupBridgePlugin("__resident__", {
        shimResidentRt: false,
        sharedGroupActive,
      }),
    ],
  };
}

function getSharedGroupOptions(sharedModules, sharedModuleMap) {
  const outfile = path.join(chunksDir, "g-shared.iife.js");
  const entryCode = `
if (!globalThis.__BILISCRIPT_SHARED_READY__) {
  globalThis.__BILISCRIPT_SHARED_READY__ = true;
  const sh = (globalThis.__BILISCRIPT_SHARED__ = globalThis.__BILISCRIPT_SHARED__ || {});
  ${sharedModules.map((rel) => `sh[${JSON.stringify(rel)}] = require("./${rel}");`).join("\n  ")}
}
`;
  return {
    outfile,
    options: {
      stdin: { contents: entryCode, resolveDir: extensionRoot, loader: "ts", sourcefile: "g-shared-entry.ts" },
      outfile,
      bundle: true,
      format: "iife",
      platform: "browser",
      minify: true,
      sourcemap: true,
      metafile: true,
      target: esbuildTarget,
      define: targetDefine,
      plugins: [
        localImportGuard,
        mermaidSlimAlias,
        ...(targetPlatform === "firefox" ? [firefoxLiveCompanionStubPlugin] : []),
        createDynamicGroupBridgePlugin("g-shared", {
          shimResidentRt: false,
          sharedModuleMap,
          shimSharedSync: false,
          shimSharedDyn: true,
          sharedGroupActive: true,
        }),
      ],
    },
  };
}

function getGroupBuildEntries(sharedModuleMap) {
  const sharedGroupActive = Boolean(sharedModuleMap);
  const specs = [];
  for (const [groupName, cfg] of Object.entries(ACTIVE_GROUPS)) {
    const outfile = path.join(chunksDir, `${groupName}.iife.js`);
    const entryCode = `
const reg = (globalThis.__BILISCRIPT_CHUNKS__ = globalThis.__BILISCRIPT_CHUNKS__ || {});
${cfg.entries
  .map((rel, i) => `import * as m_${i} from "./${rel}";\nif (!reg[${JSON.stringify(rel)}]) reg[${JSON.stringify(rel)}] = m_${i};`)
  .join("\n")}
`;
    const useShared = Boolean(sharedModuleMap && (groupName === "g-app" || groupName === "g-live-room"));
    specs.push({
      groupName,
      outfile,
      options: {
        stdin: { contents: entryCode, resolveDir: extensionRoot, loader: "ts", sourcefile: `${groupName}-entry.ts` },
        outfile,
        bundle: true,
        format: "iife",
        platform: "browser",
        minify: true,
        sourcemap: true,
        metafile: true,
        target: esbuildTarget,
        define: targetDefine,
        plugins: [
          localImportGuard,
          mermaidSlimAlias,
          ...(targetPlatform === "firefox" ? [firefoxLiveCompanionStubPlugin] : []),
          createDynamicGroupBridgePlugin(groupName, {
            shimResidentRt: true,
            sharedModuleMap: useShared ? sharedModuleMap : null,
            shimSharedSync: useShared,
            shimSharedDyn: useShared,
            sharedGroupActive,
          }),
        ],
      },
    });
  }
  return specs;
}

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
  define: targetDefine,
  plugins: [localImportGuard],
};

function printReport(groupResults) {
  const residentBytes = sizeInBytes(residentOutfile);
  const groupsTotalBytes = Object.values(groupResults).reduce((sum, g) => sum + g.bytes, 0);
  const workletBytes =
    targetPlatform !== "firefox" && fs.existsSync(workletOutfile) ? sizeInBytes(workletOutfile) : 0;

  console.log(`Wrote ${residentOutfile} (classic IIFE resident, minified: true, ${residentBytes} bytes)`);
  for (const gInfo of Object.values(groupResults)) {
    console.log(`Wrote ${gInfo.outfile} (classic IIFE group, on-demand, ${gInfo.bytes} bytes)`);
  }
  if (workletBytes > 0) {
    console.log(`Wrote ${workletOutfile} (AudioWorklet ESM, ${workletBytes} bytes)`);
  }
  console.log(`Group chunks total: ${groupsTotalBytes} bytes across ${Object.keys(groupResults).length} file(s)`);
  console.log(`Resident total: ${residentBytes} bytes`);

  const MAX_RESIDENT_BYTES = 46080;
  if (residentBytes > MAX_RESIDENT_BYTES) {
    console.error(
      `build-content.js: Content 常驻体积超限！当前 ${residentBytes} B > 预算上限 ${MAX_RESIDENT_BYTES} B`
    );
    process.exit(1);
  }
}

async function runOnce(sharedModules) {
  const sharedModuleMap =
    sharedModules.length > 0
      ? new Map(sharedModules.map((id) => [path.join(extensionRoot, id), id]))
      : null;

  await build(getResidentOptions(Boolean(sharedModuleMap)));
  const groupSpecs = getGroupBuildEntries(sharedModuleMap);
  const groupResults = {};
  for (const spec of groupSpecs) {
    await build(spec.options);
    groupResults[spec.groupName] = { outfile: spec.outfile, bytes: sizeInBytes(spec.outfile) };
  }
  if (sharedModules.length > 0) {
    const sharedSpec = getSharedGroupOptions(sharedModules, sharedModuleMap);
    await build(sharedSpec.options);
    groupResults["g-shared"] = { outfile: sharedSpec.outfile, bytes: sizeInBytes(sharedSpec.outfile) };
  }
  if (targetPlatform !== "firefox") {
    await build(workletOptions);
  }
  await assertStaticSeedGuards(groupResults);
  if (!selfCheck(groupResults)) {
    process.exit(1);
  }
  printReport(groupResults);
}

async function main() {
  execFileSync(process.execPath, [vendorMermaidSlimScript], { stdio: "inherit" });
  cleanPreviousOutput();

  const sharedModules = await computeCurrentSharedModules();
  const sharedCacheFile = path.join(__dirname, "..", "node_modules", ".b2-shared-modules.json");
  fs.mkdirSync(path.dirname(sharedCacheFile), { recursive: true });
  fs.writeFileSync(sharedCacheFile, JSON.stringify(sharedModules), "utf8");

  if (!watchMode) {
    await runOnce(sharedModules);
    return;
  }

  const sharedModuleMap =
    sharedModules.length > 0
      ? new Map(sharedModules.map((id) => [path.join(extensionRoot, id), id]))
      : null;
  const watchSpecs = [
    { name: "resident", options: getResidentOptions(Boolean(sharedModuleMap)) },
    ...getGroupBuildEntries(sharedModuleMap).map((s) => ({ name: s.groupName, options: s.options })),
    ...(sharedModules.length > 0
      ? [{ name: "g-shared", options: getSharedGroupOptions(sharedModules, sharedModuleMap).options }]
      : []),
    ...(targetPlatform !== "firefox" ? [{ name: "worklet", options: workletOptions }] : []),
  ];
  const ctxs = await Promise.all(watchSpecs.map((item) => context(item.options)));
  await Promise.all(ctxs.map((ctx) => ctx.rebuild()));
  await runOnce(sharedModules);
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
