# 前端界面设计规范

## 1. 布局与信息

- 允许在一级面板容器内使用单层分组卡片，禁止三层及以上嵌套卡片与冗余分割线。
- 禁止常驻标语、副标题、次级标签和装饰性解释文案；平时隐藏的动态错误或回退状态提示与首次安装引导页除外。
- 用排版对齐和间距区分内容层级，不靠多余文字解释界面。

## 2. 双主题、色彩与留白

- 色彩由 `oklch` 语义 token（[tokens-primitive.css](file:///d:/src/BiliScript/extension/entry/styles/tokens-primitive.css) 与 [reader-gate.css](file:///d:/src/BiliScript/extension/entry/styles/reader-gate.css)）统一定义，覆盖浅色与深色 4 象限并满足 WCAG AA 对比度（由 `tests/entry/tokens-semantic.test.ts` 校验）。
- `editorial`（数字刊物）：极简纯平基准。90% 面积使用中性纸墨或炭黑，10% 面积使用单一陶土红强调色；禁止装饰性渐变、毛玻璃、发光光晕与多层高光阴影，以 1px 细边框与纯色底区分层级。
- `flyme`（蓝雾玻璃）：允许蓝雾背景渐变、毛玻璃、玻璃卡片内高光阴影与 AI 态渐变光晕；必须保留 `prefers-reduced-transparency` 与 `data-chat-input-glow="0"` 降级路径。
- 豁免项：列表滚动边缘功能性渐隐（`mask-image`）与金句分享导出海报预设。
- 独立扩展页（[onboarding.html](file:///d:/src/BiliScript/extension/onboarding.html)、[permission-grant.html](file:///d:/src/BiliScript/extension/entry/permission-grant.html)）必须同步跟随用户的 `readerTheme` 与 `readerPalette`。
- 字重与明度对比：标题加粗加深，正文常规或中等，次要信息使用 `--biliscript-reader-muted` 与 `--biliscript-reader-faint`。
- 留白密度：在 420–540px 侧边栏阅读器下保持呼吸感而不挤压正文区，通过 4px 栅格统一行内边距（常规卡片行 `12px 16px`）与区块间距（`16px–24px`）。

## 3. 栅格、字阶、圆角与图标

- 字号与字重（均联动 `--biliscript-reader-font-scale`）：标题 `18px` 加粗（字重 600 或 700）；正文 `16px` 或 `14px`（字重 400 或 500）；辅助元信息（时间戳、徽章、快捷键提示）最低 `12px`，禁用 `10px` 与 `11px` 极小字阶。
- 间距栅格：外边距、内边距与元素间距统一采用 `4px` 整数倍（`4 / 8 / 12 / 16 / 20 / 24 / 28 / 32px`）；仅允许 `2px` 用于焦点环偏移、滑块或轨道微观间隙及分隔微调。
- 圆角：矩形容器与控件消费语义 token（`8 / 12 / 16 / 20 / 24 / 28px`）并配连续圆角 `superellipse(1.25)`；允许胶囊按钮、标签与开关使用 `999px`（`--biliscript-radius-pill`），圆形按钮使用 `50%`（`--biliscript-radius-circle`），小微标使用 `4px`（`--biliscript-radius-xs`）。
- 图标：通用 UI 图标单一来源为 Lucide（ISC 许可，`lucide-static` 开发依赖经 `scripts/sync-ui-icons.mjs` 同步至 `extension/ui/ui-icons.generated.ts`，由 `extension/ui/icon-registry.ts` 统一输出）。规格：`viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.75"`、`stroke-linecap="round"`、`stroke-linejoin="round"`；本体默认 `18px`（紧凑内联控件 `14–16px`），视觉框 ≥`24×24px`，交互按钮点击热区 ≥`32×32px`。品牌 Logo、播放器定制 AI 入口图标（[icons.ts](file:///d:/src/BiliScript/extension/ui/icons.ts)）、引导页教学插画、加载旋转环及动态经线地球图标豁免。

## 4. 交互与菜单

- 按意图显示控件：平时隐藏次要行内操作按钮，当用户鼠标悬停、光标聚焦、滚动靠近或进入交互态时显现，同时保证键盘与触控可访问。
- 菜单层级：优先点击触发的单级弹层或子页导航；若未来引入桌面端悬停展开的多级级联菜单，须同时实现开启延时、关闭延时与安全三角区（以当前鼠标坐标和子菜单上下边缘端点连成三角形区域，鼠标处于其内时暂缓切换）。

## 5. 渲染验收

- 以浏览器真实视觉渲染结果为准，样式或图标改动须通过 `pnpm lint:comments`、`pnpm typecheck`、`pnpm test:unit`、`pnpm build` 及真机校验（`pnpm harness:browser` / `pnpm smoke:firefox`）。
