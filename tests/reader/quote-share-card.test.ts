// tests/reader/quote-share-card.test.ts
// 金句分享卡片预览模态弹窗、视差弹簧微动效与光栅化导出端到端交互测试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openQuoteShareModal,
  closeQuoteShareModal,
  isQuoteShareModalOpen
} from "../../extension/reader/quote-share-modal.js";
import { layoutQuoteCardText } from "../../extension/reader/quote-share-export.js";
import { renderReadingOverview, onReadingOverviewClick } from "../../extension/reader/overview-ui.js";
import { closeReadingView } from "../../extension/reader/lifecycle.js";
import { ids } from "../../extension/reader/state.js";
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

describe("quote-share-modal 模态弹窗与卡片渲染", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="${ids.readingView}"></div>`;
    closeQuoteShareModal();
  });

  afterEach(() => {
    closeQuoteShareModal();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("渲染 6 组渐变配色预设按钮与 6 种几何纹样切换按钮", () => {
    openQuoteShareModal({ content: "测试预设与纹样列表" });

    const presetButtons = Array.from(
      document.querySelectorAll<HTMLElement>(".biliscript-quote-preset-btn[data-preset]")
    );
    expect(presetButtons.map((btn) => btn.dataset.preset)).toEqual([
      "purple-gold",
      "slate-brown",
      "mist-deep-sea",
      "mist-forest-green",
      "lavender-midnight",
      "ash-rust"
    ]);
    presetButtons.forEach((btn) => {
      const dot = btn.querySelector<HTMLElement>(".biliscript-quote-preset-dot");
      expect(dot?.style.background).toContain("linear-gradient");
    });

    const patternButtons = Array.from(
      document.querySelectorAll<HTMLElement>(".biliscript-quote-pattern-btn[data-pattern]")
    );
    expect(patternButtons.map((btn) => btn.dataset.pattern)).toEqual([
      "none",
      "rays",
      "contours",
      "soundwaves",
      "dots",
      "lens"
    ]);
  });

  it("打开分享弹窗：渲染相纸、16:9 卡片、正文、品牌与默认配色", () => {
    expect(isQuoteShareModalOpen()).toBe(false);

    openQuoteShareModal({ content: "代码如诗，简洁至上。" });

    expect(isQuoteShareModalOpen()).toBe(true);

    const host = document.querySelector(".biliscript-quote-share-host");
    expect(host).not.toBeNull();

    const dialog = host?.querySelector(".biliscript-quote-share-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");

    const textEl = host?.querySelector(".biliscript-quote-card-text");
    expect(textEl?.textContent).toBe("代码如诗，简洁至上。");

    // 卡面只承载金句：视频标题与时间戳都不再出现
    expect(host?.querySelector(".biliscript-quote-card-source")).toBeNull();
    expect(host?.querySelector(".biliscript-quote-card-timestamp")).toBeNull();
    expect(host?.querySelector(".biliscript-quote-card-brand")?.textContent).toBe("BiliScript");
    expect(host?.querySelector(".biliscript-quote-card-sheet")).not.toBeNull();
    expect(host?.querySelector(".biliscript-quote-card-scrim")).not.toBeNull();
    expect(
      host?.querySelectorAll(".biliscript-quote-card-motif .biliscript-quote-card-motif-bar").length
    ).toBe(2);
    expect(host?.querySelector(".biliscript-quote-card-motif-bar.is-lead")).not.toBeNull();
    expect(host?.querySelector(".biliscript-quote-card-motif-bar.is-track")).not.toBeNull();

    const card = host?.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.preset).toBe("mist-deep-sea");
    expect(card?.dataset.pattern).toBe("none");

    const noiseEl = host?.querySelector<HTMLElement>(".biliscript-quote-card-noise");
    expect(noiseEl?.style.backgroundImage).toContain("data:");

    const patternEl = host?.querySelector<HTMLElement>(".biliscript-quote-card-pattern");
    expect(patternEl).not.toBeNull();
    expect(patternEl?.innerHTML).toBe("");

    const activePatternBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='none']");
    expect(activePatternBtn?.classList.contains("is-active")).toBe(true);
    expect(activePatternBtn?.getAttribute("aria-pressed")).toBe("true");
  });

  it("支持在打开弹窗时通过 options.preset 和 options.pattern 指定初始预设与纹样", () => {
    openQuoteShareModal({
      content: "测试等高线纹样",
      preset: "mist-deep-sea",
      pattern: "contours"
    });

    const card = document.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.preset).toBe("mist-deep-sea");
    expect(card?.dataset.pattern).toBe("contours");

    const patternEl = document.querySelector<HTMLElement>(".biliscript-quote-card-pattern");
    expect(patternEl?.innerHTML).toContain("<path");
    expect(patternEl?.innerHTML).toContain("Q");
    expect(patternEl?.innerHTML).toContain("Z");
  });

  it("点击纹样切换按钮在 5 种几何纹样及「无纹样」间无缝切换", () => {
    openQuoteShareModal({
      content: "测试金句纹样切换",
    });

    const host = document.querySelector(".biliscript-quote-share-host");
    const card = host?.querySelector<HTMLElement>(".biliscript-quote-card");
    const patternEl = host?.querySelector<HTMLElement>(".biliscript-quote-card-pattern");

    // 1. 切换至 contours
    const contoursBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='contours']");
    contoursBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card?.dataset.pattern).toBe("contours");
    expect(patternEl?.innerHTML).toContain("<path");
    expect(patternEl?.innerHTML).toContain("Z");
    expect(contoursBtn?.classList.contains("is-active")).toBe(true);

    // 2. 切换至 soundwaves
    const soundwavesBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='soundwaves']");
    soundwavesBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card?.dataset.pattern).toBe("soundwaves");
    expect(patternEl?.innerHTML).toContain("<path");
    expect(patternEl?.innerHTML).toContain("Q");

    // 3. 切换至 dots
    const dotsBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='dots']");
    dotsBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card?.dataset.pattern).toBe("dots");
    expect(patternEl?.innerHTML).toContain("<circle");
    expect(patternEl?.innerHTML).toContain('r="0.8"');

    // 4. 切换至 lens
    const lensBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='lens']");
    lensBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card?.dataset.pattern).toBe("lens");
    expect(patternEl?.innerHTML).toContain("<line");
    expect(patternEl?.innerHTML).toContain("<circle");
    expect(patternEl?.innerHTML).toContain('cx="200" cy="150"');

    // 5. 切换至 none（无纹样）
    const noneBtn = host?.querySelector<HTMLButtonElement>("[data-pattern='none']");
    noneBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card?.dataset.pattern).toBe("none");
    expect(patternEl?.innerHTML).toBe("");
    expect(noneBtn?.classList.contains("is-active")).toBe(true);
  });

  it("点击主题预设按钮切换卡片配色", () => {
    openQuoteShareModal({
      content: "测试金句",
    });

    const host = document.querySelector(".biliscript-quote-share-host");
    const card = host?.querySelector<HTMLElement>(".biliscript-quote-card");
    expect(card?.dataset.preset).toBe("mist-deep-sea");

    const purpleBtn = host?.querySelector<HTMLButtonElement>("[data-preset='purple-gold']");
    expect(purpleBtn).not.toBeNull();

    purpleBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(card?.dataset.preset).toBe("purple-gold");
    expect(purpleBtn?.classList.contains("is-active")).toBe(true);
    expect(purpleBtn?.getAttribute("aria-pressed")).toBe("true");

    const seaBtn = host?.querySelector<HTMLButtonElement>("[data-preset='mist-deep-sea']");
    expect(seaBtn?.classList.contains("is-active")).toBe(false);
    expect(seaBtn?.getAttribute("aria-pressed")).toBe("false");
  });

  it("当 Canvas 2D 上下文正常时生成灰度像素 PNG 噪点，不可用时安全降级为 SVG 噪点", () => {
    const origDpr = window.devicePixelRatio;
    const origCreateElement = document.createElement.bind(document);

    // 1. 测试无 2D context 降级 SVG
    Object.defineProperty(window, "devicePixelRatio", { value: 1.75, configurable: true });
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") {
        const c = origCreateElement("canvas");
        c.getContext = vi.fn(() => null) as unknown as typeof c.getContext;
        return c;
      }
      return origCreateElement(tag);
    });

    openQuoteShareModal({ content: "SVG 噪点降级" });
    const svgNoiseEl = document.querySelector<HTMLElement>(".biliscript-quote-card-noise");
    expect(svgNoiseEl?.style.backgroundImage).toContain("data:image/svg+xml");
    expect(svgNoiseEl?.style.backgroundImage).toContain("feTurbulence");
    closeQuoteShareModal();
    vi.restoreAllMocks();

    // 2. 测试 2D context 灰度像素生成
    let capturedData: Uint8ClampedArray | null = null;
    const fakeImageData = { data: new Uint8ClampedArray(128 * 128 * 4) };
    const fakeCtx = {
      createImageData: vi.fn(() => fakeImageData),
      putImageData: vi.fn((imgData: typeof fakeImageData) => {
        capturedData = imgData.data;
      })
    };

    Object.defineProperty(window, "devicePixelRatio", { value: 2.25, configurable: true });
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") {
        const c = origCreateElement("canvas");
        c.getContext = vi.fn((type: string) =>
          type === "2d" ? (fakeCtx as unknown as CanvasRenderingContext2D) : null
        ) as unknown as typeof c.getContext;
        c.toDataURL = vi.fn(() => "data:image/png;base64,mockNoisePng");
        return c;
      }
      return origCreateElement(tag);
    });

    openQuoteShareModal({ content: "PNG 灰度噪点" });
    const pngNoiseEl = document.querySelector<HTMLElement>(".biliscript-quote-card-noise");
    expect(pngNoiseEl?.style.backgroundImage).toContain("data:image/png;base64,mockNoisePng");
    expect(capturedData).not.toBeNull();
    if (capturedData) {
      for (let i = 0; i < 40; i += 4) {
        expect(capturedData[i]).toBe(capturedData[i + 1]);
        expect(capturedData[i + 1]).toBe(capturedData[i + 2]);
        expect(capturedData[i + 3]).toBe(255);
      }
    }

    Object.defineProperty(window, "devicePixelRatio", { value: origDpr, configurable: true });
  });

  it("点击关闭按钮、遮罩层或按 Escape 键关闭弹窗", () => {
    openQuoteShareModal({ content: "金句内容" });
    expect(isQuoteShareModalOpen()).toBe(true);

    document.querySelector<HTMLElement>(".biliscript-quote-share-close")?.click();
    expect(isQuoteShareModalOpen()).toBe(false);
    expect(document.querySelector(".biliscript-quote-share-host")).toBeNull();

    openQuoteShareModal({ content: "金句内容" });
    document.querySelector<HTMLElement>(".biliscript-quote-share-mask")?.click();
    expect(isQuoteShareModalOpen()).toBe(false);

    openQuoteShareModal({ content: "金句内容" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(isQuoteShareModalOpen()).toBe(false);
  });

  it("空文案静默早退，重复打开时自动清理上一弹窗实例", () => {
    openQuoteShareModal({ content: "" });
    expect(isQuoteShareModalOpen()).toBe(false);
    expect(document.querySelector(".biliscript-quote-share-host")).toBeNull();

    openQuoteShareModal({ content: "第一条金句" });
    openQuoteShareModal({ content: "第二条金句" });
    expect(document.querySelectorAll(".biliscript-quote-share-host").length).toBe(1);
    expect(document.querySelector(".biliscript-quote-card-text")?.textContent).toBe("第二条金句");
  });
});

describe("quote-share-motion-and-parallax 悬停视差与弹簧回弹", () => {
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

  it("鼠标在卡片上悬停移动时更新光标柔光并通过 rAF 推进弹簧微视差，移出后回弹归零", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    openQuoteShareModal({ content: "微视差测试" });

    const card = document.querySelector<HTMLElement>(".biliscript-quote-card")!;
    expect(card.querySelector(".biliscript-quote-card-blobs-layer")).not.toBeNull();
    expect(card.querySelector(".biliscript-quote-card-glow")?.getAttribute("aria-hidden")).toBe("true");

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
    expect(callbacks.length).toBeGreaterThan(0);

    // 推进多帧动画，验证弹簧变量向目标 (0.3, 0.1333) 收敛
    let ts = 1000;
    for (let i = 0; i < 45 && callbacks.length > 0; i++) {
      const cb = callbacks.shift()!;
      ts += 16;
      cb(ts);
    }

    const springX = Number(card.style.getPropertyValue("--quote-spring-x"));
    const springY = Number(card.style.getPropertyValue("--quote-spring-y"));
    expect(springX).toBeCloseTo(0.3, 1);
    expect(springY).toBeCloseTo(0.1333, 1);

    // 鼠标移出后弹簧目标归零
    card.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(card.classList.contains("is-hovered")).toBe(false);

    for (let i = 0; i < 60 && callbacks.length > 0; i++) {
      const cb = callbacks.shift()!;
      ts += 16;
      cb(ts);
    }
    expect(Number(card.style.getPropertyValue("--quote-spring-x"))).toBeCloseTo(0, 2);
    expect(Number(card.style.getPropertyValue("--quote-spring-y"))).toBeCloseTo(0, 2);
  });

  it("prefers-reduced-motion: reduce 激活时鼠标悬停不开启视差与高光", () => {
    setMatchMediaReduce(true);
    openQuoteShareModal({ content: "减弱动效测试" });

    const card = document.querySelector<HTMLElement>(".biliscript-quote-card")!;
    card.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 200, bubbles: true }));

    expect(card.classList.contains("is-hovered")).toBe(false);
    expect(card.style.getPropertyValue("--quote-glow-x")).toBe("");
  });
});

describe("quote-share-actions-and-export 导出光栅化与控制栏交互", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="${ids.readingView}"></div>`;
    closeQuoteShareModal();
  });

  afterEach(() => {
    closeQuoteShareModal();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("点击「保存 PNG」把模态状态送入固定设计画布：白边相纸、超椭圆裁切、共享折行与 a[download] 下载", async () => {
    const points: Array<{ type: string; x: number; y: number }> = [];
    const filledTexts: string[] = [];
    const filledStyles: string[] = [];
    let clipCalled = false;
    let strokeCalled = false;
    let createdCanvasWidth = 0;
    let createdCanvasHeight = 0;

    const fakeGrad = { addColorStop: vi.fn() };
    const fakeCtx = {
      scale: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn((x: number, y: number) => points.push({ type: "move", x, y })),
      lineTo: vi.fn((x: number, y: number) => points.push({ type: "line", x, y })),
      closePath: vi.fn(),
      clip: vi.fn(() => {
        clipCalled = true;
      }),
      stroke: vi.fn(() => {
        strokeCalled = true;
      }),
      fill: vi.fn(function (this: { fillStyle: string }) {
        filledStyles.push(String(this.fillStyle));
      }),
      rect: vi.fn(),
      roundRect: vi.fn(),
      strokeRect: vi.fn(),
      createLinearGradient: vi.fn(() => fakeGrad),
      createRadialGradient: vi.fn(() => fakeGrad),
      createPattern: vi.fn(() => null),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      measureText: vi.fn((str: string) => ({ width: str.length * 18 })),
      fillText: vi.fn((text: string) => {
        filledTexts.push(text);
      }),
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      textAlign: "left",
      textBaseline: "middle",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      globalAlpha: 1,
      globalCompositeOperation: "source-over"
    };

    const origCreateElement = document.createElement.bind(document);
    let downloadAnchorClicked = false;
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") {
        const c = origCreateElement("canvas");
        c.getContext = vi.fn((type: string) =>
          type === "2d" ? (fakeCtx as unknown as CanvasRenderingContext2D) : null
        ) as unknown as typeof c.getContext;
        // 测试 toBlob 返回 null 走 toDataURL -> dataUrlToBlob 降级链路
        c.toBlob = vi.fn((cb: BlobCallback) => {
          createdCanvasWidth = c.width;
          createdCanvasHeight = c.height;
          cb(null);
        });
        c.toDataURL = vi.fn(
          () =>
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        );
        return c;
      }
      if (tag === "a") {
        const a = origCreateElement("a");
        a.click = () => {
          downloadAnchorClicked = true;
        };
        return a;
      }
      return origCreateElement(tag);
    });

    // 模拟 Image onload 立即完成，避免 jsdom 下 Image 加载挂起
    const OrigImage = globalThis.Image;
    globalThis.Image = class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = "";
      set src(_val: string) {
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof Image;

    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const capturedBlobs: Blob[] = [];
    URL.createObjectURL = vi.fn((obj: Blob | MediaSource) => {
      capturedBlobs.push(obj as Blob);
      return "blob:http://localhost/quote-card";
    });
    URL.revokeObjectURL = vi.fn();

    openQuoteShareModal({
      content: "第一段需要折行的长金句一二三四五六七八九十\n第二段精简金句",
      preset: "slate-brown",
      pattern: "none"
    });

    const downloadBtn = document.querySelector<HTMLButtonElement>("[data-action='download-image']")!;
    downloadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 30));

    // 固定设计画布：内卡 1200 宽，相纸约 1261×806，不随窗口变化
    expect(createdCanvasWidth).toBe(1261);
    expect(createdCanvasHeight).toBe(806);
    expect(clipCalled).toBe(true);
    expect(strokeCalled).toBe(true);
    // 超椭圆右上角 45° 采样点比正圆弧更贴角外扩
    expect(points.some((p) => p.x > 405 && p.y < 15)).toBe(true);
    // 折行与分段保留，品牌角标与底栏双段标记也进图
    expect(filledTexts).toContain("第二段精简金句");
    expect(filledTexts).toContain("BiliScript");
    expect(filledStyles).toContain("#e04a75");
    expect(filledStyles).toContain("#e9ebef");
    expect(downloadAnchorClicked).toBe(true);
    expect(capturedBlobs[0]).toBeInstanceOf(Blob);
    expect(capturedBlobs[0]?.type).toBe("image/png");
    expect(downloadBtn.classList.contains("is-success")).toBe(true);
    expect(downloadBtn.textContent).toContain("已保存");

    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    globalThis.Image = OrigImage;
  });

  it("点击「复制图片」支持写入系统剪贴板，并在剪贴板拒绝时展示降级提示", async () => {
    const OrigImage = globalThis.Image;
    globalThis.Image = class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = "";
      set src(_val: string) {
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof Image;

    const fakeBlob = new Blob(["mock-image"], { type: "image/png" });
    HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(fakeBlob));

    const origClipboard = navigator.clipboard;
    const origClipboardItem = (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;

    // 1. 剪贴板写入成功
    const mockWriteSuccess = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { write: mockWriteSuccess },
      configurable: true
    });
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = vi.fn();

    openQuoteShareModal({ content: "测试复制图片" });
    const copyBtn = document.querySelector<HTMLButtonElement>("[data-action='copy-image']")!;
    copyBtn.click();

    await new Promise((r) => setTimeout(r, 20));
    expect(mockWriteSuccess).toHaveBeenCalled();
    expect(copyBtn.classList.contains("is-success")).toBe(true);
    expect(copyBtn.textContent).toContain("已复制");

    closeQuoteShareModal();

    // 2. 剪贴板写入抛错时优雅回退提示
    const mockWriteReject = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      value: { write: mockWriteReject },
      configurable: true
    });

    openQuoteShareModal({ content: "测试复制失败" });
    const copyBtnFail = document.querySelector<HTMLButtonElement>("[data-action='copy-image']")!;
    copyBtnFail.click();

    await new Promise((r) => setTimeout(r, 20));
    expect(copyBtnFail.classList.contains("is-success")).toBe(false);
    expect(copyBtnFail.textContent).toContain("复制失败，建议直接保存图片");

    Object.defineProperty(navigator, "clipboard", {
      value: origClipboard,
      configurable: true
    });
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = origClipboardItem;
    globalThis.Image = OrigImage;
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
  });

  afterEach(() => {
    closeQuoteShareModal();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("金句卡片底行渲染分享图标按钮，点击打开分享弹窗且关闭阅读视图时自动收起", () => {
    renderReadingOverview(
      makeSnapshot({
        chapters: [],
        quotes: [{ from: 60, content: "不经一番寒彻骨，怎得梅花扑鼻香。" }]
      })
    );

    const shareBtn = document.querySelector<HTMLElement>("[data-overview-action='share-quote']")!;
    expect(shareBtn).not.toBeNull();
    expect(shareBtn.dataset.quote).toBe("不经一番寒彻骨，怎得梅花扑鼻香。");
    expect(shareBtn.getAttribute("aria-label")).toBe("分享金句卡片");

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    shareBtn.dispatchEvent(clickEvent);
    onReadingOverviewClick(clickEvent);

    expect(isQuoteShareModalOpen()).toBe(true);
    expect(document.querySelector(".biliscript-quote-card-text")?.textContent).toBe(
      "不经一番寒彻骨，怎得梅花扑鼻香。"
    );
    // 卡片不再带视频标题与时间戳：来源靠品牌角标承担
    expect(document.querySelector(".biliscript-quote-card-source")).toBeNull();
    expect(document.querySelector(".biliscript-quote-card-timestamp")).toBeNull();
    expect(document.querySelector(".biliscript-quote-card-brand")?.textContent).toBe("BiliScript");

    closeReadingView();
    expect(isQuoteShareModalOpen()).toBe(false);
  });

  it("分享按钮样式规格与复制按钮对齐，弹窗宿主配置 pointer-events: auto 且阻断冒泡", () => {
    const cssPath = path.resolve(process.cwd(), "extension/entry/styles/reader.css");
    const css = fs.readFileSync(cssPath, "utf-8");

    expect(css).toContain(".biliscript-reading-ov-quote-share");
    expect(css).toContain(".biliscript-reading-ov-quote-copy");
    expect(css).toContain("width: 28px;");
    expect(css).toContain("height: 28px;");
    expect(css).toContain("#biliscript-reading-view .biliscript-quote-share-host");
    expect(css).toContain("pointer-events: auto;");

    openQuoteShareModal({ content: "防穿透测试金句" });
    const host = document.querySelector<HTMLElement>(".biliscript-quote-share-host")!;

    let viewClickTriggered = false;
    const view = document.getElementById(ids.readingView)!;
    view.addEventListener("click", () => {
      viewClickTriggered = true;
    });

    host.querySelector<HTMLElement>("[data-preset]")!.click();
    expect(viewClickTriggered).toBe(false);
  });
});

describe("金句卡片正文布局（预览与导出共用同一份）", () => {
  const cjk = (n: number) => "字".repeat(n);

  it("短句保持基准字号单行", () => {
    const layout = layoutQuoteCardText("短金句");
    expect(layout.fontSize).toBe(21);
    expect(layout.lines).toEqual(["短金句"]);
    expect(layout.truncated).toBe(false);
  });

  it("长句逐级降字号直到装进正文区", () => {
    const layout = layoutQuoteCardText(cjk(70));
    expect(layout.fontSize).toBeGreaterThanOrEqual(14);
    expect(layout.fontSize).toBeLessThan(21);
    expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(129.14);
    expect(layout.truncated).toBe(false);
  });

  it("极端长句在 14px 下限按行数截断并补省略号", () => {
    const layout = layoutQuoteCardText(cjk(300));
    expect(layout.fontSize).toBe(14);
    expect(layout.truncated).toBe(true);
    expect(layout.lines.length).toBe(4);
    expect(layout.lines[3].endsWith("…")).toBe(true);
  });

  it("段落换行保留为独立行", () => {
    const layout = layoutQuoteCardText("第一段\n第二段");
    expect(layout.lines).toEqual(["第一段", "第二段"]);
  });
});

describe("quote-share 样式与架构契约", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const cssPath = path.resolve(currentDir, "../../extension/entry/styles/reader.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8").replace(/\r\n/g, "\n");
  // 连续圆角统一经语义令牌声明，兜底值与令牌同值。
  const CONTINUOUS_CORNER = "corner-shape: var(--biliscript-corner-shape, superellipse(1.25));";

  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = cssContent.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    expect(match, `缺少样式规则 ${selector}`).not.toBeNull();
    return match![1];
  }

  it("定义纹样径向遮罩、24s 慢速漂移、视差变量与无障碍降级", () => {
    expect(cssContent).toContain(".biliscript-quote-card-pattern {");
    expect(cssContent).toContain("opacity: 0.38;");
    const expectedGradient =
      "radial-gradient(circle at 50% 50%, transparent 0%, transparent 45%, rgba(0, 0, 0, 0.4) 75%, #000000 100%)";
    expect(cssContent).toContain(`mask-image: ${expectedGradient}`);
    expect(cssContent).toContain("vector-effect: non-scaling-stroke;");
    expect(cssContent).toContain("@keyframes biliscript-quote-drift");
    expect(cssContent).toContain("animation: biliscript-quote-drift 24s ease-in-out infinite alternate;");
    expect(cssContent).toContain("var(--quote-spring-x, 0)");
    expect(cssContent).toContain("var(--quote-glow-x, 50%)");
    expect(cssContent).toContain("@media (prefers-reduced-motion: reduce)");
    expect(cssContent).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(cssContent).toContain("font-family: var(--biliscript-reader-font-serif);");
    expect(cssContent).toContain("font-variant-numeric: lining-nums;");
    expect(cssContent).toContain("font-size: var(--quote-fit-size, 5.147cqi);");
  });

  it("相纸、16:9 内卡、品牌角标与暗罩按契约落位", () => {
    expect(rule(".biliscript-quote-card-sheet")).toContain("padding: 2.4cqi 2.4cqi 0;");
    expect(rule(".biliscript-quote-card-sheet")).toContain(
      "background: var(--biliscript-primitive-color-white);"
    );
    expect(rule(".biliscript-quote-card,\n.biliscript-quote-share-card")).toContain(
      "aspect-ratio: 16 / 9;"
    );
    expect(rule(".biliscript-quote-card-brand")).toContain("height: 8cqi;");
    expect(rule(".biliscript-quote-card-brand")).toContain(
      "color: var(--biliscript-primitive-color-gray-950);"
    );
    expect(rule(".biliscript-quote-card-motif")).toContain("left: 2.4cqi;");
    expect(rule(".biliscript-quote-card-motif")).toContain("height: 8cqi;");
    expect(rule(".biliscript-quote-card-motif-bar")).toContain(
      "border-radius: var(--biliscript-radius-pill);"
    );
    expect(rule(".biliscript-quote-card-motif-bar.is-lead")).toContain(
      "background: var(--biliscript-primitive-color-rose-500);"
    );
    expect(rule(".biliscript-quote-card-motif-bar.is-track")).toContain(
      "background: var(--biliscript-primitive-color-gray-200);"
    );
    expect(rule(".biliscript-quote-card-scrim")).toContain(
      "rgba(var(--biliscript-primitive-color-black-rgb), 0.16)"
    );
    expect(cssContent).not.toContain(".biliscript-quote-card-source");
    expect(cssContent).not.toContain(".biliscript-quote-card-timestamp");
  });

  it("容器、关闭键、操作按钮与切换按钮遵循面板圆角和令牌契约", () => {
    expect(rule(".biliscript-quote-share-dialog")).toMatch(/border-radius:\s*(28px|var\(--biliscript-radius-panel\));/);
    expect(rule(".biliscript-quote-share-dialog")).toContain(CONTINUOUS_CORNER);
    expect(rule(".biliscript-quote-share-dialog")).toContain("box-shadow: var(--biliscript-reader-shadow);");
    expect(rule(".biliscript-quote-share-close")).toContain("width: 34px;");
    expect(rule(".biliscript-quote-share-close")).toContain(CONTINUOUS_CORNER);
    expect(rule(".biliscript-quote-action-btn")).toContain("height: 32px;");
    expect(rule(".biliscript-quote-action-btn.is-primary")).toContain("background: var(--biliscript-reader-accent);");
    expect(rule(".biliscript-quote-card,\n.biliscript-quote-share-card")).toContain(CONTINUOUS_CORNER);
    expect(rule(".biliscript-quote-preset-btn")).toContain(CONTINUOUS_CORNER);
    expect(rule(".biliscript-quote-pattern-btn")).toContain(CONTINUOUS_CORNER);
  });

  it("quote-share-modal.ts 与 reader/index.ts 仅导出 3 个公共模态函数，不泄露内部状态与辅助实现", async () => {
    const modalModule = (await import("../../extension/reader/quote-share-modal.js")) as Record<string, unknown>;
    expect(Object.keys(modalModule).sort()).toEqual([
      "closeQuoteShareModal",
      "isQuoteShareModalOpen",
      "openQuoteShareModal"
    ]);

    const readerIndex = (await import("../../extension/reader/index.js")) as Record<string, unknown>;
    expect(typeof readerIndex.openQuoteShareModal).toBe("function");
    expect(typeof readerIndex.closeQuoteShareModal).toBe("function");
    expect(typeof readerIndex.isQuoteShareModalOpen).toBe("function");
    expect(readerIndex.getQuoteShareNoiseDataUrl).toBeUndefined();
    expect(readerIndex.QUOTE_CARD_PRESETS).toBeUndefined();
  });
});
