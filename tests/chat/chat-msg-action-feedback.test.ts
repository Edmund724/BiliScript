// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm } from "../helpers/detached-realm.js";
import type { ChatPort } from "../../extension/chat/chat-runtime.js";
import {
  READING_NOTE_DOWNLOAD_ICON,
  READING_NOTE_OBSIDIAN_ICON
} from "../../extension/ui/reading-icons.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;
let state: typeof import("../../extension/core/state.js").state;
let syncSaveNoteButtons: typeof import("../../extension/chat/render/message-actions.js").syncSaveNoteButtons;

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  emitMessage: (msg: unknown) => void;
}

function makeDeps() {
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

type RuntimeDeps = ReturnType<typeof makeDeps>;

async function makeFinishedAssistant(deps: RuntimeDeps) {
  const runtime = createChatRuntime(deps);
  deps.input.value = "问题";
  await runtime.sendTurn(deps.input.value);
  deps.ports.at(-1)!.emitMessage({ type: "token", data: "回答正文" });
  deps.ports.at(-1)!.emitMessage({ type: "done" });
  const node = deps.messages.querySelector(".chat-msg-assistant") as HTMLElement;
  return { runtime, node };
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState, resetChatSessionStateForTests } = await import("../../extension/chat/chat-state.js"));
  ({ state } = await import("../../extension/core/state.js"));
  ({ syncSaveNoteButtons } = await import("../../extension/chat/render/message-actions.js"));
  resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("消息操作反馈归属（06 号票）", () => {
  it("复制回复成功：按钮就地 flash（aria-label 变「已复制」），通知通道与历史不被惊动", async () => {
    const deps = makeDeps();
    const { node } = await makeFinishedAssistant(deps);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const copyBtn = node.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("回答正文"));

    expect(copyBtn.getAttribute("aria-label")).toBe("已复制");
    expect(copyBtn.classList.contains("is-copied")).toBe(true);
    expect(deps.ui.messagesNotice.show).not.toHaveBeenCalled();
  });

  it("复制保留原 Markdown，用户消息也复制原文而不升级标题", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn("# 用户标题");
    deps.ports.at(-1)!.emitMessage({ type: "token", data: "## 回答标题\n\n**粗体**" });
    deps.ports.at(-1)!.emitMessage({ type: "done" });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const assistant = deps.messages.querySelector(".chat-msg-assistant")!;
    assistant.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("## 回答标题\n\n**粗体**"));

    const user = deps.messages.querySelector(".chat-msg-user")!;
    user.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("# 用户标题"));
  });

  it("复制失败：经对话通知通道提示检查权限，可重试", async () => {
    const deps = makeDeps();
    const { node } = await makeFinishedAssistant(deps);
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const copyBtn = node.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!;
    copyBtn.click();

    await vi.waitFor(() => expect(deps.ui.messagesNotice.show).toHaveBeenCalledWith(
      "复制失败，请检查浏览器剪贴板权限后重试",
      4000
    ));
    expect(copyBtn.disabled).toBe(false);
  });

  it("导出 Markdown 失败：onNotice 落到对话 tab 通知通道，文案带病因", async () => {
    const deps = makeDeps();
    const { node } = await makeFinishedAssistant(deps);
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("blob 分配失败");
    });

    const exportBtn = node.querySelector<HTMLButtonElement>(".chat-msg-export-btn")!;
    expect(exportBtn.disabled).toBe(false);
    exportBtn.click();

    expect(deps.ui.messagesNotice.show).toHaveBeenCalledTimes(1);
    const notice = deps.ui.messagesNotice.show.mock.calls[0][0] as string;
    expect(notice).toContain("导出失败：");
    expect(notice).toContain("blob 分配失败");
  });
});

describe("AI 回复底栏动态「存为笔记」按钮", () => {
  it("紧邻复制按钮右侧挂载，图标与文案随 noteExportTarget 动态同步", async () => {
    state.patchSettings({ noteExportTarget: "download" });
    const deps = makeDeps();
    const { node } = await makeFinishedAssistant(deps);

    const actions = node.querySelector(".chat-msg-actions")!;
    const copyBtn = actions.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!;
    const saveNoteBtn = actions.querySelector<HTMLButtonElement>(".chat-msg-save-note-btn")!;

    expect(saveNoteBtn).not.toBeNull();
    expect(copyBtn.nextElementSibling).toBe(saveNoteBtn);
    expect(saveNoteBtn.dataset.noteTarget).toBe("download");
    expect(saveNoteBtn.getAttribute("aria-label")).toBe("导出视频笔记（.md）");
    expect(saveNoteBtn.getAttribute("title")).toBe("导出视频笔记（.md）");
    expect(saveNoteBtn.innerHTML).toBe(READING_NOTE_DOWNLOAD_ICON.trim());

    state.patchSettings({ noteExportTarget: "obsidian" });
    syncSaveNoteButtons(deps.messages, "obsidian");
    expect(saveNoteBtn.dataset.noteTarget).toBe("obsidian");
    expect(saveNoteBtn.getAttribute("aria-label")).toBe("存入 Obsidian");
    expect(saveNoteBtn.getAttribute("title")).toBe("存入 Obsidian");
    expect(saveNoteBtn.innerHTML).toBe(READING_NOTE_OBSIDIAN_ICON.trim());
  });

  it("点击防重入加锁与加载态，成功后就地 flashCopySuccess", async () => {
    let resolveSave!: (value: { ok: boolean; label?: string }) => void;
    const onSaveNote = vi.fn(
      () =>
        new Promise<{ ok: boolean; label?: string }>((resolve) => {
          resolveSave = resolve;
        })
    );
    const deps = { ...makeDeps(), onSaveNote };
    const { node } = await makeFinishedAssistant(deps);
    const saveNoteBtn = node.querySelector<HTMLButtonElement>(".chat-msg-save-note-btn")!;

    saveNoteBtn.click();
    saveNoteBtn.click();

    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(onSaveNote).toHaveBeenCalledWith(1, "回答正文", saveNoteBtn);
    expect(saveNoteBtn.disabled).toBe(true);
    expect(saveNoteBtn.classList.contains("is-loading")).toBe(true);
    expect(saveNoteBtn.getAttribute("aria-busy")).toBe("true");

    resolveSave({ ok: true, label: "已导出笔记" });
    await vi.waitFor(() => expect(saveNoteBtn.classList.contains("is-loading")).toBe(false));

    expect(saveNoteBtn.disabled).toBe(false);
    expect(saveNoteBtn.getAttribute("aria-busy")).toBeNull();
    expect(saveNoteBtn.classList.contains("is-copied")).toBe(true);
    expect(saveNoteBtn.getAttribute("aria-label")).toBe("已导出笔记");
  });

  it("存为笔记失败时展示 is-copy-failed 回执并经对话通知栏提示原因", async () => {
    const onSaveNote = vi.fn(async () => ({ ok: false, error: "Obsidian URI 打开失败" }));
    state.patchSettings({ noteExportTarget: "obsidian" });
    const deps = { ...makeDeps(), onSaveNote };
    const { node } = await makeFinishedAssistant(deps);
    const saveNoteBtn = node.querySelector<HTMLButtonElement>(".chat-msg-save-note-btn")!;

    saveNoteBtn.click();
    await vi.waitFor(() => expect(saveNoteBtn.classList.contains("is-copy-failed")).toBe(true));

    expect(saveNoteBtn.disabled).toBe(false);
    expect(saveNoteBtn.getAttribute("aria-label")).toBe("写入失败");
    expect(deps.ui.messagesNotice.show).toHaveBeenCalledWith("Obsidian URI 打开失败", 4000);
  });

  it("独立窗口跨文档 Realm 下所有底栏按钮归属目标文档并可正常存为笔记", async () => {
    const realm = createDetachedRealm();
    try {
      const onSaveNote = vi.fn(async () => ({ ok: true }));
      const base = makeDeps();
      const messages = realm.doc.createElement("div");
      const input = realm.doc.createElement("textarea");
      realm.doc.body.append(messages, input);
      const deps = { ...base, messages, input, onSaveNote };
      const { node } = await makeFinishedAssistant(deps);

      const copyBtn = node.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!;
      const saveNoteBtn = node.querySelector<HTMLButtonElement>(".chat-msg-save-note-btn")!;
      const exportBtn = node.querySelector<HTMLButtonElement>(".chat-msg-export-btn")!;
      expect(copyBtn.ownerDocument).toBe(realm.doc);
      expect(saveNoteBtn.ownerDocument).toBe(realm.doc);
      expect(exportBtn.ownerDocument).toBe(realm.doc);

      const realmWin = realm.win as unknown as typeof window;
      saveNoteBtn.dispatchEvent(new realmWin.MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(saveNoteBtn.classList.contains("is-copied")).toBe(true));
    } finally {
      realm.close();
    }
  });
});
