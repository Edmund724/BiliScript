# ADR-0020：文摘面板独立窗口双模式承载与跨文档 DOM 搬移边界

> 状态：有效

文摘面板（`#biliscript-reading-view`）在 B 站主文档 Light DOM 页内承载（[ADR-0003](0003-light-dom-script-panel.md)）之外，增加脱离浏览器主窗口约束的**独立窗口**呈现宿主，采用**同源跨文档 DOM 搬移 + 双模式窗口工厂（置顶画中画 / 普通窗口）**架构，零跨进程状态镜像，完整复用页面单例状态袋（[ADR-0002](0002-state-bag-write-discipline.md)）、`<video>` 绑定与在途流式对话。

## 已定决策

### 1. 双模式同源窗口工厂（默认置顶画中画，支持普通窗口）

- **置顶画中画（`pip`）**：基于 Document Picture-in-Picture API（`window.documentPictureInPicture.requestWindow`），窗口始终置顶且无地址栏，固定传 `disallowReturnToOpener: false` 保留浏览器自带「返回标签页」键，与系统标题栏关闭键统一作为外侧归位入口。Chromium 下与 B 站原生 `<video>` 画中画共享单 PiP 槽位互斥，且规范不支持关闭置顶；若运行环境缺失或受限于该 API，静默回落至普通窗口模式。
- **普通窗口（`popup`）**：基于同源 `window.open("about:blank", ..., "popup,...")`，不支持置顶且带浏览器防钓鱼只读来源栏，但具备完整系统窗口能力（最小化、最大化、贴边分屏），且可与 B 站原生 `<video>` 画中画并存。
- **模式偏好与切换**：两种模式共用同一套 DOM 搬移与样式镜像引擎。模式选择位于设置抽屉「阅读器与播放器」子页（与 `customPanelWidth` 同组，默认 `pip`），随常规设置落 `chrome.storage.sync`。独立窗口已打开时在设置内切换模式，借本次点击手势尝试就地重建新形态窗口并迁移面板；若浏览器因跨窗手势限制拒绝，则保留当前窗口并提示下次弹出时生效。

### 2. 跨文档宿主抽象与按需样式/属性镜像

- 弹出独立窗口时，将 `#biliscript-reading-view` 及其全部子浮层（三标签、划词解释卡、设置抽屉、金句分享导出、图片灯箱、确认框）整棵迁入目标窗口文档，不拆分视图；归位时迁回主文档并恢复 `extension/reader/script-host.ts` 几何定位。
- 面板域（`extension/reader/`、`extension/ui/`、`extension/chat/`）禁止假设壳内节点恒驻主文档，节点查找（如 `extension/shared/dom-utils.ts` 的 `byId`）、全局事件委托、选区与几何计算须收口至当前挂载文档/窗口上下文。
- `extension/shared/style-injector.ts` 维护的阅读基础样式与按需懒样式（`reader-chat.css`、`reader-settings-*.css`、`custom-select.css` 等），以及 `extension/reader/presentation.ts` 同步的明暗/色板/排版呈现属性，须镜像同步至独立窗口文档。独立窗口打开期间原页面解除右栏贴附，自然露出 B 站原生推荐列表与评论，不留空白占位。

### 3. 交互契约、生命周期与尺寸存储分层

- **顶栏键位与外侧归位语义**：页内形态顶栏动作区固定为 `[弹出独立窗口] [主题] [设置] [退出]`（见 `extension/ui/ui-renderer.ts`）；进入独立窗口后统一隐藏面板内退出键，子窗口 `pagehide`（含 Document PiP 外侧「返回标签页」与系统标题栏 `×`）统一对齐「归位回页面」（保留阅读壳开启并恢复页内贴附）；`pip` 模式同时隐藏面板内归位键，仅显示 `[主题] [设置]`；`popup` 模式在保留面板内归位键的前提下同样隐藏面板内退出键（`[归位] [主题] [设置]`）。独立窗口打开期间直接关闭阅读壳通过 `Alt+B`（`reader-toggle`）或归位后点击页内退出键完成。
- **外部入口与视频联动**：独立窗口打开期间，`reader-enter`（工具栏图标 / 页内文摘按钮）聚焦并拉起独立窗口；`reader-toggle`（`Alt+B`）关闭独立窗口并退出阅读壳；播放器快捷 AI 键聚焦独立窗口并切入对话执行追问。独立窗口内点击时间戳跳转或章节播放直接操控源页 `<video>` 但不将焦点抢回主浏览器；原页进入网页全屏或浏览器全屏时不自动归位。
- **SPA 跟随与手势/卸载边界**：源页 SPA 换片或切分P时保持独立窗口开启并自动跟随新视频刷新内容。受用户手势限制，`autoOpenReader` 自动展开与整页刷新（`reader-restore`）均以页内面板展开，不自动弹出独立窗口；原标签页关闭或整页卸载时同步关闭独立窗口（普通窗口须在源页 `pagehide` 主动调用 `close()` 防空壳残留）。
- **尺寸记忆分层**：双模式共用一份窗口宽高记忆（最小 `360 × 420`；首次无记录时宽度继承页内面板宽度或默认 `540px`，高度取 `min(760, Math.round(screen.availHeight * 0.8))`）。像素尺寸强依赖本机显示器分辨率，按 [ADR-0018](0018-layered-storage-and-extension-idb.md) 仅存本机 `chrome.storage.local`，并在「恢复默认偏好」时一并清除。

## 考虑过的方案

- **扩展独立弹窗页（`chrome.windows.create({ type: "popup", url: "entry/detached-reader.html" })`）**：跨进程不共享内存，须经 Background Port 全量镜像字幕、双语轨、概览、在途流式回复与视频控制 RPC，或重写阅读域运行时（直接冲击 [ADR-0002](0002-state-bag-write-discipline.md) / [ADR-0004](0004-content-two-round-build-and-reader-gate.md)），且同样不支持置顶，直接否决。
- **在 Document PiP 内搬移 B 站 `<video>` 或自绘视频镜像以兼顾置顶与画中画**：搬移宿主节点违背 [ADR-0003](0003-light-dom-script-panel.md) 且重度耦合播放器水合生命周期；自绘镜像丢失弹幕与原生控条且解码开销过高。
- **引入本地原生伴生进程对普通窗口置顶**：超出纯浏览器扩展能力边界，安装与跨平台维护成本远高于收益。

## 后果

- **真机验证门槛**：Firefox 153 Content Script 侧 `documentPictureInPicture` 的 `XrayWrapper` 表现、Chromium 下与原生 `<video>` 画中画的互斥边界，以及独立窗口内切换模式时的跨窗用户手势传递，须在编码阶段通过 `pnpm harness:browser` 与 `pnpm smoke:firefox` 真机实测确认。
- **审查红线**：
  - 不得为独立窗口引入跨进程扩展页（`chrome.windows.create` 独立文档 + 状态镜像同步），也不得将 B 站 `<video>` 宿主节点搬入扩展独立窗口。
  - 独立窗口的像素宽高记忆不得写入 `chrome.storage.sync`，必须留在 `chrome.storage.local`。
