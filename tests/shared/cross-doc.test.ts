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

describe("cross-doc 跨文档与跨 Realm 工具", () => {
  it("跨 Realm 节点与 Blob/DOMException 类型守卫不依赖全局 instanceof", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const crossDoc = await import("../../extension/shared/cross-doc.js");
    const domUtils = await import("../../extension/shared/dom-utils.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const foreignButton = realm.doc.createElement("button");
    const foreignInput = realm.doc.createElement("input");
    const foreignDiv = realm.doc.createElement("div");
    foreignDiv.contentEditable = "true";
    const foreignText = realm.doc.createTextNode("hello");

    expect(foreignButton instanceof window.HTMLElement).toBe(false);
    expect(foreignButton instanceof window.HTMLButtonElement).toBe(false);
    expect(foreignText instanceof window.Text).toBe(false);

    expect(crossDoc.isNode(foreignButton)).toBe(true);
    expect(crossDoc.isElementNode(foreignButton)).toBe(true);
    expect(crossDoc.isHtmlElement(foreignButton)).toBe(true);
    expect(crossDoc.isHtmlButton(foreignButton)).toBe(true);
    expect(crossDoc.isTagElement(foreignInput, "input")).toBe(true);
    expect(crossDoc.isEditableTarget(foreignInput)).toBe(true);
    expect(crossDoc.isEditableTarget(foreignDiv)).toBe(true);
    expect(crossDoc.isEditableTarget(foreignButton)).toBe(false);
    expect(crossDoc.isTextNode(foreignText)).toBe(true);
    expect(crossDoc.isNode(null)).toBe(false);
    expect(crossDoc.isElementNode(foreignText)).toBe(false);

    expect(crossDoc.resolveNodeDocument(foreignButton)).toBe(realm.doc);
    expect(crossDoc.resolveNodeWindow(foreignButton)).toBe(realm.win);

    const ForeignDomException = (realm.win as unknown as { DOMException: typeof DOMException }).DOMException;
    const foreignDomEx = new ForeignDomException("not found", "NotFoundError");
    expect(foreignDomEx instanceof DOMException).toBe(false);
    expect(domUtils.isDomExceptionNamed(foreignDomEx, ["NotFoundError", "InvalidStateError"])).toBe(true);
    expect(domUtils.isDomExceptionNamed(new Error("NotFoundError"), ["NotFoundError"])).toBe(false);

    const foreignBlobLike = { size: 4, type: "image/png", arrayBuffer: async () => new ArrayBuffer(4) };
    expect(crossDoc.isBlobLike(foreignBlobLike)).toBe(true);
    expect(crossDoc.isBlobLike({ size: "bad" })).toBe(false);
  });

  it("requireActiveById、isVisibleReaderControl 与 safeRemoveListener 在 detached 宿主与死亡对象上安全工作", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const crossDoc = await import("../../extension/shared/cross-doc.js");
    const domUtils = await import("../../extension/shared/dom-utils.js");

    const panel = realm.doc.createElement("div");
    panel.id = "detached-panel";
    realm.doc.body.appendChild(panel);
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    expect(crossDoc.requireActiveById("detached-panel")).toBe(panel);
    expect(() => crossDoc.requireActiveById("missing-node")).toThrow("Missing node: missing-node");

    const getComputedSpy = vi.spyOn(realm.win, "getComputedStyle").mockReturnValue({
      display: "block",
      visibility: "visible",
      pointerEvents: "auto",
    } as CSSStyleDeclaration);
    expect(domUtils.isVisibleReaderControl(panel)).toBe(true);
    expect(getComputedSpy).toHaveBeenCalledWith(panel);

    const deadDoc = {
      removeEventListener() {
        throw new TypeError("can't access dead object");
      },
    } as unknown as Document;
    expect(() => crossDoc.safeRemoveListener(deadDoc, "keydown", () => {}, true)).not.toThrow();
  });

  it("writeActiveClipboardText 优先写入活跃窗口剪贴板，并在失败时回退 opener", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const crossDoc = await import("../../extension/shared/cross-doc.js");

    const openerWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: openerWrite },
      configurable: true,
    });

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    await crossDoc.writeActiveClipboardText("detached text");
    expect(realm.clipboardWriteText).toHaveBeenCalledWith("detached text");
    expect(openerWrite).not.toHaveBeenCalled();

    realm.clipboardWriteText.mockRejectedValueOnce(new Error("Document is not focused"));
    await crossDoc.writeActiveClipboardText("fallback text");
    expect(openerWrite).toHaveBeenCalledWith("fallback text");
  });

  it("scheduleActiveAnimationFrame 在签发窗口调度并在同一窗口安全取消", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const crossDoc = await import("../../extension/shared/cross-doc.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const cb = vi.fn();
    const handle = crossDoc.scheduleActiveAnimationFrame(cb);
    expect(handle.window).toBe(realm.win);
    expect(realm.rafQueue.size).toBe(1);

    handle.cancel();
    expect(realm.win.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(realm.rafQueue.size).toBe(0);

    const deadWin = {
      requestAnimationFrame: () => 42,
      cancelAnimationFrame: () => {
        throw new TypeError("can't access dead object");
      },
    } as unknown as Window;
    const deadHandle = crossDoc.scheduleActiveAnimationFrame(cb, deadWin);
    expect(() => deadHandle.cancel()).not.toThrow();
  });

  it("createActiveEvent、dispatchCrossDocEvent 与 prefersActiveReducedMotion 兼容跨 Realm 与死亡窗口", async () => {
    realm = createDetachedRealm({ reducedMotion: true });
    const activeHost = await import("../../extension/shared/active-host.js");
    const crossDoc = await import("../../extension/shared/cross-doc.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const input = realm.doc.createElement("input");
    realm.doc.body.appendChild(input);

    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    const ForeignEventCtor = (realm.win as unknown as { Event: typeof Event }).Event;
    const created = crossDoc.createActiveEvent("input", { bubbles: true }, input);
    expect(created instanceof ForeignEventCtor).toBe(true);
    expect(crossDoc.dispatchCrossDocEvent(input, "input", { bubbles: true })).toBe(true);
    expect(onInput).toHaveBeenCalledTimes(1);

    expect(crossDoc.prefersActiveReducedMotion(input)).toBe(true);
    realm.win.matchMedia = (() => {
      throw new Error("Dead XrayWrapper: matchMedia");
    }) as unknown as Window["matchMedia"];
    expect(crossDoc.prefersActiveReducedMotion(input)).toBe(false);

    Object.defineProperty(realm.win, "closed", { value: true, configurable: true });
    expect(crossDoc.prefersActiveReducedMotion(input)).toBe(false);
  });
});
