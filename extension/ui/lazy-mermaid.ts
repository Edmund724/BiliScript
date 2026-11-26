import { state } from "../core/state.js";
import { onActiveHostChange } from "../shared/active-host.js";
import { isNode, resolveNodeDocument, resolveNodeWindow } from "../shared/cross-doc.js";
import { createLazyLoader } from "../shared/lazy-import.js";
import { logWarnAlways } from "../shared/logging.js";
import { MERMAID_BLOCK_ATTR, MERMAID_BLOCK_SELECTOR } from "./markdown-block-constants.js";
import type { HydrateMermaidOptions } from "./mermaid-render.js";

interface MermaidRenderModule {
  hydrateMermaidPlaceholders(root: ParentNode, options?: HydrateMermaidOptions): Promise<void>;
}

const loader = createLazyLoader<MermaidRenderModule>(() => import("./mermaid-render.js"));

async function hydrateMermaidNow(root: ParentNode, force: boolean): Promise<void> {
  try {
    const module = await loader.load();
    await module.hydrateMermaidPlaceholders(root, { theme: state.reader.readingTheme === "dark" ? "dark" : "light", force });
  } catch (error) {
    logWarnAlways("[BILISCRIPT] mermaid 懒加载失败：", error);
  }
}

let visibilityObserver: IntersectionObserver | null = null;
let observerDoc: Document | null = null;

function resetVisibilityObserver(): void {
  if (!visibilityObserver) {
    observerDoc = null;
    return;
  }
  try {
    visibilityObserver.disconnect();
  } catch {
  }
  visibilityObserver = null;
  observerDoc = null;
}

onActiveHostChange(() => {
  resetVisibilityObserver();
});

function resolveIntersectionObserver(node?: Node | null): typeof IntersectionObserver | undefined {
  const win = resolveNodeWindow(node) as Window & {
    IntersectionObserver?: typeof IntersectionObserver;
  };
  const globalObs =
    typeof IntersectionObserver === "function" ? IntersectionObserver : undefined;
  return win?.IntersectionObserver ?? globalObs;
}

function observeForHydration(block: Element): void {
  const doc = resolveNodeDocument(block);
  if (visibilityObserver && observerDoc !== doc) {
    resetVisibilityObserver();
  }
  if (!visibilityObserver) {
    const Obs = resolveIntersectionObserver(block);
    if (typeof Obs !== "function") {
      void hydrateMermaidNow(block, false);
      return;
    }
    observerDoc = doc;
    visibilityObserver = new Obs((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        visibilityObserver?.unobserve(entry.target);
        void hydrateMermaidNow(entry.target, false);
      }
    });
  }
  visibilityObserver.observe(block);
}

function isInViewport(block: Element): boolean {
  if (!block.isConnected) {
    return true;
  }
  const rect = block.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.top <= resolveNodeWindow(block).innerHeight
  );
}

export function hydrateMermaid(
  root: ParentNode | null | undefined,
  { force = false }: { force?: boolean } = {}
): void {
  if (!root || !root.querySelector(MERMAID_BLOCK_SELECTOR)) {
    return;
  }
  const Obs = resolveIntersectionObserver(isNode(root) ? root : null);
  if (force || typeof Obs !== "function") {
    void hydrateMermaidNow(root, force);
    return;
  }
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
