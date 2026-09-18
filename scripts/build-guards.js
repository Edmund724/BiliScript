// 构建期守卫（build.js 与 build-content.js 共享，CJS）。
//
// 02 复制粘贴收口：localImportGuard 此前在两份脚本里各存一份逐字相同的实现
//（因脚本未导出而手工复制，靠注释约定「两边改动必须同步」）。收口为单份工厂，
// 双份 build 脚本从同一处 import——逻辑漂移在物理上不再可能。

const path = require("path");

// 双实例守卫（build-content.js 的 assertDualInstanceAllowlist 专用，纯函数收在此
// 是为了让 tests/ 能不经构建直接喂 fixture 对账）：content 两轮构建把共享底座
// 各装一份实例，「允许双实例模块清单」必须与构建产物 sourcemap 的交集逐字一致
// ——清单外的新双实例模块（如懒侧新 import 了某个常驻模块）在此现形。

// Guard: every resolved local (`./`/`../`) import **from extension/ source** must
// stay inside extension/. Absolute and external (package) imports are left
// untouched. The guard lives on the build object via esbuild's onResolve so it
// never rewrites paths, only validates them as esbuild resolves them.
//
// 只查 extension/ 内的导入方：第三方包（mermaid 及其 d3-*/es-toolkit 等依赖）
// 内部也满是相对导入，那类不越界概念——它们由 esbuild 正常解析并打包进产物，
// 拦下来只会让任何运行时依赖都无法引入。
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

module.exports = { createLocalImportGuard, sourcesFromMap, diffDualInstanceAllowlist };

// 归一化单个 sourcemap 的 sources：map 的 sources 相对于 map 文件所在目录，
// 解析后只保留落在 extension/ 内的 .ts 源（构建产物、node_modules 依赖天然
// 排除），返回 extension 相对路径（posix 风格，与清单书写一致）。
function sourcesFromMap(mapJson, mapDir, extensionRoot) {
  return mapJson.sources
    .map((source) => path.normalize(path.join(mapDir, source)))
    .filter(
      (source) =>
        source.startsWith(extensionRoot + path.sep) && source.endsWith(".ts")
    )
    .map((source) => path.relative(extensionRoot, source).split(path.sep).join("/"));
}

// 对账：实测双实例集合（常驻包 sourcemap ∩ 全部 chunk sourcemap）vs 允许
// 双实例模块清单。unexpected = 产物里有、清单没有（新双实例模块，构建报错、
// 强制人工评估）；missing = 清单有、产物没有（清单漂移，提示清理）。
function diffDualInstanceAllowlist(actualSources, allowlistSources) {
  const actual = new Set(actualSources);
  const allowlisted = new Set(allowlistSources);
  return {
    unexpected: [...actual].filter((source) => !allowlisted.has(source)).sort(),
    missing: [...allowlisted].filter((source) => !actual.has(source)).sort(),
  };
}
