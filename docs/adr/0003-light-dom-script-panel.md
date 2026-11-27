# ADR-0003：Light DOM 右栏文摘面板、几何降级链与宿主碰撞边界

> 状态：有效

阅读模式页内宿主为留在视频页 **Light DOM** 内的右栏固定定位文摘面板（`#biliscript-reading-view`，覆盖 B 站与 YouTube），并支持经同源跨文档 DOM 搬移切入**独立窗口**（见 [ADR-0020](0020-detached-reader-window.md)）；两种宿主均**不搬移任何宿主节点、不给宿主页面加遮挡或让位规则，也不将扩展子树迁入 Shadow DOM**。

## 已定决策

### 1. 右栏锚点探测与三级几何降级链

- `extension/reader/script-host.ts` 按当前站点探测右栏锚点（B 站由 `.right-container-inner` 向下回落，YouTube 锚定 `#secondary` 且在剧场模式或下沉布局跳过；有效判据 = 节点存在 + `rect.width >= 280` + 未滚出视口），以 `--biliscript-script-*` CSS 变量驱动 `position: fixed` 贴栏，保留宿主页面交互原位可用。
- 锚点失效或窄视口时按序降级：**贴右栏 → 贴播放器右缘 → 居中浮层（`data-biliscript-script-float="1"`）**，使页面改版仅表现为位置降级而非功能失效。
- 自定义面板宽度 `customPanelWidth`（`400–960px`，默认 `540px`）贯通贴栏、贴播放器与浮层三种形态。几何重算走 `rAF` 合帧脏检查、`ResizeObserver` 与低频定时重锚自查，**禁止对宿主挂高频 `MutationObserver`**（防弹幕等高频 DOM 变更拖垮主线程）。

### 2. 无闪烁进退场与常驻壳根

- 进入阅读壳（`extension/reader/shell.ts`）先挂载阅读样式表并等待 `onload`（带超时兜底）、翻转 `body`/`html` 呈现属性并强制读取关闭态计算样式，再触发 `@starting-style` 过渡，消除首帧无样式跳变。
- 退出时等待收回过渡后拆除定位宿主与样式表，但**保留壳根节点不销毁**——域内模块在求值期解析并持有壳内节点引用，销毁重建会导致引用静默失效。

### 3. Light DOM 宿主碰撞与浮层/样式隔离边界

- **宿主 `[hidden] !important` 与全局重置防护**：B 站全局 `[hidden] { display: none !important }` 与基础标签重置会影响共享作用域；自定义选轨下拉需以更高特指度显式控制显隐，内嵌副列不带 `hidden` 属性，面板与 Markdown 区显式恢复标题、链接与列表样式。
- **播放器控制栏防塌陷**：B 站 `bpx-player` 的 `createOverflowCheck` 监测相邻子元素几何越界（`rect.left < prev.right - 1` 会折叠整条控制栏）；`player-ai.css` 仅在紧邻带大右外边距的可见兄弟之后施加负左外边距补偿，严禁无条件负偏移。
- **壳层/按需样式拆分与浮层挂载**：对话区样式（`reader-chat.css`）按需加载，禁止 `.chat-*` 规则回流壳层 `reader.css`（由 `tests/entry/reader-chat-css-split.test.ts` 守卫）；滚底按钮挂在非滚动的 `.chat-footer` 内、划词悬浮胶囊作为单实例挂在面板壳顶层，均禁止放入 tab 滚动容器内。

## 考虑过的方案

- **整页接管（搬移宿主 `<main>` 与播放器入扩展壳并剪枝页面）**：进出往返重、遮蔽原页交互且重度耦合脆弱的播放器挂载生命周期，已否决。
- **将文摘面板或播放器按钮迁入 Shadow DOM**：宿主门控规则无法跨出 Shadow Root 命中外部节点，播放器按钮依赖 `closest()` 与宿主互操作，且面板迁入仍需重写事件委托、跨边界焦点与主题属性继承，改造成本高于 `#biliscript-*` / `.biliscript-*` 前缀隔离。
