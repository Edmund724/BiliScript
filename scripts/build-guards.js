const path = require("path");

const BUILD_TARGET = "chrome120";
const BUILD_TARGETS = Object.freeze({
  chromium: "chrome120",
  firefox: "firefox153",
});

function resolveTargetPlatform(argv = process.argv) {
  const flag = argv.find((arg) => arg.startsWith("--target="));
  if (!flag) return "chromium";
  const value = flag.slice("--target=".length);
  if (value === "chromium" || value === "firefox") return value;
  throw new Error(`Unsupported --target="${value}". Expected "chromium" or "firefox".`);
}

function getEsbuildTarget(platform = "chromium") {
  const target = BUILD_TARGETS[platform];
  if (!target) {
    throw new Error(`Unsupported target platform "${platform}". Expected "chromium" or "firefox".`);
  }
  return target;
}

function createLocalImportGuard(extensionRoot) {
  const extensionRootAbs = path.resolve(extensionRoot) + path.sep;
  return {
    name: "extension-local-import-guard",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (!path.resolve(args.importer).startsWith(extensionRootAbs)) return undefined;
        const resolved = path.resolve(args.resolveDir, args.path);
        if (resolved.startsWith(extensionRootAbs)) return undefined;
        const relFromExtension = path.relative(extensionRoot, resolved);
        return {
          errors: [
            {
              text: `Import "${args.path}" in "${args.importer}" resolves to "${resolved}", ` +
              `which is outside extension/ (${relFromExtension || resolved}).`,
            },
          ],
        };
      });
    },
  };
}

function sourcesFromMap(mapJson, mapDir, extensionRoot) {
  return mapJson.sources
    .map((source) => path.normalize(path.join(mapDir, source)))
    .filter(
      (source) =>
        source.startsWith(extensionRoot + path.sep) &&
        source.endsWith(".ts") &&
        !source.endsWith(".d.ts")
    )
    .map((source) => path.relative(extensionRoot, source).split(path.sep).join("/"));
}

function collectStaticClosureInputs(outputs, startFile) {
  const visitedFiles = new Set();
  const inputs = new Set();
  const queue = [startFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visitedFiles.has(file)) continue;
    visitedFiles.add(file);
    const out = outputs[file];
    if (!out) continue;
    for (const input of Object.keys(out.inputs || {})) {
      inputs.add(input);
    }
    for (const imp of out.imports || []) {
      if (imp.external || imp.kind !== "import-statement" || !imp.path) continue;
      if (outputs[imp.path]) {
        queue.push(imp.path);
      } else {
        const resolved = path.posix.join(path.posix.dirname(file), imp.path);
        if (outputs[resolved]) queue.push(resolved);
      }
    }
  }
  return [...inputs];
}

function findForbiddenInputs(meta, { seed, forbidden, outputExtensions }) {
  const outputs = (meta && meta.outputs) || {};
  const violations = [];
  for (const [file, out] of Object.entries(outputs)) {
    if (outputExtensions && !outputExtensions.some((ext) => file.endsWith(ext))) continue;
    const directInputs = Object.keys((out && out.inputs) || {});
    if (!directInputs.some((input) => input.includes(seed))) continue;
    const closureInputs = collectStaticClosureInputs(outputs, file);
    const hits = forbidden.filter((name) => closureInputs.some((input) => input.includes(name)));
    if (hits.length > 0) violations.push({ output: file, hits });
  }
  return violations;
}

function diffDualInstanceAllowlist(actualSources, allowlistSources) {
  const actual = new Set(actualSources);
  const allowlisted = new Set(allowlistSources);
  return {
    unexpected: [...actual].filter((source) => !allowlisted.has(source)).sort(),
    missing: [...allowlisted].filter((source) => !actual.has(source)).sort(),
  };
}

module.exports = {
  createLocalImportGuard,
  sourcesFromMap,
  findForbiddenInputs,
  diffDualInstanceAllowlist,
  BUILD_TARGET,
  BUILD_TARGETS,
  resolveTargetPlatform,
  getEsbuildTarget,
};
