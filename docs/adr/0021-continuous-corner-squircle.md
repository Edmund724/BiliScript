# 全量矩形圆角容器与控件统一采用 CSS corner-shape: squircle 连续圆角

> 状态：有效

阅读面板与设置体系中，顶层面板、弹窗、内容区卡片、下拉菜单、同心圆角子项与矩形控件大量使用圆角矩形（`4px`～`28px`）搭配液态玻璃曲面透镜与双对角折射内高光（`--biliscript-reader-card-highlight`）。传统 CSS `border-radius` 使用正圆弧（Circular Arc），在直线与圆弧切点处存在曲率阶跃（$G^1$ 切线连续但 $G^2$ 曲率突变），在大圆角面板与内嵌同心子项上尤为明显，且使边缘折射高光在切点处出现生硬折点。我们决定：**全站所有非胶囊（非 `pill` / `999px`）、非正圆（非 `circle` / `50%`）、非直角重置（非 `0`）的矩形圆角容器与控件，统一采用 Chromium 原生 CSS `corner-shape: squircle`（即 $n=4$ 超椭圆 `superellipse(2)`，满足 $|x|^4 + |y|^4 = R^4$），并严格保持既有 `border-radius` 半径数值与令牌绑定不变；金句分享卡 Canvas 2D 光栅化导出同步改用 `20px` 超椭圆闭合路径裁切与内描边**。

## 考虑过的方案

- **A1：仅对顶层大圆角面板与弹窗（`>= 16px`）开启 `corner-shape: squircle`**：虽能改善外框，但下拉菜单与内嵌选中项（如 `14px` 外框套 `8px` 选项、章节卡套缩略图）会出现外框超椭圆、内层正圆弧的曲率打架，破坏同心嵌套（Concentricity）和谐感。
- **A2：接入 `corner-shape: squircle` 的同时整体上调各档 `border-radius` 数值（`+2px`～`+4px`）**：由于超椭圆在 $45^\circ$ 对角线处比同半径正圆弧略微外扩收紧，若盲目放大 `border-radius` 会挤占小控件内边距并改变既有同心圆角差值公式（如 `calc(var(--biliscript-radius-panel) - 7px)`）。
- **A3：SVG `clipPath` 或 Houdini Paint Worklet 模拟连续圆角**：引入额外 DOM 节点或脚本运行时开销，且 `clip-path` 会直接裁掉容器外投影（`box-shadow`）。
- **A4：原生 CSS `corner-shape: squircle` 全量覆盖 ABCD 四类矩形圆角 + 保持既有半径令牌不变 + Canvas 导出路径对齐（本裁决方案）**：本扩展仅面向 Chrome（见 ADR-0002），Chromium 原生 `corner-shape: squircle` 同时作用于背景、`border`、多层内高光与外阴影（`box-shadow`）、`backdrop-filter` 与 `overflow: hidden` 裁切路径，零 DOM/JS 运行时开销。

## 裁定细节与后果

1. **三层设计令牌与样式契约**：
   - 在 `tokens-primitive.css` 声明原始值 `--biliscript-primitive-corner-shape-squircle: squircle;`；在 `reader-gate.css` 声明语义令牌 `--biliscript-corner-shape: var(--biliscript-primitive-corner-shape-squircle);`。
   - 全量样式表中所有非胶囊（非 `--biliscript-radius-pill` / `--btn-radius` / `--pill-radius` / `--toggle-track-radius` / `999px`）、非正圆（非 `--biliscript-radius-circle` / `50%`）、非 `0` 的 `border-radius` 规则块，统一声明 `corner-shape: squircle;`。
   - 鉴于 CSS 规范中 `corner-shape` 默认不继承（`Inherited: no`），凡使用 `border-radius: inherit` 的伪元素或内层节点（如 `#biliscript-reading-view::before` 光雾层、流光遮罩层），必须显式声明 `corner-shape: inherit;`，确保伪元素与宿主容器曲率严丝合缝。

2. **静态架构审计守卫**：
   - `tests/entry/design-tokens-audit.test.ts` 对 `extension/entry/styles/*.css` 执行全量规则块扫描，任何新增或修改的矩形圆角规则块若遗漏 `corner-shape: squircle`（或 `inherit`）将直接阻断单测。

3. **金句分享卡 Canvas 2D 光栅化导出对齐**：
   - `extension/reader/quote-share-export.ts` 的 `renderQuoteCardBlob` 内部通过 `traceSquircleRectPath` 按参数方程 $(cx + r \cdot \operatorname{sgn}(\cos t)\sqrt{|\cos t|},\ cy + r \cdot \operatorname{sgn}(\sin t)\sqrt{|\sin t|})$ 采样四角超椭圆路径，替代正圆弧 `ctx.roundRect(..., 20)`，同时用于卡片底图 `ctx.clip()` 与 `0.5px` 内侧微描边 `ctx.stroke()`，确保导出的 PNG 图片与 DOM 预览卡 `.biliscript-quote-card` 视觉一致。
