// @vitest-environment jsdom
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

  it("speechTextFromElement 与 createChatStreamRenderer 正确处理跨 Realm DOM、剪贴板、引用与 rAF", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const chatSpeech = await import("../../extension/chat/chat-speech.js");
    const { createChatStreamRenderer } = await import("../../extension/chat/chat-stream-render.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const speechRoot = realm.doc.createElement("div");
    speechRoot.innerHTML = `<p>第一段</p><p>第二行<br>第三行</p><table><tr><td>甲</td><td>乙</td></tr></table>`;
    expect(speechRoot instanceof window.HTMLElement).toBe(false);
    const spoken = chatSpeech.speechTextFromElement(speechRoot);
    expect(spoken).toContain("第一段");
    expect(spoken).toContain("第二行\n第三行");
    expect(spoken).toContain("甲 乙");

    const messages = realm.doc.createElement("div");
    realm.doc.body.appendChild(messages);
    const winOpenSpy = vi.spyOn(realm.win, "open").mockImplementation(() => null);
    const renderer = createChatStreamRenderer({
      messages,
      getTimestampNavDeps: () => ({}),
      smoothStream: false
    });

    const userNode = renderer.messageArea.appendUserMessage("你好", { source: "live" }) as HTMLDivElement;
    expect(userNode.ownerDocument).toBe(realm.doc);
    userNode.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(realm.clipboardWriteText).toHaveBeenCalledWith("你好");

    const liveTurn = renderer.messageArea.appendAssistantMessage({ source: "live" });
    liveTurn.appendThinking("思考中");
    expect(realm.rafQueue.size).toBeGreaterThan(0);
    realm.flushRaf(32);

    liveTurn.appendToken("参考内容 [1]");
    expect(realm.rafQueue.size).toBeGreaterThan(0);
    realm.flushRaf(48);
    expect(liveTurn.node!.textContent).toContain("参考内容 [1]");

    liveTurn.finish({
      raw: "参考内容 [1]",
      sources: [{ title: "来源1", url: "https://example.com/1", snippet: "摘要" }]
    });
    const cite = liveTurn.node!.querySelector<HTMLElement>(".chat-cite")!;
    expect(cite).not.toBeNull();
    expect(cite.ownerDocument).toBe(realm.doc);
    cite.click();
    expect(winOpenSpy).toHaveBeenCalledWith("https://example.com/1", "_blank", "noopener");

    const followTurn = renderer.messageArea.appendAssistantMessage({ source: "replay" });
    expect(followTurn.node instanceof window.HTMLElement).toBe(false);
    const session = renderer.messageArea.beginInPlaceTurn(liveTurn.node!, { mode: "replace" });
    expect(followTurn.node!.hidden).toBe(true);
    session.restore();
    expect(followTurn.node!.hidden).toBe(false);
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
