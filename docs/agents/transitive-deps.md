# 传递依赖公告的处置判据

扫描器（`pnpm audit`、GitHub Dependabot 等）按 **lockfile** 判定，不按扩展产物判定。本仓库为打包型浏览器扩展，实际承担运行风险的是进入产物的代码；两者错位时按以下判据处理。

## 判据

**只处理进产物或随产物分发的传递依赖；够不着的记理由，不静默。**

- **核验是否进产物**：指经 `pnpm build` / `pnpm build:content` 打进 `dist/`（或 `extension/entry/` 产物）的代码。在构建产物及 sourcemap 中检索包名与涉事函数，并沿调用面确认可达性（符号出现不等于可达）。
- **够不着产物的公告**：在原地注释或本文记录「已核查、未进入产物及原因」，禁止使用 `ignoreGhsas` 等永久静音手段，以免吞掉后续新公告。
- **进产物且命中公告**：优先通过 `pnpm.overrides` 升级到已修复版本，并实测验证产物行为或字节一致性；每条 override 必须在注释中写明**移除条件**（何时可删）。
- **核实一手事实**：不直接把上游公告或 issue 当结论（编号可能是旧 ID 别名或修复建议实测无效）；以构建产物与上游实际源码为准。

## 浏览器地板与传递依赖升级

`extension/manifest.json` 的 `minimum_chrome_version` 与 `scripts/build-guards.js` 的 `BUILD_TARGET` 由 `scripts/build-content.js` 逐构建校验一致，但这只能拦截 **target ↔ manifest** 漂移，**无法自动发现依赖升级引入的 post-floor 内建 API**（真机冒烟机版本通常远高于地板，`node --check` 只校验本地 Node 语法）。

- 升级进入产物的运行时依赖时，须主动对照 `BUILD_TARGET` 扫产物（例如对产物 chunk 做目标地板 vs `esnext` 的 `esbuild.transform` 差异比对）。
- Chrome 自 153 起切换为两周发版节奏，重估浏览器版本地板时应以实际平台能力需求（如 Offscreen API 与现代 CSS 特性）而非版本计数为准。
