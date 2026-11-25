const path = require("path");
const { build } = require("esbuild");

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

module.exports = {
  collectStaticInputs,
  computeSharedModules,
};
