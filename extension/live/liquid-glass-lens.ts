// extension/live/liquid-glass-lens.ts
// 液态玻璃 12px 窄边缘 SVG 位移贴图缓存与三通道色散滤镜生命周期（Chromium backdrop-filter url(#id)）

export const LENS_CORNER_RADIUS = 14;
export const LENS_MAX_EDGE = 12;
export const LENS_MIN_SURFACE_SIZE = 32;

export interface CachedLensMap {
  dataUrl: string;
  scale: number;
}

const lensMapCache = new Map<string, CachedLensMap>();
let lensInstanceSeq = 0;

export function supportsBackdropSvgLens(): boolean {
  if (typeof window === "undefined" || typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Firefox\/|jsdom\//i.test(ua)) {
    return false;
  }
  if (window.matchMedia?.("(prefers-reduced-transparency: reduce)")?.matches) {
    return false;
  }
  return CSS.supports("backdrop-filter", "url(#a)") || CSS.supports("-webkit-backdrop-filter", "url(#a)");
}

export function buildLensDisplacementMap(
  width: number,
  height: number,
  radius: number,
  edge: number
): CachedLensMap | null {
  const key = `${width}x${height}:r${radius}:e${edge}`;
  const cached = lensMapCache.get(key);
  if (cached) {
    return cached;
  }
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) {
    return null;
  }

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;
  const halfW = width / 2;
  const halfH = height / 2;
  const r = Math.min(radius, halfW, halfH);
  const bx = Math.max(0, halfW - r);
  const by = Math.max(0, halfH - r);
  const maxOffset = 1.1 * edge;
  const scale = 2 * maxOffset;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5 - halfH;
    const absPy = Math.abs(py);
    const qy = absPy - by;
    const signY = py < 0 ? -1 : 1;

    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const px = x + 0.5 - halfW;
      const absPx = Math.abs(px);
      const qx = absPx - bx;
      const signX = px < 0 ? -1 : 1;

      const outX = Math.max(qx, 0);
      const outY = Math.max(qy, 0);
      const outLen = Math.hypot(outX, outY);
      const sdf = outLen + Math.min(Math.max(qx, qy), 0) - r;
      const d = -sdf;

      if (d <= 0 || d >= edge) {
        data[idx] = 128;
        data[idx + 1] = 128;
        data[idx + 2] = 128;
        data[idx + 3] = 255;
        continue;
      }

      let nx = 0;
      let ny = 0;
      if (outLen > 1e-4) {
        nx = signX * (outX / outLen);
        ny = signY * (outY / outLen);
      } else if (qx > qy) {
        nx = signX;
      } else {
        ny = signY;
      }

      // 距离边缘 d 处的向内折返偏移量：1.1 × edge × (1 - d / edge)^2.6
      const offset = maxOffset * Math.pow(1 - d / edge, 2.6);
      const dx = -nx * offset;
      const dy = -ny * offset;

      data[idx] = Math.max(0, Math.min(255, Math.round(128 + (dx / maxOffset) * 127)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + (dy / maxOffset) * 127)));
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  const entry: CachedLensMap = { dataUrl, scale };
  if (lensMapCache.size >= 24) {
    const oldestKey = lensMapCache.keys().next().value;
    if (oldestKey !== undefined) {
      lensMapCache.delete(oldestKey);
    }
  }
  lensMapCache.set(key, entry);
  return entry;
}

export interface LiquidGlassLensDeps {
  getMountHost: () => HTMLElement;
  isMinimized: () => boolean;
  isVisible: () => boolean;
}

export interface LiquidGlassLens {
  sync(overlay: HTMLElement): void;
  observeResize(overlay: HTMLElement): void;
  dispose(): void;
}

export function createLiquidGlassLens(deps: LiquidGlassLensDeps): LiquidGlassLens {
  const lensFilterId = `biliscript-live-glass-lens-${++lensInstanceSeq}`;
  let lensSvgEl: SVGSVGElement | null = null;
  let lensResizeObserver: ResizeObserver | null = null;
  let observedOverlay: HTMLElement | null = null;
  let lastLensSizeKey = "";
  let lensUpdateSeq = 0;

  function ensureLensSvg(host: HTMLElement): SVGSVGElement | null {
    if (!supportsBackdropSvgLens()) {
      return null;
    }
    if (lensSvgEl && lensSvgEl.isConnected) {
      if (lensSvgEl.parentElement !== host) {
        host.appendChild(lensSvgEl);
      }
      return lensSvgEl;
    }
    const existingSvg = host.querySelector(`svg[data-biliscript-lens-for="${lensFilterId}"]`) as SVGSVGElement | null;
    if (existingSvg) {
      lensSvgEl = existingSvg;
      return lensSvgEl;
    }

    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("data-biliscript-lens-for", lensFilterId);
    svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none;overflow:hidden";
    svg.innerHTML = `
      <defs>
        <filter id="${lensFilterId}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feImage class="live-glass-lens-feimage" x="0" y="0" width="320" height="240" preserveAspectRatio="none" result="dispMap" />
          <feDisplacementMap class="live-glass-lens-disp-r" in="SourceGraphic" in2="dispMap" scale="24" xChannelSelector="R" yChannelSelector="G" result="rawR" />
          <feColorMatrix in="rawR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="chR" />
          <feDisplacementMap class="live-glass-lens-disp-g" in="SourceGraphic" in2="dispMap" scale="21" xChannelSelector="R" yChannelSelector="G" result="rawG" />
          <feColorMatrix in="rawG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="chG" />
          <feDisplacementMap class="live-glass-lens-disp-b" in="SourceGraphic" in2="dispMap" scale="18" xChannelSelector="R" yChannelSelector="G" result="rawB" />
          <feColorMatrix in="rawB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="chB" />
          <feBlend in="chR" in2="chG" mode="screen" result="chRG" />
          <feBlend in="chRG" in2="chB" mode="screen" result="blended" />
        </filter>
      </defs>
    `;
    host.appendChild(svg);
    lensSvgEl = svg;
    return svg;
  }

  function sync(overlay: HTMLElement): void {
    if (!supportsBackdropSvgLens()) {
      return;
    }
    const isMin = deps.isMinimized();
    const rect = overlay.getBoundingClientRect();
    const width = Math.round(rect.width) || (isMin ? 220 : 320);
    const height = Math.round(rect.height) || (isMin ? 46 : 240);

    if (width < LENS_MIN_SURFACE_SIZE || height < LENS_MIN_SURFACE_SIZE) {
      delete overlay.dataset.glassLens;
      return;
    }

    const edge = Math.max(4, Math.min(LENS_MAX_EDGE, Math.floor(Math.min(width, height) / 3.5)));
    const sizeKey = `${width}x${height}:e${edge}`;
    if (sizeKey === lastLensSizeKey && overlay.dataset.glassLens === "ready") {
      return;
    }

    const host = deps.getMountHost();
    const svg = ensureLensSvg(host);
    if (!svg) {
      return;
    }

    const mapped = buildLensDisplacementMap(width, height, LENS_CORNER_RADIUS, edge);
    if (!mapped) {
      return;
    }

    lastLensSizeKey = sizeKey;
    const seq = ++lensUpdateSeq;

    const applyDecodedMap = () => {
      if (seq !== lensUpdateSeq || !overlay.isConnected || !lensSvgEl) {
        return;
      }
      const feImg = lensSvgEl.querySelector(".live-glass-lens-feimage");
      const dispR = lensSvgEl.querySelector(".live-glass-lens-disp-r");
      const dispG = lensSvgEl.querySelector(".live-glass-lens-disp-g");
      const dispB = lensSvgEl.querySelector(".live-glass-lens-disp-b");

      if (feImg) {
        feImg.setAttribute("width", String(width));
        feImg.setAttribute("height", String(height));
        feImg.setAttribute("href", mapped.dataUrl);
      }
      // 三遍色散处理：红色偏移 +15%，绿色基准，蓝色偏移 -15%
      dispR?.setAttribute("scale", (mapped.scale * 1.15).toFixed(2));
      dispG?.setAttribute("scale", mapped.scale.toFixed(2));
      dispB?.setAttribute("scale", (mapped.scale * 0.85).toFixed(2));

      overlay.style.setProperty("--biliscript-live-glass-lens", `url(#${lensFilterId})`);
      overlay.dataset.glassLens = "ready";
    };

    if (typeof Image !== "undefined") {
      const img = new Image();
      img.src = mapped.dataUrl;
      if (typeof img.decode === "function") {
        img.decode().then(applyDecodedMap, applyDecodedMap);
        return;
      }
    }
    applyDecodedMap();
  }

  function observeResize(overlay: HTMLElement): void {
    observedOverlay = overlay;
    if (lensResizeObserver || typeof ResizeObserver === "undefined" || !supportsBackdropSvgLens()) {
      return;
    }
    lensResizeObserver = new ResizeObserver(() => {
      if (observedOverlay && deps.isVisible()) {
        sync(observedOverlay);
      }
    });
    lensResizeObserver.observe(overlay);
  }

  function dispose(): void {
    lensUpdateSeq += 1;
    if (lensResizeObserver) {
      lensResizeObserver.disconnect();
      lensResizeObserver = null;
    }
    if (lensSvgEl) {
      lensSvgEl.remove();
      lensSvgEl = null;
    }
    observedOverlay = null;
    lastLensSizeKey = "";
  }

  return {
    sync,
    observeResize,
    dispose
  };
}
