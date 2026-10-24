// tests/reader/quote-share-card.test.ts
// 金句分享卡片预览模态弹窗、物理灰度噪点与细线几何纹样生成器单元测试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getQuoteShareNoiseDataUrl,
  clearQuoteShareNoiseCache,
  NOISE_BASE_SIZE
} from "../../extension/reader/quote-share-noise.js";
import {
  getQuoteSharePatternSvg,
  clearQuoteSharePatternCache,
  QUOTE_CARD_PATTERNS,
  type QuotePatternId
} from "../../extension/reader/quote-share-patterns.js";
import {
  solveSpring1D,
  createSpring2D
} from "../../extension/reader/quote-share-spring.js";
import {
  renderQuoteCardToCanvas,
  renderQuoteCardBlob,
  copyQuoteCardBlobToClipboard,
  downloadQuoteCardBlob,
  wrapCanvasText,
  extractQuoteCardExportOptions,
  dataUrlToBlob,
  canvasToBlob,
  EXPORT_PRESET_DEFS
} from "../../extension/reader/quote-share-export.js";
import {
  openQuoteShareModal,
  closeQuoteShareModal,
  isQuoteShareModalOpen,
  getActiveQuoteCardPreset,
  setActiveQuoteCardPreset,
  QUOTE_CARD_PRESETS,
  getActiveQuoteCardPattern,
  setActiveQuoteCardPattern,
  prefersReducedMotion,
  getSpringInstance
} from "../../extension/reader/quote-share-modal.js";
import { renderReadingOverview, onReadingOverviewClick } from "../../extension/reader/overview-ui.js";
import { closeReadingView } from "../../extension/reader/lifecycle.js";
import { ids } from "../../extension/reader/state.js";
import { state } from "../../extension/core/state.js";
import type { ReaderOverviewSnapshot } from "../../extension/reader/overview-coordinator.js";
import type { OverviewAnalysis } from "../../extension/ai/analysis.js";

function makeSnapshot(analysis: OverviewAnalysis | null): ReaderOverviewSnapshot {
  return {
    phase: "ready",
    analysis,
    aiChapters: false,
    chapterSourceKind: "auto",
    progressText: "",
    errorText: "",
    stripText: "",
    generatedFor: ""
  };
}

describe("quote-share-noise", () => {
  beforeEach(() => {
    clearQuoteShareNoiseCache();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    clearQuoteShareNoiseCache();
    vi.restoreAllMocks();
  });

  it("导出基础常量尺寸 128", () => {
    expect(NOISE_BASE_SIZE).toBe(128);
  });

  it("生成噪点 dataURL 并命中内存缓存（同 DPR 避免重复计算）", () => {
    const url1 = getQuoteShareNoiseDataUrl(1);
    expect(url1).toBeTruthy();
    expect(url1.startsWith("data:")).toBe(true);

    const url2 = getQuoteShareNoiseDataUrl(1);
    expect(url2).toBe(url1);
  });

  it("不同 DPR 生成不同缓存槽位", () => {
    const urlDpr1 = getQuoteShareNoiseDataUrl(1);
    const urlDpr2 = getQuoteShareNoiseDataUrl(2);
    expect(urlDpr1).toBeTruthy();
    expect(urlDpr2).toBeTruthy();
  });

  it("清空缓存后重新计算", () => {
    const url1 = getQuoteShareNoiseDataUrl(1);
    clearQuoteShareNoiseCache();
    const url2 = getQuoteShareNoiseDataUrl(1);
    expect(url1).toBeTruthy();
    expect(url2).toBeTruthy();
  });

  it("当 Canvas 2D 上下文正常时，生成灰度像素数据（R=G=B, A=255）", () => {
    let capturedData: Uint8ClampedArray | null = null;
    let putImageDataCalled = false;

    const fakeImageData = {
      data: new Uint8ClampedArray(128 * 128 * 4)
    };

    const fakeCtx = {
      createImageData: vi.fn(() => fakeImageData),
      putImageData: vi.fn((imgData: typeof fakeImageData) => {
        capturedData = imgData.data;
        putImageDataCalled = true;
      })
    };

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") {
        const c = origCreateElement("canvas");
        c.getContext = vi.fn((type: string) => {
          if (type === "2d") return fakeCtx as unknown as CanvasRenderingContext2D;
          return null;
        }) as unknown as typeof c.getContext;
        c.toDataURL = vi.fn(() => "data:image/png;base64,mockNoisePng");
        return c;
      }
      return origCreateElement(tag);
    });

    const result = getQuoteShareNoiseDataUrl(1);
    expect(result).toBe("data:image/png;base64,mockNoisePng");
    expect(putImageDataCalled).toBe(true);
    expect(capturedData).not.toBeNull();

    // 验证像素灰度属性：R === G === B 且 A === 255
    if (capturedData) {
      for (let i = 0; i < 40; i += 4) {
        const r = capturedData[i];
        const g = capturedData[i + 1];
        const b = capturedData[i + 2];
        const a = capturedData[i + 3];
        expect(r).toBe(g);
        expect(g).toBe(b);
        expect(a).toBe(255);
      }
    }
  });

  it("当 getContext('2d') 不可用时安全降级返回 SVG 噪点，不抛出异常", () => {
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") {
        const c = origCreateElement("canvas");
        c.getContext = vi.fn(() => null) as unknown as typeof c.getContext;
        return c;
      }
      return origCreateElement(tag);
    });

    const fallbackUrl = getQuoteShareNoiseDataUrl(1);
    expect(fallbackUrl.startsWith("data:image/svg+xml")).toBe(true);
    expect(fallbackUrl).toContain("feTurbulence");
  });
});

describe("quote-share-patterns", () => {
  beforeEach(() => {
    clearQuoteSharePatternCache();
  });

  afterEach(() => {
    clearQuoteSharePatternCache();
  });

  it("导出 6 种纹样模式选项（含无纹样与 5 款细线几何纹样）", () => {
    expect(QUOTE_CARD_PATTERNS.length).toBe(6);
    const ids = QUOTE_CARD_PATTERNS.map((p) => p.id);
    expect(ids).toEqual(["none", "rays", "contours", "soundwaves", "dots", "lens"]);
  });

  it("无纹样 (none) 返回空字符串", () => {
    expect(getQuoteSharePatternSvg("none")).toBe("");
  });

  it("射线 (rays)：生成以中心向外扩散的细线 SVG", () => {
    const svg = getQuoteSharePatternSvg("rays");
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain('stroke-width="0.8"');
    expect(svg).toContain('stroke="#ffffff"');
    expect(svg).toContain("<line");
    expect(svg).toContain('x1="200" y1="150"');
  });

  it("等高线 (contours)：生成多圈平滑闭合有机波动路径", () => {
    const svg = getQuoteSharePatternSvg("contours");
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain('stroke-width="0.8"');
    expect(svg).toContain("<path");
    // 包含二次贝塞尔平滑点与闭合指令
    expect(svg).toContain("Q");
    expect(svg).toContain("Z");
  });

  it("声波线 (soundwaves)：生成多层水平平滑谐波曲线", () => {
    const svg = getQuoteSharePatternSvg("soundwaves");
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain('stroke-width="0.8"');
    expect(svg).toContain("<path");
    expect(svg).toContain("Q");
  });

  it("点阵 (dots)：生成白色实心网格圆点矩阵", () => {
    const svg = getQuoteSharePatternSvg("dots");
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="none"');
    expect(svg).toContain("<circle");
    expect(svg).toContain('r="0.8"');
  });

  it("透镜 (lens)：生成菲涅尔同心环与正交光学轴线", () => {
    const svg = getQuoteSharePatternSvg("lens");
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain('stroke-width="0.8"');
    expect(svg).toContain("<line");
    expect(svg).toContain("<circle");
    expect(svg).toContain('cx="200" cy="150"');
  });

  it("命中内存缓存复用相同 SVG 字符串", () => {
    const s1 = getQuoteSharePatternSvg("rays");
    const s2 = getQuoteSharePatternSvg("rays");
    expect(s1).toBe(s2);
  });
});

describe("quote-share-modal", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="${ids.readingView}"></div>`;
    closeQuoteShareModal();
  });

  afterEach(() => {
    closeQuoteShareModal();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("包含 6 组色环相邻渐变配色预设", () => {
    expect(QUOTE_CARD_PRESETS.length).toBe(6);
    const idsList = QUOTE_CARD_PRESETS.map((p) => p.id);
    expect(idsList).toEqual([
      "purple-gold",
      "slate-brown",
      "mist-deep-sea",
      "mist-forest-green",
      "lavender-midnight",
      "ash-rust"
    ]);
  });

  it("打开分享弹窗：渲染骨架结构、正文、来源、噪点背景与默认射线纹样", () => {
    expect(isQuoteShareModalOpen()).toBe(false);

    openQuoteShareModal({
      content: "代码如诗，简洁至上。",
      from: 75,
      videoTitle: "精通重构之道"
    });

    expect(isQuoteShareModalOpen()).toBe(true);

    const host = document.querySelector(".biliscript-quote-share-host");
    expect(host).not.toBeNull();

    const dialog = host?.querySelector(".biliscript-quote-share-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");

    const textEl = host?.querySelector(".biliscript-quote-card-text");
    expect(textEl?.textContent).toBe("代码如诗，简洁至上。");

    expect(host?.querySelector(".biliscript-quote-card-timestamp")).toBeNull();

    const sourceEl = host?.querySelector(".biliscript-quote-card-source");
    expect(sourceEl?.textContent).toBe("精通重构之道");

    const card = host?.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.preset).toBe("purple-gold");
    expect(card?.dataset.pattern).toBe("rays");

    const noiseEl = host?.querySelector<HTMLElement>(".biliscript-quote-card-noise");
    expect(noiseEl?.style.backgroundImage).toContain("data:");

    const patternEl = host?.querySelector<HTMLElement>(".biliscript-quote-card-pattern");
    expect(patternEl).not.toBeNull();
    expect(patternEl?.innerHTML).toContain("<svg");
    expect(patternEl?.innerHTML).toContain("<line");

    const activePatternBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='rays']");
    expect(activePatternBtn?.classList.contains("is-active")).toBe(true);
    expect(activePatternBtn?.getAttribute("aria-pressed")).toBe("true");
  });

  it("支持在打开弹窗时通过 options.pattern 指定初始纹样", () => {
    openQuoteShareModal({
      content: "测试等高线纹样",
      from: 10,
      pattern: "contours"
    });

    expect(getActiveQuoteCardPattern()).toBe("contours");
    const card = document.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.pattern).toBe("contours");

    const patternEl = document.querySelector<HTMLElement>(".biliscript-quote-card-pattern");
    expect(patternEl?.innerHTML).toContain("<path");
  });

  it("点击纹样切换按钮在 5 种几何纹样及「无纹样」间无缝切换", () => {
    openQuoteShareModal({
      content: "测试金句纹样切换",
      from: 0
    });

    const host = document.querySelector(".biliscript-quote-share-host");
    const card = host?.querySelector<HTMLElement>(".biliscript-quote-card");
    const patternEl = host?.querySelector<HTMLElement>(".biliscript-quote-card-pattern");

    // 1. 切换至 contours
    const contoursBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='contours']");
    contoursBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getActiveQuoteCardPattern()).toBe("contours");
    expect(card?.dataset.pattern).toBe("contours");
    expect(patternEl?.innerHTML).toContain("<path");
    expect(contoursBtn?.classList.contains("is-active")).toBe(true);

    // 2. 切换至 soundwaves
    const soundwavesBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='soundwaves']");
    soundwavesBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getActiveQuoteCardPattern()).toBe("soundwaves");
    expect(card?.dataset.pattern).toBe("soundwaves");
    expect(patternEl?.innerHTML).toContain("<path");

    // 3. 切换至 dots
    const dotsBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='dots']");
    dotsBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getActiveQuoteCardPattern()).toBe("dots");
    expect(card?.dataset.pattern).toBe("dots");
    expect(patternEl?.innerHTML).toContain("<circle");

    // 4. 切换至 lens
    const lensBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='lens']");
    lensBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getActiveQuoteCardPattern()).toBe("lens");
    expect(card?.dataset.pattern).toBe("lens");
    expect(patternEl?.innerHTML).toContain("<circle");

    // 5. 切换至 none（无纹样）
    const noneBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='none']");
    noneBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getActiveQuoteCardPattern()).toBe("none");
    expect(card?.dataset.pattern).toBe("none");
    expect(patternEl?.innerHTML).toBe("");
    expect(noneBtn?.classList.contains("is-active")).toBe(true);
  });

  it("支持编程式调用 setActiveQuoteCardPattern", () => {
    openQuoteShareModal({ content: "金句", from: 0 });
    setActiveQuoteCardPattern("lens");

    expect(getActiveQuoteCardPattern()).toBe("lens");
    const card = document.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.pattern).toBe("lens");

    // 忽略无效模式调用
    setActiveQuoteCardPattern("invalid" as unknown as QuotePatternId);
    expect(getActiveQuoteCardPattern()).toBe("lens");
  });

  it("点击主题预设按钮切换卡片配色", () => {
    openQuoteShareModal({
      content: "测试金句",
      from: 10
    });

    const host = document.querySelector(".biliscript-quote-share-host");
    const card = host?.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.preset).toBe("purple-gold");

    const seaBtn = host?.querySelector<HTMLButtonElement>("[data-preset='mist-deep-sea']");
    expect(seaBtn).not.toBeNull();

    seaBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(getActiveQuoteCardPreset()).toBe("mist-deep-sea");
    expect(card?.dataset.preset).toBe("mist-deep-sea");
    expect(seaBtn?.classList.contains("is-active")).toBe(true);
    expect(seaBtn?.getAttribute("aria-pressed")).toBe("true");

    const purpleBtn = host?.querySelector<HTMLButtonElement>("[data-preset='purple-gold']");
    expect(purpleBtn?.classList.contains("is-active")).toBe(false);
    expect(purpleBtn?.getAttribute("aria-pressed")).toBe("false");
  });

  it("支持编程式调用 setActiveQuoteCardPreset", () => {
    openQuoteShareModal({ content: "金句", from: 0 });
    setActiveQuoteCardPreset("lavender-midnight");

    expect(getActiveQuoteCardPreset()).toBe("lavender-midnight");
    const card = document.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.preset).toBe("lavender-midnight");
  });

  it("点击关闭按钮关闭弹窗", () => {
    openQuoteShareModal({ content: "金句内容", from: 10 });
    expect(isQuoteShareModalOpen()).toBe(true);

    const closeBtn = document.querySelector<HTMLElement>(".biliscript-quote-share-close");
    closeBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(isQuoteShareModalOpen()).toBe(false);
    expect(document.querySelector(".biliscript-quote-share-host")).toBeNull();
  });

  it("点击遮罩层关闭弹窗", () => {
    openQuoteShareModal({ content: "金句内容", from: 10 });
    expect(isQuoteShareModalOpen()).toBe(true);

    const mask = document.querySelector<HTMLElement>(".biliscript-quote-share-mask");
    mask?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(isQuoteShareModalOpen()).toBe(false);
    expect(document.querySelector(".biliscript-quote-share-host")).toBeNull();
  });

  it("按 Escape 键关闭弹窗", () => {
    openQuoteShareModal({ content: "金句内容", from: 10 });
    expect(isQuoteShareModalOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(isQuoteShareModalOpen()).toBe(false);
    expect(document.querySelector(".biliscript-quote-share-host")).toBeNull();
  });

  it("空文案调用 openQuoteShareModal 静默早退，不创建弹窗", () => {
    openQuoteShareModal({ content: "" });
    expect(isQuoteShareModalOpen()).toBe(false);
    expect(document.querySelector(".biliscript-quote-share-host")).toBeNull();
  });

  it("重复打开时自动清理上一弹窗实例", () => {
    openQuoteShareModal({ content: "第一条金句", from: 10 });
    expect(document.querySelectorAll(".biliscript-quote-share-host").length).toBe(1);

    openQuoteShareModal({ content: "第二条金句", from: 20 });
    expect(document.querySelectorAll(".biliscript-quote-share-host").length).toBe(1);
    expect(document.querySelector(".biliscript-quote-card-text")?.textContent).toBe("第二条金句");
  });
});

describe("quote-share-pattern-styles", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const cssPath = path.resolve(process.cwd(), "extension/entry/styles/reader.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8");

  it("定义 .biliscript-quote-card-pattern 基础样式与默认透明度 0.38", () => {
    expect(cssContent).toContain(".biliscript-quote-card-pattern {");
    expect(cssContent).toContain("opacity: 0.38;");
  });

  it("配置径向遮罩 mask-image 与 -webkit-mask-image（中心避让正文阅读区）", () => {
    const expectedGradient = "radial-gradient(circle at 50% 50%, transparent 0%, transparent 45%, rgba(0, 0, 0, 0.4) 75%, #000000 100%)";
    expect(cssContent).toContain(`mask-image: ${expectedGradient}`);
    expect(cssContent).toContain(`-webkit-mask-image: ${expectedGradient}`);
  });

  it("配置 vector-effect: non-scaling-stroke 确保细线在各屏幕尺寸下保持统一线宽", () => {
    expect(cssContent).toContain("vector-effect: non-scaling-stroke;");
  });

  it("无障碍降级：prefers-reduced-transparency 下隐藏纹样层", () => {
    expect(cssContent).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(cssContent).toContain(".biliscript-quote-card-pattern {\r\n    display: none !important;\r\n  }");
  });

  it("无障碍降级：prefers-reduced-motion 下禁用纹样与按钮过渡", () => {
    expect(cssContent).toContain("@media (prefers-reduced-motion: reduce)");
    expect(cssContent).toContain(".biliscript-quote-pattern-btn");
  });
});

describe("概览 Tab 金句卡片分享按钮集成", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="${ids.readingView}">
        <div id="${ids.readingOverviewBody}"></div>
      </div>
    `;
    closeQuoteShareModal();
    state.clip.setTitle("测试视频标题");
  });

  afterEach(() => {
    closeQuoteShareModal();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("金句卡片底行渲染分享图标按钮，包含 quote 和 seconds 元数据", () => {
    renderReadingOverview(
      makeSnapshot({
        chapters: [],
        quotes: [{ from: 42, content: "山重水复疑无路，柳暗花明又一村。" }]
      })
    );

    const shareBtn = document.querySelector<HTMLElement>("[data-overview-action='share-quote']");
    expect(shareBtn).not.toBeNull();
    expect(shareBtn?.dataset.quote).toBe("山重水复疑无路，柳暗花明又一村。");
    expect(shareBtn?.dataset.seconds).toBe("42");
    expect(shareBtn?.getAttribute("aria-label")).toBe("分享金句卡片");
  });

  it("点击分享按钮触发 onReadingOverviewClick 打开分享弹窗，且不触发跳播", () => {
    renderReadingOverview(
      makeSnapshot({
        chapters: [],
        quotes: [{ from: 60, content: "不经一番寒彻骨，怎得梅花扑鼻香。" }]
      })
    );

    const shareBtn = document.querySelector<HTMLElement>("[data-overview-action='share-quote']")!;
    expect(shareBtn).not.toBeNull();

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    shareBtn.dispatchEvent(clickEvent);
    onReadingOverviewClick(clickEvent);

    expect(isQuoteShareModalOpen()).toBe(true);
    expect(document.querySelector(".biliscript-quote-card-text")?.textContent).toBe(
      "不经一番寒彻骨，怎得梅花扑鼻香。"
    );
    expect(document.querySelector(".biliscript-quote-card-source")?.textContent).toBe("测试视频标题");
  });

  it("关闭阅读视图 closeReadingView 时自动关闭金句分享弹窗", () => {
    openQuoteShareModal({ content: "临时金句", from: 5 });
    expect(isQuoteShareModalOpen()).toBe(true);

    closeReadingView();
    expect(isQuoteShareModalOpen()).toBe(false);
  });

  it("分享按钮样式规格与复制按钮对齐，弹窗宿主配置 pointer-events: auto 且阻断冒泡", () => {
    const cssPath = path.resolve(process.cwd(), "extension/entry/styles/reader.css");
    const css = fs.readFileSync(cssPath, "utf-8");

    // 1. 分享按钮与复制按钮尺寸一致
    expect(css).toContain(".biliscript-reading-ov-quote-share");
    expect(css).toContain(".biliscript-reading-ov-quote-copy");
    expect(css).toContain("width: 28px;");
    expect(css).toContain("height: 28px;");

    // 2. 弹窗宿主声明 pointer-events: auto 防穿透
    expect(css).toContain("#biliscript-reading-view .biliscript-quote-share-host");
    expect(css).toContain("pointer-events: auto;");

    // 3. 弹窗内点击事件阻断向上冒泡
    openQuoteShareModal({ content: "防穿透测试金句", from: 10 });
    const host = document.querySelector<HTMLElement>(".biliscript-quote-share-host")!;
    expect(host).not.toBeNull();

    let viewClickTriggered = false;
    const view = document.getElementById(ids.readingView)!;
    view.addEventListener("click", () => {
      viewClickTriggered = true;
    });

    const presetBtn = host.querySelector<HTMLElement>("[data-preset]")!;
    expect(presetBtn).not.toBeNull();
    presetBtn.click();

    expect(viewClickTriggered).toBe(false);
  });
});

describe("quote-share-spring 物理模拟器", () => {
  it("solveSpring1D: dt 小于等于 0 时保持原位与原速度", () => {
    const [pos, vel] = solveSpring1D(10, 5, 0, 0, 70, 0.86);
    expect(pos).toBe(10);
    expect(vel).toBe(5);
  });

  it("solveSpring1D: 欠阻尼刚度 70 阻尼比 0.86 下平滑回弹向目标收敛", () => {
    let pos = 1.0;
    let vel = 0;
    const target = 0;
    const dt = 1 / 60;
    // 模拟 45 帧（约 0.75 秒）
    for (let frame = 0; frame < 45; frame++) {
      [pos, vel] = solveSpring1D(pos, vel, target, dt, 70, 0.86);
    }
    // 经过 0.75 秒后应高度收敛至目标原点（位移 < 0.01）
    expect(Math.abs(pos)).toBeLessThan(0.01);
    expect(Math.abs(vel)).toBeLessThan(0.02);
  });

  it("createSpring2D: 初始状态停稳在原点，setTarget 触发非停稳状态", () => {
    const spring = createSpring2D({ stiffness: 70, dampingRatio: 0.86 });
    expect(spring.isSettled()).toBe(true);
    expect(spring.getState().current).toEqual({ x: 0, y: 0 });

    spring.setTarget(0.8, -0.6);
    expect(spring.isSettled()).toBe(false);
    expect(spring.getState().target).toEqual({ x: 0.8, y: -0.6 });
  });

  it("createSpring2D: step 连续步进达到停稳阈值后吸附并标记 settled: true", () => {
    const spring = createSpring2D({
      stiffness: 70,
      dampingRatio: 0.86,
      precision: 0.005,
      velocityPrecision: 0.01
    });
    spring.setTarget(1.0, 1.0);

    // 步进 60 步（每步 16ms）
    for (let i = 0; i < 60; i++) {
      spring.step(0.016);
    }

    const state = spring.getState();
    expect(state.settled).toBe(true);
    expect(state.current.x).toBe(1.0);
    expect(state.current.y).toBe(1.0);
    expect(state.velocity.x).toBe(0);
    expect(state.velocity.y).toBe(0);
  });

  it("createSpring2D: snapTo 立即设置坐标与清零速度", () => {
    const spring = createSpring2D();
    spring.setTarget(1, 1);
    expect(spring.isSettled()).toBe(false);

    spring.snapTo(0.2, 0.4);
    expect(spring.isSettled()).toBe(true);
    expect(spring.getState().current).toEqual({ x: 0.2, y: 0.4 });
    expect(spring.getState().target).toEqual({ x: 0.2, y: 0.4 });
    expect(spring.getState().velocity).toEqual({ x: 0, y: 0 });
  });
});

describe("quote-share-motion-and-parallax", () => {
  let origMatchMedia: typeof window.matchMedia;

  function setMatchMediaReduce(reduce: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduce : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(() => {
    origMatchMedia = window.matchMedia;
    setMatchMediaReduce(false);
    document.body.innerHTML = `<div id="${ids.readingView}"></div>`;
    closeQuoteShareModal();
  });

  afterEach(() => {
    closeQuoteShareModal();
    window.matchMedia = origMatchMedia;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("prefersReducedMotion: 尊重系统 mediaQuery 设置", () => {
    setMatchMediaReduce(true);
    expect(prefersReducedMotion()).toBe(true);

    setMatchMediaReduce(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("弹窗内包含色团层 blobs-layer 与柔光光标跟随层 glow", () => {
    openQuoteShareModal({ content: "动效测试金句", from: 0 });
    const blobsLayer = document.querySelector(".biliscript-quote-card-blobs-layer");
    expect(blobsLayer).not.toBeNull();
    const glowEl = document.querySelector(".biliscript-quote-card-glow");
    expect(glowEl).not.toBeNull();
    expect(glowEl?.getAttribute("aria-hidden")).toBe("true");
  });

  it("鼠标在卡片上悬停移动时更新光标柔光位置并触发 spring 目标变化", () => {
    setMatchMediaReduce(false);
    openQuoteShareModal({ content: "微视差测试", from: 0 });

    const card = document.querySelector<HTMLElement>(".biliscript-quote-card")!;
    expect(card).not.toBeNull();
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      width: 400,
      height: 300,
      right: 500,
      bottom: 400,
      x: 100,
      y: 100,
      toJSON: () => ({})
    });

    card.dispatchEvent(new MouseEvent("mousemove", { clientX: 360, clientY: 270, bubbles: true }));

    expect(card.classList.contains("is-hovered")).toBe(true);
    expect(card.style.getPropertyValue("--quote-glow-x")).toBe("260.0px");
    expect(card.style.getPropertyValue("--quote-glow-y")).toBe("170.0px");

    const spring = getSpringInstance();
    expect(spring).not.toBeNull();
    expect(spring?.isSettled()).toBe(false);
  });

  it("鼠标移出卡片时清除 is-hovered 并让 spring 目标归零回弹", () => {
    setMatchMediaReduce(false);
    openQuoteShareModal({ content: "微视差回弹测试", from: 0 });

    const card = document.querySelector<HTMLElement>(".biliscript-quote-card")!;
    card.classList.add("is-hovered");

    card.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(card.classList.contains("is-hovered")).toBe(false);

    const spring = getSpringInstance();
    expect(spring?.getState().target).toEqual({ x: 0, y: 0 });
  });

  it("prefers-reduced-motion: reduce 激活时鼠标悬停不开启视差与高光", () => {
    setMatchMediaReduce(true);
    openQuoteShareModal({ content: "减弱动效测试", from: 0 });

    const card = document.querySelector<HTMLElement>(".biliscript-quote-card")!;
    card.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 200, bubbles: true }));

    expect(card.classList.contains("is-hovered")).toBe(false);
    expect(card.style.getPropertyValue("--quote-glow-x")).toBe("");
  });
});

describe("quote-share-export 导出与光栅化", () => {
  it("wrapCanvasText: 较长单行文本按最大宽度合理折行", () => {
    const fakeCtx = {
      measureText: vi.fn((str: string) => ({ width: str.length * 10 }))
    } as unknown as CanvasRenderingContext2D;

    const lines = wrapCanvasText(fakeCtx, "一二三四五六七八九十", 45);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("一二三四五六七八九十");
  });

  it("wrapCanvasText: 保留换行符并分段折行", () => {
    const fakeCtx = {
      measureText: vi.fn((str: string) => ({ width: str.length * 10 }))
    } as unknown as CanvasRenderingContext2D;

    const lines = wrapCanvasText(fakeCtx, "第一段\n第二段", 200);
    expect(lines).toEqual(["第一段", "第二段"]);
  });

  it("extractQuoteCardExportOptions: 从 DOM 卡片正确解析属性", () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <div class="biliscript-quote-card" data-preset="slate-brown" data-pattern="contours">
        <div class="biliscript-quote-card-text">人生代代无穷已</div>
        <span class="biliscript-quote-card-source">春江花月夜</span>
      </div>
    `;
    const card = host.firstElementChild as HTMLElement;
    const opts = extractQuoteCardExportOptions(card);

    expect(opts.content).toBe("人生代代无穷已");
    expect(opts.preset).toBe("slate-brown");
    expect(opts.pattern).toBe("contours");
    expect(opts.videoTitle).toBe("春江花月夜");
  });

  it("dataUrlToBlob: 正确将 Base64 DataURL 解析为 Blob", () => {
    const rawPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const blob = dataUrlToBlob(rawPng);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("canvasToBlob: 优先使用 canvas.toBlob", async () => {
    const mockBlob = new Blob(["mock"], { type: "image/png" });
    const canvas = document.createElement("canvas");
    canvas.toBlob = vi.fn((cb: BlobCallback) => {
      cb(mockBlob);
    });

    const result = await canvasToBlob(canvas);
    expect(result).toBe(mockBlob);
    expect(canvas.toBlob).toHaveBeenCalled();
  });

  it("canvasToBlob: toBlob 返回 null 时优雅降级走 toDataURL", async () => {
    const canvas = document.createElement("canvas");
    canvas.toBlob = vi.fn((cb: BlobCallback) => cb(null));
    canvas.toDataURL = vi.fn(() => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");

    const result = await canvasToBlob(canvas);
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("image/png");
  });

  it("copyQuoteCardBlobToClipboard: 支持 navigator.clipboard.write 与 ClipboardItem", async () => {
    const mockWrite = vi.fn().mockResolvedValue(undefined);
    const origClipboard = navigator.clipboard;
    const origClipboardItem = (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;

    Object.defineProperty(navigator, "clipboard", {
      value: { write: mockWrite },
      configurable: true
    });
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = vi.fn();

    const blob = new Blob(["test"], { type: "image/png" });
    const success = await copyQuoteCardBlobToClipboard(blob);
    expect(success).toBe(true);
    expect(mockWrite).toHaveBeenCalled();

    Object.defineProperty(navigator, "clipboard", {
      value: origClipboard,
      configurable: true
    });
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = origClipboardItem;
  });

  it("copyQuoteCardBlobToClipboard: 当 API 抛错时捕获并优雅返回 false", async () => {
    const mockWrite = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      value: { write: mockWrite },
      configurable: true
    });
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = vi.fn();

    const blob = new Blob(["test"], { type: "image/png" });
    const success = await copyQuoteCardBlobToClipboard(blob);
    expect(success).toBe(false);
  });

  it("downloadQuoteCardBlob: 创建 a[download] 触发点击下载并清理 URL", () => {
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:http://localhost/mock-uuid");
    URL.revokeObjectURL = vi.fn();

    let clickCalled = false;
    const origAppendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node: Node) => {
      if (node instanceof HTMLAnchorElement) {
        node.click = () => {
          clickCalled = true;
        };
      }
      return origAppendChild(node);
    });

    const blob = new Blob(["test"], { type: "image/png" });
    downloadQuoteCardBlob(blob, "my-quote.png");

    expect(clickCalled).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);

    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  });

  it("renderQuoteCardToCanvas: 至少以 2x 缩放比例构建画布", async () => {
    const canvas = await renderQuoteCardToCanvas({
      content: "测试缩放",
      preset: "purple-gold",
      pattern: "rays",
      width: 400,
      height: 300,
      scale: 2
    });

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });
});

describe("quote-share-actions-ui 控制栏交互", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="${ids.readingView}"></div>`;
    closeQuoteShareModal();
  });

  afterEach(() => {
    closeQuoteShareModal();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("弹窗底部渲染「复制图片」与「保存 PNG」按钮", () => {
    openQuoteShareModal({ content: "操作栏按钮测试", from: 10 });

    const copyBtn = document.querySelector<HTMLButtonElement>("[data-action='copy-image']");
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.textContent).toContain("复制图片");

    const downloadBtn = document.querySelector<HTMLButtonElement>("[data-action='download-image']");
    expect(downloadBtn).not.toBeNull();
    expect(downloadBtn?.textContent).toContain("保存 PNG");
  });

  it("点击「保存 PNG」触发导出下载并更新按钮为已保存", async () => {
    openQuoteShareModal({ content: "下载按钮测试", from: 20 });

    const downloadBtn = document.querySelector<HTMLButtonElement>("[data-action='download-image']")!;
    expect(downloadBtn).not.toBeNull();

    // 模拟 Canvas 导出
    const fakeBlob = new Blob(["mock-image"], { type: "image/png" });
    HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(fakeBlob));
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    downloadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // 等待 microtask / promise
    await new Promise((r) => setTimeout(r, 20));

    expect(downloadBtn.classList.contains("is-success")).toBe(true);
    expect(downloadBtn.textContent).toContain("已保存");
  });
});

describe("quote-share-panel-style-contracts 面板风格契约", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const cssPath = path.resolve(currentDir, "../../extension/entry/styles/reader.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8").replace(/\r\n/g, "\n");

  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = cssContent.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    expect(match, `缺少样式规则 ${selector}`).not.toBeNull();
    return match![1];
  }

  it("容器使用面板的圆角、遮罩、阴影和淡入令牌", () => {
    expect(rule(".biliscript-quote-share-dialog")).toContain("border-radius: 28px;");
    expect(rule(".biliscript-quote-share-dialog")).toContain("corner-shape: squircle;");
    expect(rule(".biliscript-quote-share-dialog")).toContain("box-shadow: var(--biliscript-reader-shadow);");
    expect(rule(".biliscript-quote-share-mask")).toContain("background: var(--biliscript-reader-mask-bg, rgba(20, 16, 12, 0.28));");
    expect(rule(".biliscript-quote-share-host")).toContain("transition: opacity var(--biliscript-reader-duration-base, 250ms) var(--biliscript-reader-ease-out, cubic-bezier(0, 0, 0.2, 1));");
    expect(cssContent).toContain("@starting-style");
  });

  it("关闭键采用面板图标键尺寸与悬停、焦点、按压反馈", () => {
    const close = rule(".biliscript-quote-share-close");
    expect(close).toContain("width: 34px;");
    expect(close).toContain("height: 34px;");
    expect(close).toContain("border-radius: 28px;");
    expect(close).toContain("color: var(--biliscript-reader-text, #1f2937);");
    expect(rule(".biliscript-quote-share-close svg")).toContain("width: 18px;");
    expect(rule(".biliscript-quote-share-close:active")).toContain("transform: scale(0.91);");
    expect(cssContent).toContain(".biliscript-quote-share-close:hover,\n.biliscript-quote-share-close:focus-visible");
    expect(cssContent).not.toContain("background: rgba(255, 255, 255, 0.1);\n  color: #fff;");
  });

  it("操作按钮使用面板主次按钮规格和状态颜色", () => {
    const action = rule(".biliscript-quote-action-btn");
    expect(action).toContain("height: 32px;");
    expect(action).toContain("padding: 0 14px;");
    expect(action).toContain("border-radius: 999px;");
    expect(action).toContain("background: transparent;");
    expect(action).toContain("color: var(--biliscript-reader-muted);");
    expect(rule(".biliscript-quote-action-btn.is-primary")).toContain("background: var(--biliscript-reader-accent);");
    expect(rule(".biliscript-quote-action-btn.is-primary")).toContain("color: var(--biliscript-reader-on-fill);");
    expect(rule(".biliscript-quote-action-btn:disabled")).toContain("opacity: 0.45;");
    expect(rule(".biliscript-quote-action-btn.is-success")).toContain("color: var(--biliscript-reader-accent) !important;");
    expect(rule(".biliscript-quote-action-btn.is-primary.is-success")).toContain("color: var(--biliscript-reader-on-fill) !important;");
    expect(cssContent).toContain("filter: brightness(1.05);");
    expect(cssContent).not.toContain("#22a06b");
  });

  it("配色与纹样按钮保留外观并补齐键盘焦点", () => {
    expect(rule(".biliscript-quote-preset-btn")).toContain("border-radius: 12px;");
    expect(rule(".biliscript-quote-pattern-btn")).toContain("border-radius: 12px;");
    expect(cssContent).toContain(".biliscript-quote-preset-btn:hover,\n.biliscript-quote-preset-btn:focus-visible");
    expect(cssContent).toContain(".biliscript-quote-pattern-btn:hover,\n.biliscript-quote-pattern-btn:focus-visible");
  });
});

describe("quote-share-motion-styles 样式与降级", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const cssPath = path.resolve(currentDir, "../../extension/entry/styles/reader.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8");

  it("定义 @keyframes biliscript-quote-drift 慢速漂移动画（24s 周期）", () => {
    expect(cssContent).toContain("@keyframes biliscript-quote-drift");
    expect(cssContent).toContain("animation: biliscript-quote-drift 24s ease-in-out infinite alternate;");
  });

  it("定义 .biliscript-quote-card-blobs-layer 视差层与 --quote-spring 变量", () => {
    expect(cssContent).toContain(".biliscript-quote-card-blobs-layer");
    expect(cssContent).toContain("var(--quote-spring-x, 0)");
  });

  it("定义 .biliscript-quote-card-glow 柔光跟随层", () => {
    expect(cssContent).toContain(".biliscript-quote-card-glow");
    expect(cssContent).toContain("var(--quote-glow-x, 50%)");
    expect(cssContent).toContain(".biliscript-quote-card.is-hovered .biliscript-quote-card-glow");
  });

  it("定义 .biliscript-quote-share-actions 与操作按钮样式", () => {
    expect(cssContent).toContain(".biliscript-quote-share-actions");
    expect(cssContent).toContain(".biliscript-quote-action-btn");
    expect(cssContent).toContain(".biliscript-quote-action-btn.is-success");
  });

  it("prefers-reduced-motion: reduce 强制关闭所有漂移、视差与光标动画", () => {
    expect(cssContent).toContain("@media (prefers-reduced-motion: reduce)");
    expect(cssContent).toContain("animation: none !important;");
    expect(cssContent).toContain("transform: none !important;");
    expect(cssContent).toContain(".biliscript-quote-card-glow");
  });

  it("prefers-reduced-transparency: reduce 隐藏噪点、纹样、色团层与高光", () => {
    expect(cssContent).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(cssContent).toContain(".biliscript-quote-card-blobs-layer");
    expect(cssContent).toContain(".biliscript-quote-card-glow");
  });

  it("卡片内侧微描边使用 var(--biliscript-reader-fine-border) 支持暗色模式联动", () => {
    expect(cssContent).toContain("var(--biliscript-reader-fine-border, inset 0 0 0 0.5px rgba(0, 0, 0, 0.12))");
  });

  it("正文字号以 6% 容器宽度为基准配比 (clamp(16px, 6cqi, 24px))", () => {
    expect(cssContent).toContain("font-size: clamp(16px, 6cqi, 24px);");
  });
});

describe("quote-share-contracts 架构与 Token 契约", () => {
  it("reader-gate.css 不包含孤儿变量 --biliscript-reader-card-fine-border", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const gatePath = path.resolve(currentDir, "../../extension/entry/styles/reader-gate.css");
    const gateContent = fs.readFileSync(gatePath, "utf-8");
    expect(gateContent).not.toContain("--biliscript-reader-card-fine-border");
  });

  it("reader/index.ts 仅导出公共模态入口，不泄露噪点与配色内部实现", async () => {
    const readerIndex = await import("../../extension/reader/index.js") as Record<string, unknown>;
    expect(typeof readerIndex.openQuoteShareModal).toBe("function");
    expect(typeof readerIndex.closeQuoteShareModal).toBe("function");
    expect(typeof readerIndex.isQuoteShareModalOpen).toBe("function");
    expect(readerIndex.getQuoteShareNoiseDataUrl).toBeUndefined();
    expect(readerIndex.QUOTE_CARD_PRESETS).toBeUndefined();
  });

  it("EXPORT_PRESET_DEFS 中 6 套预设均正确复用 4 色团几何坐标与独立颜色", () => {
    for (const [, def] of Object.entries(EXPORT_PRESET_DEFS)) {
      expect(def.blobs.length).toBe(4);
      expect(def.blobs[0].cxRatio).toBe(0.18);
      expect(def.blobs[0].cyRatio).toBe(0.18);
      expect(def.blobs[0].color).toBeTruthy();
      expect(def.blobs[1].cxRatio).toBe(0.82);
      expect(def.blobs[2].cyRatio).toBe(0.82);
    }
  });
});

