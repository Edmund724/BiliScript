import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";
import { mockPlayerRects, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import { ids } from "../../extension/reader/state.js";
import type { TestState } from "./reader-test-env.js";

type ScriptHost = typeof import("../../extension/reader/script-host.js");
type Lifecycle = typeof import("../../extension/reader/lifecycle.js");

let scriptHost: ScriptHost;
let lifecycle: Lifecycle;
let state: TestState;

function makeRect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  };
}

function mountAnchor(selector: string, rect: ReturnType<typeof makeRect>): HTMLElement {
  const node = document.createElement("div");
  if (selector.startsWith("#")) {
    node.id = selector.slice(1);
  } else {
    node.className = selector.slice(1);
  }
  node.getBoundingClientRect = () => rect as DOMRect;
  document.body.appendChild(node);
  return node;
}

function readingView(): HTMLElement {
  const node = document.getElementById(ids.readingView);
  if (!node) {
    throw new Error("missing #biliscript-reading-view");
  }
  return node as HTMLElement;
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  window.innerWidth = 1920;

  state = (await import("../../extension/core/state.js")).state as TestState;
  mountReaderSkeleton(ids);

  scriptHost = await import("../../extension/reader/script-host.js");
  lifecycle = await import("../../extension/reader/lifecycle.js");
});

afterEach(() => {
  try {
    lifecycle?.closeReadingView();
  } catch {
  }
  scriptHost?.closeScriptHost();
  document.body.innerHTML = "";
  window.innerWidth = 1024;
  vi.restoreAllMocks();
});

describe("进入视频页自动展开 / 直达时，首载无锚点瞬态防闪烁", () => {
  it("waitForScriptAnchor：宽屏已存在锚点时立即放行", async () => {
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    const ready = await scriptHost.waitForScriptAnchor(500);
    expect(ready).toBe(true);
  });

  it("waitForScriptAnchor：窄屏（<1000px）无需等待立即放行", async () => {
    window.innerWidth = 900;
    const ready = await scriptHost.waitForScriptAnchor(500);
    expect(ready).toBe(true);
  });

  it("waitForScriptAnchor：宽屏初载无锚点时等待，锚点挂载后立即放行", async () => {
    const promise = scriptHost.waitForScriptAnchor(1000);

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 60));
    expect(resolved).toBe(false);

    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));

    const ready = await promise;
    expect(ready).toBe(true);
  });

  it("enterReaderMode：宽屏首载 DOM 水合期间不提前展开居中浮层，锚点就绪后直接落位贴栏", async () => {
    const enterPromise = lifecycle.enterReaderMode();

    const view = readingView();

    expect(view.classList.contains("open")).toBe(false);
    expect(view.getAttribute("data-biliscript-script-float")).toBeNull();

    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));

    await enterPromise;

    expect(view.classList.contains("open")).toBe(true);
    expect(view.getAttribute("data-biliscript-script-float")).toBeNull();
    expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1380px");
    expect(view.getAttribute("data-biliscript-reader-ready")).toBe("1");
  });

  it("enterReaderMode：超时未等到锚点时兜底放行降级为居中浮层", async () => {
    await lifecycle.enterReaderMode();
    const view = readingView();
    expect(view.classList.contains("open")).toBe(true);
  });
});
