import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import type { CommittedChatTurnInfo } from "../chat/chat-runtime.js";
import { chatSessionState } from "../chat/chat-state.js";
import { state } from "../core/state.js";
import { stripThinkBlocks } from "../ui/markdown.js";
import {
  dispatchNoteExport,
  type DispatchNoteExportOptions,
  type DispatchNoteExportResult
} from "./export-actions.js";
import { recordSessionNoteReply } from "./session-note-state.js";

export interface AutoExportNoticeOptions {
  tone?: "default" | "success";
}

export interface HandleCommittedTurnForNotesDeps {
  isSessionClosed: () => boolean;
  isAutoExportEnabled?: () => boolean;
  getCurrentClipSignature?: () => string;
  getCurrentContextKey?: () => string;
  dispatchExport?: (options?: DispatchNoteExportOptions) => Promise<DispatchNoteExportResult>;
  onNotice?: (message: string, autoHideMs?: number, options?: AutoExportNoticeOptions) => void;
}

const exportedMessages = new WeakSet<object>();

export function captureLiveClipSignature(): string {
  const stateSig = String(state.clip.currentClipSignature || "").trim();
  const urlSig = String(computeCurrentClipSignature() || "").trim();
  if (!stateSig && !urlSig) {
    return "";
  }
  return `${stateSig}||${urlSig}`;
}

export function formatAutoExportNotice(result: DispatchNoteExportResult): {
  message: string;
  tone: "default" | "success";
} {
  if (!result.ok) {
    return {
      message: result.error ? `自动导出笔记失败：${result.error}` : "自动导出笔记失败",
      tone: "default"
    };
  }
  if (result.target === "obsidian") {
    return {
      message: result.usedClipboardFallback
        ? "笔记较长，已复制并自动唤起 Obsidian"
        : "已自动存入 Obsidian 笔记",
      tone: "success"
    };
  }
  return {
    message: result.fileName ? `已自动导出笔记：${result.fileName}` : "已自动导出视频笔记（.md）",
    tone: "success"
  };
}

export async function handleCommittedChatTurnForNotes(
  info: CommittedChatTurnInfo,
  deps: HandleCommittedTurnForNotesDeps
): Promise<DispatchNoteExportResult | null> {
  const cleaned = stripThinkBlocks(info.raw).trim();
  const currentClipSignature = (deps.getCurrentClipSignature ?? captureLiveClipSignature)();
  const currentContextKey = (
    deps.getCurrentContextKey ??
    (() => String(chatSessionState.currentConversationMeta?.contextKey || chatSessionState.currentContextKey || "").trim())
  )();

  if (!info.stopped && cleaned) {
    recordSessionNoteReply({
      clipSignature: currentClipSignature,
      contextKey: currentContextKey,
      markdown: info.raw,
      capturedFrames: info.capturedFrames,
      isVideoNote: info.turnKind === "video-note"
    });
  }

  const autoExportEnabled = deps.isAutoExportEnabled
    ? deps.isAutoExportEnabled()
    : state.settings?.playerAiAutoExportNote === true;

  if (
    !autoExportEnabled
    || info.stopped
    || !cleaned
    || deps.isSessionClosed()
    || (info.turnKind !== "player-ai" && info.turnKind !== "video-note")
  ) {
    return null;
  }

  const expectedSignature = String(info.expectedClipSignature || "").trim();
  if (!expectedSignature || !currentClipSignature || expectedSignature !== currentClipSignature) {
    return null;
  }

  if (info.message && exportedMessages.has(info.message)) {
    return null;
  }
  if (info.message) {
    exportedMessages.add(info.message);
  }

  const runExport = deps.dispatchExport ?? dispatchNoteExport;
  const result = await runExport({
    aiNoteMarkdown: info.raw,
    capturedFrames: info.capturedFrames,
    autoTrigger: true
  });

  if (!deps.isSessionClosed()) {
    const notice = formatAutoExportNotice(result);
    deps.onNotice?.(notice.message, 4000, { tone: notice.tone });
  }

  return result;
}
