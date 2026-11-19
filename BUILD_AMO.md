# AMO Build & Reproduction Guide / AMO 审核构建复现说明

This document describes how to reproduce the exact Firefox add-on bundle (`dist-firefox/`) from the source archive (`BiliScript-v<version>-Source.zip`) for Mozilla Add-ons (AMO) review.

本文档说明如何从源码归档包（`BiliScript-v<version>-Source.zip`）离线复现提交至 Mozilla Add-ons（AMO）的 Firefox 扩展构建产物（`dist-firefox/`）。

## 1. Environment Requirements / 环境要求

- **Operating System / 操作系统**：Linux (Ubuntu 22.04+), macOS (13+), or Windows (10/11)
- **Node.js**：`22.x` or `24.x`（`>= 22.0.0`）
- **Package Manager / 包管理器**：`pnpm` **`12.x`**（`>= 12.0.0 < 13.0.0`，`package.json` 的 `devEngines` 锁定 `pnpm 12.x`，使用 `npm` 会被拒绝）
- **Python**（仅在本地重新打包全部三份 release 压缩包时需要）：Python `3.10+`

## 2. Reproduce Firefox Build / 复现 Firefox 构建

Extract the source archive and run inside the repository root:

解压源码包后，在仓库根目录依次执行：

```bash
pnpm install --frozen-lockfile
pnpm build:firefox
```

Or in a single command / 或一步执行：

```bash
pnpm install --frozen-lockfile && pnpm build:firefox
```

## 3. Output Directory & Verification / 产物目录与核验

- **Build Output Directory / 产物目录**：`dist-firefox/`
  - Contains `manifest.json`, `onboarding.html`, `entry/`, `icons/`, and `_locales/`.
  - During `pnpm build:firefox` (`node scripts/build.js --target=firefox`), `esbuild` bundles TypeScript/JavaScript modules with `target: "firefox153"` and minification enabled, and `scripts/firefox-manifest.js` (`deriveFirefoxManifest`) deterministically derives `dist-firefox/manifest.json` from `extension/manifest.json` and `extension/core/presets.ts`.
  - Linked `.map` sourcemap files are emitted in `dist-firefox/` for local debugging and are excluded from the AMO upload package (`BiliScript-v<version>-Firefox.zip`).
- **AMO Archive Validation / 静态校验（可选）**：
  ```bash
  pnpm dlx web-ext lint -s dist-firefox
  ```
- **Regenerate Release Archives / 重新生成发布包（可选）**：
  ```bash
  pnpm build:release
  ```
  Generates `release/BiliScript-v<version>-Chromium.zip`, `release/BiliScript-v<version>-Firefox.zip`, and `release/BiliScript-v<version>-Source.zip`.
