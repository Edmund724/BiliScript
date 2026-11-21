# ADR-0019：宿主富文本渲染与包体控制：KaTeX 纯 MathML 零字体与 Mermaid 构建期裁剪替身

> 状态：有效

文摘面板直接挂载于 B 站网页 Light DOM（[ADR-0003](0003-light-dom-script-panel.md)），同时受宿主页面严格 CSP、`web_accessible_resources` 最小暴露面与整包 `DIST_RUNTIME_MAX_BYTES = 3,900,000` 体积上限约束。数学公式与 Mermaid 图表渲染采用**纯原生 MathML 零字体输出**与**构建期源码副本按锚点裁剪配最小替身**方案。

## 已定决策

### 1. KaTeX 纯 MathML 零 Webfont 输出与跨引擎等号对齐

- `extension/ui/markdown.ts` 先执行 `escapeHtml` 防御 XSS 再做块级解析；`extension/ui/math-render.ts` 将 KaTeX 固定配置为 `output: "mathml"`，**不打包 KaTeX HTML/CSS 样式表与任何 `@font-face` Webfont 字体文件**，彻底规避宿主页面 `font-src` / `style-src` CSP 拦截与跨站扩展资源指纹暴露。
- 针对 Chromium（Blink）与 Firefox（Gecko）在原生 `<math display="block">` 顶层等号换行缩进上的排版差异，对含顶层 `=` 的长块级公式拆解为 HTML Flex 容器 + 分段 `<math display="block">`（外层保留完整 TeX 源码 `aria-label`），保证双引擎视觉对齐与屏幕阅读器语义完整。

### 2. Mermaid 12 构建期副本裁剪与最小依赖替身

- **不污染 `node_modules` 的构建区副本裁剪**：`scripts/vendor-mermaid-slim.mjs` 将 Mermaid chunk 复制到构建临时区，按源码内容锚点（不依赖易变哈希文件名）剥离未使用的图类、重型布局引擎（`cose-bilkent`、`ELK`）与重复 `katex` 副本；`scripts/build-content.js` 锁定 Mermaid 版本号与源码哈希，并在分包轮（[ADR-0004](0004-content-two-round-build-and-reader-gate.md)）通过 sourcemap `inputs` 守卫防止重型依赖回流或产生双实例。
- **最小构建期替身（`iconify` / `marked` / `d3-slim`）**：由 `scripts/vendor-iconify-stub.mjs`、`vendor-marked-stub.mjs` 与 `vendor-d3-slim.mjs` 在打包期替换重型传递依赖。其中 `vendor-d3-slim.mjs` 的 `transition().style(k, v)` **必须同步立即写入样式而非做成空操作**（Mermaid 节点提示层初始为 `opacity: 0`，空操作会导致元素永久透明不可见）。
- **运行时宿主隔离**（`extension/ui/mermaid-render.ts`）：在调用 `detectType()` 前必须先执行 `initialize()` 完成图表探测注册，按图类型显式补齐 Mermaid 12 `look` 配置（全局配置在 Mermaid 12 中不生效），重写产出 SVG 的根 ID 与内部引用以防与宿主同页多图冲突，且仅在渲染确认成功后才隐藏源码 `<pre>` 兜底。

## 考虑过的方案

- **全量打包 KaTeX 字体并暴露至 `web_accessible_resources`**：增加数百 KB 字体体积、引入宿主 CSP 冲突并扩大扩展可被网页探测的静态资源面。
- **直接 bundle 原始 `mermaid` 或用 patch-package 原地改写 `node_modules`**：前者单包膨胀数 MB 直接击穿 3.9MB 运行时总预算，后者破坏依赖树幂等性且跨机器易漂移。
