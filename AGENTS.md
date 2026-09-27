

## 工具链

依赖与脚本用 PATH 上的 pnpm（12.x）——`pnpm install` / `pnpm exec vitest run` 直接可用；npm 装依赖会被 `devEngines` 拒（EBADDEVENGINES）。

DSH 运行时自带的 pnpm 11.7.0 在本仓库必失败：`devEngines` 要求 ≥12 → 它切到 12.5.1 时生成的 Windows shim 指向无扩展名的 `sh` 占位脚本（生命周期脚本被拦、原生包 `@pnpm/exe.win32-x64` 未装），cmd 报 `'...\node_modules\pnpm\pnpm' is not recognized`。

## Agent skills

### Issue tracker

Local markdown tickets under `.scratch/tickets/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

### Transitive deps

只处理进产物或随产物分发的传递依赖公告；够不着的记理由，不静默。See `docs/agents/transitive-deps.md`.
