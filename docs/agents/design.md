# 前端界面设计规范

## 1. 布局与信息

- 一级面板容器内仅允许单层分组卡片，禁止三层及以上嵌套卡片与冗余分割线。
- 禁止常驻标语、副标题、次级标签和装饰性解释文案；动态错误/回退提示与首次安装引导页除外。
- 用排版对齐和间距区分层级，不靠额外文字解释界面。

## 2. 双主题与色彩

- 色彩由 `oklch` 语义 token（[tokens-primitive.css](../../extension/entry/styles/tokens-primitive.css) 与 [reader-gate.css](../../extension/entry/styles/reader-gate.css)）定义，覆盖浅色/深色 4 象限并满足 WCAG AA 对比度（由 `tests/entry/tokens-semantic.test.ts` 守卫）。
- `editorial`（数字刊物）：纯平极简基准，以 1px 细边框与纯色底区分层级，禁止装饰性渐变、毛玻璃、发光光晕与多层高光阴影。
- `flyme`（蓝雾玻璃）：允许蓝雾背景渐变、毛玻璃、玻璃卡片内高光与 AI 态光晕；必须保留 `prefers-reduced-transparency` 与 `data-chat-input-glow="0"` 降级路径。
- 豁免项：列表滚动边缘功能性渐隐（`mask-image`）与金句分享海报预设。
- 独立扩展页（[onboarding.html](../../extension/onboarding.html)、[permission-grant.html](../../extension/entry/permission-grant.html)）须同步跟随用户的 `readerTheme` 与 `readerPalette`。

## 3. 字阶、栅格与图标

- 字号联动 `--biliscript-reader-font-scale`，辅助元信息最低 `12px`（禁用 `10px` / `11px`）。
- 间距统一采用 `4px` 整数倍（仅焦点环偏移、滑块微调允许 `2px`）；矩形容器消费圆角语义 token 并配连续圆角 `superellipse(1.25)`。
- 通用 UI 图标单一来源为 `lucide-static`（经 `scripts/sync-ui-icons.mjs` 同步，由 `extension/ui/icon-registry.ts` 统一输出）；视觉框 ≥ `24×24px`，交互热区 ≥ `32×32px`。品牌 Logo、播放器定制 AI 入口图标（[icons.ts](../../extension/ui/icons.ts)）、引导页插画、加载旋转环及动态地球图标豁免。

## 4. 交互与验收

- 按意图显示次要行内操作按钮（悬停、聚焦或交互态显现），同时保证键盘与触控可访问。
- 优先点击触发的单级弹层或子页导航；若引入桌面端悬停级联菜单，须配套开启/关闭延时与安全三角区。
- 样式或图标改动以真实浏览器渲染为准，须通过 `pnpm lint:comments`、`pnpm typecheck`、`pnpm test:unit`、`pnpm build` 及真机校验（`pnpm harness:browser` / `pnpm smoke:firefox`）。
