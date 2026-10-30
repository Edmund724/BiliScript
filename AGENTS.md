

## 工具链

依赖与脚本用 PATH 上的 pnpm（12.x）——`pnpm install` / `pnpm exec vitest run` 直接可用；npm 装依赖会被 `devEngines` 拒（EBADDEVENGINES）。

`npx` 同样过不去 `devEngines`：还没跑到目标 CLI 就报 EBADDEVENGINES。一次性命令行工具用 `pnpm dlx <pkg>`，非 npx 不可时加 `--force`。

GitHub 直连在这台机器上不通（git clone 连不上 443，codeload 也会断），网络命令走本机 HTTP 代理 `http://127.0.0.1:7890`：`HTTPS_PROXY=http://127.0.0.1:7890 git clone …`。

Agent skills 装在 `.agents/skills/`（DSH 的项目级发现路径），`.agents` 与 `skills-lock.json` 都不入库。安装/更新用 `pnpm skills add <owner/repo>`（即 `pnpm dlx skills`），代理同上；该命令在 modules 目录状态与锁文件不一致时会重整 `node_modules`，渲染、验收或长任务进行中不要执行。

DSH 运行时自带的 pnpm 11.7.0 在本仓库必失败：`devEngines` 要求 ≥12 → 它切到 12.5.1 时生成的 Windows shim 指向无扩展名的 `sh` 占位脚本（生命周期脚本被拦、原生包 `@pnpm/exe.win32-x64` 未装），cmd 报 `'...\node_modules\pnpm\pnpm' is not recognized`。

## 真机验证

jsdom 够不着的（真实 DOM 几何 / B 站真实接口 / MV3 SW 生命周期 / offscreen / CSP）走真机：自检跑 `pnpm harness:browser`，写场景见 `scripts/browser-harness/README.md`。其余验证留在 `tests/`。

## Agent skills

### Issue tracker

Local markdown tickets under `.scratch/tickets/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

### Transitive deps

只处理进产物或随产物分发的传递依赖公告；够不着的记理由，不静默。See `docs/agents/transitive-deps.md`.

## 设计与 UI

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
