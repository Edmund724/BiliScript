import type { ImagePart } from "../../ai/types.js";
import type { NoteExportTarget } from "../../core/defaults.js";
import { state } from "../../core/state.js";
import { normalizeNoteExportTarget } from "../../core/validators.js";
import { getActiveReaderDocument } from "../../shared/active-host.js";
import {
  resolveNodeDocument,
  resolveNodeWindow,
  writeActiveClipboardText,
} from "../../shared/cross-doc.js";
import { getErrorMessage } from "../../shared/error-helpers.js";
import { supportsTtsSpeech } from "../../shared/runtime-capabilities.js";
import { flashCopyFailure, flashCopySuccess } from "../../ui/copy-feedback.js";
import { hydrateMarkdownContent, renderMarkdownStripped, stripThinkBlocks } from "../../ui/markdown.js";
import {
  READING_COPY_ICON,
  READING_NOTE_DOWNLOAD_ICON,
  READING_NOTE_OBSIDIAN_ICON,
  READING_PLAY_ICON,
  READING_RESET_ICON,
  READING_SPEAKER_ICON
} from "../../ui/reading-icons.js";
import { linkifyAssistantTimestamps, type TimestampNavDeps } from "../../ui/timestamp-nav.js";
import { createChatImageViewButton, type ChatImageViewer } from "../chat-image-viewer.js";
import type { ChatSearchSource } from "../search-sources.js";
import type { SourcePreviewController } from "./source-preview.js";
import type { ThoughtChainController } from "./thought-chain.js";
import { CHAT_MARKDOWN_OPTIONS, type TokenStreamController } from "./token-stream.js";

export type MessageSource = "live" | "replay";

export interface SaveNoteActionResult {
  ok: boolean;
  error?: string;
  label?: string;
}

export interface SaveNoteActionVisual {
  target: NoteExportTarget;
  icon: string;
  label: string;
  successLabel: string;
  failedLabel: string;
}

export function getSaveNoteActionVisual(target?: unknown): SaveNoteActionVisual {
  const normalized = normalizeNoteExportTarget(target);
  if (normalized === "obsidian") {
    return {
      target: "obsidian",
      icon: READING_NOTE_OBSIDIAN_ICON,
      label: "存入 Obsidian",
      successLabel: "已唤起 Obsidian",
      failedLabel: "写入失败"
    };
  }
  return {
    target: "download",
    icon: READING_NOTE_DOWNLOAD_ICON,
    label: "导出视频笔记（.md）",
    successLabel: "已导出笔记",
    failedLabel: "导出失败"
  };
}

export function syncSaveNoteButtons(container: ParentNode | null | undefined, target?: unknown): void {
  if (!container) {
    return;
  }
  const visual = getSaveNoteActionVisual(target ?? state.settings?.noteExportTarget);
  container.querySelectorAll<HTMLButtonElement>(".chat-msg-save-note-btn").forEach((button) => {
    button.dataset.noteTarget = visual.target;
    if (!button.classList.contains("is-copied") && !button.classList.contains("is-copy-failed")) {
      button.setAttribute("aria-label", visual.label);
      button.setAttribute("title", visual.label);
      button.innerHTML = visual.icon.trim();
    }
  });
}

export interface CreateActionBarOptions {
  stopped?: boolean;
  historyIndex?: number;
  content?: HTMLElement;
  hasSpeakableContent?: boolean;
  cleanedRaw?: string;
}

export interface RenderAssistantMessageOptions {
  userPrompt?: string;
  sources?: ChatSearchSource[];
  historyIndex?: number;
  stopped?: boolean;
  thinking?: string;
}

export interface MessageActionsDeps {
  messages: HTMLElement;
  imageViewer: ChatImageViewer;
  getTimestampNavDeps: () => TimestampNavDeps;
  onRegenerate?: (historyIndex: number, node: HTMLDivElement) => void;
  onContinue?: (historyIndex: number, node: HTMLDivElement) => void;
  onSaveNote?: (
    historyIndex: number,
    raw: string,
    button: HTMLButtonElement
  ) => Promise<SaveNoteActionResult | boolean | void> | SaveNoteActionResult | boolean | void;
  getNoteExportTarget?: () => NoteExportTarget;
  onSpeak?: (messageId: string, button: HTMLButtonElement, content: HTMLElement) => Promise<void> | void;
  isRegenerationDisabled?: () => boolean;
  onNotice?: (message: string) => void;
  onLiveAppend: () => void;
  tokenStream: TokenStreamController;
  sourcePreview: SourcePreviewController;
  thoughtChain: ThoughtChainController;
}

export interface MessageActionsController {
  appendUserMessageNode: (
    text: string,
    source: MessageSource,
    messageId?: string,
    images?: ImagePart[]
  ) => HTMLDivElement;
  appendAssistantMessageNode: (
    source: MessageSource,
    runId?: string,
    messageId?: string
  ) => HTMLDivElement;
  createActionBar: (node: HTMLDivElement, opts?: CreateActionBarOptions) => HTMLDivElement;
  createRetryActionBar: (onRetry: () => void) => HTMLDivElement;
  renderAssistantMessage: (
    node: HTMLDivElement | null,
    raw: unknown,
    opts?: RenderAssistantMessageOptions
  ) => void;
  markTruncated: (node: HTMLDivElement, text: string, historyIndex?: number) => void;
  appendBadge: (node: HTMLElement, className: string, text: string) => void;
}

function createActionButton(
  className: string,
  label: string,
  icon: string,
  doc: Document = getActiveReaderDocument()
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = `chat-msg-action-btn ${className}`;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.innerHTML = icon.trim();
  return button;
}

function appendBadge(node: HTMLElement, className: string, text: string): void {
  const badge = resolveNodeDocument(node).createElement("div");
  badge.className = className;
  badge.textContent = text;
  node.appendChild(badge);
}

export function createMessageActionsController(deps: MessageActionsDeps): MessageActionsController {
  let nextMessageId = 0;

  function allocateMessageId(explicit?: string): string {
    return explicit || `chat-message-${++nextMessageId}`;
  }

  function createCopyButton(label: string, getRaw: () => string, doc?: Document): HTMLButtonElement {
    const button = createActionButton("chat-msg-copy-btn", label, READING_COPY_ICON, doc);
    button.disabled = !getRaw().trim();
    button.addEventListener("click", async () => {
      try {
        await writeActiveClipboardText(getRaw(), resolveNodeWindow(button));
        flashCopySuccess(button, { originalSvg: READING_COPY_ICON, originalLabel: label });
      } catch {
        deps.onNotice?.("复制失败，请检查浏览器剪贴板权限后重试");
      }
    });
    return button;
  }

  function resolveNoteExportTarget(): NoteExportTarget {
    return normalizeNoteExportTarget(
      deps.getNoteExportTarget ? deps.getNoteExportTarget() : state.settings?.noteExportTarget
    );
  }

  function createSaveNoteButton(
    historyIndex: number | undefined,
    getRaw: () => string,
    doc: Document
  ): HTMLButtonElement {
    const initialVisual = getSaveNoteActionVisual(resolveNoteExportTarget());
    const button = createActionButton("chat-msg-save-note-btn", initialVisual.label, initialVisual.icon, doc);
    button.dataset.noteTarget = initialVisual.target;
    button.disabled = historyIndex === undefined || !getRaw().trim() || !deps.onSaveNote;
    let saving = false;

    button.addEventListener("click", async () => {
      if (saving || historyIndex === undefined || !deps.onSaveNote) {
        return;
      }
      const raw = getRaw();
      if (!raw.trim()) {
        return;
      }
      saving = true;
      const visual = getSaveNoteActionVisual(resolveNoteExportTarget());
      button.dataset.noteTarget = visual.target;
      button.disabled = true;
      button.classList.add("is-loading");
      button.setAttribute("aria-busy", "true");
      try {
        const result = await deps.onSaveNote(historyIndex, raw, button);
        const ok = typeof result === "boolean" ? result : result ? result.ok : true;
        const customLabel = typeof result === "object" && result?.label ? result.label : undefined;
        const errorText = typeof result === "object" && result?.error ? result.error : "";
        if (ok) {
          flashCopySuccess(button, {
            originalSvg: visual.icon,
            originalLabel: visual.label,
            copiedLabel: customLabel || visual.successLabel
          });
        } else {
          button.innerHTML = visual.icon.trim();
          flashCopyFailure(button, {
            originalLabel: visual.label,
            failedLabel: customLabel || visual.failedLabel
          });
          if (errorText) {
            deps.onNotice?.(errorText);
          }
        }
      } catch (error) {
        button.innerHTML = visual.icon.trim();
        flashCopyFailure(button, {
          originalLabel: visual.label,
          failedLabel: visual.failedLabel
        });
        deps.onNotice?.(`存为笔记失败：${getErrorMessage(error)}`);
      } finally {
        saving = false;
        button.classList.remove("is-loading");
        button.removeAttribute("aria-busy");
        button.disabled = historyIndex === undefined || !getRaw().trim() || !deps.onSaveNote;
      }
    });

    return button;
  }

  function createContinueButton(node: HTMLDivElement, historyIndex?: number): HTMLButtonElement {
    const button = createActionButton(
      "chat-msg-continue-btn",
      "继续生成",
      READING_PLAY_ICON,
      resolveNodeDocument(node)
    );
    button.disabled = historyIndex === undefined || Boolean(deps.isRegenerationDisabled?.());
    button.addEventListener("click", () => {
      if (historyIndex !== undefined && !deps.isRegenerationDisabled?.()) {
        deps.onContinue?.(historyIndex, node);
      }
    });
    return button;
  }

  function createActionBar(
    node: HTMLDivElement,
    {
      stopped = false,
      historyIndex,
      content,
      hasSpeakableContent = false,
      cleanedRaw = ""
    }: CreateActionBarOptions = {}
  ): HTMLDivElement {
    const doc = resolveNodeDocument(node);
    const actions = doc.createElement("div");
    actions.className = "chat-msg-actions";

    const regenerateBtn = createActionButton(
      "chat-msg-regenerate-btn",
      "重新生成",
      READING_RESET_ICON,
      doc
    );
    regenerateBtn.disabled = historyIndex === undefined || Boolean(deps.isRegenerationDisabled?.());
    regenerateBtn.addEventListener("click", () => {
      if (historyIndex !== undefined && !deps.isRegenerationDisabled?.()) {
        deps.onRegenerate?.(historyIndex, node);
      }
    });

    if (stopped && !content) {
      actions.append(regenerateBtn, createContinueButton(node, historyIndex));
      return actions;
    }

    actions.appendChild(createCopyButton("复制回复", () => cleanedRaw, doc));
    actions.appendChild(createSaveNoteButton(historyIndex, () => cleanedRaw, doc));

    if (supportsTtsSpeech()) {
      const speakBtn = createActionButton("chat-msg-speak-btn", "朗读回答", READING_SPEAKER_ICON, doc);
      speakBtn.disabled = !hasSpeakableContent || !deps.onSpeak;
      speakBtn.setAttribute("aria-pressed", "false");
      speakBtn.addEventListener("click", () => {
        if (content) {
          void deps.onSpeak?.(node.dataset.messageId || "", speakBtn, content);
        }
      });
      actions.appendChild(speakBtn);
    }
    actions.appendChild(regenerateBtn);

    if (stopped) {
      actions.appendChild(createContinueButton(node, historyIndex));
    }

    return actions;
  }

  function createRetryActionBar(onRetry: () => void): HTMLDivElement {
    const doc = resolveNodeDocument(deps.messages);
    const actions = doc.createElement("div");
    actions.className = "chat-msg-actions";
    const retryBtn = createActionButton("chat-msg-retry-btn", "重试", READING_RESET_ICON, doc);
    retryBtn.disabled = Boolean(deps.isRegenerationDisabled?.());
    retryBtn.addEventListener("click", () => {
      if (!deps.isRegenerationDisabled?.()) {
        onRetry();
      }
    });
    actions.appendChild(retryBtn);
    return actions;
  }

  function appendUserMessageNode(
    text: string,
    source: MessageSource,
    messageId?: string,
    images: ImagePart[] = []
  ): HTMLDivElement {
    const doc = resolveNodeDocument(deps.messages);
    const node = doc.createElement("div");
    node.className = "chat-msg chat-msg-user";
    node.setAttribute("data-message-id", allocateMessageId(messageId));
    if (images.length) {
      const imageStrip = doc.createElement("div");
      imageStrip.className = "chat-image-strip chat-msg-user-images";
      images.forEach((image) => {
        const item = doc.createElement("div");
        item.className = "chat-image-item";
        item.appendChild(createChatImageViewButton(image, deps.imageViewer, "已发送的图片"));
        imageStrip.appendChild(item);
      });
      node.appendChild(imageStrip);
    }
    const body = doc.createElement("div");
    body.className = "chat-msg-user-body";
    body.textContent = text;
    node.appendChild(body);
    const actions = doc.createElement("div");
    actions.className = "chat-msg-actions";
    actions.appendChild(createCopyButton("复制消息", () => text, doc));
    node.appendChild(actions);
    deps.messages.appendChild(node);
    if (source === "live") {
      deps.onLiveAppend();
    }
    return node;
  }

  function appendAssistantMessageNode(
    source: MessageSource,
    runId?: string,
    messageId?: string
  ): HTMLDivElement {
    const doc = resolveNodeDocument(deps.messages);
    if (source === "replay") {
      const replayed = doc.createElement("div");
      replayed.className = "chat-msg chat-msg-assistant";
      if (runId) replayed.setAttribute("data-run-id", runId);
      replayed.setAttribute("data-message-id", allocateMessageId(messageId));
      deps.messages.appendChild(replayed);
      return replayed;
    }
    deps.messages
      .querySelectorAll(".chat-msg-assistant.chat-msg-streaming")
      .forEach((el) => el.classList.remove("chat-msg-streaming"));
    const node = doc.createElement("div");
    node.className = "chat-msg chat-msg-assistant chat-msg-streaming";
    if (runId) node.setAttribute("data-run-id", runId);
    node.setAttribute("data-message-id", allocateMessageId(messageId));
    deps.tokenStream.initNodeCursor(node);
    deps.messages.appendChild(node);
    deps.onLiveAppend();
    return node;
  }

  function renderAssistantMessage(
    node: HTMLDivElement | null,
    raw: unknown,
    { sources = [], historyIndex, stopped = false, thinking }: RenderAssistantMessageOptions = {}
  ): void {
    if (!node) {
      return;
    }
    const cleanedRaw = stripThinkBlocks(raw);
    const content = resolveNodeDocument(node).createElement("div");
    content.className = "chat-msg-assistant-body markdown-body";
    content.innerHTML = renderMarkdownStripped(cleanedRaw, CHAT_MARKDOWN_OPTIONS);
    const citedSubtitleCount = linkifyAssistantTimestamps(content, deps.getTimestampNavDeps());
    const hasSpeakableContent = Boolean(content.textContent?.trim() || content.querySelector("pre, img[alt]"));
    hydrateMarkdownContent(content);
    if (sources.length) {
      deps.sourcePreview.renderCitations(content, sources);
    }

    const chainRoot = deps.thoughtChain.applyTerminalThinkingFallback(node, {
      mode: "message",
      citedSubtitleCount,
      thinking
    });

    node.innerHTML = "";
    if (chainRoot) {
      node.appendChild(chainRoot);
    }
    node.appendChild(content);

    const actions = createActionBar(node, {
      stopped,
      historyIndex,
      content,
      hasSpeakableContent,
      cleanedRaw
    });
    node.appendChild(actions);
  }

  function markTruncated(node: HTMLDivElement, text: string, historyIndex?: number): void {
    const actions = node.querySelector(".chat-msg-actions");
    if (actions && !actions.querySelector(".chat-msg-continue-btn")) {
      actions.appendChild(createContinueButton(node, historyIndex));
    }
    appendBadge(node, "chat-msg-truncated", text);
  }

  return {
    appendUserMessageNode,
    appendAssistantMessageNode,
    createActionBar,
    createRetryActionBar,
    renderAssistantMessage,
    markTruncated,
    appendBadge
  };
}
