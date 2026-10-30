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
  preset?: string;
  pattern?: QuotePatternId;
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

// ===== 版式度量（单一来源：预览 DOM 与 Canvas 导出共用同一份数字）=====
// 标称卡 408×229.5（16:9）：预览里 1cqi = 卡宽的 1%，导出的设计画布按 1200 宽等比放大。
// 字号档位、折行、内边距与品牌位都从这一份常量推导，两边不会各算一套。
export const QUOTE_CARD_CANONICAL_WIDTH = 408;
export const QUOTE_CARD_CANONICAL_HEIGHT = 229.5;

/** 正文衬线栈：与 `--biliscript-reader-font-serif` 同序，测量与绘制必须同源。 */
export const QUOTE_CARD_FONT_SERIF =
  'Georgia, "Times New Roman", "Source Han Serif SC", "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif CN", "LXGW Neo ZhiSong", "Songti SC", "STSong", "SimSun", serif';

/** 品牌角标与时间戳的无衬线栈：与 `--biliscript-reader-font-sans-medium` 同序。 */
export const QUOTE_CARD_FONT_SANS =
  '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "HarmonyOS_Regular", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

const TEXT_INSET_X = QUOTE_CARD_CANONICAL_WIDTH * 0.088;
const TEXT_INSET_TOP = QUOTE_CARD_CANONICAL_WIDTH * 0.083;
const TEXT_INSET_BOTTOM = QUOTE_CARD_CANONICAL_WIDTH * 0.163;
const TEXT_MAX_WIDTH = QUOTE_CARD_CANONICAL_WIDTH - TEXT_INSET_X * 2;
const TEXT_AREA_HEIGHT = QUOTE_CARD_CANONICAL_HEIGHT - TEXT_INSET_TOP - TEXT_INSET_BOTTOM;
const BASE_FONT_SIZE = 21;
const MIN_FONT_SIZE = 14;
const FONT_STEP = 1;
const LINE_HEIGHT_RATIO = 1.5;
/** 正文最多 4 行：超过的用省略号收尾，宁可少字也不把卡面塞满。 */
const MAX_LINES = 4;

/** 正文字重：参考卡的宋体笔画厚度；可变字重字体上可在 380–450 之间连续微调。 */
export const QUOTE_CARD_TEXT_WEIGHT = 400;

export interface QuoteCardTextMeasurer {
  measure(text: string, fontSize: number): number;
}

export interface QuoteCardTextLayout {
  /** 正文标称字号（408 卡宽下的 px）。 */
  fontSize: number;
  lineHeight: number;
  lines: string[];
  textLeft: number;
  textTop: number;
  textWidth: number;
  truncated: boolean;
}

/**
 * 用 Canvas 上下文构造文字测量器（预览与导出共用）。上下文不可用时返回 null，
 * 布局退回按全角/半角估算的测量器——jsdom 与降级环境仍能出稳定折行。
 */
export function createQuoteCardTextMeasurer(
  ctx: CanvasRenderingContext2D | null | undefined
): QuoteCardTextMeasurer | null {
  if (!ctx) {
    return null;
  }
  const measurer: QuoteCardTextMeasurer = {
    measure(text, fontSize) {
      ctx.font = `${QUOTE_CARD_TEXT_WEIGHT} ${fontSize}px ${QUOTE_CARD_FONT_SERIF}`;
      return ctx.measureText(text).width;
    }
  };
  return measurer;
}

function createApproximateMeasurer(): QuoteCardTextMeasurer {
  return {
    measure(text, fontSize) {
      let em = 0;
      for (const char of text) {
        if (char === " ") {
          em += 0.28;
        } else if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\u2014\u2026\u2018\u2019\u201c\u201d]/.test(char)) {
          em += 1;
        } else {
          em += 0.52;
        }
      }
      return em * fontSize;
    }
  };
}

/** 按宽度逐字折行；保留段落换行（模型产出的金句可能自带 \n）。 */
function wrapQuoteText(
  content: string,
  fontSize: number,
  measurer: QuoteCardTextMeasurer
): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const paragraphs = normalized.split("\n");
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) {
      continue;
    }
    let current = "";
    for (const char of para) {
      const candidate = current + char;
      if (current.length > 0 && measurer.measure(candidate, fontSize) > TEXT_MAX_WIDTH) {
        lines.push(current);
        current = char === " " ? "" : char;
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [content];
}

function truncateQuoteLines(
  lines: string[],
  maxLines: number,
  fontSize: number,
  measurer: QuoteCardTextMeasurer
): string[] {
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1] ?? "";
  while (last.length > 0 && measurer.measure(`${last}…`, fontSize) > TEXT_MAX_WIDTH) {
    last = last.slice(0, -1);
  }
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/**
 * 金句正文布局：字号从 21px 逐级降到 14px，取第一档能塞进正文区的；
 * 14px 仍超高则按行数截断并补省略号。返回值全部是标称单位。
 */
export function layoutQuoteCardText(
  content: string,
  measurer?: QuoteCardTextMeasurer | null
): QuoteCardTextLayout {
  const measure = measurer ?? createApproximateMeasurer();
  const lineHeightRatio = LINE_HEIGHT_RATIO;
  let fontSize = BASE_FONT_SIZE;
  let lines: string[] = [];

  for (; fontSize >= MIN_FONT_SIZE; fontSize -= FONT_STEP) {
    lines = wrapQuoteText(content, fontSize, measure);
    if (lines.length * fontSize * lineHeightRatio <= TEXT_AREA_HEIGHT + 0.01) {
      break;
    }
  }

  fontSize = Math.max(MIN_FONT_SIZE, fontSize);
  const lineHeight = fontSize * lineHeightRatio;
  const maxLines = Math.max(1, Math.min(MAX_LINES, Math.floor((TEXT_AREA_HEIGHT + 0.01) / lineHeight)));
  let truncated = false;

  if (lines.length > maxLines) {
    lines = truncateQuoteLines(lines, maxLines, fontSize, measure);
    truncated = true;
  }

  return {
    fontSize,
    lineHeight,
    lines,
    textLeft: TEXT_INSET_X,
    textTop: TEXT_INSET_TOP + (TEXT_AREA_HEIGHT - lines.length * lineHeight) / 2,
    textWidth: TEXT_MAX_WIDTH,
    truncated
  };
}

/**
 * 连续圆角曲线的超椭圆指数 K，与样式令牌
 * `--biliscript-primitive-corner-shape-continuous` 的 `superellipse(K)` 同值。
 * 导出图与 DOM 预览卡的角部曲率必须一致，改一处必须同改另一处。
 */
const CORNER_SUPERELLIPSE_K = 1.25;

/**
 * 在 Canvas 2D 上绘制连续圆角（超椭圆 x^(2K) + y^(2K) = r^(2K)，
 * 对应 CSS corner-shape: superellipse(K)）闭合矩形路径。
 */
function traceContinuousCornerRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  stepsPerCorner = 24
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const exponent = 1 / (2 * CORNER_SUPERELLIPSE_K);
  const superellipseCoord = (t: number): { dx: number; dy: number } => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return {
      dx: Math.sign(c) * Math.pow(Math.abs(c), exponent) * r,
      dy: Math.sign(s) * Math.pow(Math.abs(s), exponent) * r
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

// ===== 导出画布（标称单位绘制，整体放大约 2.94 倍）=====
// 相纸：纯白满版，左右/上留白 2.4%、底栏 8%（承载品牌角标）。
const CANONICAL_SHEET_WIDTH = QUOTE_CARD_CANONICAL_WIDTH / (1 - 0.048);
const CANONICAL_SHEET_SIDE = CANONICAL_SHEET_WIDTH * 0.024;
const CANONICAL_SHEET_BAND = CANONICAL_SHEET_WIDTH * 0.08;
const CANONICAL_SHEET_HEIGHT =
  CANONICAL_SHEET_SIDE + QUOTE_CARD_CANONICAL_HEIGHT + CANONICAL_SHEET_BAND;

/** 导出内卡宽：固定 1200，成品约 1261×806，不随预览窗口变化。 */
const EXPORT_CARD_WIDTH = 1200;
const EXPORT_SCALE = EXPORT_CARD_WIDTH / QUOTE_CARD_CANONICAL_WIDTH;

const CARD_RADIUS = 20;
const QUOTE_MARK_SIZE = 34;
const QUOTE_MARK_LEFT = 36;
const QUOTE_MARK_CENTER_Y = 42;
const BRAND_FONT_SIZE = 11;
const MOTIF_HEIGHT = 5;
const MOTIF_LEAD_WIDTH = 16;
const MOTIF_TRACK_WIDTH = 36;
const MOTIF_GAP = 5.5;
const MOTIF_LEAD_COLOR = "#e04a75";
const MOTIF_TRACK_COLOR = "#e9ebef";

/** 底栏左侧双段标记：短玫红 + 长灰，与品牌角标同处底栏中线上。 */
function drawQuoteCardMotif(ctx: CanvasRenderingContext2D): void {
  const centerY = CANONICAL_SHEET_SIDE + QUOTE_CARD_CANONICAL_HEIGHT + CANONICAL_SHEET_BAND / 2;
  const bars: Array<[x: number, width: number, color: string]> = [
    [CANONICAL_SHEET_SIDE, MOTIF_LEAD_WIDTH, MOTIF_LEAD_COLOR],
    [CANONICAL_SHEET_SIDE + MOTIF_LEAD_WIDTH + MOTIF_GAP, MOTIF_TRACK_WIDTH, MOTIF_TRACK_COLOR]
  ];
  ctx.save();
  for (const [x, width, color] of bars) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, centerY - MOTIF_HEIGHT / 2, width, MOTIF_HEIGHT, MOTIF_HEIGHT / 2);
    } else {
      ctx.rect(x, centerY - MOTIF_HEIGHT / 2, width, MOTIF_HEIGHT);
    }
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

/**
 * 离屏渲染分享卡至高分辨率 Canvas：白边相纸 + 16:9 内卡 + 品牌角标。
 * 全部坐标与字号走标称单位，靠 ctx.scale 放大——预览与成图共用同一份版式。
 */
async function renderQuoteCardToCanvas(
  options: QuoteCardExportOptions
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(CANONICAL_SHEET_WIDTH * EXPORT_SCALE);
  canvas.height = Math.round(CANONICAL_SHEET_HEIGHT * EXPORT_SCALE);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

  // 0. 纯白相纸（顺带盖住取整后的画布余量，成品不留透明边）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width / EXPORT_SCALE, canvas.height / EXPORT_SCALE);

  const cardX = CANONICAL_SHEET_SIDE;
  const cardY = CANONICAL_SHEET_SIDE;
  const cardW = QUOTE_CARD_CANONICAL_WIDTH;
  const cardH = QUOTE_CARD_CANONICAL_HEIGHT;

  // 1. 16:9 内卡裁切路径（20px 连续圆角）
  ctx.save();
  ctx.beginPath();
  traceContinuousCornerRectPath(ctx, cardX, cardY, cardW, cardH, CARD_RADIUS);
  ctx.clip();

  // 2. 底层线性渐变（165deg）
  const presetDef =
    (options.preset ? PRESET_BY_ID.get(options.preset) : undefined) ?? QUOTE_CARD_PRESETS[0];

  const angleRad = (presetDef.base.angleDeg * Math.PI) / 180;
  const len = Math.abs(cardW * Math.sin(angleRad)) + Math.abs(cardH * Math.cos(angleRad));
  const dx = (len / 2) * Math.sin(angleRad);
  const dy = -(len / 2) * Math.cos(angleRad);
  const centerX = cardX + cardW / 2;
  const centerY = cardY + cardH / 2;

  const linearGrad = ctx.createLinearGradient(centerX - dx, centerY - dy, centerX + dx, centerY + dy);
  presetDef.base.stops.forEach((stop) => {
    linearGrad.addColorStop(stop.offset, stop.color);
  });
  ctx.fillStyle = linearGrad;
  ctx.fillRect(cardX, cardY, cardW, cardH);

  // 3. 叠加 4 个大径向色团
  for (const blob of presetDef.blobs) {
    const blobX = cardX + blob.cxRatio * cardW;
    const blobY = cardY + blob.cyRatio * cardH;
    const r = blob.rRatio * Math.max(cardW, cardH);
    const radGrad = ctx.createRadialGradient(blobX, blobY, 0, blobX, blobY, r);
    radGrad.addColorStop(0, blob.color);
    radGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = radGrad;
    ctx.fillRect(cardX, cardY, cardW, cardH);
  }

  // 4. 几何细线纹样层与径向中心遮罩
  const patternId = options.pattern ?? "none";
  if (patternId !== "none") {
    const svgContent = getQuoteSharePatternSvg(patternId);
    if (svgContent) {
      const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
      const patternImg = await loadImageFromDataUrl(svgDataUrl);
      if (patternImg) {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = Math.round(cardW * EXPORT_SCALE);
        tempCanvas.height = Math.round(cardH * EXPORT_SCALE);
        const tempCtx = tempCanvas.getContext("2d");

        if (tempCtx) {
          tempCtx.scale(EXPORT_SCALE, EXPORT_SCALE);
          tempCtx.drawImage(patternImg, 0, 0, cardW, cardH);

          tempCtx.globalCompositeOperation = "destination-out";
          const maskGrad = tempCtx.createRadialGradient(
            cardW / 2,
            cardH / 2,
            0,
            cardW / 2,
            cardH / 2,
            Math.max(cardW, cardH) * 0.52
          );
          maskGrad.addColorStop(0, "rgba(0, 0, 0, 1)");
          maskGrad.addColorStop(0.45, "rgba(0, 0, 0, 1)");
          maskGrad.addColorStop(0.75, "rgba(0, 0, 0, 0.6)");
          maskGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
          tempCtx.fillStyle = maskGrad;
          tempCtx.fillRect(0, 0, cardW, cardH);

          ctx.save();
          ctx.globalAlpha = 0.38;
          ctx.drawImage(tempCanvas, cardX, cardY, cardW, cardH);
          ctx.restore();
        }
      }
    }
  }

  // 5. 灰度物理噪点平铺层（图案按设备像素平铺，避免被放大变换拉糊）
  const noiseUrl = getQuoteShareNoiseDataUrl(EXPORT_SCALE);
  const noiseImg = await loadImageFromDataUrl(noiseUrl);
  if (noiseImg) {
    try {
      const noisePattern = ctx.createPattern(noiseImg, "repeat");
      if (noisePattern) {
        ctx.save();
        ctx.globalCompositeOperation = "overlay";
        ctx.globalAlpha = 0.06;
        ctx.scale(1 / EXPORT_SCALE, 1 / EXPORT_SCALE);
        ctx.fillStyle = noisePattern;
        ctx.fillRect(cardX * EXPORT_SCALE, cardY * EXPORT_SCALE, cardW * EXPORT_SCALE, cardH * EXPORT_SCALE);
        ctx.restore();
      }
    } catch {
      // 忽略 pattern 创建异常
    }
  }

  // 6. 中性暗罩：与预览同参数，压住浅段渐变保证白字可读
  ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
  ctx.fillRect(cardX, cardY, cardW, cardH);

  // 7. 引号装饰
  ctx.save();
  ctx.font = `${QUOTE_MARK_SIZE}px Georgia, "Times New Roman", serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("“", cardX + QUOTE_MARK_LEFT, cardY + QUOTE_MARK_CENTER_Y);
  ctx.restore();

  // 8. 金句正文：折行与字号档位来自共享布局，预览与成图逐行一致
  const layout = layoutQuoteCardText(options.content, createQuoteCardTextMeasurer(ctx));
  ctx.save();
  ctx.font = `${QUOTE_CARD_TEXT_WEIGHT} ${layout.fontSize}px ${QUOTE_CARD_FONT_SERIF}`;
  const textCtx = ctx as CanvasRenderingContext2D & { fontVariantNumeric: string };
  textCtx.fontVariantNumeric = "lining-nums";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  layout.lines.forEach((line, index) => {
    ctx.fillText(
      line,
      cardX + layout.textLeft,
      cardY + layout.textTop + layout.lineHeight / 2 + index * layout.lineHeight
    );
  });
  ctx.restore();

  // 9. 卡片内侧 0.5px 精细描边（与圆角同心）
  ctx.save();
  ctx.beginPath();
  traceContinuousCornerRectPath(ctx, cardX + 0.25, cardY + 0.25, cardW - 0.5, cardH - 0.5, CARD_RADIUS - 0.25);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.12)";
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.restore();

  ctx.restore();

  // 10. 相纸底栏品牌角标
  ctx.save();
  ctx.font = `600 ${BRAND_FONT_SIZE}px ${QUOTE_CARD_FONT_SANS}`;
  try {
    if ("letterSpacing" in ctx) {
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${(
        -BRAND_FONT_SIZE * 0.01
      ).toFixed(2)}px`;
    }
  } catch {
    // 引擎不支持字距时按默认间距绘制
  }
  ctx.fillStyle = "#17181a";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(
    "BiliScript",
    CANONICAL_SHEET_WIDTH - CANONICAL_SHEET_SIDE,
    CANONICAL_SHEET_HEIGHT - CANONICAL_SHEET_BAND / 2
  );
  ctx.restore();

  // 11. 底栏左侧双段标记
  drawQuoteCardMotif(ctx);

  // 12. 相纸边缘 1px 发丝线（与预览的 inset 阴影同观感，白底信息流里也有边界）
  ctx.save();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.06)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, CANONICAL_SHEET_WIDTH - 1, CANONICAL_SHEET_HEIGHT - 1);
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
