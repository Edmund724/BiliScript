// extension/ui/lazy-math.ts — 数学公式水合的窄入口 + 懒加载器（常驻轻模块）。
// 仅当 root 内存在 [data-biliscript-math] 占位时才按需加载 math-render.js。

import { createLazyLoader } from "../shared/lazy-import.js";
import { logWarnAlways } from "../shared/logging.js";
import { MATH_BLOCK_SELECTOR } from "./markdown.js";
import type { MathRenderModule } from "./math-render.js";

const loader = createLazyLoader<MathRenderModule>(() => import("./math-render.js"));

export function hydrateMath(root: ParentNode | null | undefined): void {
  if (!root || !root.querySelector(MATH_BLOCK_SELECTOR)) {
    return;
  }
  loader
    .load()
    .then((module) => {
      module.hydrateMathPlaceholders(root);
    })
    .catch((error) => {
      logWarnAlways("[BILISCRIPT] 数学公式懒加载失败：", error);
    });
}
