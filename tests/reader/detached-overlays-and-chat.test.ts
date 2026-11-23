import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import { createDetachedRealm, type DetachedRealm } from "../helpers/detached-realm.js";

let realm: DetachedRealm | null = null;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
});

afterEach(() => {
  realm?.close();
  realm = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reader 独立宿主：划词浮层、解释卡片、金句卡导出、命令面板与 AI 对话", () => {
  it("explain-pop-ui 与 explain-card 在宿主切换后重新绑定选区、视口夹紧、剪贴板与 Esc/Tab 陷阱", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const { ids } = await import("../../extension/reader/state.js");
    const explainPop = await import("../../extension/reader/explain-pop-ui.js");
    const explainCard = await import("../../extension/reader/explain-card.js");

    mountReaderSkeleton(ids);
    const readingView = document.getElementById(ids.readingView)!;
    const subList = document.getElementById(ids.readingSubtitleList)!;
    subList.innerHTML = `<button type="button" class="biliscript-reading-item" data-index="0" data-seconds="5"><span class="biliscript-reading-time">00:05</span><span class="biliscript-reading-text">这是测试字幕正文内容</span></button>`;

    explainPop.bindReadingExplainEvents();

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedEventTarget = new EventTarget();
    const detachedClipboard = vi.fn().mockResolvedValue(undefined);
    const detachedWin = {
      closed: false,
      innerWidth: 380,
      innerHeight: 500,
      navigator: { clipboard: { writeText: detachedClipboard } },
      addEventListener: detachedEventTarget.addEventListener.bind(detachedEventTarget),
      removeEventListener: detachedEventTarget.removeEventListener.bind(detachedEventTarget),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(16);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
      getComputedStyle: window.getComputedStyle.bind(window),
      getSelection: () => null,
    } as unknown as Window;

    detachedDoc.body.appendChild(detachedDoc.adoptNode(readingView));
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);

    const textNode = detachedDoc.querySelector(".biliscript-reading-text")!.firstChild!;
    const range = detachedDoc.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    detachedWin.getSelection = () =>
      ({
        rangeCount: 1,
        toString: () => "这是测试",
        getRangeAt: () => range,
        removeAllRanges: vi.fn(),
      }) as unknown as Selection;

    const popEl = detachedDoc.getElementById(ids.readingExplainPop)!;
    if (!popEl.querySelector('[data-selection-action="copy-timestamp"]')) {
      const btn = detachedDoc.createElement("button");
      btn.type = "button";
      btn.dataset.selectionAction = "copy-timestamp";
      btn.textContent = "复制带时间戳";
      popEl.appendChild(btn);
    }
    detachedDoc.dispatchEvent(new Event("selectionchange"));
    expect(popEl.hidden).toBe(false);

    const copyBtn = popEl.querySelector<HTMLButtonElement>('[data-selection-action="copy-timestamp"]')!;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(detachedClipboard).toHaveBeenCalledWith("[0:05] 这是测试");

    explainCard.openReaderExplainCard({
      selection: "这是测试",
      line: "这是测试字幕正文内容",
      from: 5,
      index: 0,
    });
    expect(explainCard.isReaderExplainCardOpen()).toBe(true);

    detachedDoc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(explainCard.isReaderExplainCardOpen()).toBe(false);
  });

  it("quote-share-modal 与 quote-share-export 支持跨 Realm 按钮/Blob 与独立窗口剪贴板下载", async () => {
    realm = createDetachedRealm({ devicePixelRatio: 2 });
    const activeHost = await import("../../extension/shared/active-host.js");
    const { ids } = await import("../../extension/reader/state.js");
    const quoteModal = await import("../../extension/reader/quote-share-modal.js");
    const quoteExport = await import("../../extension/reader/quote-share-export.js");

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const MockClipboardItem = vi.fn(function (this: Record<string, unknown>, data: Record<string, unknown>) {
      this.data = data;
    });
    (realm.win as unknown as { ClipboardItem: unknown }).ClipboardItem = MockClipboardItem;

    const foreignBlob = {
      size: 8,
      type: "image/png",
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Blob;
    expect(foreignBlob instanceof window.Blob).toBe(false);

    const copied = await quoteExport.copyQuoteCardBlobToClipboard(foreignBlob);
    expect(copied).toBe(true);
    expect(MockClipboardItem).toHaveBeenCalledTimes(1);
    expect(realm.clipboardWrite).toHaveBeenCalledTimes(1);

    const createObjectURL = vi.fn(() => "blob:detached-png");
    const revokeObjectURL = vi.fn();
    (realm.win as unknown as { URL: unknown }).URL = { createObjectURL, revokeObjectURL };
    const detachedAppendSpy = vi.spyOn(realm.doc.body, "appendChild");
    vi.spyOn((realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    quoteExport.downloadQuoteCardBlob(foreignBlob, "quote.png");
    expect(createObjectURL).toHaveBeenCalledWith(foreignBlob);
    expect(detachedAppendSpy).toHaveBeenCalledTimes(1);

    quoteModal.openQuoteShareModal({ content: "跨 Realm 金句测试" });
    expect(quoteModal.isQuoteShareModalOpen()).toBe(true);
    const modalHost = readingView.querySelector(".biliscript-quote-share-host")!;
    expect(modalHost.ownerDocument).toBe(realm.doc);

    const copyImgBtn = modalHost.querySelector<HTMLButtonElement>('[data-action="copy-image"]')!;
    expect(copyImgBtn instanceof window.HTMLButtonElement).toBe(false);
    expect(copyImgBtn.disabled).toBe(false);

    quoteModal.closeQuoteShareModal({ restoreFocus: false });
  });

  it("command-palette 在 detached 宿主挂载并在宿主切换时自动收起", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { ids } = await import("../../extension/reader/state.js");
    const palette = await import("../../extension/reader/command-palette.js");

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);
    coreState.transitionReaderShell("open");
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    palette.openCommandPalette();
    expect(palette.isCommandPaletteOpen()).toBe(true);
    expect(readingView.querySelector("#biliscript-command-palette")?.ownerDocument).toBe(realm.doc);

    activeHost.resetActiveReaderHost();
    expect(palette.isCommandPaletteOpen()).toBe(false);
  });

  it("chat-tab 在已独立状态下首次懒加载不崩溃，且 chat-popovers/lists/live-records/scroll-follow 跨 Realm 安全", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const { ids } = await import("../../extension/reader/state.js");
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");

    uiRenderer.ensureUiReady({ forceRecreate: true });
    const openerReadingView = document.getElementById(ids.readingView)!;
    realm.doc.body.innerHTML = openerReadingView.outerHTML;
    openerReadingView.remove();

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const chatTab = await import("../../extension/reader/chat-tab.js");
    expect(chatTab.ensureChatTabActivated).toBeTypeOf("function");
    expect(chatTab.deactivateChatTabOverlays).toBeTypeOf("function");

    const { createReaderChatPopovers } = await import("../../extension/reader/chat-popovers.js");
    const historyPopover = realm.doc.createElement("div");
    historyPopover.id = ids.readingChatHistoryPopover;
    historyPopover.hidden = false;
    const innerItem = realm.doc.createElement("button");
    historyPopover.appendChild(innerItem);
    const modelPanel = realm.doc.createElement("div");
    modelPanel.hidden = true;
    const historyBtn = realm.doc.createElement("button");
    const modelChipBtn = realm.doc.createElement("button");
    realm.doc.body.append(historyPopover, modelPanel, historyBtn, modelChipBtn);

    expect(innerItem instanceof window.Element).toBe(false);
    const popovers = createReaderChatPopovers({
      historyPopover,
      modelPanel,
      historyBtn,
      modelChipBtn,
      renderHistoryList: vi.fn(),
      settlePendingDeletion: vi.fn(),
      renderModelPanel: vi.fn(),
    });
    popovers.handleDocumentClick({ target: innerItem } as unknown as MouseEvent);
    expect(historyPopover.hidden).toBe(false);

    const { createScrollFollowController } = await import("../../extension/reader/chat-scroll-follow.js");
    const messages = realm.doc.createElement("div");
    const scrollBottomBtn = realm.doc.createElement("button");
    const setAutoScroll = vi.fn();
    const scrollFollow = createScrollFollowController({
      messages,
      scrollBottomBtn,
      setAutoScroll,
      scrollToBottom: vi.fn(),
    });
    scrollFollow.bind();

    const foreignInput = realm.doc.createElement("input");
    messages.appendChild(foreignInput);
    expect(foreignInput instanceof window.HTMLInputElement).toBe(false);
    foreignInput.dispatchEvent(
      new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
      })
    );
    expect(setAutoScroll).not.toHaveBeenCalled();

    const { createChatLiveTextRecords } = await import("../../extension/reader/chat-live-text-records.js");
    const liveRoot = realm.doc.createElement("div");
    const onRetry = vi.fn();
    const liveRecords = createChatLiveTextRecords({
      root: liveRoot,
      getRecords: () => [
        {
          callId: "c1",
          source: "gemini",
          objective: "分析",
          status: "failed",
          error: "err",
        } as never,
      ],
      subscribe: () => () => {},
      onRetry,
      onContinue: vi.fn(),
    });
    liveRecords.setOpen(true);
    const retryBtn = liveRoot.querySelector<HTMLButtonElement>('button[data-live-record-action="retry"]')!;
    expect(retryBtn instanceof window.Element).toBe(false);
    retryBtn.click();
    expect(onRetry).toHaveBeenCalledWith("c1");
  });

  it("downloadQuoteCardBlob 在死亡窗口 URL.revokeObjectURL 抛错且定时回退时不会崩溃", async () => {
    vi.useFakeTimers();
    try {
      realm = createDetachedRealm();
      const activeHost = await import("../../extension/shared/active-host.js");
      const quoteExport = await import("../../extension/reader/quote-share-export.js");

      activeHost.setActiveReaderHost(realm.doc, realm.win);
      const revokeSpy = vi.fn(() => {
        throw new Error("Dead XrayWrapper: revokeObjectURL");
      });
      (realm.win as unknown as { URL: unknown }).URL = {
        createObjectURL: vi.fn(() => "blob:dead-test"),
        revokeObjectURL: revokeSpy,
      };
      realm.win.setTimeout = (() => {
        throw new Error("Dead XrayWrapper: setTimeout");
      }) as unknown as Window["setTimeout"];
      vi.spyOn((realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

      const foreignBlob = { size: 4, type: "image/png", arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Blob;
      quoteExport.downloadQuoteCardBlob(foreignBlob, "dead.png");
      expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
      expect(revokeSpy).toHaveBeenCalledWith("blob:dead-test");
    } finally {
      vi.useRealTimers();
    }
  });

  it("quote-share-modal 与 command-palette 在死亡窗口 / 非 readingView 容器切换时安全收口并重建", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { ids } = await import("../../extension/reader/state.js");
    const quoteModal = await import("../../extension/reader/quote-share-modal.js");
    const palette = await import("../../extension/reader/command-palette.js");

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);
    coreState.transitionReaderShell("open");
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    realm.win.matchMedia = (() => {
      throw new Error("Dead XrayWrapper: matchMedia");
    }) as unknown as Window["matchMedia"];

    quoteModal.openQuoteShareModal({ content: "测试金句" });
    expect(quoteModal.isQuoteShareModalOpen()).toBe(true);
    expect(() => quoteModal.closeQuoteShareModal({ restoreFocus: false })).not.toThrow();

    palette.openCommandPalette();
    expect(palette.isCommandPaletteOpen()).toBe(true);

    const openerView = document.createElement("div");
    openerView.id = ids.readingView;
    document.body.appendChild(openerView);
    activeHost.resetActiveReaderHost();
    expect(palette.isCommandPaletteOpen()).toBe(false);

    palette.openCommandPalette();
    expect(palette.isCommandPaletteOpen()).toBe(true);
    expect(openerView.querySelector("#biliscript-command-palette")?.ownerDocument).toBe(document);
    palette.closeCommandPalette();
  });

  it("chat-tab-composer 在跨 Realm 拒绝恢复草稿时安全派发 input 事件", async () => {
    realm = createDetachedRealm();
    const { createReaderChatComposer } = await import("../../extension/reader/chat-tab-composer.js");

    const input = realm.doc.createElement("textarea");
    input.value = "保留草稿";
    const sendBtn = realm.doc.createElement("button");
    realm.doc.body.append(input, sendBtn);

    const onInput = vi.fn();
    input.addEventListener("input", onInput);

    const composer = createReaderChatComposer({
      input,
      sendBtn,
      chatRuntime: {
        sendTurn: vi.fn().mockResolvedValue("rejected"),
        isTurnActive: () => false,
        stopActiveStream: vi.fn(),
      },
    });

    const ok = await composer.sendViaInputBox("自动问题", { restoreOnReject: true });
    expect(ok).toBe(false);
    expect(input.value).toBe("保留草稿");
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("token-stream、thinking-buffer 与 replay 在 opener rAF 挂起时切换宿主可取消旧帧并在 detached 窗口完成渲染", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const { createTokenStreamController } = await import("../../extension/chat/render/token-stream.js");
    const { createThinkingBufferController } = await import("../../extension/chat/render/thinking-buffer.js");
    const { createConversationReplay } = await import("../../extension/chat/replay.js");
    const { applyConversationIdentity } = await import("../../extension/chat/chat-state.js");

    const openerRafQueue = new Map<number, FrameRequestCallback>();
    let nextOpenerId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      const id = nextOpenerId++;
      openerRafQueue.set(id, cb);
      return id;
    });
    const openerCancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      openerRafQueue.delete(id);
    });

    const detachedRafQueue = new Map<number, FrameRequestCallback>();
    let nextDetachedId = 1;
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = {
      closed: false,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
        const id = nextDetachedId++;
        detachedRafQueue.set(id, cb);
        return id;
      }),
      cancelAnimationFrame: vi.fn((id: number) => {
        detachedRafQueue.delete(id);
      }),
    } as unknown as Window;

    const tokenHost = document.createElement("div");
    const thinkEl = document.createElement("div");
    document.body.append(tokenHost, thinkEl);

    const stream = createTokenStreamController({
      isSmoothStream: () => false,
      scrollToBottom: vi.fn(),
      onBodyStart: vi.fn(),
    });
    const thinking = createThinkingBufferController({
      scrollToBottom: vi.fn(),
    });

    applyConversationIdentity({ history: [{ role: "user", content: "hi" }] });
    const replaySetAutoScroll = vi.fn();
    const replayScrollToBottom = vi.fn();
    const replay = createConversationReplay({
      renderer: {
        messageArea: {
          clear: vi.fn(),
          appendUserMessage: vi.fn(),
          appendAssistantMessage: vi.fn(),
        } as never,
        setAutoScroll: replaySetAutoScroll,
        scrollToBottom: replayScrollToBottom,
      },
      updateLayout: vi.fn(),
      clearSuggestions: vi.fn(),
    });

    stream.appendToken(tokenHost, "Hello ");
    thinking.append(thinkEl, "Step 1 ");
    replay.render();
    await vi.waitFor(() => {
      expect(openerRafQueue.size).toBe(3);
    });

    detachedDoc.body.appendChild(detachedDoc.adoptNode(tokenHost));
    detachedDoc.body.appendChild(detachedDoc.adoptNode(thinkEl));
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);

    expect(openerCancelSpy).toHaveBeenCalledTimes(3);
    expect(openerRafQueue.size).toBe(0);
    expect(detachedRafQueue.size).toBe(3);

    stream.appendToken(tokenHost, "Detached!");
    thinking.append(thinkEl, "Step 2");

    const callbacks = Array.from(detachedRafQueue.values());
    detachedRafQueue.clear();
    callbacks.forEach((cb) => cb(32));

    await expect(
      Promise.race([
        replay.inFlight!.then(() => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200)),
      ])
    ).resolves.toBe("settled");

    await vi.waitFor(() => {
      expect(tokenHost.textContent).toContain("Hello Detached!");
    });
    expect(thinkEl.textContent).toBe("Step 1 Step 2");
    expect(replaySetAutoScroll).toHaveBeenCalledWith(true);
    expect(replayScrollToBottom).toHaveBeenCalledWith(true, { instant: true });
  });

  it("quote-share-modal 在 host.isConnected 与 remove 抛错时仍通过宿主切换安全关闭", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { ids } = await import("../../extension/reader/state.js");
    const quoteModal = await import("../../extension/reader/quote-share-modal.js");

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);
    coreState.transitionReaderShell("open");
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    quoteModal.openQuoteShareModal({ content: "死亡宿主金句测试" });
    expect(quoteModal.isQuoteShareModalOpen()).toBe(true);

    const modalHost = readingView.querySelector<HTMLElement>(".biliscript-quote-share-host")!;
    Object.defineProperty(modalHost, "isConnected", {
      get() {
        throw new Error("Dead XrayWrapper: isConnected");
      },
      configurable: true,
    });
    modalHost.remove = () => {
      throw new Error("Dead XrayWrapper: remove");
    };
    realm.win.matchMedia = (() => {
      throw new Error("Dead XrayWrapper: matchMedia");
    }) as unknown as Window["matchMedia"];

    expect(() => activeHost.resetActiveReaderHost()).not.toThrow();
    expect(quoteModal.isQuoteShareModalOpen()).toBe(false);
  });
});
