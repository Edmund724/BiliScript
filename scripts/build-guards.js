// 构建期守卫（build.js 与 build-content.js 共享，CJS）。
//
// 02 复制粘贴收口：localImportGuard 此前在两份脚本里各存一份逐字相同的实现
//（因脚本未导出而手工复制，靠注释约定「两边改动必须同步」）。收口为单份工厂，
// 双份 build 脚本从同一处 import——逻辑漂移在物理上不再可能。

const path = require("path");

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

module.exports = { createLocalImportGuard };
