// extension/reader/quote-share-patterns.ts
// 金句分享卡片轻量内联 SVG 细线几何纹样生成器。
//
// 规范：
// 1. 提供 5 款细线几何纹样（射线、同心等高线、声波线、点阵、透镜）及「无纹样」；
// 2. 线宽统一约束为 0.8px，默认透明度约 0.3；
// 3. 配合 CSS mask-image 径向遮罩，中心阅读区留白，边缘呈现细腻纹样。

export type QuotePatternId = "none" | "rays" | "contours" | "soundwaves" | "dots" | "lens";

export interface QuoteCardPattern {
  id: QuotePatternId;
  name: string;
}

export const QUOTE_CARD_PATTERNS: QuoteCardPattern[] = [
  { id: "none", name: "无纹样" },
  { id: "rays", name: "射线" },
  { id: "contours", name: "等高线" },
  { id: "soundwaves", name: "声波" },
  { id: "dots", name: "点阵" },
  { id: "lens", name: "透镜" }
];

const patternCache = new Map<QuotePatternId, string>();

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

/**
 * 清空纹样缓存（测试与重置使用）。
 */
export function clearQuoteSharePatternCache(): void {
  patternCache.clear();
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

/**
 * 1. 射线 (rays)：自卡片中心向外发散的多角度细线。
 */
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

/**
 * 2. 同心等高线 (contours)：有机波动闭合等高线环路。
 */
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

/**
 * 3. 声波线 (soundwaves)：水平层叠平滑声波谐波曲面。
 */
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

/**
 * 4. 点阵 (dots)：均匀分布的极细圆点矩阵。
 */
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

/**
 * 5. 透镜 (lens)：菲涅尔光学透镜同心环与正交轴线。
 */
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
