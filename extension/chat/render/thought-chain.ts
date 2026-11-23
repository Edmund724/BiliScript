import { getActiveReaderDocument } from "../../shared/active-host.js";
import { resolveNodeDocument } from "../../shared/cross-doc.js";
import { READING_CHEVRON_DOWN_ICON } from "../../ui/reading-icons.js";
import { formatClock } from "../../shared/clock-text.js";
import { createChatImageViewButton, type ChatImageViewer } from "../chat-image-viewer.js";
import type { ChatToolStatusEvent } from "../protocol.js";
import type { ChatSearchSource, HistorySearchTurn } from "../search-sources.js";
import type { SourcePreviewController } from "./source-preview.js";
import type { ThinkingBufferController } from "./thinking-buffer.js";

const THINKING_ICON_SVG =
  '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.2l1.84 4.96 4.96 1.84-4.96 1.84L12 18.8l-1.84-4.96L5.2 12l4.96-1.84L12 5.2z"/></svg>';

function createChevronSpan(
  className: string,
  doc: Document = getActiveReaderDocument()
): HTMLSpanElement {
  const chevron = doc.createElement("span");
  chevron.className = className;
  chevron.innerHTML = READING_CHEVRON_DOWN_ICON.trim();
  return chevron;
}

export type ThoughtStatus = "searching" | "done" | "failed" | "cancelled";
export type ThoughtStepKind = "read_subtitles" | "capture_video_frame_at_time" | "web_search" | "thinking";

export interface ThoughtStepState {
  row: HTMLElement;
  callId?: string;
  kind: ThoughtStepKind;
  status: ThoughtStatus;
  titleEl: HTMLElement;
  detailEl: HTMLElement;
  noteEl: HTMLElement;
  bodyEl: HTMLElement;
  frameCount: number;
  expectedFrameCount: number;
  resultCount?: number;
  startTime?: number;
  elapsedMs?: number;
  implicit?: boolean;
}

export interface ThoughtChainState {
  root: HTMLDivElement;
  headBtn: HTMLButtonElement;
  summaryEl: HTMLElement;
  stepsEl: HTMLElement;
  innerEl: HTMLElement;
  announcerEl: HTMLElement;
  steps: ThoughtStepState[];
  sourcesWrap: HTMLElement | null;
  sources: ChatSearchSource[];
  status: ThoughtStatus;
  collapsed: boolean;
  userToggled: boolean;
  stoppedWithoutBody: boolean;
  citedSubtitleCount: number;
  activeThinkingStep: ThoughtStepState | null;
  thinkingElapsedMs: number | null;
}

export interface ThoughtChainDeps {
  messages: HTMLElement;
  imageViewer: ChatImageViewer;
  thinkingBuffer: ThinkingBufferController;
  sourcePreview: SourcePreviewController;
}

export type TerminalThinkingFallbackOptions =
  | { mode: "message"; citedSubtitleCount: number; thinking?: string }
  | { mode: "stopped-without-body"; thinking?: string; createIfMissing: boolean }
  | { mode: "failed" };

export interface ThoughtChainController {
  getChain: (node: HTMLElement) => ThoughtChainState | null;
  setChain: (node: HTMLElement, chain: ThoughtChainState) => void;
  deleteChain: (node: HTMLElement) => void;
  clearSettled: (node: HTMLElement) => void;
  cancelChainThinkingFrames: (chain: ThoughtChainState) => void;
  setSubtitleContextCount: (node: HTMLElement, count: number) => void;
  flushPendingThinking: (node: HTMLElement) => void;
  cancelAllThinkingFrames: (node: HTMLElement) => void;
  collapseOnBodyStart: (node: HTMLDivElement) => void;
  appendThinkingStep: (node: HTMLDivElement | null, text: unknown, forceNewStep: boolean) => ThoughtStepState | null;
  applySearchStatus: (node: HTMLDivElement | null, msg: ChatToolStatusEvent) => void;
  settleTools: (node: HTMLDivElement | null, status: "failed" | "cancelled") => void;
  takeSearchSources: (node: HTMLDivElement | null) => ChatSearchSource[];
  clearThoughtChain: (node: HTMLDivElement | null) => void;
  attachHistorySearchToThoughtChain: (node: HTMLDivElement, turn: HistorySearchTurn) => void;
  applyTerminalThinkingFallback: (node: HTMLDivElement, opts: TerminalThinkingFallbackOptions) => HTMLDivElement | null;
}

function resolveToolKind(msg: ChatToolStatusEvent): Exclude<ThoughtStepKind, "thinking"> {
  if (msg.tool === "read_subtitles") {
    return "read_subtitles";
  }
  if (msg.tool === "capture_video_frame_at_time") {
    return "capture_video_frame_at_time";
  }
  return "web_search";
}

function formatVideoFrameTime(seconds: unknown): string {
  const formatted = formatClock(seconds, { hours: "auto" });
  return formatted.includes(":") && formatted.split(":").length === 2
    ? formatted.padStart(5, "0")
    : formatted;
}

function formatThinkingSeconds(elapsedMs: number): string {
  const clampedMs = Math.max(100, elapsedMs);
  return (clampedMs / 1000).toFixed(1);
}

function stepTitleByKind(kind: ThoughtStepKind): string {
  if (kind === "read_subtitles") return "读取字幕";
  if (kind === "capture_video_frame_at_time") return "采样关键帧";
  if (kind === "web_search") return "联网检索";
  return "深度思考";
}

function setThoughtChainCollapsed(chain: ThoughtChainState, collapsed: boolean): void {
  chain.collapsed = collapsed;
  chain.root.classList.toggle("chat-thought-chain-collapsed", collapsed);
  chain.root.classList.toggle("chat-thinking-collapsed", collapsed);
  chain.headBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function buildThoughtChainShell(
  opts: { collapsed?: boolean } = {},
  doc: Document = getActiveReaderDocument()
): ThoughtChainState {
  const collapsed = Boolean(opts.collapsed);
  const root = doc.createElement("div");
  root.className = [
    "chat-thought-chain",
    "chat-thinking",
    "chat-thinking-collapsible",
    ...(collapsed ? ["chat-thought-chain-collapsed", "chat-thinking-collapsed"] : [])
  ].join(" ");
  root.dataset.status = "searching";

  const headBtn = doc.createElement("button");
  headBtn.type = "button";
  headBtn.className = "chat-thought-chain-head chat-thinking-label";
  headBtn.disabled = false;
  headBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");

  const icon = doc.createElement("span");
  icon.className = "chat-thought-chain-icon chat-thinking-icon";
  icon.innerHTML = THINKING_ICON_SVG;

  const summaryEl = doc.createElement("span");
  summaryEl.className = "chat-thought-chain-summary chat-thinking-label-text";
  summaryEl.textContent = "思考过程";

  headBtn.append(icon, summaryEl, createChevronSpan("chat-thought-chain-chevron chat-thinking-chevron", doc));

  const body = doc.createElement("div");
  body.className = "chat-thought-chain-body";
  const innerEl = doc.createElement("div");
  innerEl.className = "chat-thought-chain-inner";
  const stepsEl = doc.createElement("div");
  stepsEl.className = "chat-thought-chain-steps";
  innerEl.appendChild(stepsEl);
  body.appendChild(innerEl);

  const announcerEl = doc.createElement("div");
  announcerEl.className = "chat-search-announcer";
  announcerEl.setAttribute("role", "status");
  announcerEl.setAttribute("aria-live", "polite");
  announcerEl.setAttribute("aria-atomic", "true");

  root.append(headBtn, body, announcerEl);

  const chain: ThoughtChainState = {
    root,
    headBtn,
    summaryEl,
    stepsEl,
    innerEl,
    announcerEl,
    steps: [],
    sourcesWrap: null,
    sources: [],
    status: "searching",
    collapsed,
    userToggled: false,
    stoppedWithoutBody: false,
    citedSubtitleCount: 0,
    activeThinkingStep: null,
    thinkingElapsedMs: null
  };

  headBtn.addEventListener("click", () => {
    chain.userToggled = true;
    setThoughtChainCollapsed(chain, !chain.collapsed);
  });

  return chain;
}

function createThoughtStep(
  kind: ThoughtStepKind,
  detail: string,
  noteText: string,
  status: ThoughtStatus,
  opts: { callId?: string; implicit?: boolean; thinkingText?: string; doc?: Document } = {}
): ThoughtStepState {
  const doc = opts.doc ?? getActiveReaderDocument();
  const row = doc.createElement("div");
  row.className = [
    "chat-thought-step",
    status === "searching"
      ? "is-running"
      : status === "failed"
        ? "is-failed"
        : status === "cancelled"
          ? "is-cancelled"
          : "is-done"
  ].join(" ");
  row.dataset.stepKind = kind;

  const dot = doc.createElement("span");
  dot.className = "chat-thought-step-dot";

  const main = doc.createElement("div");
  main.className = "chat-thought-step-main";

  const line = doc.createElement("div");
  line.className = "chat-thought-step-row";

  const titleEl = doc.createElement("span");
  titleEl.className = "chat-thought-step-title";
  titleEl.textContent = stepTitleByKind(kind);

  const detailEl = doc.createElement("span");
  detailEl.className = "chat-thought-step-detail";
  detailEl.textContent = detail;

  const noteEl = doc.createElement("span");
  noteEl.className = "chat-thought-step-meta";
  noteEl.textContent = noteText;

  line.append(titleEl, detailEl, noteEl);
  main.appendChild(line);

  const bodyEl = doc.createElement("div");
  if (kind === "thinking") {
    bodyEl.className = "chat-thinking-text";
    if (opts.thinkingText) {
      bodyEl.textContent = opts.thinkingText;
    }
    main.appendChild(bodyEl);
  } else {
    bodyEl.className = "chat-thought-step-body";
    main.appendChild(bodyEl);
  }

  row.append(dot, main);

  return {
    row,
    callId: opts.callId,
    kind,
    status,
    titleEl,
    detailEl,
    noteEl,
    bodyEl,
    frameCount: 0,
    expectedFrameCount: 3,
    implicit: opts.implicit
  };
}

function applyStepStatus(step: ThoughtStepState, status: ThoughtStatus, noteText: string): void {
  step.status = status;
  step.row.classList.remove("is-running", "is-done", "is-failed", "is-cancelled");
  step.row.classList.add(
    status === "searching"
      ? "is-running"
      : status === "failed"
        ? "is-failed"
        : status === "cancelled"
          ? "is-cancelled"
          : "is-done"
  );
  step.noteEl.textContent = noteText;
}

function syncThoughtChainStatus(chain: ThoughtChainState): void {
  const running = chain.steps.filter((step) => step.status === "searching");
  if (running.length > 0) {
    chain.status = "searching";
  } else if (chain.steps.some((step) => step.status === "failed")) {
    chain.status = "failed";
  } else if (chain.steps.length > 0 && chain.steps.every((step) => step.status === "cancelled")) {
    chain.status = "cancelled";
  } else if (chain.steps.some((step) => step.status === "cancelled") && !chain.steps.some((step) => step.kind === "thinking" && step.status === "done")) {
    const lastStep = chain.steps[chain.steps.length - 1];
    chain.status = lastStep?.status ?? "done";
  } else {
    chain.status = "done";
  }
  chain.root.dataset.status = chain.status;
}

function updateThoughtChainHeader(chain: ThoughtChainState): void {
  syncThoughtChainStatus(chain);
  const running = chain.steps.filter((step) => step.status === "searching");
  if (running.length > 0) {
    const current = running[running.length - 1];
    const detail = current.detailEl.textContent?.trim() || "";
    if (current.kind === "read_subtitles") {
      chain.summaryEl.textContent = detail ? `读取字幕 · ${detail}…` : "读取字幕中…";
    } else if (current.kind === "capture_video_frame_at_time") {
      chain.summaryEl.textContent = detail ? `采样关键帧 · ${detail}…` : "采样关键帧中…";
    } else if (current.kind === "web_search") {
      chain.summaryEl.textContent = detail ? `联网检索 · ${detail}…` : "联网检索中…";
    } else {
      chain.summaryEl.textContent = "深度思考中…";
    }
    return;
  }

  if (chain.stoppedWithoutBody) {
    chain.summaryEl.textContent = "已停止";
    return;
  }

  const parts: string[] = [];
  const hasThinking = chain.steps.some((step) => step.kind === "thinking");
  if (hasThinking) {
    if (chain.thinkingElapsedMs !== null) {
      const secs = formatThinkingSeconds(chain.thinkingElapsedMs);
      parts.push(`已思考 <span class="chat-thinking-duration-num">${secs}</span>s`);
    } else {
      parts.push("思考过程");
    }
  }

  const frameSteps = chain.steps.filter((step) => step.kind === "capture_video_frame_at_time");
  if (frameSteps.length > 0) {
    const totalFrames = frameSteps.reduce((sum, step) => sum + step.frameCount, 0);
    if (totalFrames > 0) {
      parts.push(`采样 ${totalFrames} 张画面`);
    } else if (frameSteps.some((step) => step.status === "failed")) {
      parts.push("未取到画面");
    } else if (frameSteps.some((step) => step.status === "cancelled")) {
      parts.push("已取消");
    }
  }

  const searchSteps = chain.steps.filter((step) => step.kind === "web_search");
  if (searchSteps.length > 0) {
    if (chain.sources.length > 0) {
      parts.push(`联网检索 ${chain.sources.length} 条`);
    } else if (searchSteps.some((step) => step.status === "failed")) {
      parts.push("搜索失败");
    } else if (searchSteps.some((step) => step.status === "cancelled")) {
      parts.push("已取消");
    } else {
      parts.push("联网检索 0 条");
    }
  }

  const explicitSubtitleSteps = chain.steps.filter((step) => step.kind === "read_subtitles" && !step.implicit);
  if (chain.citedSubtitleCount > 0) {
    parts.push(`参考 ${chain.citedSubtitleCount} 处字幕`);
  } else if (explicitSubtitleSteps.length > 0) {
    const doneCount = explicitSubtitleSteps.reduce((sum, step) => sum + (step.resultCount ?? 0), 0);
    if (doneCount > 0) {
      parts.push(`参考 ${doneCount} 处字幕`);
    } else if (explicitSubtitleSteps.some((step) => step.status === "failed")) {
      parts.push("字幕读取失败");
    } else if (explicitSubtitleSteps.some((step) => step.status === "cancelled")) {
      parts.push("已取消");
    } else if (parts.length === 0) {
      parts.push("已读取字幕");
    }
  }

  if (parts.length === 0) {
    chain.summaryEl.textContent = "思考过程";
  } else if (hasThinking && chain.thinkingElapsedMs !== null) {
    chain.summaryEl.innerHTML = parts.join(" · ");
  } else {
    chain.summaryEl.textContent = parts.join(" · ");
  }
}

function announceToolTerminal(
  chain: ThoughtChainState,
  step: ThoughtStepState,
  status: Exclude<ThoughtStatus, "searching">
): void {
  const isFrame = step.kind === "capture_video_frame_at_time";
  const isSubtitle = step.kind === "read_subtitles";
  const missing = Math.max(0, step.expectedFrameCount - step.frameCount);
  const text = status === "done"
    ? isFrame
      ? `已获取 ${step.frameCount} 张画面${missing ? `，缺失 ${missing} 张` : ""}`
      : isSubtitle
        ? typeof step.resultCount === "number" ? `已读取 ${step.resultCount} 处字幕` : "字幕读取完成"
        : `搜索完成，共 ${chain.sources.length} 条来源`
    : status === "failed"
      ? isFrame
        ? "未取到画面，已按文字继续"
        : isSubtitle
          ? "字幕读取失败"
          : "搜索失败"
      : isFrame
        ? "画面截取已取消"
        : isSubtitle
          ? "字幕读取已取消"
          : "搜索已取消";
  chain.announcerEl.setAttribute("role", status === "failed" ? "alert" : "status");
  chain.announcerEl.setAttribute("aria-live", status === "failed" ? "assertive" : "polite");
  chain.announcerEl.textContent = text;
}

export function createThoughtChainController(deps: ThoughtChainDeps): ThoughtChainController {
  const thoughtChainStates = new WeakMap<HTMLElement, ThoughtChainState>();
  const subtitleContextCounts = new WeakMap<HTMLElement, number>();
  const settledSearchTurns = new WeakSet<HTMLElement>();

  function getChain(node: HTMLElement): ThoughtChainState | null {
    return thoughtChainStates.get(node) ?? null;
  }

  function setChain(node: HTMLElement, chain: ThoughtChainState): void {
    thoughtChainStates.set(node, chain);
  }

  function deleteChain(node: HTMLElement): void {
    thoughtChainStates.delete(node);
  }

  function clearSettled(node: HTMLElement): void {
    settledSearchTurns.delete(node);
  }

  function cancelChainThinkingFrames(chain: ThoughtChainState): void {
    for (const step of chain.steps) {
      if (step.kind === "thinking") {
        deps.thinkingBuffer.cancelFrame(step.bodyEl);
      }
    }
  }

  function setSubtitleContextCount(node: HTMLElement, count: number): void {
    if (Number.isFinite(count) && count > 0) {
      subtitleContextCounts.set(node, Math.floor(count));
    } else {
      subtitleContextCounts.delete(node);
    }
  }

  function flushPendingThinking(node: HTMLElement): void {
    const chain = thoughtChainStates.get(node);
    if (!chain) {
      return;
    }
    for (const step of chain.steps) {
      if (step.kind === "thinking") {
        deps.thinkingBuffer.flushNode(step.bodyEl);
      }
    }
  }

  function cancelAllThinkingFrames(node: HTMLElement): void {
    const chain = thoughtChainStates.get(node);
    if (chain) {
      cancelChainThinkingFrames(chain);
    }
  }

  function ensureImplicitSubtitleStep(node: HTMLElement, chain: ThoughtChainState, incomingKind: ThoughtStepKind): void {
    if (incomingKind === "read_subtitles") {
      return;
    }
    const subtitleCount = subtitleContextCounts.get(node) ?? 0;
    if (subtitleCount <= 0) {
      return;
    }
    if (chain.steps.some((step) => step.kind === "read_subtitles")) {
      return;
    }
    const step = createThoughtStep("read_subtitles", `共 ${subtitleCount} 条字幕`, "已完成", "done", {
      implicit: true,
      doc: resolveNodeDocument(node),
    });
    chain.steps.unshift(step);
    chain.stepsEl.prepend(step.row);
  }

  function ensureThoughtChain(node: HTMLDivElement, opts: { collapsed?: boolean } = {}): ThoughtChainState {
    let chain = thoughtChainStates.get(node);
    if (!chain) {
      chain = buildThoughtChainShell({ collapsed: opts.collapsed ?? false }, resolveNodeDocument(node));
      thoughtChainStates.set(node, chain);
      node.prepend(chain.root);
    } else if (!chain.root.parentNode) {
      node.prepend(chain.root);
    }
    return chain;
  }

  function settleThoughtChainThinking(chain: ThoughtChainState, opts: { stopped?: boolean } = {}): void {
    let settledAny = false;
    for (const step of chain.steps) {
      if (step.kind !== "thinking") {
        continue;
      }
      deps.thinkingBuffer.flushNode(step.bodyEl);
      if (step.status === "searching") {
        settledAny = true;
        if (opts.stopped) {
          applyStepStatus(step, "cancelled", "已停止");
        } else {
          const elapsed =
            typeof step.startTime === "number" ? Math.max(0, Date.now() - step.startTime) : 0;
          step.elapsedMs = elapsed;
          chain.thinkingElapsedMs = (chain.thinkingElapsedMs ?? 0) + elapsed;
          applyStepStatus(step, "done", `${formatThinkingSeconds(elapsed)}s`);
        }
      }
    }
    chain.activeThinkingStep = null;
    if (settledAny) {
      updateThoughtChainHeader(chain);
    }
  }

  function collapseOnBodyStart(node: HTMLDivElement): void {
    const chain = thoughtChainStates.get(node);
    if (!chain) {
      return;
    }
    const hadRunningThinking = chain.steps.some((step) => step.kind === "thinking" && step.status === "searching");
    if (!hadRunningThinking) {
      return;
    }
    settleThoughtChainThinking(chain);
    if (!chain.steps.some((step) => step.status === "searching")) {
      setThoughtChainCollapsed(chain, true);
    }
  }

  function appendThinkingStep(node: HTMLDivElement | null, text: unknown, forceNewStep: boolean): ThoughtStepState | null {
    if (!node) {
      return null;
    }
    const chain = ensureThoughtChain(node, { collapsed: false });
    ensureImplicitSubtitleStep(node, chain, "thinking");
    let step = forceNewStep ? null : chain.activeThinkingStep;
    if (!step) {
      step = createThoughtStep("thinking", "", "思考中…", "searching", {
        doc: resolveNodeDocument(node),
      });
      step.startTime = Date.now();
      chain.steps.push(step);
      chain.stepsEl.appendChild(step.row);
      chain.activeThinkingStep = step;
      if (!chain.userToggled) {
        setThoughtChainCollapsed(chain, false);
      }
      updateThoughtChainHeader(chain);
    }
    deps.thinkingBuffer.append(step.bodyEl, text);
    return step;
  }

  function appendSourceList(
    chain: ThoughtChainState,
    sources: ChatSearchSource[],
    opts: { paid?: boolean; notice?: string } = {}
  ): void {
    if (!sources.length && !opts.notice) {
      return;
    }
    const doc = resolveNodeDocument(chain.innerEl);
    if (!chain.sourcesWrap) {
      chain.sourcesWrap = doc.createElement("div");
      chain.sourcesWrap.className = "chat-search-sources";
      chain.sourcesWrap.addEventListener("scroll", () => deps.sourcePreview.hide(), { passive: true });
      chain.innerEl.appendChild(chain.sourcesWrap);
    }
    if (opts.notice && !chain.sourcesWrap.querySelector(".chat-search-sources-notice")) {
      const notice = doc.createElement("div");
      notice.className = "chat-search-sources-notice";
      notice.textContent = opts.notice;
      chain.sourcesWrap.appendChild(notice);
    }
    for (const source of sources) {
      const index = chain.sources.length + 1;
      const marked = opts.paid ? ({ ...source, paid: true } as ChatSearchSource) : source;
      chain.sources.push(marked);
      const row = doc.createElement("button");
      row.type = "button";
      row.className = "chat-search-source-row";
      row.setAttribute("title", source.url || source.title);
      const idx = doc.createElement("span");
      idx.className = "chat-search-source-idx";
      idx.textContent = String(index);
      const title = doc.createElement("span");
      title.className = "chat-search-source-title";
      title.textContent = source.title || source.url;
      row.append(idx, title);
      if (marked.paid) {
        const badge = doc.createElement("span");
        badge.className = "chat-search-source-paid";
        badge.textContent = "付费";
        row.appendChild(badge);
      }
      row.addEventListener("click", () => {
        deps.sourcePreview.openUrl(source.url);
      });
      deps.sourcePreview.bindAnchor(row, source);
      chain.sourcesWrap.appendChild(row);
    }
  }

  function appendVideoFrameList(step: ThoughtStepState, msg: ChatToolStatusEvent): void {
    const frames = Array.isArray(msg.frames) ? msg.frames.slice(0, 3) : [];
    step.frameCount = typeof msg.resultCount === "number" ? msg.resultCount : frames.length;
    step.expectedFrameCount = msg.expectedCount ?? 3;
    if (!frames.length) {
      return;
    }
    const doc = resolveNodeDocument(step.bodyEl);
    const list = doc.createElement("div");
    list.className = "chat-video-frame-results";
    step.bodyEl.appendChild(list);
    for (const frame of frames) {
      const time = formatVideoFrameTime(frame.currentTime);
      const item = doc.createElement("div");
      item.className = "chat-video-frame-item";
      const button = createChatImageViewButton(frame.image, deps.imageViewer, `视频在 ${time} 的实际画面`);
      button.setAttribute("aria-label", `查看 ${time} 的实际画面`);
      button.title = `查看 ${time} 的实际画面`;
      const caption = doc.createElement("span");
      caption.className = "chat-video-frame-time";
      caption.textContent = time;
      item.append(button, caption);
      list.appendChild(item);
    }
  }

  function applySearchStatus(node: HTMLDivElement | null, msg: ChatToolStatusEvent): void {
    if (!node || !node.parentNode || settledSearchTurns.has(node)) {
      return;
    }
    const kind = resolveToolKind(msg);
    const chain = ensureThoughtChain(node, { collapsed: false });
    ensureImplicitSubtitleStep(node, chain, kind);

    const target = kind === "capture_video_frame_at_time" ? formatVideoFrameTime(msg.targetTime) : "";
    const detailText =
      kind === "capture_video_frame_at_time"
        ? `${target} 附近`
        : String(msg.query || "");

    if (msg.status === "searching") {
      const implicitSub =
        kind === "read_subtitles"
          ? chain.steps.find((candidate) => candidate.kind === "read_subtitles" && candidate.implicit)
          : undefined;
      if (implicitSub) {
        implicitSub.implicit = false;
        implicitSub.callId = msg.callId;
        implicitSub.detailEl.textContent = detailText;
        applyStepStatus(implicitSub, "searching", "读取中…");
        chain.announcerEl.textContent = "";
        updateThoughtChainHeader(chain);
        return;
      }
      const existing = msg.callId ? chain.steps.find((candidate) => candidate.callId === msg.callId) : undefined;
      if (existing) {
        return;
      }
      const runningMeta =
        kind === "capture_video_frame_at_time"
          ? "截取中…"
          : kind === "read_subtitles"
            ? "读取中…"
            : "搜索中…";
      const step = createThoughtStep(kind, detailText, runningMeta, "searching", {
        callId: msg.callId,
        doc: resolveNodeDocument(node),
      });
      chain.steps.push(step);
      chain.stepsEl.appendChild(step.row);
      chain.announcerEl.textContent = "";
      if (!chain.userToggled) {
        setThoughtChainCollapsed(chain, false);
      }
      updateThoughtChainHeader(chain);
      return;
    }

    let step = msg.callId
      ? chain.steps.find((candidate) => candidate.callId === msg.callId)
      : [...chain.steps].reverse().find((candidate) => candidate.kind === kind && candidate.status === "searching");

    if (!step && kind === "read_subtitles") {
      const implicitSub = chain.steps.find((candidate) => candidate.kind === "read_subtitles" && candidate.implicit);
      if (implicitSub) {
        implicitSub.implicit = false;
        implicitSub.callId = msg.callId;
        implicitSub.detailEl.textContent = detailText;
        step = implicitSub;
      } else {
        step = createThoughtStep(kind, detailText, "", "searching", {
          callId: msg.callId,
          doc: resolveNodeDocument(node),
        });
        chain.steps.push(step);
        chain.stepsEl.appendChild(step.row);
      }
    }

    if (!step || step.status !== "searching") {
      return;
    }

    if (msg.status === "failed" || msg.status === "cancelled") {
      const failureText =
        kind === "capture_video_frame_at_time"
          ? "未取到画面，已按文字继续"
          : kind === "read_subtitles"
            ? "字幕读取失败"
            : "搜索失败";
      applyStepStatus(step, msg.status, msg.status === "failed" ? failureText : "已取消");
    } else if (kind === "capture_video_frame_at_time") {
      appendVideoFrameList(step, msg);
      const missing = Math.max(0, step.expectedFrameCount - step.frameCount);
      applyStepStatus(step, "done", `${step.frameCount} 张${missing ? `，缺失 ${missing} 张` : ""}`);
    } else if (kind === "read_subtitles") {
      step.resultCount = typeof msg.resultCount === "number" ? msg.resultCount : undefined;
      applyStepStatus(step, "done", typeof msg.resultCount === "number" ? `${msg.resultCount} 处` : "已完成");
    } else {
      const platform = String(msg.platform || "").trim();
      step.resultCount = typeof msg.resultCount === "number" ? msg.resultCount : undefined;
      applyStepStatus(
        step,
        "done",
        typeof msg.resultCount === "number" ? `${msg.resultCount} 条${platform ? ` · ${platform}` : ""}` : ""
      );
      if (Array.isArray(msg.sources) && (msg.sources.length || msg.paidFallbackNotice)) {
        appendSourceList(chain, msg.sources, { paid: msg.paid, notice: msg.paidFallbackNotice });
      }
    }

    const runningTools = chain.steps.filter((candidate) => candidate.kind !== "thinking" && candidate.status === "searching");
    updateThoughtChainHeader(chain);
    if (!runningTools.length) {
      announceToolTerminal(chain, step, msg.status);
    }
  }

  function settleTools(node: HTMLDivElement | null, status: "failed" | "cancelled"): void {
    if (!node) {
      return;
    }
    settledSearchTurns.add(node);
    deps.sourcePreview.hide();
    const chain = thoughtChainStates.get(node);
    if (!chain) {
      return;
    }
    const runningTools = chain.steps.filter((step) => step.kind !== "thinking" && step.status === "searching");
    if (!runningTools.length) {
      return;
    }
    for (const step of runningTools) {
      const failureText =
        step.kind === "capture_video_frame_at_time"
          ? "未取到画面，已按文字继续"
          : step.kind === "read_subtitles"
            ? "字幕读取失败"
            : "搜索失败";
      applyStepStatus(step, status, status === "failed" ? failureText : "已取消");
    }
    const latest = runningTools[runningTools.length - 1];
    updateThoughtChainHeader(chain);
    announceToolTerminal(chain, latest, status);
  }

  function takeSearchSources(node: HTMLDivElement | null): ChatSearchSource[] {
    if (!node) {
      return [];
    }
    deps.sourcePreview.hide();
    return thoughtChainStates.get(node)?.sources.slice() ?? [];
  }

  function clearThoughtChain(node: HTMLDivElement | null): void {
    if (!node) {
      return;
    }
    const chain = thoughtChainStates.get(node);
    if (chain) {
      cancelChainThinkingFrames(chain);
      chain.root.remove();
    }
    thoughtChainStates.delete(node);
    settledSearchTurns.delete(node);
    deps.sourcePreview.hide();
  }

  function attachHistorySearchToThoughtChain(node: HTMLDivElement, turn: HistorySearchTurn): void {
    const doc = resolveNodeDocument(node);
    const existing = thoughtChainStates.get(node);
    const chain = existing ?? buildThoughtChainShell({ collapsed: true }, doc);
    if (!existing) {
      thoughtChainStates.set(node, chain);
      const uniqueTs = new Set(
        Array.from(node.querySelectorAll<HTMLElement>(".chat-timestamp-link"))
          .map((el) => el.dataset.timestampSeconds)
          .filter(Boolean)
      );
      chain.citedSubtitleCount = uniqueTs.size;
      node.prepend(chain.root);
    }

    const searchRows: ThoughtStepState[] = turn.queries.map((query, i) =>
      createThoughtStep("web_search", query, `${turn.resultCounts[i] ?? 0} 条`, "done", { doc })
    );
    const firstThinking = chain.steps.find((step) => step.kind === "thinking");
    if (firstThinking) {
      const insertIdx = chain.steps.indexOf(firstThinking);
      chain.steps.splice(insertIdx, 0, ...searchRows);
      for (const row of searchRows) {
        chain.stepsEl.insertBefore(row.row, firstThinking.row);
      }
    } else {
      chain.steps.push(...searchRows);
      for (const row of searchRows) {
        chain.stepsEl.appendChild(row.row);
      }
    }
    appendSourceList(chain, turn.sources);
    setThoughtChainCollapsed(chain, true);
    updateThoughtChainHeader(chain);
  }

  function applyTerminalThinkingFallback(
    node: HTMLDivElement,
    opts: TerminalThinkingFallbackOptions
  ): HTMLDivElement | null {
    if (opts.mode === "message") {
      let chain = thoughtChainStates.get(node);
      if (chain) {
        chain.stoppedWithoutBody = false;
        settleThoughtChainThinking(chain);
        chain.citedSubtitleCount = opts.citedSubtitleCount;
        setThoughtChainCollapsed(chain, true);
        updateThoughtChainHeader(chain);
        return chain.root;
      }
      if (typeof opts.thinking === "string" && opts.thinking.trim()) {
        const doc = resolveNodeDocument(node);
        chain = buildThoughtChainShell({ collapsed: true }, doc);
        const step = createThoughtStep("thinking", "", "", "done", {
          thinkingText: opts.thinking,
          doc,
        });
        chain.steps.push(step);
        chain.stepsEl.appendChild(step.row);
        chain.citedSubtitleCount = opts.citedSubtitleCount;
        thoughtChainStates.set(node, chain);
        updateThoughtChainHeader(chain);
        return chain.root;
      }
      return null;
    }

    if (opts.mode === "stopped-without-body") {
      let chain = thoughtChainStates.get(node);
      if (opts.createIfMissing) {
        if (!chain && typeof opts.thinking === "string" && opts.thinking.trim()) {
          const doc = resolveNodeDocument(node);
          chain = buildThoughtChainShell({ collapsed: false }, doc);
          const step = createThoughtStep("thinking", "", "已停止", "cancelled", {
            thinkingText: opts.thinking,
            doc,
          });
          chain.steps.push(step);
          chain.stepsEl.appendChild(step.row);
          thoughtChainStates.set(node, chain);
        }
        if (!chain) {
          return null;
        }
      } else if (!chain || chain.steps.length === 0) {
        return null;
      }
      chain.stoppedWithoutBody = true;
      settleThoughtChainThinking(chain, { stopped: true });
      setThoughtChainCollapsed(chain, false);
      updateThoughtChainHeader(chain);
      return chain.root;
    }

    const chain = thoughtChainStates.get(node);
    const keepChain = Boolean(chain && chain.steps.some((step) => step.kind !== "thinking"));
    if (chain) {
      settleThoughtChainThinking(chain, { stopped: true });
      setThoughtChainCollapsed(chain, true);
      updateThoughtChainHeader(chain);
    }
    return keepChain && chain ? chain.root : null;
  }

  return {
    getChain,
    setChain,
    deleteChain,
    clearSettled,
    cancelChainThinkingFrames,
    setSubtitleContextCount,
    flushPendingThinking,
    cancelAllThinkingFrames,
    collapseOnBodyStart,
    appendThinkingStep,
    applySearchStatus,
    settleTools,
    takeSearchSources,
    clearThoughtChain,
    attachHistorySearchToThoughtChain,
    applyTerminalThinkingFallback
  };
}
