// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ChatPort, CommittedChatTurnInfo } from "../../extension/chat/chat-runtime.js";
import { createChatRuntime } from "../../extension/chat/chat-runtime.js";
import { resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import { state } from "../../extension/core/state.js";
import {
  captureLiveClipSignature,
  handleCommittedChatTurnForNotes
} from "../../extension/notes/auto-export-controller.js";
import {
  clearSessionNoteRecords,
  findLatestSessionNoteForClip
} from "../../extension/notes/session-note-state.js";
import type { DispatchNoteExportResult } from "../../extension/notes/export-actions.js";

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  emitMessage: (msg: unknown) => void;
}

function makeRuntimeDeps(onTurnCommitted: (info: CommittedChatTurnInfo) => void) {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports: FakePort[] = [];
  return {
    messages,
    input,
    ports,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: vi.fn(() => true)
    },
    ui: {
      setStreamingUiState: vi.fn(),
      messagesNotice: { show: vi.fn(), clear: vi.fn() },
      inputNotice: { show: vi.fn(), clear: vi.fn() },
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      showSetupBlockedState: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => ({ pass: true }) as const),
    getProviderId: () => "test-provider",
    getSelectedModel: () => "test-model",
    getTimestampNavDeps: () => ({}),
    onTurnCommitted,
    connectPort: vi.fn(async () => {
      const listeners: Array<(msg: unknown) => void> = [];
      const port: FakePort = {
        name: "offscreen-chat",
        onMessage: { addListener: (fn) => { listeners.push(fn); } },
        onDisconnect: { addListener: () => {} },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        emitMessage: (msg) => {
          for (const fn of [...listeners]) {
            fn(msg);
          }
        }
      };
      ports.push(port);
      return port as unknown as ChatPort;
    })
  };
}

beforeEach(() => {
  resetModuleState();
  resetChatSessionStateForTests();
  clearSessionNoteRecords();
  document.body.innerHTML = "";
  state.clip.setBvid("BV1test000000");
  state.clip.setCid("1");
  state.clip.setCurrentClipSignature("BV1test000000|1|zh-CN");
  state.patchSettings({
    playerAiAutoExportNote: true,
    noteExportTarget: "download"
  });
});

afterEach(() => {
  clearSessionNoteRecords();
  vi.restoreAllMocks();
});

describe("流式结束自动导出笔记闭环 (playerAiAutoExportNote)", () => {
  it("video-note / player-ai 轮次正常完成且 clipSignature 匹配时自动导出一次并给出非阻塞提示", async () => {
    const dispatchExport = vi.fn<() => Promise<DispatchNoteExportResult>>(async () => ({
      ok: true,
      target: "download",
      method: "background-download",
      fileName: "视频笔记.md"
    }));
    const onNotice = vi.fn();
    let capturedInfo: CommittedChatTurnInfo | null = null;
    const deps = makeRuntimeDeps((info) => {
      capturedInfo = info;
    });
    const runtime = createChatRuntime(deps);
    const expectedSig = captureLiveClipSignature();

    await runtime.sendTurn("请生成结构化视频笔记", {
      preserveInputDraft: true,
      turnKind: "video-note",
      expectedClipSignature: expectedSig
    });
    deps.ports.at(-1)!.emitMessage({ type: "token", data: "## 核心要点\n- 要点一 [00:12]" });
    deps.ports.at(-1)!.emitMessage({ type: "done" });

    expect(capturedInfo).not.toBeNull();
    expect(capturedInfo!.turnKind).toBe("video-note");
    expect(capturedInfo!.stopped).toBe(false);

    const first = await handleCommittedChatTurnForNotes(capturedInfo!, {
      isSessionClosed: () => false,
      dispatchExport,
      onNotice
    });
    const second = await handleCommittedChatTurnForNotes(capturedInfo!, {
      isSessionClosed: () => false,
      dispatchExport,
      onNotice
    });

    expect(first?.ok).toBe(true);
    expect(second).toBeNull();
    expect(dispatchExport).toHaveBeenCalledTimes(1);
    expect(dispatchExport).toHaveBeenCalledWith({
      aiNoteMarkdown: "## 核心要点\n- 要点一 [00:12]",
      capturedFrames: [],
      autoTrigger: true
    });
    expect(onNotice).toHaveBeenCalledWith("已自动导出笔记：视频笔记.md", 4000, { tone: "success" });

    const saved = findLatestSessionNoteForClip({ clipSignature: expectedSig });
    expect(saved?.isVideoNote).toBe(true);
    expect(saved?.markdown).toContain("核心要点");
  });

  it("手动停止 (stopped) 或中途报错 (error) 时严格抑制自动导出", async () => {
    const dispatchExport = vi.fn();
    const onNotice = vi.fn();
    const committed: CommittedChatTurnInfo[] = [];
    const deps = makeRuntimeDeps((info) => {
      committed.push(info);
    });
    const runtime = createChatRuntime(deps);
    const expectedSig = captureLiveClipSignature();

    await runtime.sendTurn("生成笔记", {
      preserveInputDraft: true,
      turnKind: "video-note",
      expectedClipSignature: expectedSig
    });
    deps.ports.at(-1)!.emitMessage({ type: "token", data: "半截内容" });
    deps.ports.at(-1)!.emitMessage({ type: "stopped" });

    expect(committed).toHaveLength(1);
    expect(committed[0].stopped).toBe(true);
    const stoppedRes = await handleCommittedChatTurnForNotes(committed[0], {
      isSessionClosed: () => false,
      dispatchExport,
      onNotice
    });
    expect(stoppedRes).toBeNull();
    expect(dispatchExport).not.toHaveBeenCalled();

    await runtime.sendTurn("再来一次", {
      preserveInputDraft: true,
      turnKind: "player-ai",
      expectedClipSignature: expectedSig
    });
    deps.ports.at(-1)!.emitMessage({ type: "error", message: "上游超时" });
    expect(committed).toHaveLength(1);
    expect(dispatchExport).not.toHaveBeenCalled();
  });

  it("SPA 换片后 clipSignature 变更、普通 user 提问、关闭开关或会话关闭时严格抑制", async () => {
    const dispatchExport = vi.fn();
    const onNotice = vi.fn();
    const expectedSig = captureLiveClipSignature();

    const baseInfo: CommittedChatTurnInfo = {
      raw: "## 笔记正文",
      historyIndex: 1,
      message: { role: "assistant", content: "## 笔记正文" },
      stopped: false,
      capturedFrames: [],
      turnKind: "player-ai",
      expectedClipSignature: expectedSig
    };

    state.clip.setCurrentClipSignature("BV1other00000|2|zh-CN");
    expect(
      await handleCommittedChatTurnForNotes(baseInfo, {
        isSessionClosed: () => false,
        dispatchExport,
        onNotice
      })
    ).toBeNull();

    state.clip.setCurrentClipSignature("BV1test000000|1|zh-CN");
    expect(
      await handleCommittedChatTurnForNotes(
        { ...baseInfo, message: { role: "assistant", content: "## 笔记正文" }, turnKind: "user" },
        { isSessionClosed: () => false, dispatchExport, onNotice }
      )
    ).toBeNull();

    expect(
      await handleCommittedChatTurnForNotes(
        { ...baseInfo, message: { role: "assistant", content: "## 笔记正文" } },
        { isSessionClosed: () => true, dispatchExport, onNotice }
      )
    ).toBeNull();

    state.patchSettings({ playerAiAutoExportNote: false });
    expect(
      await handleCommittedChatTurnForNotes(
        { ...baseInfo, message: { role: "assistant", content: "## 笔记正文" } },
        { isSessionClosed: () => false, dispatchExport, onNotice }
      )
    ).toBeNull();

    expect(dispatchExport).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });
});
