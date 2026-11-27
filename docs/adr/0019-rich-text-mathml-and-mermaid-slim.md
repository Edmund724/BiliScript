# ADR-0019：宿主富文本渲染与包体控制：KaTeX 纯 MathML 零字体与 Mermaid 构建期裁剪替身

> 状态：有效

文摘面板直接挂载于视频页 Light DOM（[ADR-0003](0003-light-dom-script-panel.md)），同时受宿主页面严格 CSP、`web_accessible_resources` 最小暴露面与双端运行时体积预算（[ADR-0004](0004-content-two-round-build-and-reader-gate.md)）约束。数学公式与 Mermaid 图表渲染采用**纯原生 MathML 零字体输出**与**构建期源码副本按锚点裁剪配最小替身**方案。

## 已定决策

### 1. KaTeX 纯 MathML 零 Webfont 输出与跨引擎等号对齐

- `extension/ui/markdown.ts` 先执行 `escapeHtml` 防御 XSS 再做块级解析；`extension/ui/math-render.ts` 将 KaTeX 固定配置为 `output: "mathml"`，**不打包 KaTeX HTML/CSS 样式表与任何 `@font-face` Webfont 字体文件**，彻底规避宿主页面 `font-src` / `style-src` CSP 拦截与跨站扩展资源指纹暴露。
- 针对 Chromium（Blink）与 Firefox（Gecko）在原生 `<math display="block">` 顶层等号换行缩进上的排版差异，对含顶层 `=` 的长块级公式拆解为 HTML Flex 容器 + 分段 `<math display="block">`（外层保留完整 TeX 源码 `aria-label`），保证双引擎视觉对齐与屏幕阅读器语义完整。

### 2. Mermaid 12 构建期副本裁剪与最小依赖替身

- **不污染 `node_modules` 的构建区副本裁剪**：`scripts/vendor-mermaid-slim.mjs` 将 Mermaid chunk 复制到构建临时区，按源码内容锚点剥离未使用的图类、重型布局引擎（`cose-bilkent`、`ELK`）与重复 `katex` 副本；`scripts/build-content.js` 锁定 Mermaid 版本号与源码哈希，并通过 sourcemap `inputs` 守卫防止重型依赖回流或双实例。
- **四项最小构建期替身（`iconify` / `marked` / `lodash-root` / `d3-slim`）**：打包期分别由 `scripts/vendor-{iconify,marked,lodash-root,d3-slim}-stub.mjs`（以及 `vendor-d3-slim.mjs`）替换重型传递依赖。其中 `vendor-d3-slim.mjs` 的 `transition().style(k, v)` **必须同步立即写入样式而非空操作**（否则初始 `opacity: 0` 的节点提示层将永久不可见），仅放行经审计的终态 setter 子集，对未支持过渡接口在运行期抛错并由构建期静态审计全部 `.transition()` / `.interrupt()` 调用点。
- **运行时宿主隔离与 CSSOM 前缀契约**（`extension/ui/mermaid-render.ts`）：调用 `detectType()` 前须先 `initialize()` 并按图类型补齐 Mermaid 12 `look` 配置；复用缓存 SVG 换 ID 依赖「所有被引用内部 ID 与内嵌 `<style>` 规则选择器均以根 ID 为前缀」的契约（未引用裸 ID 不纳入），校验或处理 `<style>` 前缀必须经浏览器 CSSOM（`CSSStyleRule`），严禁纯文本或正则切分以免破坏 `@keyframes` 等 at-rule（由 `scripts/mermaid-smoke/harness.html` 冒烟断言守卫）。

## 考虑过的方案

- **全量打包 KaTeX 字体并暴露至 `web_accessible_resources`**：增加数百 KB 字体体积、引入宿主 CSP 冲突并扩大扩展可被网页探测的静态资源面。
- **直接 bundle 原始 `mermaid` 或用 patch-package 原地改写 `node_modules`**：前者单包膨胀数 MB 直接击穿双端运行时总预算，后者破坏依赖树幂等性且跨机器易漂移。
