# ADR-0003：Light DOM 右栏文摘面板、几何降级链与宿主碰撞边界

> 状态：有效

阅读模式唯一载体为留在 B 站页面 **Light DOM** 内的右栏固定定位文摘面板（`#biliscript-reading-view`），**不搬移任何 B 站宿主节点、不给宿主页面加遮挡或让位规则，也不将扩展子树迁入 Shadow DOM**。

## 已定决策

### 1. 右栏锚点探测与三级几何降级链

- `extension/reader/script-host.ts` 按优先级串行试探 `ANCHOR_SELECTORS`（新版 `.right-container-inner` 起至旧版 `#reco_list` 止，有效判据 = 节点存在 + `rect.width >= 280` + 未滚出视口），将计算出的几何写入 `--biliscript-script-left/top/width/height` 驱动 `position: fixed` 贴栏，保留页面弹幕、评论与分P交互原位可用，视频事件经 `reader/video-bind.ts` 直接绑定 `<video>`。
- 锚点失效或窄视口时按序降级：**贴右栏 → 贴播放器右缘 → 居中浮层（`data-biliscript-script-float="1"`）**。对 B 站改版的对抗面收敛在单一锚点数组，失配仅表现为位置降级而非功能失效。
- 自定义面板宽度 `customPanelWidth`（400–650px，默认 540px，由 `customPanelWidthEnabled` 门控）贯通贴栏、贴播放器与浮层三种形态。几何重算走 `resize`/`scroll` 的 `rAF` 合帧脏检查、`ResizeObserver` 与 2000ms 定时重锚自查，**禁止对宿主挂高频 `MutationObserver`**（防弹幕高频变更打爆主线程）。

### 2. 无闪烁进退场与常驻壳根

- 进入阅读壳（`reader/shell.ts`）先挂载阅读样式表 `<link>` 并等待 `onload`（带超时兜底）、翻转 `body`/`html` 呈现属性并强制读取关闭态计算样式，再触发 `@starting-style` 离散过渡，消除首帧无样式跳变。
- 退出时等待面板收回过渡完成后拆除定位宿主与样式表，但**保留壳根节点不销毁**——域内模块在求值期解析并长期持有壳内节点引用，销毁重建会导致引用静默失效。

### 3. Light DOM 宿主碰撞硬边界

扩展子树与 B 站共享同一文档样式作用域，以下真机碰撞约束（jsdom 单测不可见）必须守恒：

- **宿主 `[hidden] !important` 与全局重置防护**：B 站 `video.*.css` 含全局 `[hidden] { display: none !important }` 及标题、链接、列表重置。双语选轨外层浮层 `.custom-select-dropdown[hidden]` 须以 `(1,3,0)` 特指度显式声明 `display: none` 压过 `:has()`，内嵌副列以 `initCustomSelect(..., { inline: true })` 常显（不带 `hidden` 属性，规避宿主 `[hidden] !important` 与外点收起拦截）；面板与 Markdown 区显式恢复标题、链接令牌色与列表标记。
- **播放器控制栏 `createOverflowCheck` 防塌陷**：B 站 `bpx-player` 内部监测控制栏相邻子元素几何越界，一旦 `rect.left < prev.right - 1` 会判定空间不足并折叠隐藏整条控制栏。`player-ai.css` 仅在紧邻带大右外边距的可见 Hi-Res / Dolby 按钮之后才施加负左外边距补偿，严禁对零外边距前序兄弟无条件负偏移。

### 4. 壳层/按需样式拆分与浮层挂载边界

- **对话工具键归属常驻壳与样式拆分守卫**：AI 对话「更多操作」入口（`#biliscript-reading-chat-more-btn` 与 `#biliscript-reading-chat-more-menu`，由 `extension/ui/ui-renderer.ts` 渲染）保留在面板常驻标签行 `.biliscript-reading-tabs-row > .biliscript-reading-tabs-tools` 内，入口按钮复用壳层 `.biliscript-reading-icon-btn` 外观，初始渲染不依赖按需加载的 `extension/entry/styles/reader-chat.css`。显隐由 `extension/entry/styles/reader.css` 的 `:has(#biliscript-reading-tab-chat.is-active)` 与 `reader-chat.css` 的历史模式 `:has(.chat-history-popover:not([hidden])) > .biliscript-reading-tabs-row` 声明式控制；懒加载组合根 `extension/reader/chat-tab.ts` 仅经 `extension/shared/dom-ids.ts` 稳定 DOM ID 跨层接线。`reader-chat.css` 由 `extension/shared/style-injector.ts`（`ensureReaderChatStyles`，挂载点在 `ui-renderer.ts` 切入 `chat` 分支与 `chat-tab.ts` 模块顶）按需挂载，`tests/entry/reader-chat-css-split.test.ts` 守卫对话 `.chat-*` 规则不回流 `reader.css`。
- **滚底按钮隔离于消息滚动容器**：`.chat-scroll-bottom`（`#biliscript-reading-chat-scroll-bottom`，见 `extension/reader/chat-template.ts`）必须挂载在 `position: relative` 的非滚动 `<footer class="chat-footer">` 内（以 `bottom: calc(100% + 6px)` 定位），**禁止移入滚动容器 `<main class="chat-messages">`**，防止绝对定位按钮随消息流漂移，并在历史记录整页隐藏 `.chat-footer` 时自动同步退场。
- **划词悬浮胶囊为面板壳级单实例**：`#biliscript-reading-explain-pop`（由 `extension/reader/explain-pop-ui.ts` 构建并经 `computeSelectionPopPosition` 防裁切定位）以单实例直接挂载在 `<aside id="biliscript-reading-script-panel">` 顶层，**禁止落入「字幕」或「概览」各自的 tab 滚动容器内**，以支持跨双 tab 复用并以面板与视口坐标系统一计算定位边界。

## 考虑过的方案

- **整页接管（搬移 B 站 `<main>` 与播放器入扩展壳并剪枝页面）**：进出模式往返重、遮蔽弹幕评论，且重度耦合脆弱的播放器挂载与控制条生命周期，已彻底退役。
- **将文摘面板或播放器按钮迁入 Shadow DOM**：宿主门控规则物理上无法跨出 Shadow Root 命中外部节点；播放器内按钮依赖 `closest()` 与宿主 DOM 互操作；仅把面板迁入 Shadow DOM 仍需重写事件委托冒泡（retargeting）、跨边界焦点/无障碍关系与全局呈现属性继承，改造成本远高于以 `#biliscript-*` / `.biliscript-*` 作用域前缀隔离残余样式面。
