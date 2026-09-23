// Reader 静态呈现层的按需加载器（候选3 常驻瘦身；arch-slim-2/09 自 core/
// 搬回 reader/：加载器跟随被加载模块的目录）。
//
// reader/presentation.js 含 hydrateReaderStateFromSettings / applyReadingViewPresentation
// / renderReadingStatus 等函数（digest-only-ui：步进器模板/绑定已随排版档位机制
// 退役）。它们在普通页启动路径被 content.js 与 init-essentials.js 静态引用，会把
// validators 拖入常驻。本模块把它改为动态 import 边：普通页不加载，
// 只在进入阅读模式或阅读视图已打开时设置变更才加载。
//
// 加载器语义与 reader/lazy-reader.ts 一致：同文档内重复调用共享同一 promise，失败
// 清缓存可重试。

import { createLazyLoader } from "../shared/lazy-import.js";
import type { Settings } from "../core/defaults.js";

interface PresentationDomain {
  hydrateReaderStateFromSettings(settings?: Partial<Settings>): void;
  applyReadingViewPresentation(): void;
  renderReadingStatus(text: string | number | null | undefined): void;
}

const loader = createLazyLoader<PresentationDomain>(() => import("./presentation.js"));

export async function hydrateReaderStateFromSettings(settings?: Partial<Settings>): Promise<void> {
  const mod = await loader.load();
  mod.hydrateReaderStateFromSettings(settings);
}

export async function applyReadingViewPresentation(): Promise<void> {
  const mod = await loader.load();
  mod.applyReadingViewPresentation();
}

export async function renderReadingStatus(text: string | number | null | undefined): Promise<void> {
  const mod = await loader.load();
  mod.renderReadingStatus(text);
}

// 尽力而为的状态栏播报：呈现层是懒加载的，装载失败或节点缺失都会让
// renderReadingStatus 以拒绝收场。需要落地顺序的调用方 await 它并自行 try/catch；
// 纯播报（错误路径、浮空链）用本包装——浮空调用不接 catch 就是未处理拒绝。
export function announceReadingStatus(text: string | number | null | undefined): void {
  void renderReadingStatus(text).catch(() => {});
}
