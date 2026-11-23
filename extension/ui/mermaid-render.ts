import mermaid from "mermaid";
import { isElementNode, resolveNodeDocument } from "../shared/cross-doc.js";
import { logWarnAlways } from "../shared/logging.js";
import { MERMAID_BLOCK_ATTR, MERMAID_BLOCK_SELECTOR, MERMAID_SOURCE_SELECTOR } from "./markdown.js";

export interface HydrateMermaidOptions {
  theme?: string;
  force?: boolean;
}

interface RenderedDiagram {
  svg: string;
  id: string;
}

const MERMAID_THEME_ATTR = "data-biliscript-mermaid-theme";
const MERMAID_UNSUPPORTED_MESSAGE = "不支持的图表类型，已显示源码";

const PANEL_FONT_FAMILY =
  '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "HarmonyOS_Regular", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

const SVG_CACHE_LIMIT = 40;
const svgCache = new Map<string, RenderedDiagram>();
const pendingRenders = new Map<string, Promise<RenderedDiagram>>();

let idSeq = 0;
let configuredTheme: string | null = null;

function mermaidTheme(theme: string): "default" | "dark" {
  return theme === "dark" ? "dark" : "default";
}

function ensureConfigured(theme: string): void {
  if (configuredTheme === theme) {
    return;
  }
  configuredTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    theme: mermaidTheme(theme),
    fontFamily: PANEL_FONT_FAMILY,
    layout: "dagre",
    flowchart: { look: "classic" },
    sequence: { look: "classic" },
    securityLevel: "strict",
    suppressErrorRendering: true,
  });
}

function rememberSvg(cacheKey: string, diagram: RenderedDiagram): void {
  if (svgCache.size >= SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) {
      svgCache.delete(oldest);
    }
  }
  svgCache.set(cacheKey, diagram);
}

function startRender(cacheKey: string, source: string, theme: string): Promise<RenderedDiagram> {
  const task = (async () => {
    ensureConfigured(theme);
    const id = `biliscript-mermaid-${++idSeq}`;
    const { svg } = await mermaid.render(id, source);
    const rendered: RenderedDiagram = { svg, id };
    rememberSvg(cacheKey, rendered);
    return rendered;
  })().finally(() => {
    pendingRenders.delete(cacheKey);
  });
  pendingRenders.set(cacheKey, task);
  return task;
}

function renderDiagram(source: string, theme: string): Promise<RenderedDiagram> {
  const cacheKey = `${theme}\u0000${source}`;
  const cached = svgCache.get(cacheKey);
  if (cached) {
    svgCache.delete(cacheKey);
    svgCache.set(cacheKey, cached);
    return Promise.resolve(cached);
  }
  return pendingRenders.get(cacheKey) ?? startRender(cacheKey, source, theme);
}

function mountDiagram(block: Element, diagram: RenderedDiagram, theme: string): void {
  const freshId = `biliscript-mermaid-${++idSeq}`;
  const holder = resolveNodeDocument(block).createElement("div");
  holder.className = "biliscript-md-mermaid-svg";
  holder.innerHTML = diagram.id === freshId ? diagram.svg : diagram.svg.split(diagram.id).join(freshId);
  block.querySelector(".biliscript-md-mermaid-svg")?.remove();
  block.querySelector(".biliscript-md-mermaid-fallback")?.remove();
  block.appendChild(holder);
  block.setAttribute(MERMAID_BLOCK_ATTR, "done");
  block.setAttribute(MERMAID_THEME_ATTR, theme);
}

function setFallback(block: Element, message: string): void {
  block.querySelector(".biliscript-md-mermaid-svg")?.remove();
  block.querySelector(".biliscript-md-mermaid-fallback")?.remove();
  const note = resolveNodeDocument(block).createElement("div");
  note.className = "biliscript-md-mermaid-fallback";
  note.textContent = message;
  block.appendChild(note);
}

function markError(block: Element, theme: string): void {
  block.setAttribute(MERMAID_BLOCK_ATTR, "error");
  block.setAttribute(MERMAID_THEME_ATTR, theme);
  setFallback(block, "图表渲染失败，已显示源码");
}

function markUnsupported(block: Element, theme: string): void {
  block.setAttribute(MERMAID_BLOCK_ATTR, "unsupported");
  block.setAttribute(MERMAID_THEME_ATTR, theme);
  setFallback(block, MERMAID_UNSUPPORTED_MESSAGE);
}

function readSource(block: Element): string {
  return block.querySelector(MERMAID_SOURCE_SELECTOR + " code")?.textContent ?? "";
}

export async function hydrateMermaidPlaceholders(
  root: ParentNode,
  options: HydrateMermaidOptions = {}
): Promise<void> {
  const { theme = "light", force = false } = options;
  ensureConfigured(theme);
  const blocks = Array.from(
    isElementNode(root) && root.matches(MERMAID_BLOCK_SELECTOR)
      ? [root, ...root.querySelectorAll(MERMAID_BLOCK_SELECTOR)]
      : root.querySelectorAll(MERMAID_BLOCK_SELECTOR)
  ).filter((block) => {
    if (block.getAttribute(MERMAID_BLOCK_ATTR) === "pending") {
      return true;
    }
    return force && block.getAttribute(MERMAID_THEME_ATTR) !== theme;
  });
  for (const block of blocks) {
    const source = readSource(block);
    if (!source.trim()) {
      continue;
    }
    try {
      mermaid.detectType(source);
    } catch {
      markUnsupported(block, theme);
      continue;
    }
    try {
      mountDiagram(block, await renderDiagram(source, theme), theme);
    } catch (error) {
      markError(block, theme);
      logWarnAlways("[BILISCRIPT] mermaid 图表渲染失败：", error);
    }
  }
}
