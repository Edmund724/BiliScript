// extension/reader/quote-share-export.ts
// 金句分享卡片客户端光栅化导出、剪贴板写入与文件下载。

import { getQuoteShareNoiseDataUrl } from "./quote-share-noise.js";
import {
  type QuotePatternId,
  getQuoteSharePatternSvg
} from "./quote-share-patterns.js";

export interface QuoteCardExportOptions {
  content: string;
  videoTitle?: string;
  preset?: string;
  pattern?: QuotePatternId;
  width?: number;
  height?: number;
  scale?: number;
}

interface PresetGradientDef {
  base: {
    angleDeg: number;
    stops: Array<{ offset: number; color: string }>;
  };
  blobs: Array<{
    cxRatio: number;
    cyRatio: number;
    rRatio: number;
    color: string;
  }>;
}

const BLOB_GEOMETRIES = [
  { cxRatio: 0.18, cyRatio: 0.18, rRatio: 0.55 },
  { cxRatio: 0.82, cyRatio: 0.2, rRatio: 0.5 },
  { cxRatio: 0.2, cyRatio: 0.82, rRatio: 0.55 },
  { cxRatio: 0.82, cyRatio: 0.8, rRatio: 0.5 }
] as const;

function createPresetDef(
  baseStops: Array<{ offset: number; color: string }>,
  blobColors: readonly [string, string, string, string],
  angleDeg = 165
): PresetGradientDef {
  return {
    base: {
      angleDeg,
      stops: baseStops
    },
    blobs: BLOB_GEOMETRIES.map((geom, index) => ({
      ...geom,
      color: blobColors[index]
    }))
  };
}

export const EXPORT_PRESET_DEFS: Record<string, PresetGradientDef> = {
  "purple-gold": createPresetDef(
    [
      { offset: 0, color: "#b4bed6" },
      { offset: 0.45, color: "#9d8daa" },
      { offset: 1, color: "#b85e46" }
    ],
    [
      "rgba(167, 158, 211, 0.8)",
      "rgba(214, 164, 193, 0.72)",
      "rgba(238, 112, 77, 0.82)",
      "rgba(250, 180, 71, 0.88)"
    ]
  ),
  "slate-brown": createPresetDef(
    [
      { offset: 0, color: "#aebdc5" },
      { offset: 0.45, color: "#66727a" },
      { offset: 1, color: "#32201b" }
    ],
    [
      "rgba(156, 173, 187, 0.72)",
      "rgba(197, 182, 165, 0.68)",
      "rgba(82, 50, 38, 0.76)",
      "rgba(212, 123, 67, 0.9)"
    ]
  ),
  "mist-deep-sea": createPresetDef(
    [
      { offset: 0, color: "#c6d6df" },
      { offset: 0.45, color: "#4b8393" },
      { offset: 1, color: "#0b3544" }
    ],
    [
      "rgba(191, 212, 222, 0.75)",
      "rgba(167, 196, 212, 0.72)",
      "rgba(51, 123, 129, 0.72)",
      "rgba(16, 63, 81, 0.86)"
    ]
  ),
  "mist-forest-green": createPresetDef(
    [
      { offset: 0, color: "#bcccd4" },
      { offset: 0.45, color: "#68816e" },
      { offset: 1, color: "#183522" }
    ],
    [
      "rgba(188, 204, 212, 0.75)",
      "rgba(177, 194, 183, 0.65)",
      "rgba(109, 129, 63, 0.8)",
      "rgba(36, 75, 44, 0.85)"
    ]
  ),
  "lavender-midnight": createPresetDef(
    [
      { offset: 0, color: "#b7c6da" },
      { offset: 0.45, color: "#b088bd" },
      { offset: 1, color: "#1b1035" }
    ],
    [
      "rgba(170, 188, 224, 0.75)",
      "rgba(212, 175, 208, 0.8)",
      "rgba(130, 86, 165, 0.8)",
      "rgba(57, 32, 82, 0.85)"
    ]
  ),
  "ash-rust": createPresetDef(
    [
      { offset: 0, color: "#c2cbd3" },
      { offset: 0.45, color: "#dda185" },
      { offset: 1, color: "#6e2b26" }
    ],
    [
      "rgba(197, 209, 219, 0.75)",
      "rgba(240, 195, 167, 0.82)",
      "rgba(217, 111, 90, 0.82)",
      "rgba(166, 69, 55, 0.85)"
    ]
  )
};

/**
 * 将 Base64 或 SVG DataURL 加载为 HTMLImageElement。
 */
export async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") {
    return null;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * 文本折行算法，支持中英文混合排版。
 */
export function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const rawParagraphs = normalized.split("\n");

  for (const para of rawParagraphs) {
    if (!para.trim()) {
      continue;
    }
    let currentLine = "";
    for (let i = 0; i < para.length; i++) {
      const char = para[i];
      const candidate = currentLine + char;
      const metrics = ctx.measureText(candidate);
      if (metrics.width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char === " " ? "" : char;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [text];
}

/**
 * 从 DOM 卡片元素提取导出参数。
 */
export function extractQuoteCardExportOptions(cardEl: HTMLElement): QuoteCardExportOptions {
  const textEl = cardEl.querySelector(".biliscript-quote-card-text");
  const sourceEl = cardEl.querySelector(".biliscript-quote-card-source");

  const rect = cardEl.getBoundingClientRect();
  const width = Math.round(rect.width) || 400;
  const height = Math.round(rect.height) || 300;

  return {
    content: textEl?.textContent?.trim() || "",
    videoTitle: sourceEl?.textContent?.trim() || "",
    preset: cardEl.dataset.preset || "purple-gold",
    pattern: (cardEl.dataset.pattern || "rays") as QuotePatternId,
    width,
    height
  };
}

/**
 * 在 Canvas 2D 上绘制 iOS 连续圆角（Squircle / n=4 超椭圆，对应 CSS corner-shape: squircle）闭合矩形路径。
 */
export function traceSquircleRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  stepsPerCorner = 24
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const superellipseCoord = (t: number): { dx: number; dy: number } => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return {
      dx: Math.sign(c) * Math.sqrt(Math.abs(c)) * r,
      dy: Math.sign(s) * Math.sqrt(Math.abs(s)) * r
    };
  };

  const corners = [
    { cx: x + width - r, cy: y + r, start: -Math.PI / 2, end: 0 },
    { cx: x + width - r, cy: y + height - r, start: 0, end: Math.PI / 2 },
    { cx: x + r, cy: y + height - r, start: Math.PI / 2, end: Math.PI },
    { cx: x + r, cy: y + r, start: Math.PI, end: (3 * Math.PI) / 2 }
  ];

  ctx.moveTo(x + r, y);
  for (const corner of corners) {
    for (let i = 0; i <= stepsPerCorner; i++) {
      const t = corner.start + ((corner.end - corner.start) * i) / stepsPerCorner;
      const { dx, dy } = superellipseCoord(t);
      ctx.lineTo(corner.cx + dx, corner.cy + dy);
    }
  }
  ctx.closePath();
}

/**
 * 离屏渲染卡片至高分辨率 Canvas。
 */
export async function renderQuoteCardToCanvas(
  options: QuoteCardExportOptions
): Promise<HTMLCanvasElement> {
  const scale =
    options.scale ??
    Math.max(2, Math.round((typeof window !== "undefined" && window.devicePixelRatio) || 2));
  const width = options.width ?? 400;
  const height = options.height ?? 300;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.scale(scale, scale);

  // 1. 20px 连续圆角（squircle）裁切路径
  ctx.save();
  ctx.beginPath();
  traceSquircleRectPath(ctx, 0, 0, width, height, 20);
  ctx.clip();

  // 2. 底层线性渐变（165deg）
  const presetKey = options.preset && EXPORT_PRESET_DEFS[options.preset] ? options.preset : "purple-gold";
  const presetDef = EXPORT_PRESET_DEFS[presetKey];

  const angleRad = (presetDef.base.angleDeg * Math.PI) / 180;
  const len = Math.abs(width * Math.sin(angleRad)) + Math.abs(height * Math.cos(angleRad));
  const dx = (len / 2) * Math.sin(angleRad);
  const dy = -(len / 2) * Math.cos(angleRad);
  const x0 = width / 2 - dx;
  const y0 = height / 2 - dy;
  const x1 = width / 2 + dx;
  const y1 = height / 2 + dy;

  const linearGrad = ctx.createLinearGradient(x0, y0, x1, y1);
  presetDef.base.stops.forEach((stop) => {
    linearGrad.addColorStop(stop.offset, stop.color);
  });
  ctx.fillStyle = linearGrad;
  ctx.fillRect(0, 0, width, height);

  // 3. 叠加 4 个大径向色团
  for (const blob of presetDef.blobs) {
    const cx = blob.cxRatio * width;
    const cy = blob.cyRatio * height;
    const r = blob.rRatio * Math.max(width, height);
    const radGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    radGrad.addColorStop(0, blob.color);
    radGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = radGrad;
    ctx.fillRect(0, 0, width, height);
  }

  // 4. 几何细线纹样层与径向中心遮罩
  const patternId = options.pattern ?? "rays";
  if (patternId !== "none") {
    const svgContent = getQuoteSharePatternSvg(patternId);
    if (svgContent) {
      const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
      const patternImg = await loadImageFromDataUrl(svgDataUrl);
      if (patternImg) {
        // 创建离屏临时 Canvas 应用径向遮罩（中心避让留白）
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = Math.round(width * scale);
        tempCanvas.height = Math.round(height * scale);
        const tempCtx = tempCanvas.getContext("2d");

        if (tempCtx) {
          tempCtx.scale(scale, scale);
          tempCtx.drawImage(patternImg, 0, 0, width, height);

          // 遮罩：中心 45% 挖空，75% 渐变，边缘保留
          tempCtx.globalCompositeOperation = "destination-out";
          const maskGrad = tempCtx.createRadialGradient(
            width / 2,
            height / 2,
            0,
            width / 2,
            height / 2,
            Math.max(width, height) * 0.52
          );
          maskGrad.addColorStop(0, "rgba(0, 0, 0, 1)");
          maskGrad.addColorStop(0.45, "rgba(0, 0, 0, 1)");
          maskGrad.addColorStop(0.75, "rgba(0, 0, 0, 0.6)");
          maskGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
          tempCtx.fillStyle = maskGrad;
          tempCtx.fillRect(0, 0, width, height);

          // 绘制到主 Canvas（透明度 0.38）
          ctx.save();
          ctx.globalAlpha = 0.38;
          ctx.drawImage(tempCanvas, 0, 0, width, height);
          ctx.restore();
        }
      }
    }
  }

  // 5. 灰度物理噪点平铺层
  const noiseUrl = getQuoteShareNoiseDataUrl(scale);
  const noiseImg = await loadImageFromDataUrl(noiseUrl);
  if (noiseImg) {
    try {
      const noisePattern = ctx.createPattern(noiseImg, "repeat");
      if (noisePattern) {
        ctx.save();
        ctx.globalCompositeOperation = "overlay";
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = noisePattern;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
    } catch {
      // 忽略 pattern 创建异常
    }
  }

  // 6. 正文与文字排版层
  if (typeof document !== "undefined" && document.fonts?.load) {
    await document.fonts.load('400 16px "BiliScript Noto Serif SC"', options.content).catch(() => []);
  }

  // 6.1 引号装饰“
  ctx.save();
  ctx.font = '34px Georgia, "Times New Roman", serif';
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("“", 36, 42);
  ctx.restore();

  // 6.2 金句正文（支持根据容器宽度自适应折行与居中排版）
  const fontSize = Math.min(21, Math.max(16, Math.round(width * 0.055)));
  const lineHeight = fontSize * 1.85;
  const maxTextWidth = width - 72;

  ctx.save();
  ctx.font = `400 ${fontSize}px "BiliScript Noto Serif SC", Georgia, "Times New Roman", "Songti SC", "SimSun", serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;

  const lines = wrapCanvasText(ctx, options.content, maxTextWidth);
  const totalTextHeight = lines.length * lineHeight;
  const startY = (height - totalTextHeight) / 2 + lineHeight / 2;

  lines.forEach((line, index) => {
    ctx.fillText(line, 36, startY + index * lineHeight);
  });
  ctx.restore();

  // 6.3 底部视频来源
  const sourceText = options.videoTitle || "BiliScript";

  ctx.save();
  ctx.font = '11px "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "HarmonyOS_Regular", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.textBaseline = "alphabetic";

  if (sourceText) {
    ctx.textAlign = "right";
    let truncatedSource = sourceText;
    while (truncatedSource.length > 3 && ctx.measureText(truncatedSource).width > width * 0.45) {
      truncatedSource = truncatedSource.slice(0, -2) + "…";
    }
    ctx.fillText(truncatedSource, width - 36, height - 23);
  }
  ctx.restore();

  // 恢复圆角裁切
  ctx.restore();

  // 7. 内侧 0.5px 精细微描边（与 20px 连续圆角同心对齐）
  ctx.save();
  ctx.beginPath();
  traceSquircleRectPath(ctx, 0.25, 0.25, width - 0.5, height - 0.5, 20 - 0.25);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.12)";
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.restore();

  return canvas;
}

/**
 * 将 DataURL 解析为 Blob。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.substring(0, comma) : "";
  const match = header.match(/^data:([^;]+);base64/);
  const mime = match ? match[1] : "image/png";
  const b64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
  const bin =
    typeof atob === "function"
      ? atob(b64)
      : typeof (globalThis as unknown as { Buffer?: { from(s: string, enc: string): { toString(e: string): string } } }).Buffer !== "undefined"
      ? (globalThis as unknown as { Buffer: { from(s: string, enc: string): { toString(e: string): string } } }).Buffer.from(b64, "base64").toString("binary")
      : "";
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * 将 Canvas 转为 Blob。
 */
export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType = "image/png"
): Promise<Blob> {
  if (typeof canvas.toBlob === "function") {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          try {
            const dataUrl = canvas.toDataURL(mimeType);
            resolve(dataUrlToBlob(dataUrl));
          } catch (e) {
            reject(new Error("Canvas toBlob failed and dataURL fallback failed"));
          }
        }
      }, mimeType);
    });
  }

  const dataUrl = canvas.toDataURL(mimeType);
  return dataUrlToBlob(dataUrl);
}

/**
 * 渲染卡片为 PNG Blob。
 */
export async function renderQuoteCardBlob(
  optionsOrCard: QuoteCardExportOptions | HTMLElement,
  overrideScale?: number
): Promise<Blob> {
  let opts: QuoteCardExportOptions;
  if (optionsOrCard instanceof HTMLElement) {
    opts = extractQuoteCardExportOptions(optionsOrCard);
  } else {
    opts = optionsOrCard;
  }
  if (overrideScale !== undefined) {
    opts = { ...opts, scale: overrideScale };
  }

  const canvas = await renderQuoteCardToCanvas(opts);
  return await canvasToBlob(canvas, "image/png");
}

/**
 * 将卡片图片 Blob 写入系统剪贴板。
 */
export async function copyQuoteCardBlobToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === "function" &&
      typeof ClipboardItem !== "undefined"
    ) {
      const item = new ClipboardItem({ [blob.type || "image/png"]: blob });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch (err) {
    console.warn("[quote-share-export] clipboard.write failed:", err);
  }
  return false;
}

/**
 * 触发卡片图片文件下载。
 */
export function downloadQuoteCardBlob(
  blob: Blob,
  filename = `biliscript-quote-${Date.now()}.png`
): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
