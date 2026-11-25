const fs = require("fs");
const path = require("path");
const { build, transformSync } = require("esbuild");

async function collectStaticInputs({ entries, extensionRoot, targetPlatform, esbuildTarget, targetDefine, plugins = [] }) {
  const code =
    entries.map((f, i) => `import * as m_${i} from "./${f}";`).join("\n") +
    `\nglobalThis.__B2_PROBE__ = [${entries.map((_, i) => `m_${i}`).join(",")}];`;
  const res = await build({
    stdin: { contents: code, resolveDir: extensionRoot, loader: "ts", sourcefile: "b2-probe.ts" },
    bundle: true,
    minify: true,
    metafile: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: esbuildTarget,
    define: targetDefine,
    plugins: [
      ...plugins,
      {
        name: "b2-probe-ext-dyn",
        setup(b) {
          b.onResolve({ filter: /^\.\.?\// }, (a) =>
            a.kind === "dynamic-import" ? { path: "b2-dyn:" + a.path, external: true } : undefined
          );
        },
      },
    ],
  });
  const out = Object.values(res.metafile.outputs)[0];
  const result = new Set();
  for (const inp of Object.keys(out.inputs || {})) {
    const norm = inp.split(path.sep).join("/");
    if (norm.startsWith("extension/") && !norm.endsWith("-entry.ts") && !norm.includes("b2-probe")) {
      result.add(norm.slice("extension/".length));
    }
  }
  return result;
}

async function computeSharedModules({
  appEntries,
  liveEntries,
  onboardingEntries,
  excludeModules = new Set(),
  extensionRoot,
  targetPlatform,
  esbuildTarget,
  targetDefine,
  plugins = [],
}) {
  const shared = new Set();
  const appSet = await collectStaticInputs({
    entries: appEntries,
    extensionRoot,
    targetPlatform,
    esbuildTarget,
    targetDefine,
    plugins,
  });

  if (targetPlatform !== "firefox") {
    const liveSet = await collectStaticInputs({
      entries: liveEntries,
      extensionRoot,
      targetPlatform,
      esbuildTarget,
      targetDefine,
      plugins,
    });
    for (const m of liveSet) {
      if (appSet.has(m) && !excludeModules.has(m)) {
        shared.add(m);
      }
    }
  }

  const onbSet = await collectStaticInputs({
    entries: onboardingEntries,
    extensionRoot,
    targetPlatform,
    esbuildTarget,
    targetDefine,
    plugins,
  });
  for (const m of onbSet) {
    if (appSet.has(m) && !excludeModules.has(m)) {
      if (targetPlatform === "firefox" && m.startsWith("live/")) continue;
      shared.add(m);
    }
  }

  return [...shared].sort();
}

function resolveExtensionRelative(extensionRoot, fromRel, specifier) {
  const resolved = path.resolve(path.dirname(path.join(extensionRoot, fromRel)), specifier);
  const tsPath = resolved.endsWith(".js") ? resolved.slice(0, -3) + ".ts" : resolved + ".ts";
  return path.relative(extensionRoot, tsPath).split(path.sep).join("/");
}

function collectNamedImportsForTargets({ consumerFiles, targetSet, extensionRoot }) {
  const used = new Map();
  const addSymbol = (target, sym) => {
    if (!targetSet.has(target)) return;
    let set = used.get(target);
    if (!set) {
      set = new Set();
      used.set(target, set);
    }
    set.add(sym);
  };
  const reStatic = /(?:import|export)\s+(?:(\*\s+as\s+\w+|\*)|(?:\{([^}]+)\})|(\w+)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+["'](\.\.?\/[^"']+)["']/g;
  const reDynamic = /import\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;

  for (const rel of consumerFiles) {
    const src = fs.readFileSync(path.join(extensionRoot, rel), "utf8");
    const js = transformSync(src, { loader: "ts" }).code;
    for (const match of js.matchAll(reStatic)) {
      const target = resolveExtensionRelative(extensionRoot, rel, match[5]);
      if (!targetSet.has(target)) continue;
      if (match[1]) {
        addSymbol(target, "*");
      }
      if (match[3]) {
        addSymbol(target, "default");
      }
      const braceList = match[2] || match[4];
      if (braceList) {
        for (const item of braceList.split(",")) {
          const name = item.trim().split(/\s+as\s+/)[0].trim();
          if (name) addSymbol(target, name);
        }
      }
    }
    for (const match of js.matchAll(reDynamic)) {
      const target = resolveExtensionRelative(extensionRoot, rel, match[1]);
      addSymbol(target, "*");
    }
  }
  return used;
}

module.exports = {
  collectStaticInputs,
  computeSharedModules,
  collectNamedImportsForTargets,
};
