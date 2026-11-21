# ADR-0036：跨引擎 UI 渲染、零 Webfont MathML/Mermaid 与无障碍交互不变量

> 状态：有效

在 Chromium 与桌面端 Firefox 的阅读界面、设置抽屉、金句卡片导出及 Markdown/公式/图表富文本渲染中，为规避宿主页面 CSP 限制、跨引擎排版/XrayWrapper 差异、Windows 分数缩放对齐漂移以及焦点与手势令牌丢失问题，我们确立以下 UI 渲染与交互不变量。

## 背景与动机

1. **宿主页面 CSP 与扩展资源限制**：Markdown 数学公式与 Mermaid 图表直接运行在 B 站网页 DOM 环境中；若引入 KaTeX HTML/CSS 样式表和 `@font-face` Webfont，不仅需大面积暴露 `web_accessible_resources`，还会被宿主严格 CSP 拦截。
2. **Blink vs Gecko 及 Windows 高分屏底层行为差异**：原生 `<math display="block">` 在顶层等号对齐时的跨行缩进行为在 Chromium 与 Firefox 上不一致；Firefox content script 的 `XrayWrapper` 会破坏对 DOM `hidden` 属性描述符的拦截劫持；Windows 125%/150% 分数缩放下 `translate3d` 图层提升与 `offsetWidth` 整数舍入会造成开关像素错位与截断。
3. **异步导出与动态工具栏高频 DOM 变更**：`navigator.clipboard.write()` 要求在用户点击激活栈内同步调用；B 站播放器与工具栏 Vue 水合及弹幕属性变更每秒触发大量 `MutationObserver` 回调，朴素全树扫描会严重消耗主线程。

## 已定决策

### 1. MathML-Only KaTeX 渲染、先转义 Markdown 与增量流式游标

- `ui/math-render.ts` 配置 KaTeX 仅输出原生浏览器 MathML（零 Webfont、零额外样式资源），并对顶层含 `=` 的长公式拆解为 HTML Flex 容器 + 分段 `<math display="block">`（同时保留完整 TeX `aria-label`），在 Blink 与 Gecko 上获得一致对齐。
- `ui/markdown.ts` 实行 **先 `escapeHtml` 再块级解析** 防御 XSS（省略 Setext 标题避免正文 `---` 误识别），并以 O(delta) 的 `ThinkStripCursor` / `MarkdownTailCursor` 与就地追加节点游标保持流式输出时 `<table>` / `<ul>` / `<ol>` DOM 身份与横向滚动条位置不变。
- `ui/mermaid-render.ts` 在 `detectType()` 前先执行 `initialize()` 完成图表探测注册，按图表类型单独补齐 Mermaid 12 `look` 配置（全局配置实测失效），缓存 SVG 并重写根 ID 避免同页 ID 冲突，且仅在 `data-biliscript-mermaid="done"` 后隐藏源 `<pre>` 保底。

### 2. 跨引擎焦点管理、合成器动画与 `XrayWrapper` 安全边界

- `ui/custom-select.ts`、`ui/focus-scope.ts` 与 `live/audio-popover.ts` 采用 `popover="manual"`（避开 `auto` 轻触关闭与触发键抢焦竞争），通过原生 `MutationObserver`（`attributeFilter: ["hidden"]`）代替覆写 DOM 属性描述符以兼容 Firefox `XrayWrapper`；关闭模态或下拉时严格保证 **先解除兄弟节点 `inert`（或先失焦已禁用的触发器）再恢复焦点**。
- `ui/trigger-motion.ts`、`ui/nav-motion.ts` 与 `ui/toggle-switch.ts` 仅使用合成器属性与独立 CSS `scale`（不覆写居中弹窗 `translate(-50%, -50%)`），在开关滑块采用 2D `translateX` 避免 Windows 分数缩放错位，且不在 `pointerdown` 阻止默认行为以保住原生 `<label>` 点击联动（改用一次性捕获 `click` 拦截拖拽尾事件）。

### 3. 零扫描工具栏注入快速路径与同步激活剪贴板导出

- `ui/script-button.ts` 实现 `body` / 工具栏容器两级 `MutationObserver` 切换与 `anchorSeat` 兄弟节点零扫描快速路径，搭配 200ms/2000ms 自适应两档自愈轮询。
- `reader/quote-share-export.ts` 与 `reader/quote-share-modal.ts` 统一在 408×229.5 逻辑坐标系下用同一 Canvas 2D 文本测量器计算 DOM 预览与 1200px PNG 导出折行，利用 `new ClipboardItem({ "image/png": blobPromise })` 在点击同步栈内保留用户激活令牌，并在非 `corner-shape` 引擎上用 SVG `clip-path` + 内描边复现 1:1 连续超椭圆曲线（对齐 ADR-0021）。
- `ui/model-picker.ts` 与 `ui/provider-transaction.ts` 要求权限申请 `chrome.permissions.request` 之前**零 `await`**，防止异步微任务打断浏览器用户手势令牌。

## 考虑过的备选

- **全量打包 KaTeX CSS/字体并放到 `web_accessible_resources`**：增大分发包体并引入跨站字体资源暴露与 CSP 冲突，予以否决。
- **在点击导出金句图片时先 `await canvas.toBlob()` 再写入剪贴板**：在 Chromium 与 Firefox 中均会因手势激活过期而抛出 `NotAllowedError`，予以否决。

## 后果

- 任何涉及 `chrome.permissions.request`、`navigator.clipboard.write` 或模态焦点的交互路径必须遵守「零 `await` 守手势」「先解 `inert` 再 `.focus()`」和「不使用全局 DOM 属性描述符劫持」三条红线。
