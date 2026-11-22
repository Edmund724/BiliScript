

## 工具链

依赖与脚本用 PATH 上的 pnpm（12.x）——`pnpm install` / `pnpm exec vitest run` 直接可用；npm 装依赖会被 `devEngines` 拒（EBADDEVENGINES）。

`npx` 同样过不去 `devEngines`：还没跑到目标 CLI 就报 EBADDEVENGINES。一次性命令行工具用 `pnpm dlx <pkg>`（例如 `pnpm dlx web-ext lint -s dist-firefox`），非 npx 不可时加 `--force`。

DSH 运行时自带的 pnpm 11.7.0 在本仓库必失败：`devEngines` 要求 ≥12 → 它切到 12.5.1 时生成的 Windows shim 指向无扩展名的 `sh` 占位脚本（生命周期脚本被拦、原生包 `@pnpm/exe.win32-x64` 未装），cmd 报 `'...\node_modules\pnpm\pnpm' is not recognized`。

## 浏览器兼容

目标平台为 **Chromium（最低 Chrome 120）** 与 **桌面端 Firefox（最低 Firefox 153，不适配 Android）**，架构边界与功能门控以 `docs/adr/0017-firefox-desktop-compatibility.md` 为准：

- **构建与清单**：`extension/manifest.json` 保持为 Chromium 单一事实源（`dist/`）；Firefox 构建通过 `--target=firefox`（`pnpm build:firefox`）派生 `dist-firefox/manifest.json`（Event Page `background.scripts`、28 个常驻 `host_permissions`、`gecko` 与 `data_collection_permissions`）。
- **Offscreen 宿主**：Chromium 走 `chrome.offscreen`；Firefox 走后台 Event Page 动态挂载隐藏 `iframe`（方案 A，收口于 `extension/core/offscreen-host.ts`），保持跨帧 `runtime.Port` / `runtime.onMessage` 与 256 KB 后台体积守卫不变。
- **首期范围与样式红线**：Firefox 首期交付核心文摘阅读、双轨翻译、概览、对话、金句导出、Agent 桥接与无字幕 ASR 转写，门控隐藏 `tts` 朗读与 `live` 实时伴看入口；Firefox 滚动条样式必须包裹在 `@supports (-moz-appearance: none)` 内，严禁裸写 `scrollbar-width` / `scrollbar-color` 破坏 Chrome 121+ 的 `::-webkit-scrollbar`。

## 真机验证

jsdom 够不着的（真实 DOM 几何 / B 站真实接口 / MV3 SW 与 Firefox Event Page 生命周期 / offscreen / CSP）走真机：Chromium 自检跑 `pnpm harness:browser`，写场景见 `scripts/browser-harness/README.md`；Firefox 静态校验跑 `pnpm dlx web-ext lint -s dist-firefox`，真机分叉点冒烟跑 `pnpm smoke:firefox`。其余验证留在 `tests/`。

### POSIX 安装脚本测试

`tests/agent-bridge/install-agent-sh.test.ts` 在 Windows 下依赖 Git Bash（`msys-2.0.dll`），无法在终端沙箱内运行，默认被 `vitest.config.mjs` 排除。改动 `scripts/install-agent.sh` 或 bridge `status` 输出时，需在沙箱外执行 `pnpm test:installer`。

## Agent skills

### Issue tracker

GitHub Issues on `Edmund724/BiliScript` via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

### Transitive deps

只处理进产物或随产物分发的传递依赖公告；够不着的记理由，不静默。See `docs/agents/transitive-deps.md`.

## 设计与 UI

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
