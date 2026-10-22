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
  openQuoteShareModal,
  closeQuoteShareModal,
  isQuoteShareModalOpen,
  getActiveQuoteCardPreset,
  setActiveQuoteCardPreset,
  QUOTE_CARD_PRESETS,
  getActiveQuoteCardPattern,
  setActiveQuoteCardPattern
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

  it("打开分享弹窗：渲染骨架结构、正文、时间戳、噪点背景与默认射线纹样", () => {
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

    const timeEl = host?.querySelector(".biliscript-quote-card-timestamp");
    expect(timeEl?.textContent).toBe("1:15");

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
  const cssPath = path.resolve(currentDir, "../../extension/entry/styles/reader.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8");

  it("定义 .biliscript-quote-card-pattern 基础样式与默认透明度 0.3", () => {
    expect(cssContent).toContain(".biliscript-quote-card-pattern {");
    expect(cssContent).toContain("opacity: 0.3;");
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
});
