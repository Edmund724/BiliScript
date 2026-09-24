// ui/mermaid-render.ts — mermaid 图表占位（ui/markdown 产出的 [data-biliscript-mermaid]）
// 的异步水合实现。
//
// 为什么是独立模块 + 懒 chunk：mermaid 及其图表类型仍是 MB 级依赖，常驻图与
// 对话/阅读域的 chunk 都不该背。本模块只经 ui/lazy-mermaid 的动态 import 触达，
// esbuild 把它切成 chunks/mermaid-render.mjs（见 scripts/build-content.js 的
// lazyTargets），并把仅保留类型的精简入口作为轮 B 专属依赖；已保留类型继续
// 按需拆成二级动态 chunk，只有真正出现某类图表时才加载对应的渲染代码。
//
// 渲染触发面（本模块不做 DOM 扫描与观察器）：调用方在**节点插入 DOM 之后**显式
// 调用 hydrateMermaidPlaceholders——chat-runtime 的流式 stable 容器与终态整渲染、
// explain-card 的作答块、reader 主题切换的重渲染。流式 tail 容器每帧整体重建，
// 且未闭合围栏本就落在 tail，故不对其水合：图表只在围栏闭合、块进入 stable 后
// 渲染。
//
// 依赖方向：只依赖 mermaid 与 markdown.js 的选择器常量，不读 core/state（主题
// 由调用方传入），因此可在单测里 mock "mermaid" 直接跑（tests/ui/mermaid-render）。
import mermaid from "mermaid";
import { logWarnAlways } from "../shared/logging.js";
import { MERMAID_BLOCK_ATTR, MERMAID_BLOCK_SELECTOR, MERMAID_SOURCE_SELECTOR } from "./markdown.js";

export interface HydrateMermaidOptions {
  // "light" / "dark"（reader 面板主题），映射到 mermaid 的 default / dark 主题。
  theme?: string;
  // 已渲染的块（done / error / unsupported）是否也纳入考虑：主题切换时用。真正重做的只有
  // 「渲染时主题 ≠ 目标主题」的块（见 MERMAID_THEME_ATTR），因此调用点可以在
  // 每次重渲时无脑传 true。
  force?: boolean;
}

interface RenderedDiagram {
  svg: string;
  // mermaid 渲染时用的根 id：<style> 选择器与 marker/gradient 的 url(#…) 引用
  // 都以它为前缀，插入时换新 id 必须整体替换这个串。
  id: string;
}

// 块上记录的「渲染时用的主题」：force 水合据此判断某块是否真的需要重做——
// applyReadingViewPresentation 在进入阅读模式、字幕重渲等路径上同样会跑，只看
// 状态位会无差别重挂 SVG（白闪一次）。
const MERMAID_THEME_ATTR = "data-biliscript-mermaid-theme";
const MERMAID_UNSUPPORTED_MESSAGE = "不支持的图表类型，已显示源码";

// 面板字体栈：与 reader-gate.css 的 --biliscript-reader-font-sans 令牌互为镜像——
// mermaid 配置吃不了 CSS 变量，只能字面量同步，改动须两边一致。mermaid 默认
// 栈是 "trebuchet ms, verdana, arial"，与面板字体不搭，显式对齐。
const PANEL_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", Arial, sans-serif';

// 已渲染 SVG 的缓存，键为「主题 + 源码」。为什么必须有：流式的 stable 容器每
// 增长一次就整体重建 innerHTML（已渲染的图随之销毁），终态整渲染与历史回放同理
// ——没有缓存时同一张图会被反复重渲染（单图渲染是几十到几百毫秒的布局计算，长
// 回答里能累积成几十次），命中缓存只有一次字符串替换。上限防长会话历史回放无界
// 增长；主题进键，切主题后两个主题各存一份。
const SVG_CACHE_LIMIT = 40;
const svgCache = new Map<string, RenderedDiagram>();
// 同一「主题 + 源码」的在途渲染：流式 stable 水合与终态整渲染可能同时命中同一
// 张图（前者未完成时后者已开始），不去重就会渲染两遍。
const pendingRenders = new Map<string, Promise<RenderedDiagram>>();

let idSeq = 0;
let configuredTheme: string | null = null;

function mermaidTheme(theme: string): "default" | "dark" {
  return theme === "dark" ? "dark" : "default";
}

// mermaid 的配置是全局单例（initialize 整体覆写），主题变化时重配一次。
function ensureConfigured(theme: string): void {
  if (configuredTheme === theme) {
    return;
  }
  configuredTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    theme: mermaidTheme(theme),
    fontFamily: PANEL_FONT_FAMILY,
    // 图表源码来自模型输出：strict 走 mermaid 内置的 DOMPurify 标签清洗，并
    // 关掉点击交互与链接改写（与 MarkText 等集成同一档）。
    securityLevel: "strict",
    // 语法错误时不要往 document.body 注入 mermaid 自带的错误图——它会污染宿主
    // 页面 DOM，且与下方「保留源码 + 失败提示」的降级重复。
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
    // 命中即提到队尾（Map 保持插入序），LRU 淘汰最近用过的图
    svgCache.delete(cacheKey);
    svgCache.set(cacheKey, cached);
    return Promise.resolve(cached);
  }
  return pendingRenders.get(cacheKey) ?? startRender(cacheKey, source, theme);
}

function mountDiagram(block: Element, diagram: RenderedDiagram, theme: string): void {
  // 每次插入换一个新 id：同一张图（缓存命中）在页面上出现两份时 id 不会重复。
  // mermaid 的内部 id 全以根 id 为前缀，整体替换即覆盖 <style> 选择器与
  // url(#…) 引用。
  const freshId = `biliscript-mermaid-${++idSeq}`;
  const holder = document.createElement("div");
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
  const note = document.createElement("div");
  note.className = "biliscript-md-mermaid-fallback";
  note.textContent = message;
  block.appendChild(note);
}

// 失败降级：源码 <pre> 一直在（渲染成功时才被 CSS 隐藏），这里只需把状态翻到
// error 让它重新可见，并补一行说明——只显示源码而不解释，与「语言标签被当正文
// 吐出来」的旧 bug 观感无法区分。
function markError(block: Element, theme: string): void {
  block.setAttribute(MERMAID_BLOCK_ATTR, "error");
  // 记下失败时的主题：同样的语法错误换个主题重试没有意义，主题变了才值得再试。
  block.setAttribute(MERMAID_THEME_ATTR, theme);
  setFallback(block, "图表渲染失败，已显示源码");
}

// 未保留的 Mermaid 类型不是 error；保留源码并留待主题或能力变化后重新检测。
function markUnsupported(block: Element, theme: string): void {
  block.setAttribute(MERMAID_BLOCK_ATTR, "unsupported");
  block.setAttribute(MERMAID_THEME_ATTR, theme);
  setFallback(block, MERMAID_UNSUPPORTED_MESSAGE);
}

function readSource(block: Element): string {
  return block.querySelector(MERMAID_SOURCE_SELECTOR + " code")?.textContent ?? "";
}

// 水合 root 内的全部图表占位。先逐张确认类型；不支持与渲染失败是不同状态，
// 任一情况都不影响后续图表（逐张捕获），两类失败都保留源码。
export async function hydrateMermaidPlaceholders(
  root: ParentNode,
  options: HydrateMermaidOptions = {}
): Promise<void> {
  const { theme = "light", force = false } = options;
  // detectType 依赖 mermaid 模块初始化时注册的图表探测器（mermaid 11 的
  // initialize 内部会 addDiagrams 完成注册），必须先配置再检测——否则首个
  // 水合会话里 detectors 为空，全部图表被误判 unsupported（真实浏览器冒烟
  // 抓到的回归）。ensureConfigured 按主题幂等，渲染路径里的再次调用是空转。
  ensureConfigured(theme);
  // root 自身若是占位（lazy-mermaid 的可见性门控按单块水合时直接把块当
  // root 传入），querySelectorAll 不含自身，需显式并入；既有调用点传的都是
  // 会话容器，自身不匹配选择器，行为不变。
  const blocks = Array.from(
    root instanceof Element && root.matches(MERMAID_BLOCK_SELECTOR)
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
