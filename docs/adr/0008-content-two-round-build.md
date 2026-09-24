# content 两轮构建与双实例纪律——单轮化否决，约定守卫化

content script 采用**两轮构建**：轮 B 把全部动态 import 目标（17 个，今 19 个）作 entryPoints 以 `splitting: true` 出懒加载区；轮 A 对 `entry/content.ts` 单独 `splitting: false`，onResolve 插件把懒加载目标 external 成轮 B 产物路径，常驻图整体内联进单文件 `content-main.mjs`。常驻口径 = bootstrap + 主包共 **2 个请求**（commit 24f63e2 实测：由单轮 splitting 的 19 请求降下）。代价（已接受）：常驻底座在轮 B 懒 chunk 区重复一份——本地资源按需读取，无网络成本。

双实例是两轮构建的直接后果：共享底座模块在常驻包与懒加载区各求值一份。纪律：**跨实例共享的可变状态必须挂 globalThis 槽**（5 个槽模块：state / messaging / reader-bus / style-injector / logging，经三个历史 bug 淬炼：7d08229 script 点击静默无效、5a62ac6 主题不落盘、828430f 跨侧读空值）；其余双实例模块（22 个，sourcemap 交集实测）不得携带未声明的模块级可变状态——含可变状态的 13 个在头注声明 `BOC_DUAL_INSTANCE_STATEFUL` 标记并写明安全依据，scripts/build-content.js 的 `assertDualInstanceAllowlist` 对「实测双实例集合 vs 允许清单」与「清单 mutable 位 vs 头注标记」做构建期对账（2026-09-18 落地）。

## 考虑过的方案

- **单轮 splitting**（2026-09-17 架构评审候选 6 提出，已否决）：共享模块会被提升成主入口静态 chunk，首帧请求从 2 回到 ~4-7 个串行发现链，与「按钮出现速度第一」直接冲突；懒侧 -30~40K 字节的大头已由 first-button-ux/03（defaults 拆分）拿走，单轮化争不到实质收益。
- **seam external**（同轮提出，已否决）：① 导出面无校验——漏符号是运行时硬崩溃、构建期零报错，需自写对账守卫；② 边界必须是传递闭包，手工划定即腐化（ADR-0003 修过的同类问题、更严重）。严格劣于单轮，单轮又已否决，故排除。

## 后果

- 常驻请求结构（2 请求）是体验瓶颈期间，架构评审（含 AI 代理）不得再提议单轮化或 seam external。
- 新增跨实例可变状态：挂 globalThis 槽（自动纳入共享槽守卫）；新增双实例模块：构建守卫报错，评估后入允许清单并按 mutable 与否完成头注声明。
- 重开条件：首帧请求结构不再是体验瓶颈——如模块加载管线级缓存（import map 预解析、packaging 原语等）在扩展内容脚本场景普及，2 请求的实测优势不复存在时，单轮化可重新评审。
