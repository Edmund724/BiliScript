# ADR-0020：文摘面板独立窗口双模式承载与跨文档 DOM 搬移边界

> 状态：有效

文摘面板（`#biliscript-reading-view`）在视频页 Light DOM 页内承载（[ADR-0003](0003-light-dom-script-panel.md)）之外，支持脱离浏览器主窗口的**独立窗口**呈现宿主（覆盖 B 站与 YouTube），采用**同源跨文档 DOM 搬移 + 双模式窗口工厂（置顶画中画 / 普通窗口）**架构，零跨进程状态镜像，完整复用页面单例状态袋（[ADR-0002](0002-state-bag-write-discipline.md)）、`<video>` 绑定与在途流式对话。

## 已定决策

### 1. 双模式同源窗口工厂（默认置顶画中画，支持普通窗口）

- **置顶画中画（`pip`）**：基于 Document Picture-in-Picture API（固定传 `disallowReturnToOpener: false` 保留浏览器「返回标签页」键），窗口始终置顶且无地址栏；Chromium 下与原生 `<video>` 画中画共享单 PiP 槽位互斥，运行环境缺失或受限时静默回落普通窗口。
- **普通窗口（`popup`）**：基于同源 `window.open("about:blank", ..., "popup,...")`，不置顶但具备系统窗口分屏能力且可与原生 `<video>` 画中画并存。
- **模式偏好**：双模式共用同一 DOM 搬移与样式镜像引擎，模式偏好随常规设置存 `chrome.storage.sync`；独立窗口已打开时切换模式将借当前手势尝试就地重建，受限则下次弹出时生效。

### 2. 跨文档宿主抽象与按需样式/属性镜像

- 弹出时将 `#biliscript-reading-view` 及其全部子浮层整棵迁入目标窗口文档，不拆分视图；归位时迁回主文档并恢复 `extension/reader/script-host.ts` 几何定位。弹出期间原页解除右栏贴附，自然露出原生侧栏。
- 面板域（`extension/reader/`、`extension/ui/`、`extension/chat/`）禁止假设壳内节点恒驻主文档，节点查找、事件委托、选区与几何计算须收口至当前挂载文档/窗口上下文；阅读基础样式、按需懒样式及明暗/色板/排版属性统一经 `extension/shared/style-injector.ts` 与 `extension/reader/presentation.ts` 镜像同步至独立窗口。

### 3. 归位语义、生命周期与尺寸存储分层

- **顶栏与归位语义**：独立窗口内统一隐藏面板退出键，子窗口 `pagehide`（含 Document PiP 外侧「返回标签页」与系统标题栏 `×`）统一对齐「归位回页面」（保留阅读壳开启并恢复页内贴附）；`pip` 仅保留 `[主题][设置]`，`popup` 为 `[归位][主题][设置]`。关闭阅读壳经 `Alt+B`（`reader-toggle`）或归位后点击退出键完成。
- **手势与卸载边界**：源页 SPA 换片时保持独立窗口跟随刷新，时间戳跳转不将焦点抢回主浏览器，全屏时不自动归位；受用户手势限制，`autoOpenReader` 与整页恢复均以页内面板展开，不自动弹出独立窗口；源页卸载时同步关闭独立窗口防空壳残留。
- **尺寸记忆分层**：双模式共享的像素宽高记忆（`extension/core/detached-bounds-store.ts`）强依赖本机显示器分辨率，按 [ADR-0018](0018-layered-storage-and-extension-idb.md) 仅存本机 `chrome.storage.local`（并在恢复默认偏好时清除）。

## 考虑过的方案

- **扩展独立弹窗页（`chrome.windows.create` + 状态镜像）**：跨进程不共享内存，须经 Background Port 全量镜像字幕、概览、在途流式回复与视频控制 RPC，直接冲击 [ADR-0002](0002-state-bag-write-discipline.md) / [ADR-0004](0004-content-two-round-build-and-reader-gate.md) 且不支持置顶，否决。
- **在 Document PiP 内搬移宿主 `<video>` 或自绘视频镜像**：搬移宿主节点违背 [ADR-0003](0003-light-dom-script-panel.md) 且耦合播放器水合生命周期；自绘镜像丢失原生控条且开销过高，否决。

## 后果

- 跨窗手势、Firefox `XrayWrapper` 兼容与原生画中画互斥边界由 `pnpm harness:browser` 与 `pnpm smoke:firefox` 持续验证。
- **审查红线**：
  - 不得为独立窗口引入跨进程扩展页（`chrome.windows.create` 独立文档 + 状态镜像同步），也不得将宿主 `<video>` 节点搬入扩展独立窗口。
  - 独立窗口的像素宽高记忆不得写入 `chrome.storage.sync`，必须留在 `chrome.storage.local`。
