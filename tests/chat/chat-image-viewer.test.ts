import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm, type DetachedRealm } from "../helpers/detached-realm.js";

let realm: DetachedRealm | null = null;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(() => {
  realm?.close();
  realm = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("chat-image-viewer、chat-speech 与 chat/render 独立宿主与跨 Realm 迁移", () => {
  it("chatImageViewer 在 detached 宿主挂载 dialog、支持 Escape/Tab，并在宿主切换时自动关闭", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const viewerMod = await import("../../extension/chat/chat-image-viewer.js");

    const readingView = realm.doc.createElement("div");
    readingView.id = "biliscript-reading-view";
    const trigger = realm.doc.createElement("button");
    readingView.appendChild(trigger);
    realm.doc.body.appendChild(readingView);

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const viewer = viewerMod.createChatImageViewer();
    viewer.open("data:image/png;base64,AAAA", trigger, "测试图");

    const dialog = readingView.querySelector<HTMLDialogElement>(".chat-image-viewer")!;
    expect(dialog).not.toBeNull();
    expect(dialog.ownerDocument).toBe(realm.doc);
    expect(dialog.hasAttribute("open")).toBe(true);

    const closeBtn = dialog.querySelector<HTMLButtonElement>(".chat-image-viewer-close")!;
    realm.doc.dispatchEvent(
      new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      })
    );
    expect(realm.doc.activeElement).toBe(closeBtn);

    realm.doc.dispatchEvent(
      new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );
    expect(readingView.querySelector(".chat-image-viewer")).toBeNull();

    viewer.open("data:image/png;base64,AAAA", trigger, "二次打开");
    expect(readingView.querySelector(".chat-image-viewer")).not.toBeNull();
    activeHost.resetActiveReaderHost();
    expect(readingView.querySelector(".chat-image-viewer")).toBeNull();
  });

  it("speechTextFromElement、sourcePreview 与 inPlaceTurn 正确处理跨 Realm HTMLElement 与 Text", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const chatSpeech = await import("../../extension/chat/chat-speech.js");
    const sourcePreviewMod = await import("../../extension/chat/render/source-preview.js");
    const inPlaceMod = await import("../../extension/chat/render/in-place-turn.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const speechRoot = realm.doc.createElement("div");
    speechRoot.innerHTML = `<p>第一段</p><p>第二行<br>第三行</p><table><tr><td>甲</td><td>乙</td></tr></table>`;
    expect(speechRoot instanceof window.HTMLElement).toBe(false);
    const spoken = chatSpeech.speechTextFromElement(speechRoot);
    expect(spoken).toContain("第一段");
    expect(spoken).toContain("第二行\n第三行");
    expect(spoken).toContain("甲 乙");

    const messages = realm.doc.createElement("div");
    const body = realm.doc.createElement("div");
    body.innerHTML = `<p>参考内容 [1]</p>`;
    messages.appendChild(body);
    realm.doc.body.appendChild(messages);

    const winOpenSpy = vi.spyOn(realm.win, "open").mockImplementation(() => null);
    const previewCtrl = sourcePreviewMod.createSourcePreviewController({ messages });
    previewCtrl.renderCitations(body, [{ title: "来源1", url: "https://example.com/1", snippet: "摘要" }]);

    const cite = body.querySelector<HTMLElement>(".chat-cite")!;
    expect(cite).not.toBeNull();
    expect(cite.ownerDocument).toBe(realm.doc);
    cite.click();
    expect(winOpenSpy).toHaveBeenCalledWith("https://example.com/1", "_blank", "noopener");

    const turnA = realm.doc.createElement("div");
    const turnB = realm.doc.createElement("div");
    messages.append(turnA, turnB);
    expect(turnB instanceof window.HTMLElement).toBe(false);
    const inPlace = inPlaceMod.createInPlaceTurnController({
      messages,
      setAutoScroll: vi.fn(),
      scrollToBottom: vi.fn(),
      tokenStream: {
        cancelFlush: vi.fn(),
        resetState: vi.fn(),
        mountCursor: vi.fn(),
        flushSyncInitial: vi.fn(),
      },
      thoughtChain: {
        getChain: () => null,
        setChain: vi.fn(),
        deleteChain: vi.fn(),
        clearSettled: vi.fn(),
        cancelChainThinkingFrames: vi.fn(),
        clearThoughtChain: vi.fn(),
      },
      createTurnHandle: vi.fn(() => ({
        node: turnA,
        body: turnA,
        setThinking: vi.fn(),
        appendToken: vi.fn(),
        commit: vi.fn(),
        discard: vi.fn(),
        markError: vi.fn(),
      })) as unknown as Parameters<typeof inPlaceMod.createInPlaceTurnController>[0]["createTurnHandle"],
    });
    const session = inPlace.beginInPlaceTurn(turnA, { mode: "replace" });
    expect(turnB.hidden).toBe(true);
    session.restore();
    expect(turnB.hidden).toBe(false);
  });

  it("tokenStream、thinkingBuffer、thoughtChain 与 messageActions 使用活跃宿主文档、剪贴板与 rAF", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const tokenStreamMod = await import("../../extension/chat/render/token-stream.js");
    const thinkingBufferMod = await import("../../extension/chat/render/thinking-buffer.js");
    const thoughtChainMod = await import("../../extension/chat/render/thought-chain.js");
    const messageActionsMod = await import("../../extension/chat/render/message-actions.js");
    const { createChatImageViewer } = await import("../../extension/chat/chat-image-viewer.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const messages = realm.doc.createElement("div");
    realm.doc.body.appendChild(messages);

    const tokenStream = tokenStreamMod.createTokenStreamController({
      isSmoothStream: () => false,
      scrollToBottom: vi.fn(),
      onBodyStart: vi.fn(),
    });
    const thinkingBuffer = thinkingBufferMod.createThinkingBufferController({
      scrollToBottom: vi.fn(),
    });
    const sourcePreview = (await import("../../extension/chat/render/source-preview.js")).createSourcePreviewController({ messages });
    const imageViewer = createChatImageViewer();
    const thoughtChain = thoughtChainMod.createThoughtChainController({
      messages,
      imageViewer,
      thinkingBuffer,
      sourcePreview,
    });
    const msgActions = messageActionsMod.createMessageActionsController({
      messages,
      imageViewer,
      getTimestampNavDeps: () => ({}),
      onLiveAppend: vi.fn(),
      tokenStream,
      sourcePreview,
      thoughtChain,
    });

    const userNode = msgActions.appendUserMessageNode("你好", "live");
    expect(userNode.ownerDocument).toBe(realm.doc);
    const copyBtn = userNode.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(realm.clipboardWriteText).toHaveBeenCalledWith("你好");

    const assistantNode = msgActions.appendAssistantMessageNode("live");
    thoughtChain.appendThinkingStep(assistantNode, "思考中", true);
    expect(realm.rafQueue.size).toBeGreaterThan(0);
    realm.flushRaf(32);

    tokenStream.appendToken(assistantNode, "回答内容");
    expect(realm.rafQueue.size).toBeGreaterThan(0);
    realm.flushRaf(48);
    expect(assistantNode.textContent).toContain("回答内容");
  });

  it("historical-video-frame 显式将离屏抓帧 video 挂载到 opener document.body", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const frameMod = await import("../../extension/chat/historical-video-frame.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const openerAppendSpy = vi.spyOn(document.body, "appendChild");
    const detachedAppendSpy = vi.spyOn(realm.doc.body, "appendChild");
    const fakeVideo = document.createElement("video");
    Object.defineProperty(fakeVideo, "readyState", { value: 2, configurable: true });
    Object.defineProperty(fakeVideo, "duration", { value: 100, configurable: true });
    Object.defineProperty(fakeVideo, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(fakeVideo, "videoHeight", { value: 360, configurable: true });

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") {
        queueMicrotask(() => {
          fakeVideo.dispatchEvent(new Event("loadedmetadata"));
          fakeVideo.dispatchEvent(new Event("seeked"));
        });
        return fakeVideo;
      }
      return origCreate(tag);
    });

    await frameMod
      .captureHistoricalVideoFrame(
        {
          bvid: "BV1test",
          cid: "123",
          targetTime: 10,
        },
        {
          timeoutMs: 200,
          transport: async () => ({ code: 0, data: { durl: [{ url: "https://example.com/v.mp4" }] } }),
        }
      )
      .catch(() => {});

    expect(openerAppendSpy).toHaveBeenCalledWith(fakeVideo);
    expect(detachedAppendSpy).not.toHaveBeenCalled();
  });
});
