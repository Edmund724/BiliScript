// extension/chat/render/message-actions.ts — 用户/助手消息壳、操作栏与终态 Markdown 水合

import type { ImagePart } from "../../ai/types.js";
import { getErrorMessage } from "../../shared/error-helpers.js";
import { supportsTtsSpeech } from "../../shared/runtime-capabilities.js";
import { flashCopySuccess } from "../../ui/copy-feedback.js";
import { hydrateMarkdownContent, renderMarkdownStripped, stripThinkBlocks } from "../../ui/markdown.js";
import {
  READING_COPY_ICON,
  READING_DOWNLOAD_ICON,
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
  onExport?: (historyIndex: number, raw: string) => void;
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

function createActionButton(className: string, label: string, icon: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chat-msg-action-btn ${className}`;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.innerHTML = icon.trim();
  return button;
}

function appendBadge(node: HTMLElement, className: string, text: string): void {
  const badge = document.createElement("div");
  badge.className = className;
  badge.textContent = text;
  node.appendChild(badge);
}

export function createMessageActionsController(deps: MessageActionsDeps): MessageActionsController {
  let nextMessageId = 0;

  function allocateMessageId(explicit?: string): string {
    return explicit || `chat-message-${++nextMessageId}`;
  }

  function createCopyButton(label: string, getRaw: () => string): HTMLButtonElement {
    const button = createActionButton("chat-msg-copy-btn", label, READING_COPY_ICON);
    button.disabled = !getRaw().trim();
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getRaw());
        flashCopySuccess(button, { originalSvg: READING_COPY_ICON, originalLabel: label });
      } catch {
        deps.onNotice?.("复制失败，请检查浏览器剪贴板权限后重试");
      }
    });
    return button;
  }

  function createContinueButton(node: HTMLDivElement, historyIndex?: number): HTMLButtonElement {
    const button = createActionButton("chat-msg-continue-btn", "继续生成", READING_PLAY_ICON);
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
    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";

    const regenerateBtn = createActionButton("chat-msg-regenerate-btn", "重新生成", READING_RESET_ICON);
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

    actions.appendChild(createCopyButton("复制回复", () => cleanedRaw));

    if (supportsTtsSpeech()) {
      const speakBtn = createActionButton("chat-msg-speak-btn", "朗读回答", READING_SPEAKER_ICON);
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

    const exportBtn = createActionButton("chat-msg-export-btn", "导出 Markdown", READING_DOWNLOAD_ICON);
    exportBtn.disabled = historyIndex === undefined || !cleanedRaw.trim();
    exportBtn.addEventListener("click", () => {
      if (historyIndex === undefined) {
        return;
      }
      try {
        deps.onExport?.(historyIndex, cleanedRaw);
      } catch (error) {
        deps.onNotice?.(`导出失败：${getErrorMessage(error)}`);
      }
    });
    actions.appendChild(exportBtn);

    return actions;
  }

  function createRetryActionBar(onRetry: () => void): HTMLDivElement {
    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";
    const retryBtn = createActionButton("chat-msg-retry-btn", "重试", READING_RESET_ICON);
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
    const node = document.createElement("div");
    node.className = "chat-msg chat-msg-user";
    node.setAttribute("data-message-id", allocateMessageId(messageId));
    if (images.length) {
      const imageStrip = document.createElement("div");
      imageStrip.className = "chat-image-strip chat-msg-user-images";
      images.forEach((image) => {
        const item = document.createElement("div");
        item.className = "chat-image-item";
        item.appendChild(createChatImageViewButton(image, deps.imageViewer, "已发送的图片"));
        imageStrip.appendChild(item);
      });
      node.appendChild(imageStrip);
    }
    const body = document.createElement("div");
    body.className = "chat-msg-user-body";
    body.textContent = text;
    node.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";
    actions.appendChild(createCopyButton("复制消息", () => text));
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
    if (source === "replay") {
      const replayed = document.createElement("div");
      replayed.className = "chat-msg chat-msg-assistant";
      if (runId) replayed.setAttribute("data-run-id", runId);
      replayed.setAttribute("data-message-id", allocateMessageId(messageId));
      deps.messages.appendChild(replayed);
      return replayed;
    }
    deps.messages
      .querySelectorAll(".chat-msg-assistant.chat-msg-streaming")
      .forEach((el) => el.classList.remove("chat-msg-streaming"));
    const node = document.createElement("div");
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
    const content = document.createElement("div");
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
      actions.insertBefore(createContinueButton(node, historyIndex), actions.querySelector(".chat-msg-export-btn"));
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
