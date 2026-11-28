## Commands (agents may run these without asking)

仅用 PATH 上的 `pnpm`（12.x）；禁用 `npm`、`npx` 及 DSH 内置 pnpm 11（触发 `devEngines` 报错）。一次性 CLI 用 `pnpm dlx <pkg>`（非 npx 不可时加 `--force`）。

- install: `pnpm install`
- typecheck: `pnpm typecheck`
- checks: `pnpm lint:comments` / `pnpm icons:check` / `pnpm catalog:check`
- test (高频迭代，单文件): `pnpm exec vitest run <path>`
- test (里程碑，unit-node + unit-dom): `pnpm test:unit`
- test (合入前全量 / 仅 e2e): `pnpm test` / `pnpm test:e2e`
- test (POSIX 安装脚本，需在沙箱外跑): `pnpm test:installer`
- build (Chromium / Firefox): `pnpm build` / `pnpm build:firefox`
- verify (真机 / 静态清单): `pnpm harness:browser` / `pnpm smoke:firefox` / `pnpm dlx web-ext lint -s dist-firefox`

## 测试与验证

- **Vitest 分层**：3 个 project——`unit-node`（默认 `node`，覆盖其余单测）、`unit-dom`（`jsdom`，覆盖 `tests/ui/**`、`tests/reader/**`）、`e2e`（`jsdom`，覆盖 `tests/e2e/**`）。
- **验证节奏**：高频迭代用 `pnpm typecheck` + 单文件 `vitest run <path>`（禁用 `vitest related`，模块耦合会拉起近似全量）；里程碑跑 `pnpm test:unit`；合入前跑 `pnpm test` + `pnpm build` + 真机验证。
- **防回退约束**：新增非 UI/Reader/E2E 单测默认 `node` 环境，仅真实依赖 DOM / `window` / `history` / `location` 时在首行加 `// @vitest-environment jsdom`；同模块用例用 `describe` 收拢不拆 1–3 个用例的微文件；组合矩阵与多状态流程放 `tests/e2e/`。
- **真机验证边界**：jsdom 测不到的（真实 DOM 几何 / B 站真实接口 / MV3 SW 与 Firefox Event Page 生命周期 / offscreen / CSP）走真机（写场景见 `scripts/browser-harness/README.md`），其余留在 `tests/`。
- **POSIX 安装脚本特例**：`tests/agent-bridge/install-agent-sh.test.ts` 在 Windows 下依赖 Git Bash（`msys-2.0.dll`），默认被 `vitest.config.mjs` 排除；改动 `scripts/install-agent.sh` 或 bridge `status` 输出时在沙箱外执行 `pnpm test:installer`。

## 浏览器兼容

目标平台为 Chromium（≥120）与桌面端 Firefox（≥153，不适配 Android），架构边界与功能门控以 `docs/adr/0017-firefox-desktop-compatibility.md` 为准：

- **清单与产物**：`extension/manifest.json` 为 Chromium 单一事实源（`dist/`）；Firefox 产物与清单通过 `pnpm build:firefox` 派生至 `dist-firefox/`。
- **Offscreen 与门控**：Offscreen 分叉收口于 `extension/core/offscreen-host.ts`（保持 300 KB 后台体积守卫）；Firefox 门控隐藏 `tts` 朗读与 `live` 实时伴看入口。
- **样式红线**：Firefox 滚动条样式必须包裹在 `@supports (-moz-appearance: none)` 内，严禁裸写 `scrollbar-width` / `scrollbar-color` 破坏 Chrome 121+ 的 `::-webkit-scrollbar`。

## Agent docs

- **Issue tracker**: GitHub Issues on `Edmund724/BiliScript` via `gh` CLI (`docs/agents/issue-tracker.md`)
- **Triage labels**: Default five-role vocabulary (`docs/agents/triage-labels.md`)
- **Domain docs**: Single-context (`docs/agents/domain.md`)
- **UI design**: 双主题、视觉 token 与交互规范 (`docs/agents/design.md`)
- **Transitive deps**: 只处理进产物或随产物分发的传递依赖公告；够不着的记理由，不静默 (`docs/agents/transitive-deps.md`)

## 设计与 UI

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
