# ADR-0032：文摘阅读域四层无环架构、双阶惰性分包与无闪烁壳生命周期

> 状态：有效

在阅读面板（`extension/reader/` 与 `extension/ui/`）的演进中，为控制常驻包请求数与体积（对齐 ADR-0008）并彻底消除面板开合闪烁与 DOM/焦点竞争，我们决定在阅读域实施 **严格四层无环依赖图（`readerPorts` 反转反向边）**、**二级按需分包与零成本卸载短路**，以及 **样式门控先行、序列化事务队列与滚动高频重采样避让** 的壳生命周期契约。

## 背景与动机

1. **模块循环依赖与测试孤岛**：`reader/` 内部视频绑定、播放同步、批量渲染与生命周期协调之间存在天然双向协作，若相互直接静态 `import` 会造成 ESM 循环引用且使单测无法隔离。
2. **重模块拖累首屏与非阅读用户**：`reader/chat-tab.ts`（约两千行对话内核）、`reader/presentation.ts`（含 `core/validators.ts`）、`ai/player-ai.ts` 体积显著；若在常驻包或阅读首包静态引用，会大幅膨胀初始加载；而关闭面板若触发懒包下载则是严重的反向浪费。
3. **首次开合布局跳变与滚动性能抖动**：面板采用 `@starting-style` 离散动画（ADR-0020）和右侧贴栏几何计算（ADR-0006），若在 CSS `<link>` 加载或锚点宽高测量前就翻转显隐属性，首帧会出现跳变与无样式闪烁；关闭时立刻加 `hidden=true` 又会截断退场过渡并触发 `aria-hidden` 焦点错误。

## 已定决策

### 1. 阅读域四层无环 DAG 与反转意图/投影通道

- 阅读域严格维持 `reader-bus <- LAYOUT <- SYNC <- LIFECYCLE` 单向静态依赖方向：所有逆向回调（如 `video-bind -> sync`、`sync -> batched-render`、`batched-render -> subtitle-search`）统一通过 `reader-bus.ts` 的 `registerReaderPorts` 与 `setReadingSubtitleBatchHook` 在 `lifecycle.ts` 求值时一次性注入；每个槽显式声明缺失策略（`'throw'` / `'noop'` / `'noop-warn'`）。
- 标签切换遵循 `ui/ui-renderer.ts` 单向回传意图（`reportTabIntent`）→ `reader/script-tab-activation.ts` 串行队列更新状态与按需激活 → 发回 `"project-tab"` 指令由 UI 纯投影 DOM 的反转契约，彻底切断 `reader -> ui` 循环边。

### 2. 二级惰性分包边界与「未加载即 No-Op」卸载守卫

- `reader/chat-tab.ts`、`reader/presentation.ts`、`reader/shell.ts`（剥离纯谓词 `shell-intact.ts` 与纯类型 `ReaderShellIntent`）与 `ai/player-ai.ts` 均置于独立动态 chunk 之后；`ui/reading-header-icons.ts` 将常驻图标与懒载按钮图标物理拆文件，防止 esbuild 公共块提升把懒载 SVG 拉入常驻包。
- 所有面板关闭、存储监听同步或清理路径均先同步判定 `isReaderChatTabLoaded()` / `isPlayerAiLoaded()`：若目标 chunk 尚未加载，直接作为无副作用（no-op）返回，严禁为了销毁而反向触发网络/包加载。
- 挂载态 `#biliscript-reading-view` 一旦建壳后在其生命周期内保持 DOM 节点身份稳定（不在领域叶加载后重建），以免叶模块缓存的节点引用悬空。

### 3. 无闪烁壳事务队列与渲染性能约束

- `reader/shell.ts` 与 `entry/content.ts` 共享串行进入/退出事务队列：开启面板前必须先挂载样式 `<link>`、等待 stylesheet `onload`（50ms 可用性兜底）并预计算贴栏几何 CSS 变量与主题快照，再翻转 `data-biliscript-reader-mode="1"` 并刷新 `getComputedStyle(readingView).display`，保证 `@starting-style` 从最终几何矩形起跳。
- 退场时先 `blur()` 活动子元素并按先设 `inert` 再设 `aria-hidden="true"` 的顺序保住退场过渡动画（同时不记录未确认的搜索拒签偏好），动画结束后再落 `hidden=true`。
- 贴栏滚动期间通过 `data-biliscript-script-scrolling="1"`（仅值变化时写 DOM，150ms 空闲恢复）暂时关闭头部 `backdrop-filter`，避免每帧重采样掉帧；字幕长列表采用首屏批 + `rAF` 分帧追加与 `content-visibility: auto` 视口均值动态行高采样（跳过隐藏态与 `<3` 样本），避免初次下拉时 `scrollHeight` 边滚边涨。

## 考虑过的备选

- **由每个子模块直接监听 `chrome.storage` 并在 `closeReadingView` 时无条件动态 `import` 各 Tab 执行清理**：会导致关闭已折叠面板时反向拉起 `chat-tab` 大包并在多轮测试重载中触发重复注册，予以否决。
- **使用 `chrome.scripting.insertCSS` 注入阅读样式**：内容脚本侧无法卸载动态插入的样式表，退出阅读模式后会永久残留污染宿主页面，予以否决。

## 后果

- 新增跨阅读层逆向调用必须注册进 `readerPorts` 并遵循 `tests/layer-deps.test.ts` 与壳顺序守卫约束；任何可能改变 `#biliscript-reading-view` 呈现属性或状态位的扩展都必须通过 `reader/presentation-fields.ts` 单表派生。
