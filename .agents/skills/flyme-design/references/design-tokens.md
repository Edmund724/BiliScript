# Flyme Design Tokens（AIOS / AIOS 2 基准）

数值分两档：【官方】有官方材料支撑；【推导】按真机观感推导。对外一律表述「按 Flyme 设计语言推导」，不称官方规范数值。

## 色彩

主蓝【官方 #008CFF】只用于操作与选中（按钮 / 开关开启 / 进度 / 链接）：

| 模式 | 主色 | 按压 | 浅底 |
|------|------|------|------|
| 浅色 | #008CFF | #0077D9 | rgba(0,140,255,0.10) |
| 深色 | #3D9BFF | #66B0FF | rgba(61,155,255,0.16) |

功能图标色板【推导】（同组相邻项错开色相）：蓝 #008CFF / 青 #13B8C4 / 绿 #34B37A / 琥珀 #F5A623 / 橙 #FF7A45 / 红 #F5484D / 紫 #7B61FF（深色提亮一档）。

背景与文字：

| 层 | 浅色 | 深色 |
|------|------|------|
| 页面背景 | #F2F3F5 | #101114 |
| 卡片 / 列表组 | #FFFFFF | #1B1C20 |
| 输入框底 | #F0F1F3 | #222327 |
| 主文字 / 次文字 / 提示 | #17181A / #6B6E75 / #8A8E96 | #ECEDEF / #9CA0A8 / #6A6E76 |

功能色：成功 #34B37A / 警告 #FF9F0A / 错误 #F5484D（深色提亮一档）。

## AI 流光（仅 AI 场景）

浅深同值。不进入普通按钮 / 卡片 / 列表：

| Token | 值 | 用途 |
|-------|-----|------|
| `--ai-glow` | linear-gradient(120deg, #2B5BFF, #7B5CFF 55%, #B44BFF) | Aicy 面板光晕 |
| `--ai-text` | linear-gradient(90deg, #7B5CFF, #FF5C8A 50%, #FF9F2E) | AI 渐变字（紫左橙右） |
| `--ai-logo` | linear-gradient(135deg, #FF9F2E, #B44BFF 55%, #4E5BFF) | Aicy 双环 logo |
| `--tint-mint / lavender / blue` | #DDF3EF / #EFEAFF / #EDF3FD | AI / 管家淡彩底 |

## 形状与间距

操作件胶囊（圆角 = 高度一半）；容器保持矩形感：卡片 / 列表组 16、磁贴 20、弹窗 24、底部面板顶部 24、输入框 12。

页面边距 16，组距 12，行高 56（紧凑 48 / 宽松 64），卡片内边距 16–20，图标与文字间距 16。

## 字体

回退栈：`system-ui, "PingFang SC", "HarmonyOS Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`

Display 30 Light / Title 20 Medium / Headline 17 Medium / 列表标题 16 / Body 15 / Caption 12。大标题用 Light 是魅族传统。

## 材质与动效

毛玻璃：浅 `rgba(255,255,255,0.72) + blur(24px) saturate(180%)`，深 `rgba(16,17,20,0.72)`；用于通知 / 控制中心 / 滚动后导航 / 标签栏。不支持时用 0.95 纯色。浅色浮层阴影 `0 8px 24px rgba(17,18,26,0.10)`，深色零阴影。

动效基线 200–350ms，`cubic-bezier(0.32, 0.72, 0, 1)`；回弹曲线 `cubic-bezier(0.3, 1.2, 0.4, 1)` 仅用于面板 / 应用切换 / 小窗。按压 scale(0.97) 120ms；入场 fade + translateY(12px) + scale(0.98)，stagger 40ms；AI 呼吸 4–6s，声浪 1.2s。`prefers-reduced-motion` 下全退化为 ≤100ms fade。
