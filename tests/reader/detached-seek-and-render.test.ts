import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
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

describe("reader 独立宿主：时间戳跳转无抢焦、rAF 批渲染迁移、字幕 Tab 与调试快照", () => {
  it("独立窗口内选区拦截跳转，点击时间戳操作 opener video 且不调用 opener window.focus()", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { ids } = await import("../../extension/reader/state.js");
    const syncMod = await import("../../extension/reader/sync.js");
    const viewRender = await import("../../extension/reader/view-render.js");
    const videoBind = await import("../../extension/reader/video-bind.js");

    const video = mountPlayerChain();
    mockPlayerRects();
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];
    const openerFocusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});

    mountReaderSkeleton(ids);
    const readingView = document.getElementById(ids.readingView)!;
    realm.doc.body.innerHTML = readingView.outerHTML;
    readingView.remove();

    (coreState.state.clip as unknown as { subtitleBody: Array<{ from: number; to: number; content: string }> }).subtitleBody = [
      { from: 0, to: 10, content: "第一句" },
      { from: 10, to: 20, content: "第二句" },
    ];
    coreState.transitionReaderShell("open");
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    videoBind.bindReadingViewVideo(video);
    const view = viewRender.createViewRender({ sessionProjections: [] });
    view.projections
      .filter((projection) => projection.id !== "presentation")
      .forEach((projection) => projection.project());

    const subtitleList = realm.doc.getElementById(ids.readingSubtitleList)!;
    subtitleList.addEventListener("click", syncMod.onReadingSubtitleClick);
    const item = realm.doc.querySelector<HTMLElement>('.biliscript-reading-item[data-index="1"]')!;
    expect(item).not.toBeNull();

    vi.spyOn(realm.win, "getSelection").mockReturnValue({
      toString: () => "选中文本",
    } as unknown as Selection);
    syncMod.markSubtitlePointerDownSelection();
    item.dispatchEvent(
      new (realm.win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
        bubbles: true,
      })
    );
    expect(video.currentTime).toBe(0);

    vi.spyOn(realm.win, "getSelection").mockReturnValue({
      toString: () => "",
    } as unknown as Selection);
    syncMod.markSubtitlePointerDownSelection();
    item.dispatchEvent(
      new (realm.win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
        bubbles: true,
      })
    );
    expect(video.currentTime).toBe(10);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(openerFocusSpy).not.toHaveBeenCalled();
  });

  it("batched-render 在 detached 窗口调度 rAF 并在宿主切换时迁移未完成帧", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const batched = await import("../../extension/reader/batched-render.js");

    const list = realm.doc.createElement("div");
    realm.doc.body.appendChild(list);
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const items = Array.from({ length: 260 }, (_, idx) => ({
      index: idx,
      from: idx * 2,
      to: idx * 2 + 1,
      content: `字幕 ${idx}`,
    }));

    batched.startReadingSubtitleAppendTask({
      listEl: list,
      items,
      cursor: 20,
      withHours: false,
    });
    expect(realm.rafQueue.size).toBe(1);

    const realm2 = createDetachedRealm();
    activeHost.setActiveReaderHost(realm2.doc, realm2.win);
    expect(realm.win.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(realm.rafQueue.size).toBe(0);
    expect(realm2.rafQueue.size).toBe(1);

    realm2.flushRaf(32);
    expect(list.children.length).toBeGreaterThan(0);

    batched.cancelReadingSubtitleAppend();
    realm2.close();
  });

  it("subtitle-tab-ui 的 Ctrl+F 快捷键、pointerup 释放、跨 Realm 动作按钮与编辑态守卫在宿主切换后生效", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { ids, setReaderActiveScriptTab } = await import("../../extension/reader/state.js");
    const subtitleTab = await import("../../extension/reader/subtitle-tab-ui.js");
    const { subtitleScrollFollow } = await import("../../extension/reader/subtitle-scroll-follow.js");
    const transcribeBanner = await import("../../extension/reader/transcribe-banner.js");
    const subtitleNotice = await import("../../extension/reader/subtitle-notice.js");
    const snapshotMod = await import("../../extension/reader/debug-snapshot.js");

    mountPlayerChain();
    mockPlayerRects();
    mountReaderSkeleton(ids);
    const readingView = document.getElementById(ids.readingView)!;
    const subBody = document.getElementById(ids.readingTabBodySubtitle)!;
    subBody.hidden = false;
    subBody.classList.add("is-active");
    coreState.transitionReaderShell("open");
    setReaderActiveScriptTab("subtitle");

    subtitleTab.bindSubtitleTabEvents();

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedEventTarget = new EventTarget();
    const detachedWin = {
      closed: false,
      addEventListener: detachedEventTarget.addEventListener.bind(detachedEventTarget),
      removeEventListener: detachedEventTarget.removeEventListener.bind(detachedEventTarget),
      dispatchEvent: detachedEventTarget.dispatchEvent.bind(detachedEventTarget),
      getSelection: () => null,
      getComputedStyle: window.getComputedStyle.bind(window),
    } as unknown as Window;

    detachedDoc.body.appendChild(detachedDoc.adoptNode(readingView));
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);

    const searchInput = detachedDoc.getElementById(ids.readingSearchInput) as HTMLInputElement;
    const focusSpy = vi.spyOn(searchInput, "focus");
    const selectSpy = vi.spyOn(searchInput, "select");
    detachedDoc.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledTimes(1);

    subtitleScrollFollow.handlePointerDown({ isDirectContainer: true, isScrollbar: true, canScroll: true });
    expect(subtitleScrollFollow.isManualPaused()).toBe(true);
    detachedEventTarget.dispatchEvent(new Event("pointerup"));

    const { publishSubtitleStatusPhase } = await import("../../extension/shared/subtitle-status-bus.js");
    (coreState.state.ui as unknown as { statusText: string }).statusText = "转写进度 50%";
    publishSubtitleStatusPhase("asr-transcribing");
    transcribeBanner.updateReadingTranscribeBanner();
    expect(detachedDoc.getElementById(ids.readingTranscribeProgress)?.textContent).toBe("转写进度 50%");

    subtitleNotice.showSubtitleNotice("独立窗口提示");
    const noticeEl = detachedDoc.getElementById(ids.readingSubtitleNotice)!;
    expect(noticeEl.hidden).toBe(false);
    expect(noticeEl.textContent).toBe("独立窗口提示");

    const snap = snapshotMod.createReaderDebugSnapshot("detached-check");
    expect(snap.readingDetached).toBe(true);
    expect(snap.hasReadingView).toBe(true);
    expect(snap.nodes.length).toBeGreaterThan(0);

    realm = createDetachedRealm();
    const foreignInput = realm.doc.createElement("input");
    const subtitleList = detachedDoc.getElementById(ids.readingSubtitleList)!;
    expect(foreignInput instanceof window.HTMLInputElement).toBe(false);
    const { isEditableTarget } = await import("../../extension/shared/cross-doc.js");
    expect(isEditableTarget(foreignInput)).toBe(true);
    expect(subtitleList.ownerDocument).toBe(detachedDoc);
  });

  it("explain-pop-ui 与 subtitle-tab-ui 在 setActiveReaderHost 先于 adoptNode 调用时仍能绑定到新宿主", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { ids, setReaderActiveScriptTab } = await import("../../extension/reader/state.js");
    const subtitleTab = await import("../../extension/reader/subtitle-tab-ui.js");
    const explainPop = await import("../../extension/reader/explain-pop-ui.js");

    mountPlayerChain();
    mockPlayerRects();
    mountReaderSkeleton(ids);
    const readingView = document.getElementById(ids.readingView)!;
    const subBody = document.getElementById(ids.readingTabBodySubtitle)!;
    subBody.hidden = false;
    subBody.classList.add("is-active");
    coreState.transitionReaderShell("open");
    setReaderActiveScriptTab("subtitle");

    subtitleTab.bindSubtitleTabEvents();
    explainPop.bindReadingExplainEvents();

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedEventTarget = new EventTarget();
    const detachedWin = {
      closed: false,
      innerWidth: 420,
      innerHeight: 560,
      addEventListener: detachedEventTarget.addEventListener.bind(detachedEventTarget),
      removeEventListener: detachedEventTarget.removeEventListener.bind(detachedEventTarget),
      dispatchEvent: detachedEventTarget.dispatchEvent.bind(detachedEventTarget),
      getSelection: () => null,
      getComputedStyle: window.getComputedStyle.bind(window),
    } as unknown as Window;

    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    detachedDoc.body.appendChild(detachedDoc.adoptNode(readingView));

    const searchInput = detachedDoc.getElementById(ids.readingSearchInput) as HTMLInputElement;
    const focusSpy = vi.spyOn(searchInput, "focus");
    detachedDoc.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("chat-scroll-follow 在 opener rAF 挂起期间切换宿主后取消旧帧并在 detached 窗口刷新", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const { createScrollFollowController } = await import("../../extension/reader/chat-scroll-follow.js");

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
      requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
        const id = nextDetachedId++;
        detachedRafQueue.set(id, cb);
        return id;
      }),
      cancelAnimationFrame: vi.fn((id: number) => {
        detachedRafQueue.delete(id);
      }),
    } as unknown as Window;

    const messages = document.createElement("div");
    const scrollBottomBtn = document.createElement("button");
    scrollBottomBtn.hidden = true;
    document.body.append(messages, scrollBottomBtn);

    const setAutoScroll = vi.fn();
    const ctrl = createScrollFollowController({
      messages,
      scrollBottomBtn,
      getBottomOffset: () => 200,
      setAutoScroll,
      scrollToBottom: vi.fn(),
    });

    ctrl.notifyScrolled();
    expect(openerRafQueue.size).toBe(1);

    detachedDoc.body.appendChild(detachedDoc.adoptNode(messages));
    detachedDoc.body.appendChild(detachedDoc.adoptNode(scrollBottomBtn));
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);

    expect(openerCancelSpy).toHaveBeenCalledTimes(1);
    expect(openerRafQueue.size).toBe(0);
    expect(detachedRafQueue.size).toBe(1);

    const callbacks = Array.from(detachedRafQueue.values());
    detachedRafQueue.clear();
    callbacks.forEach((cb) => cb(32));

    expect(setAutoScroll).toHaveBeenCalledWith(false);
    expect(scrollBottomBtn.hidden).toBe(false);
  });
});
