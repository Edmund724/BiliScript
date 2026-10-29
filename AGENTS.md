

## 视频制作

这是宣传片制作专用分支，用户的指令默认都与视频制作有关。每次开始工作前先读 `scripts/promo/README.md`，按其中的任务入口、前置条件和工件地图执行。

修改期减少测试和验收，但每次小修后都必须重新渲染完整视频，将修改合并进成片：

- 完整视频渲染后检查受影响片段；单镜头或关键帧只用于额外定位问题，不能代替完整视频。
- 字幕、音频、时间轴或转场修改，补查相关片段及声音。
- 阶段完成才运行完整草稿验收；最终交付前运行 `promo:verify` 并完成全片视听验收。
- 只有修改共享组件或构建流程时，才运行相关代码测试。

## 工具链

依赖与脚本用 PATH 上的 pnpm（12.x）——`pnpm install` / `pnpm exec vitest run` 直接可用；npm 装依赖会被 `devEngines` 拒（EBADDEVENGINES）。

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
