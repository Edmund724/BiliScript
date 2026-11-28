# 文摘面板、独立窗口与高亮域词表（Reader & Notes）

返回根索引：[GLOSSARY.md](../../GLOSSARY.md) · 相关架构裁决：[ADR-0003](../adr/0003-light-dom-script-panel.md)、[ADR-0017](../adr/0017-firefox-desktop-compatibility.md)、[ADR-0018](../adr/0018-layered-storage-and-extension-idb.md)、[ADR-0019](../adr/0019-rich-text-mathml-and-mermaid-slim.md)、[ADR-0020](../adr/0020-detached-reader-window.md)。

## 文摘面板与阅读壳生命周期

### 文摘面板与右栏锚点

- **文摘面板**：阅读模式承载主体（`#biliscript-reading-view` / `#biliscript-reading-script-panel`），包含「字幕 / 概览 / AI 对话」三标签与全部子浮层。页内面板采用 Light DOM 右栏固定定位，不搬宿主 `<video>`；当前激活标签唯一状态位在 `extension/reader/state.ts`，写手单点为 `extension/reader/script-tab-activation.ts` 的 `activateScriptTab`。
- **右栏锚点**：按站点路由的贴栏候选链（B 站 `.right-container-inner` 至 `#reco_list`，YouTube `#secondary` 并在剧场模式跳过贴栏），有效判据为存在、宽度 `>= 280` 且未滚出视口；失效时依次降级至贴播放器与居中浮层。
- **阅读壳**：进入与退出阅读形态的唯一四态状态机事务（`closed / entering / open / exiting`，单源 `extension/core/state.ts` 的 `transitionReaderShell`），按 `open / restore / chat` 三意图串行执行样式挂载、呈现属性切换与收回过渡，退出时不拆壳根以保持域叶子节点引用有效。
- **播放器快捷按钮**：覆盖 B 站（`.bpx-player-container`）与 YouTube `/watch`（`#movie_player`）播放器右侧居中位，宿主门过即挂并走自愈链重挂。

- 代码锚点：`extension/reader/shell.ts`、`extension/reader/script-host.ts`、`extension/reader/script-tab-activation.ts`、`extension/reader/lifecycle.ts`、`extension/reader/state.ts`、`extension/ai/player-ai.ts`
- _Avoid_: 整页接管、反解 DOM class 取当前标签、手抄进入/退出序列

### 独立窗口跨文档宿主与零泄漏清理

- **双模式承载**：通过同源跨文档 `adoptNode` 将整棵文摘面板搬移至**置顶画中画**（Document PiP，`pip`）或**普通窗口**（`window.open`，`popup`），独立窗口隐藏退出键且系统 `×` / `pagehide` 统一对齐「归位回页面」；模式偏好存 `sync`，窗口像素宽高记忆仅存本机 `local`（`extension/core/detached-bounds-store.ts`）。
- **跨文档零泄漏边界**：活跃宿主句柄集中于 `extension/shared/active-host.ts`，镜像样式表由 `extension/shared/style-injector.ts` 的 `WeakMap<Document, ...>` 托管并在 `clearDetachedHostDocument` 时彻底清除。跨文档控件（`CustomSelect`、`model-picker`、`chat-model-panel`、`quote-share-modal`、`quote-share-export`）通过 `registerDetachedDocumentCleanup` 清理已关闭子文档关联的观察者与集合，文本宽度测量优先使用 `OffscreenCanvas` 避免持有子文档 `<canvas>`；Mermaid 离屏渲染容器在 `finally` 清除并移除孤儿节点。真机零泄漏由 `scripts/browser-harness/scenarios/detached-window-leak.mjs` 通过 Document PiP + `WeakRef` + CDP `HeapProfiler.collectGarbage` 回归守卫。

- 代码锚点：`extension/reader/detached-window.ts`、`extension/shared/active-host.ts`、`extension/shared/style-injector.ts`、`extension/ui/custom-select.ts`、`extension/ui/model-picker.ts`、`extension/reader/chat-model-panel.ts`、`extension/reader/quote-share-modal.ts`、`extension/reader/quote-share-export.ts`、`extension/ui/mermaid-render.ts`
- _Avoid_: 跨进程扩展页镜像同步、把宿主 `<video>` 搬入独立窗口、在模块级静态集合中长期强引用子文档节点或 `<canvas>`

## 视觉主题、排版与离屏渲染隔离

### 明暗模式、外观色板与文摘排版

- **明暗模式（`readerTheme`）**与**外观色板（`readerPalette`）**：正交双轴，`flyme`（蓝雾玻璃）与 `editorial`（暖纸衬线数字刊物）各具浅深完整令牌，切换互不覆盖。
- **文摘排版**：`readerFontSizeScale` 全局作用于三标签与设置抽屉正文；`chatLineHeight` 与 `chatParagraphSpacing` 仅作用于 AI 对话消息区，实时预览并配独立重置键（`extension/reader/chat-display-settings.ts`）。
- **输入框光晕**：`.chat-input-card` 外部虹彩漫射层，受 `chatInputGlow` 门控且在 `editorial` 色板下自动关闭。

### 对话离屏渲染隔离与字幕连续 DOM 边界

- **字幕区全量 DOM 不隔离**：`extension/entry/styles/reader.css` 中的 `.biliscript-subtitle-list` 保持全量连续 DOM，不启用容器级离屏隐藏，确保跨屏鼠标拖拽划词批注、复制与页内查找连贯。
- **对话区离屏隔离**：`extension/entry/styles/reader-chat.css` 对已完成非流式消息（`.chat-msg:not(.chat-msg-streaming)`）、已渲染 Mermaid 容器（`.biliscript-md-mermaid[data-biliscript-mermaid="done"]`）、折叠思考块（`.chat-thinking.chat-thinking-collapsed` / `.chat-thought-chain.chat-thought-chain-collapsed`）及非流式 Markdown 块级节点启用 `content-visibility: auto` 与 `contain-intrinsic-size: auto none auto <典型高度>`（使用 `auto` 记忆首次布局高度，避免回滚跳变并与 `extension/reader/chat-scroll-follow.ts` 贴底距离阈值兼容）；对活跃流式消息（`.chat-msg.chat-msg-streaming`）及含展开态浮层/控件的消息显式置为 `content-visibility: visible`，防止高度抖动或菜单裁剪。
- **Firefox 滚动条红线**：所有 `scrollbar-width` / `scrollbar-color` 声明必须包裹于 `@supports (-moz-appearance: none)` 内（[ADR-0017](../adr/0017-firefox-desktop-compatibility.md)）。

## 面板控件、待解释意图与高亮资产

### 面板控件词表

- **图标键**：无框纯图标按钮（`.biliscript-reading-icon-btn` / `.chat-msg-copy-btn` / `.biliscript-reading-ov-quote-copy`），静止透明，悬停与键盘焦点统一走 `--biliscript-reader-fill-hover`（**悬停反馈**）。
- **带框图标开关**：有边框纯图标选中开关（`.chat-web-search-pill`），两静止态字形一致，靠描边/底色与切换动效表达状态。
- **复制键**与**重置键**：复制图标与旋转重置图标统一由 `extension/ui/reading-icons.ts` 单源导出（`READING_COPY_ICON` / `READING_RESET_ICON`）。
- **待解释意图**：用户从字幕或选区解释卡发起、等待 AI 对话受理的一次解释请求，受理前可取消，受理后清除（`extension/reader/explain-intent.ts`）。

### 用户高亮批注（`note_highlights`）

用户在字幕区或概览区创建的划词高亮与批注，以 `videoKey` 为键独立持久化于 IDB v4 `note_highlights` 表（每视频上限 200 条，索引 `by_updatedAt`），由历史 `chrome.storage.local["biliscript_note_highlights_v1"]` 幂等迁移（标记 `note_highlights_migrated_v1`）。`note_highlights` 属于用户主动资产，**严禁参与视频缓存字节 LRU 淘汰**。

- 代码锚点：`extension/notes/highlights-store.ts`、`extension/reader/subtitle-highlights-ui.ts`、`extension/subtitle/idb-store.ts`
- _Avoid_: 把用户高亮混入可淘汰视频缓存、未确认 IDB 落盘前删除旧 local 键
