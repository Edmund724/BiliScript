// extension/reader/quote-share-noise.ts
// 离屏 Canvas 物理像素级灰度噪点生成器。
//
// 规范：
// 1. 128×128 逻辑像素网格，结合 window.devicePixelRatio 映射物理像素；
// 2. 随机物理灰度像素（R=G=B=val, A=255）；
// 3. 产出 base64 PNG dataURL，并在组件间内存按 dpr 缓存复用；
// 4. 在无 DOM / 无 Canvas 2D 上下文环境安全降级为 SVG 噪点，不抛出异常。

export const NOISE_BASE_SIZE = 128;

const noiseCache = new Map<number, string>();

/**
 * 获取当前 DPR 适配的 128×128 灰度噪点 base64 dataURL。
 * 命中缓存时直接复用，避免每次打开弹窗重复重绘 Canvas。
 */
export function getQuoteShareNoiseDataUrl(customDpr?: number): string {
  const dpr = typeof customDpr === "number" && customDpr > 0
    ? customDpr
    : (typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

  const cached = noiseCache.get(dpr);
  if (cached) {
    return cached;
  }

  const dataUrl = generateNoiseDataUrl(dpr);
  noiseCache.set(dpr, dataUrl);
  return dataUrl;
}

/**
 * 清空噪点内存缓存（测试与重置使用）。
 */
export function clearQuoteShareNoiseCache(): void {
  noiseCache.clear();
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
