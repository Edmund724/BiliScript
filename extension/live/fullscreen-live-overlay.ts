// extension/live/fullscreen-live-overlay.ts
// 播放器全屏（浏览器全屏与网页全屏）右上角半透明实时伴看浮窗：
// 1. 头部状态胶囊（状态文本、麦克风 VAD 动效、点击结束伴看）
// 2. 音频快捷设置入口（静音、把视频声音也分享给 Agent、语音优先）
// 3. 最小化（-）与关闭隐藏（×）
// 4. 纯语音实时流式对话气泡（右侧绿色用户气泡、左侧 Agent 流式气泡）与「清空」按钮
// 5. 播放器容器内拖拽移动
// 6. 液体玻璃 12px 窄边缘 SVG 位移与三通道色散镜头（Chromium backdrop-filter url(#id)）

import type { LiveChatController, LiveChatState } from "./live-chat-controller.js";
import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";

const LENS_CORNER_RADIUS = 14;
const LENS_MAX_EDGE = 12;
const LENS_MIN_SURFACE_SIZE = 32;

interface CachedLensMap {
  dataUrl: string;
  scale: number;
}

const lensMapCache = new Map<string, CachedLensMap>();
let lensInstanceSeq = 0;

function supportsBackdropSvgLens(): boolean {
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

function buildLensDisplacementMap(width: number, height: number, radius: number, edge: number): CachedLensMap | null {
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

export interface FullscreenLiveOverlayDeps {
  getPlayerHost: () => HTMLElement | null;
  getLiveController: () => LiveChatController | null;
  getChatHistory?: () => Array<{ role: string; content: string }>;
  onStopLive?: () => void;
  onClearHistory?: () => Promise<void> | void;
}

export interface FullscreenLiveOverlay {
  show(options?: { forceExpand?: boolean }): void;
  hide(): void;
  toggle(): void;
  restore(): void;
  isVisible(): boolean;
  isMinimized(): boolean;
  syncState(state?: LiveChatState, reconnecting?: boolean): void;
  updateVad(active: boolean): void;
  updateTranscript(event: MossLiveTranscriptEvent): void;
  clearMessages(): void;
  getElement(): HTMLElement | null;
  getMiniCapsuleElement(): HTMLElement | null;
  dispose(): void;
}

export function createFullscreenLiveOverlay(deps: FullscreenLiveOverlayDeps): FullscreenLiveOverlay {
  let rootEl: HTMLElement | null = null;
  let statusCapsuleEl: HTMLButtonElement | null = null;
  let statusDotEl: HTMLElement | null = null;
  let statusTextEl: HTMLElement | null = null;
  let audioBtnEl: HTMLButtonElement | null = null;
  let audioPopEl: HTMLElement | null = null;
  let muteSwitchEl: HTMLButtonElement | null = null;
  let shareAudioSwitchEl: HTMLButtonElement | null = null;
  let voicePrioritySwitchEl: HTMLButtonElement | null = null;
  let minBtnEl: HTMLButtonElement | null = null;
  let closeBtnEl: HTMLButtonElement | null = null;
  let bodyEl: HTMLElement | null = null;
  let messagesEl: HTMLElement | null = null;
  let clearBtnEl: HTMLButtonElement | null = null;
  let scrollBottomBtnEl: HTMLButtonElement | null = null;

  let miniCapsuleEl: HTMLElement | null = null;
  let miniCapsuleDotEl: HTMLElement | null = null;

  let isMin = false;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  let isCapsuleDragging = false;
  let capsuleDragStartX = 0;
  let capsuleDragStartY = 0;
  let capsuleInitialLeft = 0;
  let capsuleInitialTop = 0;
  let capsuleMoved = false;

  const SCROLL_THRESHOLD = 60;
  let isScrolledToBottom = true;

  // 活跃转写气泡记录
  let pendingUserBubble: HTMLElement | null = null;
  let currentAssistantBubble: HTMLElement | null = null;
  let currentAssistantRunId: string | null = null;
  let currentAssistantTurnId: string | null = null;

  // 液体玻璃边缘镜头状态
  const lensFilterId = `biliscript-live-glass-lens-${++lensInstanceSeq}`;
  let lensSvgEl: SVGSVGElement | null = null;
  let lensResizeObserver: ResizeObserver | null = null;
  let lastLensSizeKey = "";
  let lensUpdateSeq = 0;

  function ensureLensSvg(host: HTMLElement): SVGSVGElement | null {
    if (!supportsBackdropSvgLens()) {
      return null;
    }
    if (lensSvgEl && lensSvgEl.isConnected) {
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

  function syncEdgeLens(overlay: HTMLElement): void {
    if (!supportsBackdropSvgLens()) {
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const width = Math.round(rect.width) || (isMin ? 220 : 320);
    const height = Math.round(rect.height) || (isMin ? 46 : 240);

    // 跳过小于 32px 的表面
    if (width < LENS_MIN_SURFACE_SIZE || height < LENS_MIN_SURFACE_SIZE) {
      delete overlay.dataset.glassLens;
      return;
    }

    const edge = Math.max(4, Math.min(LENS_MAX_EDGE, Math.floor(Math.min(width, height) / 3.5)));
    const sizeKey = `${width}x${height}:e${edge}`;
    if (sizeKey === lastLensSizeKey && overlay.dataset.glassLens === "ready") {
      return;
    }

    const host = deps.getPlayerHost() || document.body;
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
      if (seq !== lensUpdateSeq || !rootEl || !lensSvgEl) {
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

      rootEl.style.setProperty("--biliscript-live-glass-lens", `url(#${lensFilterId})`);
      rootEl.dataset.glassLens = "ready";
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

  function observeOverlayResize(overlay: HTMLElement): void {
    if (lensResizeObserver || typeof ResizeObserver === "undefined" || !supportsBackdropSvgLens()) {
      return;
    }
    lensResizeObserver = new ResizeObserver(() => {
      if (rootEl && isVisible()) {
        syncEdgeLens(rootEl);
      }
    });
    lensResizeObserver.observe(overlay);
  }

  function ensureMounted(): HTMLElement {
    if (rootEl && rootEl.isConnected) {
      return rootEl;
    }

    const host = deps.getPlayerHost() || document.body;
    let existing = host.querySelector("#biliscript-fullscreen-live-overlay") as HTMLElement | null;
    let existingCapsule = host.querySelector(".biliscript-fullscreen-live-mini-capsule") as HTMLElement | null;
    if (existing) {
      rootEl = existing;
      miniCapsuleEl = existingCapsule;
      if (miniCapsuleEl) {
        miniCapsuleDotEl = miniCapsuleEl.querySelector(".live-overlay-status-dot");
      }
      bindDomReferences(rootEl);
      return rootEl;
    }

    const overlay = document.createElement("div");
    overlay.id = "biliscript-fullscreen-live-overlay";
    overlay.className = "biliscript-fullscreen-live-overlay";
    overlay.setAttribute("data-biliscript-extension-node", "fullscreen-live-overlay");
    overlay.innerHTML = `
      <div class="live-overlay-header">
        <button type="button" class="live-overlay-status-capsule" title="点击结束伴看" aria-label="点击结束伴看">
          <span class="live-overlay-status-dot"></span>
          <span class="live-overlay-status-text">正在陪看</span>
        </button>
        <div class="live-overlay-header-actions">
          <div class="live-overlay-audio-anchor">
            <button type="button" class="live-overlay-icon-btn live-overlay-audio-btn" title="音频设置" aria-label="音频设置">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              </svg>
            </button>
            <div class="live-overlay-audio-popover" hidden>
              <div class="live-overlay-pop-item">
                <span>麦克风</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-mute-switch" aria-label="切换麦克风静音"></button>
              </div>
              <div class="live-overlay-pop-item">
                <span>把视频声音也分享给 Agent</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-share-switch" aria-label="把视频声音也分享给 Agent"></button>
              </div>
              <div class="live-overlay-pop-item">
                <span>语音优先</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-priority-switch" aria-label="语音优先"></button>
              </div>
            </div>
          </div>
          <button type="button" class="live-overlay-icon-btn live-overlay-min-btn" title="最小化" aria-label="最小化">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button type="button" class="live-overlay-icon-btn live-overlay-close-btn" title="关闭伴看" aria-label="关闭伴看">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="live-overlay-body">
        <div class="live-overlay-messages"></div>
        <button type="button" class="live-overlay-scroll-bottom-btn" title="回到底部" aria-label="回到底部" hidden>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
        <div class="live-overlay-footer">
          <button type="button" class="live-overlay-clear-btn" title="清空对话" aria-label="清空对话">清空</button>
        </div>
      </div>
    `;

    const miniCapsule = document.createElement("div");
    miniCapsule.className = "biliscript-fullscreen-live-mini-capsule is-hidden";
    miniCapsule.setAttribute("role", "button");
    miniCapsule.setAttribute("tabindex", "0");
    miniCapsule.setAttribute("title", "点击还原伴看浮窗");
    miniCapsule.setAttribute("aria-label", "点击还原伴看浮窗");
    miniCapsule.hidden = true;
    miniCapsule.innerHTML = `
      <span class="live-overlay-status-dot"></span>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" x2="12" y1="19" y2="22"/>
      </svg>
    `;

    host.appendChild(overlay);
    host.appendChild(miniCapsule);
    rootEl = overlay;
    miniCapsuleEl = miniCapsule;
    miniCapsuleDotEl = miniCapsule.querySelector(".live-overlay-status-dot");

    bindDomReferences(overlay);
    bindEvents(overlay);
    bindCapsuleEvents(miniCapsule);
    observeOverlayResize(overlay);
    loadInitialHistory();
    return overlay;
  }

  function bindDomReferences(overlay: HTMLElement): void {
    statusCapsuleEl = overlay.querySelector(".live-overlay-status-capsule");
    statusDotEl = overlay.querySelector(".live-overlay-status-dot");
    statusTextEl = overlay.querySelector(".live-overlay-status-text");
    audioBtnEl = overlay.querySelector(".live-overlay-audio-btn");
    audioPopEl = overlay.querySelector(".live-overlay-audio-popover");
    muteSwitchEl = overlay.querySelector(".live-overlay-mute-switch");
    shareAudioSwitchEl = overlay.querySelector(".live-overlay-share-switch");
    voicePrioritySwitchEl = overlay.querySelector(".live-overlay-priority-switch");
    minBtnEl = overlay.querySelector(".live-overlay-min-btn");
    closeBtnEl = overlay.querySelector(".live-overlay-close-btn");
    bodyEl = overlay.querySelector(".live-overlay-body");
    messagesEl = overlay.querySelector(".live-overlay-messages");
    clearBtnEl = overlay.querySelector(".live-overlay-clear-btn");
    scrollBottomBtnEl = overlay.querySelector(".live-overlay-scroll-bottom-btn");
  }

  function updateScrollFollowState(): void {
    if (!messagesEl) return;
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    const atBottom = distFromBottom <= SCROLL_THRESHOLD;
    isScrolledToBottom = atBottom;
    if (scrollBottomBtnEl) {
      scrollBottomBtnEl.hidden = atBottom;
    }
  }

  function scrollToBottom(force = false): void {
    if (!messagesEl) return;
    if (force || isScrolledToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      isScrolledToBottom = true;
      if (scrollBottomBtnEl) {
        scrollBottomBtnEl.hidden = true;
      }
    }
  }

  function loadInitialHistory(): void {
    if (!messagesEl || !deps.getChatHistory) return;
    const history = deps.getChatHistory();
    messagesEl.innerHTML = "";
    if (Array.isArray(history)) {
      for (const item of history) {
        if (!item || !item.content) continue;
        const bubble = document.createElement("div");
        bubble.className =
          item.role === "user"
            ? "live-overlay-bubble live-overlay-bubble-user"
            : "live-overlay-bubble live-overlay-bubble-assistant";
        bubble.textContent = item.content;
        messagesEl.appendChild(bubble);
      }
      scrollToBottom(true);
    }
  }

  function bindEvents(overlay: HTMLElement): void {
    const header = overlay.querySelector(".live-overlay-header") as HTMLElement | null;

    // 拖拽逻辑
    if (header) {
      header.addEventListener("pointerdown", onDragStart);
    }

    // 头部胶囊点击：结束伴看
    statusCapsuleEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (deps.onStopLive) {
        deps.onStopLive();
      } else {
        void deps.getLiveController()?.stop();
      }
      hide();
    });

    // 音频设置菜单展示与切换
    audioBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!audioPopEl) return;
      const willOpen = audioPopEl.hidden;
      audioPopEl.hidden = !willOpen;
      if (rootEl) {
        if (willOpen) {
          rootEl.dataset.popoverOpen = "1";
        } else {
          delete rootEl.dataset.popoverOpen;
        }
      }
      if (willOpen) {
        syncAudioSwitches();
      }
    });

    audioPopEl?.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    muteSwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      controller?.toggleMute();
      syncAudioSwitches();
    });

    shareAudioSwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      if (controller) {
        controller.setShareVideoAudio(!controller.isSharingVideoAudio());
        syncAudioSwitches();
      }
    });

    voicePrioritySwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      if (controller) {
        controller.setVoicePriority(!controller.isVoicePriority());
        syncAudioSwitches();
      }
    });

    // 最小化按钮：收为右上角半透明微型胶囊
    minBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      minimize();
    });

    // 关闭按钮：彻底关闭伴看
    closeBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (deps.onStopLive) {
        deps.onStopLive();
      } else {
        void deps.getLiveController()?.stop();
      }
      hide();
    });

    // 滚动跟随监听与回底按键
    messagesEl?.addEventListener("scroll", updateScrollFollowState, { passive: true });
    scrollBottomBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (messagesEl && typeof messagesEl.scrollTo === "function") {
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
      } else if (messagesEl) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      isScrolledToBottom = true;
      if (scrollBottomBtnEl) {
        scrollBottomBtnEl.hidden = true;
      }
    });

    // 清空按钮
    clearBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      clearMessages();
      deps.getLiveController()?.resetMerger?.();
      if (deps.onClearHistory) {
        void deps.onClearHistory();
      }
    });
  }

  function bindCapsuleEvents(capsule: HTMLElement): void {
    capsule.addEventListener("pointerdown", onCapsuleDragStart);
    capsule.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        restore();
      }
    });
  }

  function syncAudioSwitches(): void {
    const controller = deps.getLiveController();
    if (!controller) return;

    if (muteSwitchEl) {
      const isMuted = controller.isMuted();
      muteSwitchEl.setAttribute("aria-checked", String(!isMuted));
      muteSwitchEl.classList.toggle("is-active", !isMuted);
    }
    if (shareAudioSwitchEl) {
      const share = controller.isSharingVideoAudio();
      shareAudioSwitchEl.setAttribute("aria-checked", String(share));
      shareAudioSwitchEl.classList.toggle("is-active", share);
    }
    if (voicePrioritySwitchEl) {
      const prio = controller.isVoicePriority();
      voicePrioritySwitchEl.setAttribute("aria-checked", String(prio));
      voicePrioritySwitchEl.classList.toggle("is-active", prio);
    }
  }

  function minimize(): void {
    isMin = true;
    if (rootEl) {
      rootEl.hidden = true;
      rootEl.classList.add("is-hidden");
      delete rootEl.dataset.popoverOpen;
    }
    if (audioPopEl) {
      audioPopEl.hidden = true;
    }
    if (miniCapsuleEl) {
      miniCapsuleEl.hidden = false;
      miniCapsuleEl.classList.remove("is-hidden");
    }
    syncState();
  }

  function restore(): void {
    isMin = false;
    if (miniCapsuleEl) {
      miniCapsuleEl.hidden = true;
      miniCapsuleEl.classList.add("is-hidden");
    }
    show({ forceExpand: true });
  }

  // 胶囊拖拽处理
  function onCapsuleDragStart(e: PointerEvent): void {
    if (!miniCapsuleEl) return;
    isCapsuleDragging = true;
    capsuleMoved = false;
    capsuleDragStartX = e.clientX;
    capsuleDragStartY = e.clientY;

    const rect = miniCapsuleEl.getBoundingClientRect();
    const host = deps.getPlayerHost() || document.body;
    const hostRect = host.getBoundingClientRect();

    capsuleInitialLeft = rect.left - hostRect.left;
    capsuleInitialTop = rect.top - hostRect.top;

    miniCapsuleEl.style.left = `${capsuleInitialLeft}px`;
    miniCapsuleEl.style.top = `${capsuleInitialTop}px`;
    miniCapsuleEl.style.right = "auto";
    miniCapsuleEl.style.bottom = "auto";

    window.addEventListener("pointermove", onCapsuleDragMove);
    window.addEventListener("pointerup", onCapsuleDragEnd);
  }

  function onCapsuleDragMove(e: PointerEvent): void {
    if (!isCapsuleDragging || !miniCapsuleEl) return;
    const deltaX = e.clientX - capsuleDragStartX;
    const deltaY = e.clientY - capsuleDragStartY;
    if (Math.hypot(deltaX, deltaY) > 4) {
      capsuleMoved = true;
    }

    const host = deps.getPlayerHost() || document.body;
    const hostRect = host.getBoundingClientRect();
    const rect = miniCapsuleEl.getBoundingClientRect();

    let nextLeft = capsuleInitialLeft + deltaX;
    let nextTop = capsuleInitialTop + deltaY;

    const maxLeft = Math.max(0, hostRect.width - rect.width);
    const maxTop = Math.max(0, hostRect.height - rect.height);

    nextLeft = Math.max(0, Math.min(nextLeft, maxLeft));
    nextTop = Math.max(0, Math.min(nextTop, maxTop));

    miniCapsuleEl.style.left = `${nextLeft}px`;
    miniCapsuleEl.style.top = `${nextTop}px`;
  }

  function onCapsuleDragEnd(): void {
    isCapsuleDragging = false;
    window.removeEventListener("pointermove", onCapsuleDragMove);
    window.removeEventListener("pointerup", onCapsuleDragEnd);
    if (!capsuleMoved) {
      restore();
    }
  }

  // 拖拽处理
  function onDragStart(e: PointerEvent): void {
    // 排除交互控件点击触发拖拽
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, [role='switch'], input, .live-overlay-audio-popover")) {
      return;
    }
    if (!rootEl) return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = rootEl.getBoundingClientRect();
    const host = deps.getPlayerHost() || document.body;
    const hostRect = host.getBoundingClientRect();

    initialLeft = rect.left - hostRect.left;
    initialTop = rect.top - hostRect.top;

    rootEl.style.left = `${initialLeft}px`;
    rootEl.style.top = `${initialTop}px`;
    rootEl.style.right = "auto";
    rootEl.style.bottom = "auto";

    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  }

  function onDragMove(e: PointerEvent): void {
    if (!isDragging || !rootEl) return;
    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    const host = deps.getPlayerHost() || document.body;
    const hostRect = host.getBoundingClientRect();
    const rect = rootEl.getBoundingClientRect();

    let nextLeft = initialLeft + deltaX;
    let nextTop = initialTop + deltaY;

    // 边界限制在播放器区域内
    const maxLeft = Math.max(0, hostRect.width - rect.width);
    const maxTop = Math.max(0, hostRect.height - rect.height);

    nextLeft = Math.max(0, Math.min(nextLeft, maxLeft));
    nextTop = Math.max(0, Math.min(nextTop, maxTop));

    rootEl.style.left = `${nextLeft}px`;
    rootEl.style.top = `${nextTop}px`;
  }

  function onDragEnd(): void {
    isDragging = false;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  }

  function show(options?: { forceExpand?: boolean }): void {
    const el = ensureMounted();
    if (options?.forceExpand) {
      isMin = false;
    }
    if (isMin) {
      el.hidden = true;
      el.classList.add("is-hidden");
      if (miniCapsuleEl) {
        miniCapsuleEl.hidden = false;
        miniCapsuleEl.classList.remove("is-hidden");
      }
    } else {
      el.hidden = false;
      el.classList.remove("is-hidden");
      if (miniCapsuleEl) {
        miniCapsuleEl.hidden = true;
        miniCapsuleEl.classList.add("is-hidden");
      }
      loadInitialHistory();
      syncEdgeLens(el);
    }
    syncState();
  }

  function hide(): void {
    if (rootEl) {
      rootEl.hidden = true;
      rootEl.classList.add("is-hidden");
      delete rootEl.dataset.popoverOpen;
    }
    if (miniCapsuleEl) {
      miniCapsuleEl.hidden = true;
      miniCapsuleEl.classList.add("is-hidden");
    }
    if (audioPopEl) {
      audioPopEl.hidden = true;
    }
    if (scrollBottomBtnEl) {
      scrollBottomBtnEl.hidden = true;
    }
  }

  function toggle(): void {
    if (isVisible()) {
      hide();
    } else {
      show();
    }
  }

  function isVisible(): boolean {
    return Boolean(rootEl && !rootEl.hidden && !rootEl.classList.contains("is-hidden"));
  }

  function isMinimized(): boolean {
    return isMin;
  }

  function syncState(customState?: LiveChatState, reconnecting?: boolean): void {
    if (!rootEl) return;
    const controller = deps.getLiveController();
    const state = customState ?? controller?.getState() ?? "idle";
    const isReconnecting = reconnecting ?? Boolean(controller?.isReconnecting?.());

    if (miniCapsuleDotEl) {
      miniCapsuleDotEl.className = "live-overlay-status-dot";
      if (isReconnecting) {
        miniCapsuleDotEl.classList.add("is-reconnecting");
      } else if (state === "connecting") {
        miniCapsuleDotEl.classList.add("is-connecting");
      } else if (state === "connected") {
        miniCapsuleDotEl.classList.add("is-connected");
      } else if (state === "failure") {
        miniCapsuleDotEl.classList.add("is-failure");
      }
    }

    if (!statusTextEl || !statusDotEl) return;

    statusDotEl.className = "live-overlay-status-dot";

    if (isReconnecting) {
      statusTextEl.textContent = "重连中...";
      statusDotEl.classList.add("is-reconnecting");
    } else if (state === "connecting") {
      statusTextEl.textContent = "连接中...";
      statusDotEl.classList.add("is-connecting");
    } else if (state === "connected") {
      statusTextEl.textContent = "正在陪看";
      statusDotEl.classList.add("is-connected");
    } else if (state === "failure") {
      statusTextEl.textContent = "连接异常";
      statusDotEl.classList.add("is-failure");
    } else {
      statusTextEl.textContent = "已就绪";
    }

    syncAudioSwitches();
  }

  function updateVad(active: boolean): void {
    if (statusCapsuleEl) {
      statusCapsuleEl.classList.toggle("is-talking", active);
    }
    if (statusDotEl) {
      statusDotEl.classList.toggle("is-talking", active);
    }
    if (miniCapsuleEl) {
      miniCapsuleEl.classList.toggle("is-talking", active);
    }
    if (miniCapsuleDotEl) {
      miniCapsuleDotEl.classList.toggle("is-talking", active);
    }
  }

  function canAcceptUserInputTranscript(): boolean {
    if (pendingUserBubble !== null) {
      return true;
    }
    const controller = deps.getLiveController();
    if (controller?.isVoiceRecentlyActive) {
      return controller.isVoiceRecentlyActive();
    }
    return true;
  }

  function updateTranscript(event: MossLiveTranscriptEvent): void {
    if (!messagesEl || !event) return;

    switch (event.kind) {
      case "input.updated": {
        if (!canAcceptUserInputTranscript()) return;
        const clean = String(event.text || "");
        if (!clean.trim() && !pendingUserBubble) return;
        if (!pendingUserBubble) {
          pendingUserBubble = document.createElement("div");
          pendingUserBubble.className = "live-overlay-bubble live-overlay-bubble-user is-pending";
          messagesEl.appendChild(pendingUserBubble);
        }
        pendingUserBubble.textContent = clean;
        scrollToBottom();
        break;
      }
      case "input.done": {
        if (!canAcceptUserInputTranscript()) return;
        const finalText = String(event.text || pendingUserBubble?.textContent || "").trim();
        if (!finalText) {
          pendingUserBubble?.remove();
          pendingUserBubble = null;
          return;
        }
        if (!pendingUserBubble) {
          pendingUserBubble = document.createElement("div");
          pendingUserBubble.className = "live-overlay-bubble live-overlay-bubble-user";
          messagesEl.appendChild(pendingUserBubble);
        }
        pendingUserBubble.textContent = finalText;
        pendingUserBubble.classList.remove("is-pending");
        pendingUserBubble = null;
        scrollToBottom();
        break;
      }
      case "output.updated": {
        const { runId, turnId, text } = event;
        if (
          !currentAssistantBubble ||
          currentAssistantRunId !== runId ||
          currentAssistantTurnId !== turnId
        ) {
          currentAssistantBubble = document.createElement("div");
          currentAssistantBubble.className =
            "live-overlay-bubble live-overlay-bubble-assistant is-streaming";
          messagesEl.appendChild(currentAssistantBubble);
          currentAssistantRunId = runId;
          currentAssistantTurnId = turnId;
        }
        currentAssistantBubble.textContent = text;
        scrollToBottom();
        break;
      }
      case "output.done": {
        if (currentAssistantBubble) {
          currentAssistantBubble.textContent = event.text;
          currentAssistantBubble.classList.remove("is-streaming");
        }
        currentAssistantBubble = null;
        currentAssistantRunId = null;
        currentAssistantTurnId = null;
        scrollToBottom();
        break;
      }
      case "response.interrupted":
      case "response.ended": {
        if (currentAssistantBubble) {
          currentAssistantBubble.classList.remove("is-streaming");
        }
        currentAssistantBubble = null;
        currentAssistantRunId = null;
        currentAssistantTurnId = null;
        break;
      }
    }
  }

  function clearMessages(): void {
    if (messagesEl) {
      messagesEl.innerHTML = "";
    }
    pendingUserBubble = null;
    currentAssistantBubble = null;
    currentAssistantRunId = null;
    currentAssistantTurnId = null;
  }

  function getElement(): HTMLElement | null {
    return rootEl;
  }

  function dispose(): void {
    onDragEnd();
    isCapsuleDragging = false;
    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", onCapsuleDragMove);
      window.removeEventListener("pointerup", onCapsuleDragEnd);
    }
    if (lensResizeObserver) {
      lensResizeObserver.disconnect();
      lensResizeObserver = null;
    }
    if (lensSvgEl) {
      lensSvgEl.remove();
      lensSvgEl = null;
    }
    if (miniCapsuleEl) {
      miniCapsuleEl.remove();
      miniCapsuleEl = null;
      miniCapsuleDotEl = null;
    }
    if (rootEl) {
      rootEl.remove();
      rootEl = null;
    }
    lastLensSizeKey = "";
    pendingUserBubble = null;
    currentAssistantBubble = null;
  }

  return {
    show,
    hide,
    toggle,
    restore,
    isVisible,
    isMinimized,
    syncState,
    updateVad,
    updateTranscript,
    clearMessages,
    getElement,
    getMiniCapsuleElement: () => miniCapsuleEl,
    dispose
  };
}
