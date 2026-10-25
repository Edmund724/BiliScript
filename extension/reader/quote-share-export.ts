// extension/reader/quote-share-export.ts
// 金句分享卡片预设表、细线几何纹样、物理灰度噪点、客户端光栅化导出、剪贴板写入与文件下载。

export type QuotePatternId = "none" | "rays" | "contours" | "soundwaves" | "dots" | "lens";

export interface QuoteCardPattern {
  id: QuotePatternId;
  name: string;
}

export const QUOTE_CARD_PATTERNS: readonly QuoteCardPattern[] = [
  { id: "none", name: "无纹样" },
  { id: "rays", name: "射线" },
  { id: "contours", name: "等高线" },
  { id: "soundwaves", name: "声波" },
  { id: "dots", name: "点阵" },
  { id: "lens", name: "透镜" }
];

export type QuotePresetId =
  | "purple-gold"
  | "slate-brown"
  | "mist-deep-sea"
  | "mist-forest-green"
  | "lavender-midnight"
  | "ash-rust";

export interface QuoteCardPreset {
  id: QuotePresetId;
  name: string;
  dotColor: string;
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

export interface QuoteCardExportOptions {
  content: string;
  videoTitle?: string;
  preset?: string;
  pattern?: QuotePatternId;
  width?: number;
  height?: number;
  scale?: number;
}

const BLOB_GEOMETRIES = [
  { cxRatio: 0.18, cyRatio: 0.18, rRatio: 0.55 },
  { cxRatio: 0.82, cyRatio: 0.2, rRatio: 0.5 },
  { cxRatio: 0.2, cyRatio: 0.82, rRatio: 0.55 },
  { cxRatio: 0.82, cyRatio: 0.8, rRatio: 0.5 }
] as const;

function definePreset(
  id: QuotePresetId,
  name: string,
  dotColor: string,
  baseStops: Array<{ offset: number; color: string }>,
  blobColors: readonly [string, string, string, string],
  angleDeg = 165
): QuoteCardPreset {
  return {
    id,
    name,
    dotColor,
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

export const QUOTE_CARD_PRESETS: readonly QuoteCardPreset[] = [
  definePreset(
    "purple-gold",
    "紫粉·橙金",
    "linear-gradient(135deg, #dc82c8, #f5aa32)",
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
  definePreset(
    "slate-brown",
    "灰蓝·深棕",
    "linear-gradient(135deg, #87a0b9, #c37d50)",
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
  definePreset(
    "mist-deep-sea",
    "雾蓝·深海",
    "linear-gradient(135deg, #73b4eb, #12325a)",
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
  definePreset(
    "mist-forest-green",
    "雾蓝·墨绿",
    "linear-gradient(135deg, #6eb0c3, #16462a)",
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
  definePreset(
    "lavender-midnight",
    "薰衣草·深夜紫",
    "linear-gradient(135deg, #aa8cdc, #150b2e)",
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
  definePreset(
    "ash-rust",
    "天灰·锈红",
    "linear-gradient(135deg, #a5b4be, #8c2d23)",
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
];

const PRESET_BY_ID = new Map<string, QuoteCardPreset>(
  QUOTE_CARD_PRESETS.map((preset) => [preset.id, preset])
);

const NOISE_BASE_SIZE = 128;
const noiseCache = new Map<number, string>();
const patternCache = new Map<QuotePatternId, string>();

/**
 * 获取当前 DPR 适配的 128×128 灰度噪点 base64 dataURL。
 * 命中缓存时直接复用，避免每次打开弹窗重复重绘 Canvas。
 */
export function getQuoteShareNoiseDataUrl(customDpr?: number): string {
  const dpr =
    typeof customDpr === "number" && customDpr > 0
      ? customDpr
      : typeof window !== "undefined" && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;

  const cached = noiseCache.get(dpr);
  if (cached) {
    return cached;
  }

  const dataUrl = generateNoiseDataUrl(dpr);
  noiseCache.set(dpr, dataUrl);
  return dataUrl;
}

function generateNoiseDataUrl(dpr: number): string {
  if (typeof document === "undefined") {
    return createFallbackNoiseSvgDataUrl();
  }

  const width = Math.max(1, Math.round(NOISE_BASE_SIZE * dpr));
  const height = Math.max(1, Math.round(NOISE_BASE_SIZE * dpr));

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return createFallbackNoiseSvgDataUrl();
    }

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;
    const len = data.length;
    for (let i = 0; i < len; i += 4) {
      const val = (Math.random() * 256) | 0;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return createFallbackNoiseSvgDataUrl();
  }
}

function createFallbackNoiseSvgDataUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${NOISE_BASE_SIZE}" height="${NOISE_BASE_SIZE}"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 获取指定纹样的内联 SVG 字符串（命中内存缓存时直接复用）。
 */
export function getQuoteSharePatternSvg(patternId: QuotePatternId): string {
  if (patternId === "none") {
    return "";
  }
  const cached = patternCache.get(patternId);
  if (cached !== undefined) {
    return cached;
  }
  const svg = generatePatternSvg(patternId);
  patternCache.set(patternId, svg);
  return svg;
}

function generatePatternSvg(patternId: QuotePatternId): string {
  switch (patternId) {
    case "rays":
      return generateRaysSvg();
    case "contours":
      return generateContoursSvg();
    case "soundwaves":
      return generateSoundwavesSvg();
    case "dots":
      return generateDotsSvg();
    case "lens":
      return generateLensSvg();
    default:
      return "";
  }
}

function generateRaysSvg(): string {
  const cx = 200;
  const cy = 150;
  const r = 320;
  const count = 48;
  const lines: string[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i * 2 * Math.PI) / count;
    const x2 = Number((cx + r * Math.cos(angle)).toFixed(1));
    const y2 = Number((cy + r * Math.sin(angle)).toFixed(1));
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" />`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" fill="none" stroke="#ffffff" stroke-width="0.8" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${lines.join("")}</svg>`;
}

function generateContoursSvg(): string {
  const cx = 200;
  const cy = 150;
  const numContours = 10;
  const pointsPerContour = 24;
  const paths: string[] = [];

  for (let k = 1; k <= numContours; k++) {
    const baseR = 25 * k;
    const pts: Array<{ x: number; y: number }> = [];

    for (let j = 0; j < pointsPerContour; j++) {
      const theta = (j * 2 * Math.PI) / pointsPerContour;
      const r = baseR * (1 + 0.08 * Math.sin(3 * theta + k * 0.7) + 0.05 * Math.cos(2 * theta - k * 0.5));
      const x = Number((cx + r * Math.cos(theta)).toFixed(1));
      const y = Number((cy + r * Math.sin(theta)).toFixed(1));
      pts.push({ x, y });
    }

    const n = pts.length;
    const startX = Number(((pts[n - 1].x + pts[0].x) / 2).toFixed(1));
    const startY = Number(((pts[n - 1].y + pts[0].y) / 2).toFixed(1));
    let d = `M ${startX} ${startY}`;

    for (let i = 0; i < n; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % n];
      const midX = Number(((curr.x + next.x) / 2).toFixed(1));
      const midY = Number(((curr.y + next.y) / 2).toFixed(1));
      d += ` Q ${curr.x} ${curr.y} ${midX} ${midY}`;
    }
    d += " Z";
    paths.push(`<path d="${d}" />`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" fill="none" stroke="#ffffff" stroke-width="0.8" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${paths.join("")}</svg>`;
}

function generateSoundwavesSvg(): string {
  const numWaves = 14;
  const samples = 24;
  const paths: string[] = [];

  for (let i = 0; i < numWaves; i++) {
    const baseY = 20 + i * 19;
    const pts: Array<{ x: number; y: number }> = [];

    for (let j = 0; j <= samples; j++) {
      const x = Number(((j / samples) * 400).toFixed(1));
      const normX = j / samples;
      const envelope = Math.sin(Math.PI * normX);
      const wave = Math.sin(normX * Math.PI * 6 + i * 0.8) * 12 * envelope;
      const y = Number((baseY + wave).toFixed(1));
      pts.push({ x, y });
    }

    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let j = 1; j < pts.length; j++) {
      const prev = pts[j - 1];
      const curr = pts[j];
      const midX = Number(((prev.x + curr.x) / 2).toFixed(1));
      const midY = Number(((prev.y + curr.y) / 2).toFixed(1));
      d += ` Q ${prev.x} ${prev.y} ${midX} ${midY}`;
    }
    paths.push(`<path d="${d}" />`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" fill="none" stroke="#ffffff" stroke-width="0.8" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${paths.join("")}</svg>`;
}

function generateDotsSvg(): string {
  const circles: string[] = [];
  const stepX = 16;
  const stepY = 16;

  for (let x = 12; x <= 388; x += stepX) {
    for (let y = 12; y <= 288; y += stepY) {
      circles.push(`<circle cx="${x}" cy="${y}" r="0.8" />`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" fill="#ffffff" stroke="none" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${circles.join("")}</svg>`;
}

function generateLensSvg(): string {
  const cx = 200;
  const cy = 150;
  const elements: string[] = [];

  elements.push(`<line x1="${cx}" y1="10" x2="${cx}" y2="290" />`);
  elements.push(`<line x1="10" y1="${cy}" x2="390" y2="${cy}" />`);

  const numRings = 24;
  for (let n = 1; n <= numRings; n++) {
    const r = Number((48 * Math.sqrt(n)).toFixed(1));
    elements.push(`<circle cx="${cx}" cy="${cy}" r="${r}" />`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" fill="none" stroke="#ffffff" stroke-width="0.8" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${elements.join("")}</svg>`;
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") {
    return Promise.resolve(null);
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
function wrapCanvasText(
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
 * 在 Canvas 2D 上绘制 iOS 连续圆角（Squircle / n=4 超椭圆，对应 CSS corner-shape: squircle）闭合矩形路径。
 */
function traceSquircleRectPath(
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
async function renderQuoteCardToCanvas(
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
  const presetDef =
    (options.preset ? PRESET_BY_ID.get(options.preset) : undefined) ?? QUOTE_CARD_PRESETS[0];

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
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = Math.round(width * scale);
        tempCanvas.height = Math.round(height * scale);
        const tempCtx = tempCanvas.getContext("2d");

        if (tempCtx) {
          tempCtx.scale(scale, scale);
          tempCtx.drawImage(patternImg, 0, 0, width, height);

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

function dataUrlToBlob(dataUrl: string): Blob {
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

async function canvasToBlob(
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
          } catch {
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
  options: QuoteCardExportOptions
): Promise<Blob> {
  const canvas = await renderQuoteCardToCanvas(options);
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
