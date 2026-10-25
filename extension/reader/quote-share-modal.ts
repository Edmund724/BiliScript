// extension/reader/quote-share-modal.ts
// 金句分享卡片预览模态弹窗、视差弹簧微动效与图片光栅化导出。

import { escapeHtml } from "../shared/string-utils.js";
import {
  READING_CLOSE_ICON,
  READING_COPY_ICON,
  READING_CHECK_ICON,
  READING_DOWNLOAD_ICON
} from "../ui/reading-icons.js";
import {
  QUOTE_CARD_PATTERNS,
  QUOTE_CARD_PRESETS,
  type QuoteCardExportOptions,
  type QuotePatternId,
  getQuoteShareNoiseDataUrl,
  getQuoteSharePatternSvg,
  renderQuoteCardBlob,
  copyQuoteCardBlobToClipboard,
  downloadQuoteCardBlob
} from "./quote-share-export.js";
import { ids } from "./state.js";

export interface OpenQuoteShareModalOptions {
  content: string;
  from?: number;
  videoTitle?: string;
  preset?: string;
  pattern?: QuotePatternId;
}

interface SpringPoint2D {
  x: number;
  y: number;
}

interface Spring2DInstance {
  setTarget(x: number, y: number): void;
  stop(): void;
}

interface QuoteShareModalState {
  open: boolean;
  content: string;
  videoTitle: string;
  activePreset: string;
  activePattern: QuotePatternId;
  host: HTMLElement | null;
  spring: Spring2DInstance | null;
  copying: boolean;
  downloading: boolean;
}

const state: QuoteShareModalState = {
  open: false,
  content: "",
  videoTitle: "",
  activePreset: "purple-gold",
  activePattern: "rays",
  host: null,
  spring: null,
  copying: false,
  downloading: false
};

/**
 * 计算欠阻尼/临界阻尼弹簧在 dt 秒步进后的解析解。
 */
function solveSpring1D(
  current: number,
  velocity: number,
  target: number,
  dt: number,
  stiffness = 70,
  dampingRatio = 0.86
): [newPos: number, newVel: number] {
  if (dt <= 0) {
    return [current, velocity];
  }

  const p0 = current - target;
  const v0 = velocity;
  const w0 = Math.sqrt(Math.max(0.0001, stiffness));
  const alpha = dampingRatio * w0;

  if (dampingRatio < 1) {
    const wd = w0 * Math.sqrt(1 - dampingRatio * dampingRatio);
    const decay = Math.exp(-alpha * dt);
    const cosVal = Math.cos(wd * dt);
    const sinVal = Math.sin(wd * dt);

    const b = (v0 + alpha * p0) / wd;
    const pNew = decay * (p0 * cosVal + b * sinVal);
    const vNew = -alpha * pNew + decay * (-p0 * wd * sinVal + (v0 + alpha * p0) * cosVal);

    return [target + pNew, vNew];
  }

  if (dampingRatio === 1) {
    const decay = Math.exp(-alpha * dt);
    const c1 = p0;
    const c2 = v0 + alpha * p0;
    const pNew = decay * (c1 + c2 * dt);
    const vNew = decay * (v0 - alpha * c2 * dt);
    return [target + pNew, vNew];
  }

  const w1 = w0 * Math.sqrt(dampingRatio * dampingRatio - 1);
  const r1 = -alpha + w1;
  const r2 = -alpha - w1;
  const c2 = (v0 - r1 * p0) / (r2 - r1);
  const c1 = p0 - c2;
  const pNew = c1 * Math.exp(r1 * dt) + c2 * Math.exp(r2 * dt);
  const vNew = c1 * r1 * Math.exp(r1 * dt) + c2 * r2 * Math.exp(r2 * dt);
  return [target + pNew, vNew];
}

function createSpring2D(options: {
  stiffness?: number;
  dampingRatio?: number;
  precision?: number;
  velocityPrecision?: number;
  onUpdate?: (pos: SpringPoint2D) => void;
}): Spring2DInstance {
  const stiffness = options.stiffness ?? 70;
  const dampingRatio = options.dampingRatio ?? 0.86;
  const precision = options.precision ?? 0.002;
  const velPrecision = options.velocityPrecision ?? 0.005;

  let currentX = 0;
  let currentY = 0;
  let targetX = 0;
  let targetY = 0;
  let velX = 0;
  let velY = 0;
  let settled = true;
  let rafId: number | null = null;
  let lastTimestamp = 0;

  function step(dt: number): void {
    if (settled) {
      return;
    }

    const safeDt = Math.max(0.001, Math.min(0.064, dt));
    const [nextX, nextVx] = solveSpring1D(currentX, velX, targetX, safeDt, stiffness, dampingRatio);
    const [nextY, nextVy] = solveSpring1D(currentY, velY, targetY, safeDt, stiffness, dampingRatio);

    currentX = nextX;
    velX = nextVx;
    currentY = nextY;
    velY = nextVy;

    const diffX = Math.abs(currentX - targetX);
    const diffY = Math.abs(currentY - targetY);
    const speedX = Math.abs(velX);
    const speedY = Math.abs(velY);

    if (diffX < precision && diffY < precision && speedX < velPrecision && speedY < velPrecision) {
      currentX = targetX;
      currentY = targetY;
      velX = 0;
      velY = 0;
      settled = true;
    }
  }

  function tick(timestamp: number): void {
    if (lastTimestamp === 0) {
      lastTimestamp = timestamp;
    }
    const dt = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    step(dt);
    options.onUpdate?.({ x: currentX, y: currentY });

    if (settled) {
      rafId = null;
      lastTimestamp = 0;
      return;
    }

    rafId = requestAnimationFrame(tick);
  }

  function setTarget(x: number, y: number): void {
    if (targetX === x && targetY === y) {
      return;
    }
    targetX = x;
    targetY = y;
    settled = false;
    if (rafId === null && typeof requestAnimationFrame === "function") {
      lastTimestamp = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  function stop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastTimestamp = 0;
  }

  return {
    setTarget,
    stop
  };
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isQuoteShareModalOpen(): boolean {
  return state.open;
}

function setActiveQuoteCardPreset(presetId: string): void {
  const matched = QUOTE_CARD_PRESETS.some((p) => p.id === presetId);
  if (!matched || state.activePreset === presetId) {
    return;
  }
  state.activePreset = presetId;
  updatePresetSelectionInDom(presetId);
}

function setActiveQuoteCardPattern(patternId: QuotePatternId): void {
  const matched = QUOTE_CARD_PATTERNS.some((p) => p.id === patternId);
  if (!matched || state.activePattern === patternId) {
    return;
  }
  state.activePattern = patternId;
  updatePatternSelectionInDom(patternId);
}

function updatePresetSelectionInDom(presetId: string): void {
  if (!state.host) {
    return;
  }
  const card = state.host.querySelector<HTMLElement>(".biliscript-quote-card");
  if (card) {
    card.dataset.preset = presetId;
  }
  const buttons = state.host.querySelectorAll<HTMLElement>("[data-preset]");
  buttons.forEach((btn) => {
    const isActive = btn.dataset.preset === presetId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function updatePatternSelectionInDom(patternId: QuotePatternId): void {
  if (!state.host) {
    return;
  }
  const card = state.host.querySelector<HTMLElement>(".biliscript-quote-card");
  if (card) {
    card.dataset.pattern = patternId;
  }
  const patternEl = state.host.querySelector<HTMLElement>(".biliscript-quote-card-pattern");
  if (patternEl) {
    patternEl.innerHTML = getQuoteSharePatternSvg(patternId);
  }
  const buttons = state.host.querySelectorAll<HTMLElement>("[data-pattern]");
  buttons.forEach((btn) => {
    const isActive = btn.dataset.pattern === patternId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

export function openQuoteShareModal(options: OpenQuoteShareModalOptions): void {
  closeQuoteShareModal();

  const content = String(options.content || "").trim();
  if (!content) {
    return;
  }

  state.open = true;
  state.content = content;
  state.videoTitle = String(options.videoTitle || "").trim();
  if (options.preset && QUOTE_CARD_PRESETS.some((p) => p.id === options.preset)) {
    state.activePreset = options.preset;
  } else {
    state.activePreset = "purple-gold";
  }
  if (options.pattern && QUOTE_CARD_PATTERNS.some((p) => p.id === options.pattern)) {
    state.activePattern = options.pattern;
  } else {
    state.activePattern = "rays";
  }

  const host = document.createElement("div");
  host.className = "biliscript-quote-share-host";
  host.innerHTML = buildModalHtml();

  bindModalEvents(host);
  setupMotionAndParallax(host);

  const container = document.getElementById(ids.readingView) || document.body;
  container.appendChild(host);
  state.host = host;

  document.addEventListener("keydown", onDocumentKeyDown, true);
}

export function closeQuoteShareModal(): void {
  if (!state.open && !state.host) {
    return;
  }
  state.open = false;
  state.copying = false;
  state.downloading = false;

  if (state.spring) {
    state.spring.stop();
    state.spring = null;
  }

  document.removeEventListener("keydown", onDocumentKeyDown, true);
  state.host?.remove();
  state.host = null;
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (!state.open || event.key !== "Escape") {
    return;
  }
  event.stopPropagation();
  closeQuoteShareModal();
}

function setupMotionAndParallax(host: HTMLElement): void {
  const card = host.querySelector<HTMLElement>(".biliscript-quote-card");
  if (!card) {
    return;
  }

  const spring = createSpring2D({
    stiffness: 70,
    dampingRatio: 0.86,
    onUpdate: ({ x, y }) => {
      card.style.setProperty("--quote-spring-x", x.toFixed(4));
      card.style.setProperty("--quote-spring-y", y.toFixed(4));
    }
  });
  state.spring = spring;

  card.addEventListener("mousemove", (event) => {
    if (prefersReducedMotion()) {
      return;
    }
    const rect = card.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const halfW = rect.width / 2 || 200;
    const halfH = rect.height / 2 || 150;
    const nx = Math.max(-1, Math.min(1, (x - halfW) / halfW));
    const ny = Math.max(-1, Math.min(1, (y - halfH) / halfH));

    card.style.setProperty("--quote-glow-x", `${x.toFixed(1)}px`);
    card.style.setProperty("--quote-glow-y", `${y.toFixed(1)}px`);
    card.classList.add("is-hovered");

    spring.setTarget(nx, ny);
  });

  card.addEventListener("mouseleave", () => {
    card.classList.remove("is-hovered");
    spring.setTarget(0, 0);
  });
}

function bindModalEvents(host: HTMLElement): void {
  host.addEventListener("click", async (event) => {
    event.stopPropagation();
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-action], [data-preset], [data-pattern]"
    );
    if (!target) {
      return;
    }
    const action = target.dataset.action;
    if (action === "close") {
      closeQuoteShareModal();
      return;
    }
    if (action === "copy-image") {
      const card = host.querySelector<HTMLElement>(".biliscript-quote-card");
      if (card && target instanceof HTMLButtonElement) {
        await handleCopyImageAction(target, card);
      }
      return;
    }
    if (action === "download-image") {
      const card = host.querySelector<HTMLElement>(".biliscript-quote-card");
      if (card && target instanceof HTMLButtonElement) {
        await handleDownloadImageAction(target, card);
      }
      return;
    }
    const preset = target.dataset.preset;
    if (preset) {
      setActiveQuoteCardPreset(preset);
      return;
    }
    const pattern = target.dataset.pattern as QuotePatternId | undefined;
    if (pattern) {
      setActiveQuoteCardPattern(pattern);
      return;
    }
  });
}

function buildExportOptions(card: HTMLElement): QuoteCardExportOptions {
  const rect = card.getBoundingClientRect();
  return {
    content: state.content,
    videoTitle: state.videoTitle || "BiliScript",
    preset: state.activePreset,
    pattern: state.activePattern,
    width: Math.round(rect.width) || 400,
    height: Math.round(rect.height) || 300
  };
}

interface AsyncButtonFeedbackOptions {
  btn: HTMLButtonElement;
  busyKey: "copying" | "downloading";
  loadingText: string;
  defaultIconHtml: string;
  action: () => Promise<boolean | void>;
  successText: string;
  failureText?: string;
  errorText: string;
  successDuration?: number;
  failureDuration?: number;
}

async function runAsyncButtonAction(options: AsyncButtonFeedbackOptions): Promise<void> {
  const {
    btn,
    busyKey,
    loadingText,
    defaultIconHtml,
    action,
    successText,
    failureText,
    errorText,
    successDuration = 1500,
    failureDuration = 2000
  } = options;

  if (state[busyKey]) {
    return;
  }
  state[busyKey] = true;

  const textEl = btn.querySelector<HTMLElement>(".biliscript-quote-action-text");
  const iconEl = btn.querySelector<HTMLElement>(".biliscript-quote-action-icon");
  const origText = textEl?.textContent || "";

  if (textEl) {
    textEl.textContent = loadingText;
  }
  btn.disabled = true;

  const resetState = (delay: number) => {
    setTimeout(() => {
      btn.classList.remove("is-success");
      if (textEl) {
        textEl.textContent = origText;
      }
      if (iconEl) {
        iconEl.innerHTML = defaultIconHtml;
      }
      btn.disabled = false;
      state[busyKey] = false;
    }, delay);
  };

  try {
    const result = await action();
    if (result !== false) {
      btn.classList.add("is-success");
      if (textEl) {
        textEl.textContent = successText;
      }
      if (iconEl) {
        iconEl.innerHTML = READING_CHECK_ICON;
      }
      resetState(successDuration);
    } else {
      if (textEl && failureText) {
        textEl.textContent = failureText;
      }
      resetState(failureDuration);
    }
  } catch {
    if (textEl) {
      textEl.textContent = errorText;
    }
    resetState(failureDuration);
  }
}

async function handleCopyImageAction(btn: HTMLButtonElement, card: HTMLElement): Promise<void> {
  await runAsyncButtonAction({
    btn,
    busyKey: "copying",
    loadingText: "生成中...",
    defaultIconHtml: READING_COPY_ICON,
    action: async () => {
      const blob = await renderQuoteCardBlob(buildExportOptions(card));
      return await copyQuoteCardBlobToClipboard(blob);
    },
    successText: "已复制 ✓",
    failureText: "复制失败，建议直接保存图片",
    errorText: "生成失败",
    successDuration: 2000,
    failureDuration: 2500
  });
}

async function handleDownloadImageAction(btn: HTMLButtonElement, card: HTMLElement): Promise<void> {
  await runAsyncButtonAction({
    btn,
    busyKey: "downloading",
    loadingText: "导出中...",
    defaultIconHtml: READING_DOWNLOAD_ICON,
    action: async () => {
      const blob = await renderQuoteCardBlob(buildExportOptions(card));
      const filename = `biliscript-quote-${Date.now()}.png`;
      downloadQuoteCardBlob(blob, filename);
    },
    successText: "已保存 ✓",
    errorText: "导出失败",
    successDuration: 1500,
    failureDuration: 2000
  });
}

function buildModalHtml(): string {
  const noiseUrl = getQuoteShareNoiseDataUrl();

  const presetsHtml = QUOTE_CARD_PRESETS.map((preset) => {
    const isActive = preset.id === state.activePreset;
    return `
      <button type="button" class="biliscript-quote-preset-btn${isActive ? " is-active" : ""}" data-preset="${preset.id}" aria-pressed="${isActive ? "true" : "false"}" title="${escapeHtml(preset.name)}">
        <span class="biliscript-quote-preset-dot" style="background: ${preset.dotColor};" aria-hidden="true"></span>
        <span>${escapeHtml(preset.name)}</span>
      </button>
    `;
  }).join("");

  const patternsHtml = QUOTE_CARD_PATTERNS.map((pattern) => {
    const isActive = pattern.id === state.activePattern;
    return `
      <button type="button" class="biliscript-quote-pattern-btn${isActive ? " is-active" : ""}" data-pattern="${pattern.id}" aria-pressed="${isActive ? "true" : "false"}" title="${escapeHtml(pattern.name)}">
        <span>${escapeHtml(pattern.name)}</span>
      </button>
    `;
  }).join("");

  return `
    <div class="biliscript-quote-share-mask" data-action="close"></div>
    <section class="biliscript-quote-share-dialog" role="dialog" aria-modal="true" aria-label="分享金句卡片" tabindex="-1">
      <header class="biliscript-quote-share-header">
        <h3 class="biliscript-quote-share-title">分享金句卡片</h3>
        <button type="button" class="biliscript-quote-share-close" data-action="close" aria-label="关闭" title="关闭">
          ${READING_CLOSE_ICON}
        </button>
      </header>
      <div class="biliscript-quote-share-presets" role="toolbar" aria-label="渐变配色切换">
        ${presetsHtml}
      </div>
      <div class="biliscript-quote-share-patterns" role="toolbar" aria-label="几何纹样切换">
        ${patternsHtml}
      </div>
      <div class="biliscript-quote-share-preview">
        <div class="biliscript-quote-card biliscript-quote-share-card" data-preset="${state.activePreset}" data-pattern="${state.activePattern}">
          <div class="biliscript-quote-card-bg">
            <div class="biliscript-quote-card-blobs-layer">
              <div class="biliscript-quote-card-blobs"></div>
            </div>
            <div class="biliscript-quote-card-pattern" aria-hidden="true">${getQuoteSharePatternSvg(state.activePattern)}</div>
            <div class="biliscript-quote-card-glow" aria-hidden="true"></div>
            <div class="biliscript-quote-card-noise" style="background-image: url('${noiseUrl}');"></div>
          </div>
          <div class="biliscript-quote-card-content">
            <div class="biliscript-quote-card-quote-mark" aria-hidden="true">“</div>
            <p class="biliscript-quote-card-text">${escapeHtml(state.content)}</p>
            <footer class="biliscript-quote-card-footer">
              <span class="biliscript-quote-card-source">${escapeHtml(state.videoTitle || "BiliScript")}</span>
            </footer>
          </div>
        </div>
      </div>
      <footer class="biliscript-quote-share-actions">
        <button type="button" class="biliscript-quote-action-btn biliscript-quote-copy-btn" data-action="copy-image" title="复制卡片图片到剪贴板">
          <span class="biliscript-quote-action-icon">${READING_COPY_ICON}</span>
          <span class="biliscript-quote-action-text">复制图片</span>
        </button>
        <button type="button" class="biliscript-quote-action-btn biliscript-quote-download-btn is-primary" data-action="download-image" title="保存卡片为 PNG 图片">
          <span class="biliscript-quote-action-icon">${READING_DOWNLOAD_ICON}</span>
          <span class="biliscript-quote-action-text">保存 PNG</span>
        </button>
      </footer>
    </section>
  `;
}
