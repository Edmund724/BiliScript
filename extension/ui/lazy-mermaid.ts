// ui/lazy-mermaid.ts — mermaid 图表水合的窄入口 + 懒加载器（常驻轻模块）。
//
// 为什么惰性：ui/mermaid-render 连着 mermaid 全量包（MB 级，见其头注）。多数
// 对话里没有图表，装载挂在「root 里真有 [data-boc-mermaid] 占位」这一判定之后，
// 没有图表的会话连这个脏 chunk 都不请求。
//
// 主题在这里读（state.reader.readingTheme），不在各调用点——调用点只表达「这里
// 有节点需要水合」，主题是渲染细节。core/state 与 shared/logging 都是轻叶子
// （ui/theme-button 已有同款先例）；下面对 mermaid-render 的 import 是 type-only，
// 不会把重模块拉进常驻包。
import { state } from "../core/state.js";
import { createLazyLoader } from "../shared/lazy-import.js";
import { logWarnAlways } from "../shared/logging.js";
import { MERMAID_BLOCK_SELECTOR } from "./markdown.js";
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
export function hydrateMermaid(
  root: ParentNode | null | undefined,
  { force = false }: { force?: boolean } = {}
): void {
  if (!root || !root.querySelector(MERMAID_BLOCK_SELECTOR)) {
    return;
  }
  const theme = state.reader.readingTheme === "dark" ? "dark" : "light";
  loader
    .load()
    .then((module) => module.hydrateMermaidPlaceholders(root, { theme, force }))
    .catch((error: unknown) => {
      logWarnAlways("[BOC] mermaid 懒加载失败：", error);
    });
}
