---
name: flyme-design
description: Flyme design language (Alive Design) for the web — light orderly surfaces, capsule controls, colorful icons, frosted glass, AI glow gradients, interruptible springy motion. Use when building Flyme-style app pages, components, settings/control-center/notification layouts, Aicy panels, or single-file HTML prototypes. Trigger: Flyme, 魅族, Meizu, AIOS, Aicy.
---

# Flyme Design

How Flyme builds interfaces that feel light and orderly, then spends color and life only where it pays off. Distilled from Flyme AIOS / AIOS 2 ("轻盈有序" + Alive Design) and translated to the web (CSS custom properties, `backdrop-filter`, compositor-friendly transitions, native `<dialog>`).

The through-line: **底色克制、点缀活泼、形状柔和、动效细腻——生命感只给 AI 与壁纸。** 普通界面维持中性有序；色彩集中在功能图标与关键操作；大面积彩色与呼吸感只出现在 Aicy / 实况通知 / Alive 壁纸。

拿不准时选更轻的方案：更少装饰、更轻层级、更短更柔的动效。

## 1. 轻盈有序 — 中性底打底

大面积中性色，靠分组卡片组织信息，而不是靠线条和装饰。

- 页面浅 `#F2F3F5` / 深 `#101114`；卡片浅 `#FFFFFF` / 深 `#1B1C20`；组内默认无分隔线。
- 主蓝 `#008CFF` 只出现在操作与选中（按钮、开关开启、进度、链接），不做大面积底色。
- 深色模式用分层灰表达层级，不加阴影。

## 2. 胶囊 — 操作件的形状

> 胶囊只属于操作，容器保持矩形感。

- 按钮、搜索框、滑条做成胶囊（圆角 = 高度一半）；卡片 / 列表组 / 弹窗用大圆角（16 / 20 / 24），不做成胶囊。
- 需要悬浮操作时用底部全宽胶囊操作条，不画 FAB。

```css
.btn-primary {
  height: 44px; border-radius: 22px; /* 胶囊 = 高度一半 */
  background: var(--primary); color: #fff;
}
.btn-primary:active { transform: scale(0.97); }
```

## 3. 点缀活泼 — 功能入口始终彩色

活泼感由图标提供，不由底色提供。同组内相邻项错开色相。

- 设置行用线性彩色图标（24px，按功能取色）；宫格任务用圆角方形浓彩底 + 白符号。
- AI 符号（Aicy 双环）只出现在 AI 场景。

## 4. 毛玻璃 — 浮层带来结构

通知中心、控制中心、滚动后的导航/标签栏是实时毛玻璃上的白卡，而不是不透明条带。

```css
.glass {
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(24px) saturate(180%);
}
```

- 浅色浮层配轻阴影，深色零阴影；不支持 `backdrop-filter` 时退化为 0.95 不透明纯色。
- 每屏毛玻璃层数控制在 4 层以内。

## 5. 流光 — AI 专属视觉层

AI 场景（Aicy 唤醒 / 问屏 / 识屏、AI 生成、实况通知）铺蓝紫流光光晕 + 4–6s 缓慢呼吸；普通按钮、卡片、列表不引用 `--ai-*`。

```css
.ai-panel { background: linear-gradient(120deg, #2B5BFF, #7B5CFF 55%, #B44BFF); }
.ai-title {
  background: linear-gradient(90deg, #7B5CFF, #FF5C8A 50%, #FF9F2E);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
```

## 6. Alive 手感 — 可打断、并行、跟手、回弹

动效基准 200–350ms，曲线 `cubic-bezier(0.32, 0.72, 0, 1)`。四个字记住手感：

- **可打断** — 面板收起手势随时接管，不等动画播完。
- **并行** — 打开与退出同时存在不串场。
- **跟手** — 壁纸光晕、滑条随手指线性变化（跟手阶段 `transition: none`）。
- **回弹** — 只在面板展开收起、应用切换、小窗切换三处用一次小幅回稳；无物理依据的弹跳与旋转不用（加载小圆圈除外）。

入场用 fade + 位移 12px + 缩放 0.98，逐项 40ms stagger；弹窗用 scale(0.94→1) + fade。声浪呼吸是唯一允许的重复脉冲。

## 7. 典型布局 — 分组卡片是默认答案

- **设置页**：胶囊搜索 → 分组白卡（页面边距 16，组距 12，行高 56）→ 右侧值文字 + chevron / 开关。
- **控制中心 / 通知中心**：全屏毛玻璃面板；顶部大时钟；白卡 + 竖向胶囊滑条 + 磁贴网格；通知卡白底圆角 16，任务型通知升级为实况通知（状态栏胶囊常驻，点击悬浮展开）。
- **Aicy 面板**：流光背景 → 白色建议胶囊行 → 聆听条 → 问屏入口 → 模式白卡；系统内唯一允许大面积彩色的界面。

弹窗一律原生 `<dialog>` + `showModal`，点遮罩与 Esc 关闭，配 `aria-labelledby`。

## 参考文件（按需加载）

数值以 `references/` 为准，SKILL 只定方向。每次只读当下分支需要的一个：

| 文件 | 内容 | 何时加载 |
|------|------|---------|
| `references/design-tokens.md` | 色彩 / 形状 / 间距 / 字体 / 材质 / 动效 / 图标 | 生成 Design Token 前 |
| `references/components.md` | 导航 / 列表 / 按钮 / 输入 / 开关 / 浮层 / 控制中心 / 通知 / Aicy / 实况通知 | 实现对应组件时 |
| `references/layout-patterns.md` | 页面骨架 / 设置 / 个人中心 / 列表 / 控制与通知中心 / 外观与壁纸 / 断点 / 降级 | 搭建页面结构时 |
| `assets/prototype-template/index.html` | 全部 CSS 变量与基础组件样板 | 生成 HTML 原型时复制为起点 |

## Process

1. **确认需求** — 页面类型、浅/深双主题（默认都要）、目标设备（默认手机 375dp）、是否含 AI 场景（含则启用流光层）。
2. **Token → 布局 → 组件** — 读对应参考文件，输出双主题 CSS 变量，按骨架排布，逐组件实现默认 / 按下 / 禁用 / 加载态，图标内联 SVG。
3. **生成原型** — 以 template 为起点产出单文件 HTML：沉浸式状态栏、滚动后毛玻璃导航、主题切换、入场 stagger、触屏反馈；`prefers-reduced-motion` 下退化为 ≤100ms fade，流光静态化。
4. **自检** — 逐条核对，不通过返工：图标全彩色；操作件全胶囊；毛玻璃只在浮层；主色只在操作与选中；流光只在 AI 场景；分组白卡 + 无 FAB + 无水波纹；触控区 ≥44px，对比度 ≥4.5:1。

## Quick Reference

| Need | Technique | Concrete value |
| --- | --- | --- |
| 主蓝 | 操作与选中专用 | `#008CFF`（深 `#3D9BFF`） |
| 页面 / 卡片 | 中性分层 | 浅 `#F2F3F5` / `#FFFFFF`；深 `#101114` / `#1B1C20` |
| 胶囊 | 操作件圆角 | 高度一半（按钮 44 高 → 22） |
| 容器圆角 | 卡片 / 磁贴 / 弹窗 | `16 / 20 / 24` |
| 列表组 | 白卡 + 边距 + 组距 | `16 / 12`，行高 `56` |
| 毛玻璃 | 浮层配方 | `rgba(255,255,255,0.72) + blur(24px) saturate(180%)` |
| AI 流光 | 仅 AI 场景 | 蓝紫 `--ai-glow`；渐变字 `--ai-text` |
| 动效基线 | 时长 + 曲线 | `200–350ms`，`cubic-bezier(0.32, 0.72, 0, 1)` |
| 入场 | fade + 位移 + 缩放 | `translateY(12px) + scale(0.98)`，stagger `40ms` |
| 按压 | 缩放反馈 | `scale(0.97)`，`120ms` |
| 回弹 | 仅三处，一次回稳 | `cubic-bezier(0.3, 1.2, 0.4, 1)`，位移 ≤8px |
| 弹窗 | 原生 dialog | 宽 ≤320，圆角 24，`closedby="any"` |
| 降级 | reduced-motion | ≤100ms fade，流光静态 |
