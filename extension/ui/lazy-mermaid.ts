// ui/lazy-mermaid.ts — mermaid 图表水合的窄入口 + 懒加载器（常驻轻模块）。
//
// 为什么惰性：ui/mermaid-render 连着 Mermaid 及已保留图表类型的 MB 级依赖。
// 多数对话里没有图表，装载挂在「root 里真有 [data-biliscript-mermaid] 占位」这一判定
// 之后，没有图表的会话连这个脏 chunk 都不请求。占位在屏外时连装载也不触发
// （IntersectionObserver 门控，见下方 observeForHydration），滚入视口才装载。
//
// 主题在这里读（state.reader.readingTheme），不在各调用点——调用点只表达「这里
// 有节点需要水合」，主题是渲染细节。core/state 与 shared/logging 都是轻叶子
// （ui/theme-button 已有同款先例）；下面对 mermaid-render 的 import 是 type-only，
// 不会把重模块拉进常驻包。
import { state } from "../core/state.js";
import { createLazyLoader } from "../shared/lazy-import.js";
import { logWarnAlways } from "../shared/logging.js";
import { MERMAID_BLOCK_ATTR, MERMAID_BLOCK_SELECTOR } from "./markdown.js";
import type { HydrateMermaidOptions } from "./mermaid-render.js";

// 本模块消费的被加载模块的窄面（lazy-* 包装器惯例：只依赖公开入口）
interface MermaidRenderModule {
  hydrateMermaidPlaceholders(root: ParentNode, options?: HydrateMermaidOptions): Promise<void>;
}

const loader = createLazyLoader<MermaidRenderModule>(() => import("./mermaid-render.js"));

// 水合 root 内的图表占位。无占位 ⇒ 直接返回（不装载）；装载后异步渲染，失败只
// 落日志——调用点在渲染主路径上，不能被图表失败带崩（单张图的失败已在
// mermaid-render 内部降级为「保留源码」）。
// force：已渲染的块也重渲染（主题切换用）。
async function hydrateMermaidNow(root: ParentNode, force: boolean): Promise<void> {
  try {
    const module = await loader.load();
    await module.hydrateMermaidPlaceholders(root, { theme: state.reader.readingTheme === "dark" ? "dark" : "light", force });
  } catch (error) {
    logWarnAlways("[BILISCRIPT] mermaid 懒加载失败：", error);
  }
}

// 可见性门控（mermaid-slim-round2）：屏外占位不拉起 mermaid 懒 chunk，滚入视口
// 才装载+水合；视口内占位保持「调用即渲染」的零感知时机。force（主题切换）与
// 无 IntersectionObserver 的环境（jsdom、旧内核）回退立即水合，行为与门控前
// 一致。observer 是模块级单例：触发即 unobserve，目标被会话 DOM 移除时
// IntersectionObserver 对目标是弱引用，不泄漏。
let visibilityObserver: IntersectionObserver | null = null;

function observeForHydration(block: Element): void {
  visibilityObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      visibilityObserver?.unobserve(entry.target);
      void hydrateMermaidNow(entry.target, false);
    }
  });
  visibilityObserver.observe(block);
}

// 调用点约定节点已插入 DOM（mermaid-render 头注）；游离节点无法被观察，
// 回退立即水合，避免「永远等不到相交」的活锁。
function isInViewport(block: Element): boolean {
  if (!block.isConnected) {
    return true;
  }
  const rect = block.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.top <= window.innerHeight
  );
}

export function hydrateMermaid(
  root: ParentNode | null | undefined,
  { force = false }: { force?: boolean } = {}
): void {
  if (!root || !root.querySelector(MERMAID_BLOCK_SELECTOR)) {
    return;
  }
  if (force || typeof IntersectionObserver === "undefined") {
    void hydrateMermaidNow(root, force);
    return;
  }
  // 非 force 路径只处理 pending 占位（done/error/unsupported 无需重渲，与
  // mermaid-render 的过滤语义一致）；逐个判可见性，屏外的挂观察器滚入才水合。
  const pendingBlocks = Array.from(
    root.querySelectorAll(`${MERMAID_BLOCK_SELECTOR}[${MERMAID_BLOCK_ATTR}="pending"]`)
  );
  if (pendingBlocks.length === 0) {
    return;
  }
  for (const block of pendingBlocks) {
    if (isInViewport(block)) {
      void hydrateMermaidNow(block, false);
    } else {
      observeForHydration(block);
    }
  }
}
