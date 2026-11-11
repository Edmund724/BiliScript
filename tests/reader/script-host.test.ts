// script-host 右栏定位器测试。
//
// 覆盖：锚点优先级命中与变量写入（贴栏宽度为显式自定义值，无自定义默认 540px，
// 贴视口右界；纵向钳进一屏）、隐藏副本跳过、播放器贴右缘降级（自定义宽度收缩、
// 可用不足 300px 降浮层）、浮层降级（属性 + 可选 --biliscript-script-float-width）、
// 窄窗浮层（999/1000 边界）、贴栏↔浮层双向切换、2s 自查重锚、close 拆除与变量清除。
//
// 注意：setup.ts 给 Element.prototype.getBoundingClientRect 打了「恒返回
// 800x450」的默认补丁——不覆盖它会让锚点判定/降级分支全部走不到，测试假绿。
// 本文件所有涉及 rect 判定的元素都在用例内显式 stub。jsdom 下
// documentElement.clientWidth 恒 0，视口右界回落 innerWidth（1920）；
// innerHeight 用 jsdom 默认 768。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetModuleState, setLocationUrl } from "../setup.js";
import { READER_MODE_URL } from "../setup.js";

type ScriptHost = typeof import("../../extension/reader/script-host.js");
type CoreState = typeof import("../../extension/core/state.js");

let scriptHost: ScriptHost;
// 每用例动态 import 的 state（与 script-host 同一模块图）：resetModuleState 会
// 清掉 __BILISCRIPT_STATE__ 共享槽，文件级静态 import 的 state 会指向旧槽对象，
// patchSettings 写的和 script-host 读的不是同一份。
let coreState: CoreState;

// 右栏锚点六个选择器对应的可命中节点，按需在用例里往 body 挂。
const ANCHOR_SELECTORS = [
  ".right-container-inner",
  ".right-container",
  ".playlist-container--right",
  "#reco_list",
  "#viewbox_report",
  ".up-info-container"
];

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

// 给指定选择器创建节点并 stub rect；挂在 body 下（script-host 只读不插）。
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

// 搭最小播放器链（video → 宿主链），让 video-probe 的 findReaderPlayerHost 命中。
function mountPlayerChain(playerRect: ReturnType<typeof makeRect>) {
  const host = document.createElement("div");
  host.className = "bpx-player-container";
  host.getBoundingClientRect = () => playerRect as DOMRect;
  const video = document.createElement("video");
  host.appendChild(video);
  document.body.appendChild(host);
  return { host, video };
}

function readingView(): HTMLElement {
  const node = document.getElementById("biliscript-reading-view");
  if (!node) {
    throw new Error("missing #biliscript-reading-view");
  }
  return node as HTMLElement;
}

function vars(el: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["left", "top", "width", "height"]) {
    result[name] = el.style.getPropertyValue(`--biliscript-script-${name}`);
  }
  return result;
}

// 浮层形态的自定义宽度变量（仅显式自定义时写入）。
function floatWidthVar(el: HTMLElement): string {
  return el.style.getPropertyValue("--biliscript-script-float-width");
}

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  coreState = await import("../../extension/core/state.js");
  scriptHost = await import("../../extension/reader/script-host.js");
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];

  readonly callback: ResizeObserverCallback;
  observed: Element[] = [];
  readonly observeCalls: Element[] = [];
  readonly unobserveCalls: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    if (!this.observed.includes(target)) {
      this.observed.push(target);
    }
    this.observeCalls.push(target);
  }

  unobserve(target: Element): void {
    this.unobserveCalls.push(target);
    this.observed = this.observed.filter((observed) => observed !== target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed = [];
  }

  emit(): void {
    this.callback([], {} as ResizeObserver);
  }
}

function installTestResizeObserver(): typeof TestResizeObserver {
  TestResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  return TestResizeObserver;
}

beforeEach(() => {
  resetModuleState();
  installTestResizeObserver();
  document.body.innerHTML = "";
  window.innerWidth = 1920;
  // 定位写组的目标元素（真实页面由 ui-renderer 挂在 body 下）。
  const view = document.createElement("div");
  view.id = "biliscript-reading-view";
  document.body.appendChild(view);
  // 锚点不在 beforeEach 统一挂载：querySelector 按 DOM 顺序取首个命中，
  // 统一挂默认锚点会抢走各用例自建锚点的优先级，各用例按需显式 mount。
});

// fake timers 下 rAF 也被 mock，不会自动触发；换成同步执行保证
// scheduleScriptLayout 的合帧回调在断言前跑完。
function runRafSynchronously() {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
}

afterEach(async () => {
  scriptHost?.closeScriptHost();
  document.body.innerHTML = "";
  window.innerWidth = 1024;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("script-host 锚点命中", () => {
  it.each([
    [".right-container-inner", "新版播放页"],
    [".right-container", "外层兜底"],
    [".playlist-container--right", "合集/列表态"],
    ["#reco_list", "旧版播放页"],
    ["#viewbox_report", "旧版无推荐列表"],
    [".up-info-container", "旧版无推荐列表兜底"]
  ])("优先级锚点 %s（%s）命中时写入四个变量", async (selector) => {
    await loadModules();
    const rect = makeRect(1520, 80, 360, 2000);
    mountAnchor(selector, rect);

    scriptHost.openScriptHost();

    const el = readingView();
    expect(el.getAttribute("data-biliscript-script-float")).toBe(null);
    // 贴栏宽度由 getTargetPanelWidth() 决定（默认 540px），贴视口右界：
    // left = 1920 - 540 = 1380；纵向钳进一屏（top 80，height = 768 - 80）。
    expect(vars(el)).toEqual({
      left: "1380px",
      top: "80px",
      width: "540px",
      height: "688px"
    });
  });

  it("优先级：高优先锚点存在时跳过低优先锚点", async () => {
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    mountAnchor("#reco_list", makeRect(1500, 100, 340, 1500));

    scriptHost.openScriptHost();

    // 高优先锚点命中且贴视口右界：宽默认 540px。
    expect(vars(readingView()).width).toBe("540px");
  });

  it("可填宽度不足下限 380：左缘左移补足", async () => {
    await loadModules();
    // 锚点左缘 1640：可填宽 1920-1640=280 < 380 → 左缘左移到 1920-380=1540，
    // 宽度恒为 380。
    mountAnchor(".right-container-inner", makeRect(1640, 80, 280, 2000));

    scriptHost.openScriptHost();
    expect(vars(readingView())).toEqual({
      left: "1380px",
      top: "80px",
      width: "540px",
      height: "688px"
    });
  });

  it("视口右界用 clientWidth（不含经典滚动条）：页面滚动条带不被覆盖", async () => {
    await loadModules();
    // innerWidth 1920 含 20px 经典滚动条 → clientWidth 1900。
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1900);
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));

    scriptHost.openScriptHost();
    expect(vars(readingView())).toEqual({
      left: "1360px",
      top: "80px",
      width: "540px",
      height: "688px"
    });
  });

  it("锚点滚出视口顶（top 为负）：面板顶钳到 0、高度撑满一屏", async () => {
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, -300, 360, 2000));

    scriptHost.openScriptHost();
    expect(vars(readingView())).toEqual({
      left: "1380px",
      top: "0px",
      width: "540px",
      height: "768px"
    });
    expect(anchor).toBeTruthy();
  });

  it("锚点 rect.right 超出视口的候选被跳过，落到下一个有效候选", async () => {
    await loadModules();
    // 1920 视口，第一个锚点右缘 2000 出界；第二个有效。
    const outOfViewport = mountAnchor(".right-container-inner", makeRect(1640, 80, 360, 2000));
    document.body.appendChild(outOfViewport);
    mountAnchor(".right-container", makeRect(1520, 80, 360, 2000));

    scriptHost.openScriptHost();

    expect(vars(readingView()).top).toBe("80px");
  });
});

describe("script-host 隐藏副本跳过", () => {
  it("width 0 的隐藏高优先锚点被跳过，落到次优先有效锚点", async () => {
    await loadModules();
    const hidden = mountAnchor(".right-container-inner", makeRect(0, 0, 0, 0));
    document.body.appendChild(hidden);
    mountAnchor(".right-container", makeRect(1520, 80, 360, 2000));

    scriptHost.openScriptHost();

    expect(vars(readingView()).top).toBe("80px");
  });

  it("全部锚点均为隐藏副本（width 0）→ 降级贴播放器右缘", async () => {
    await loadModules();
    const hidden = [];
    for (const selector of ANCHOR_SELECTORS) {
      hidden.push(mountAnchor(selector, makeRect(0, 0, 0, 0)));
    }
    // 高优先隐藏锚点插在 body 尾部，确保排序不是按 DOM 顺序撞对结果。
    hidden.forEach((node) => document.body.appendChild(node));
    mountPlayerChain(makeRect(0, 80, 1000, 560));

    scriptHost.openScriptHost();

    // left = 1000 + 12 = 1012，宽 = 1920 - 1012 = 908（占满到视口右界），
    // 纵向钳进一屏（top 80，height = 768 - 80）。
    expect(vars(readingView())).toEqual({
      left: "1012px",
      top: "80px",
      width: "908px",
      height: "688px"
    });
  });
});

describe("script-host 降级链", () => {
  it("锚点全落空但有播放器：面板占「播放器右缘 + 12 → 视口右界」，纵向钳进一屏", async () => {
    await loadModules();
    mountPlayerChain(makeRect(0, 80, 1000, 560));

    scriptHost.openScriptHost();

    expect(vars(readingView())).toEqual({
      left: "1012px",
      top: "80px",
      width: "908px",
      height: "688px"
    });
  });

  it("播放器右缘太靠右挤不出 300 宽 → 继续降级为浮层", async () => {
    await loadModules();
    // 播放器右缘 1700：left 1712，可用 1920-1712=208 < 300 → 浮层。
    mountPlayerChain(makeRect(0, 80, 1700, 560));

    scriptHost.openScriptHost();

    const el = readingView();
    expect(el.getAttribute("data-biliscript-script-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
  });

  it("锚点与播放器都没有：浮层属性，不写变量", async () => {
    await loadModules();

    scriptHost.openScriptHost();

    const el = readingView();
    expect(el.getAttribute("data-biliscript-script-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
  });

  it("innerWidth < 1000：直接浮层形态（即使锚点有效）", async () => {
    await loadModules();
    window.innerWidth = 900;
    mountAnchor(".right-container-inner", makeRect(520, 80, 360, 2000));

    scriptHost.openScriptHost();

    const el = readingView();
    expect(el.getAttribute("data-biliscript-script-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
  });

  it("浮层 → 贴栏双向切换：resize 到宽视口后清浮层属性并写变量", async () => {
    await loadModules();
    window.innerWidth = 900;
    const anchor = mountAnchor(".right-container-inner", makeRect(520, 80, 360, 2000));

    scriptHost.openScriptHost();
    expect(readingView().getAttribute("data-biliscript-script-float")).toBe("1");

    window.innerWidth = 1920;
    // 锚点 rect 不随 innerWidth 自动变，改成宽视口下的正确值。
    anchor.getBoundingClientRect = () => makeRect(1520, 80, 360, 2000) as DOMRect;
    runRafSynchronously();
    window.dispatchEvent(new Event("resize"));
    vi.restoreAllMocks();

    const el = readingView();
    expect(el.getAttribute("data-biliscript-script-float")).toBe(null);
    // 贴栏恢复：默认宽 540px。
    expect(vars(el).width).toBe("540px");
  });
});

describe("script-host 宽度偏好（05 号票：三种壳层形态）", () => {
  it("贴栏形态：显式自定义 400/650 生效，未自定义回默认 540", async () => {
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));

    coreState.state.patchSettings({ customPanelWidthEnabled: true, customPanelWidth: 400 });
    scriptHost.openScriptHost();
    expect(vars(readingView())).toMatchObject({ left: "1520px", width: "400px" });

    runRafSynchronously();
    coreState.state.patchSettings({ customPanelWidth: 650 });
    scriptHost.relayoutScriptHost();
    expect(vars(readingView())).toMatchObject({ left: "1270px", width: "650px" });

    // 清除显式自定义标记：即便宽度值仍非默认，也回默认 540。
    coreState.state.patchSettings({ customPanelWidthEnabled: false, customPanelWidth: 460 });
    scriptHost.relayoutScriptHost();
    expect(vars(readingView())).toMatchObject({ left: "1380px", width: "540px" });
    vi.restoreAllMocks();
  });

  it("播放器降级：自定义宽度收缩为自定义值，未自定义占满可用宽度", async () => {
    await loadModules();
    // 播放器右缘 1000：left 1012，可用 908。
    mountPlayerChain(makeRect(0, 80, 1000, 560));

    coreState.state.patchSettings({ customPanelWidthEnabled: true, customPanelWidth: 400 });
    scriptHost.openScriptHost();
    expect(vars(readingView())).toMatchObject({ left: "1012px", top: "80px", width: "400px" });

    runRafSynchronously();
    coreState.state.patchSettings({ customPanelWidth: 650 });
    scriptHost.relayoutScriptHost();
    expect(vars(readingView()).width).toBe("650px");

    coreState.state.patchSettings({ customPanelWidthEnabled: false });
    scriptHost.relayoutScriptHost();
    expect(vars(readingView()).width).toBe("908px");
    vi.restoreAllMocks();
  });

  it("播放器降级：自定义宽度不超过可用宽度（钳制）", async () => {
    await loadModules();
    // 播放器右缘 1500：left 1512，可用 408 < 自定义 650 → 钳到 408。
    mountPlayerChain(makeRect(0, 80, 1500, 560));

    coreState.state.patchSettings({ customPanelWidthEnabled: true, customPanelWidth: 650 });
    scriptHost.openScriptHost();
    expect(vars(readingView())).toMatchObject({ left: "1512px", width: "408px" });
  });

  it("播放器降级：可用宽度 300px 下限——可用 300 成立、298 降浮层", async () => {
    await loadModules();
    const { host } = mountPlayerChain(makeRect(0, 80, 1608, 560));
    // 右缘 1608：left 1620，可用 300 ≥ 300 → 降级成立，宽 min(650, 300) = 300。
    coreState.state.patchSettings({ customPanelWidthEnabled: true, customPanelWidth: 650 });
    scriptHost.openScriptHost();
    expect(readingView().getAttribute("data-biliscript-script-float")).toBe(null);
    expect(vars(readingView()).width).toBe("300px");

    // 右缘 1610：left 1622，可用 298 < 300 → 浮层。
    runRafSynchronously();
    host.getBoundingClientRect = () => makeRect(0, 80, 1610, 560) as DOMRect;
    scriptHost.relayoutScriptHost();
    expect(readingView().getAttribute("data-biliscript-script-float")).toBe("1");
    expect(vars(readingView())).toEqual({ left: "", top: "", width: "", height: "" });
    vi.restoreAllMocks();
  });

  it.each([[999, "1"], [1000, null]])(
    "视口 %ipx（FLOAT_VIEWPORT_MIN_WIDTH=1000 边界）：浮层属性 %s",
    async (innerWidth, floatAttr) => {
      await loadModules();
      window.innerWidth = innerWidth;
      mountAnchor(".right-container-inner", makeRect(520, 80, 360, 2000));

      scriptHost.openScriptHost();

      expect(readingView().getAttribute("data-biliscript-script-float")).toBe(floatAttr);
      if (floatAttr === null) {
        expect(vars(readingView()).width).toBe("540px");
      }
    }
  );

  it("浮层形态：显式自定义宽度写 --biliscript-script-float-width，未自定义不写", async () => {
    await loadModules();
    window.innerWidth = 900;

    coreState.state.patchSettings({ customPanelWidthEnabled: true, customPanelWidth: 460 });
    scriptHost.openScriptHost();
    const el = readingView();
    expect(el.getAttribute("data-biliscript-script-float")).toBe("1");
    expect(floatWidthVar(el)).toBe("460px");

    runRafSynchronously();
    coreState.state.patchSettings({ customPanelWidthEnabled: false });
    scriptHost.relayoutScriptHost();
    expect(floatWidthVar(readingView())).toBe("");
    vi.restoreAllMocks();
  });

  it("贴栏 ↔ 浮层双向切换：定位变量与浮层宽度变量随形态清写", async () => {
    await loadModules();
    coreState.state.patchSettings({ customPanelWidthEnabled: true, customPanelWidth: 500 });
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));

    scriptHost.openScriptHost();
    expect(vars(readingView()).width).toBe("500px");
    expect(floatWidthVar(readingView())).toBe("");

    // 贴栏 → 浮层：清四变量、挂浮层属性、写浮层宽度变量。
    runRafSynchronously();
    window.innerWidth = 900;
    anchor.getBoundingClientRect = () => makeRect(520, 80, 360, 2000) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(readingView().getAttribute("data-biliscript-script-float")).toBe("1");
    expect(vars(readingView())).toEqual({ left: "", top: "", width: "", height: "" });
    expect(floatWidthVar(readingView())).toBe("500px");

    // 浮层 → 贴栏：清浮层属性与浮层宽度变量、恢复定位变量。
    window.innerWidth = 1920;
    anchor.getBoundingClientRect = () => makeRect(1520, 80, 360, 2000) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(readingView().getAttribute("data-biliscript-script-float")).toBe(null);
    expect(vars(readingView())).toMatchObject({ left: "1420px", width: "500px" });
    expect(floatWidthVar(readingView())).toBe("");
    vi.restoreAllMocks();
  });

  it("close 清除浮层宽度变量与浮层属性", async () => {
    await loadModules();
    window.innerWidth = 900;
    coreState.state.patchSettings({ customPanelWidthEnabled: true, customPanelWidth: 460 });
    scriptHost.openScriptHost();
    expect(floatWidthVar(readingView())).toBe("460px");

    scriptHost.closeScriptHost();
    const el = readingView();
    expect(floatWidthVar(el)).toBe("");
    expect(el.getAttribute("data-biliscript-script-float")).toBe(null);
  });
});

describe("script-host 重算时机", () => {
  it("resize/scroll 触发 rAF 合帧重算，rect 变化后变量更新", async () => {
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();

    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    // 合帧：两次事件只排一帧。
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // 滚动后锚点 rect 变化（fixed 定位需跟滚）：挂起帧执行时读的是当下
    // rect，等它在 jsdom 的 rAF 定时器上落地后变量更新为新 top。
    anchor.getBoundingClientRect = () => makeRect(1520, 20, 360, 2000) as DOMRect;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vars(readingView()).top).toBe("20px");
    // 合帧期内未再排新帧。
    expect(rafSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("ResizeObserver 观察当前锚点并在下一动画帧贴合尺寸变化", async () => {
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();

    const observer = TestResizeObserver.instances[0];
    expect(observer).toBeTruthy();
    expect(observer.observeCalls).toEqual([anchor]);

    anchor.getBoundingClientRect = () => makeRect(1520, 20, 320, 1800) as DOMRect;
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    observer.emit();
    observer.emit();
    // observer 回调只合帧排一次 rAF；下一帧读取宽高都已变化后的 rect 才写变量。
    expect(rafSpy).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vars(readingView()).top).toBe("20px");
    vi.restoreAllMocks();
  });

  it("ResizeObserver 观察的锚点随 2s 自查切换而迁移", async () => {
    vi.useFakeTimers();
    await loadModules();
    const old = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    const observer = TestResizeObserver.instances[0];

    old.remove();
    const next = mountAnchor(".right-container", makeRect(1500, 100, 360, 1800));
    runRafSynchronously();
    vi.advanceTimersByTime(2000);

    expect(observer.unobserveCalls).toContain(old);
    expect(observer.observeCalls).toContain(next);
    expect(observer.observed).toEqual([next]);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("关闭 Script host 时解除 ResizeObserver 并取消待执行重排", async () => {
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    const observer = TestResizeObserver.instances[0];
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");

    observer.emit();
    expect(rafSpy).toHaveBeenCalledTimes(1);
    scriptHost.closeScriptHost();
    expect(observer.disconnected).toBe(true);
    observer.emit();

    expect(rafSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("没有 ResizeObserver 时 2s 自查仍会重锚", async () => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    expect(TestResizeObserver.instances).toEqual([]);

    anchor.getBoundingClientRect = () => makeRect(1520, 20, 360, 2000) as DOMRect;
    runRafSynchronously();
    vi.advanceTimersByTime(2000);

    expect(vars(readingView()).top).toBe("20px");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("2s 自查：锚点节点被换掉后重锚到新节点", async () => {
    vi.useFakeTimers();
    await loadModules();
    const old = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    expect(vars(readingView()).width).toBe("540px");

    // SPA 换页：旧节点 rect 塌掉（从文档里摘掉后 stub 仍在但新节点顶上）。
    old.getBoundingClientRect = () => makeRect(0, 0, 0, 0) as DOMRect;
    mountAnchor(".right-container", makeRect(1500, 100, 360, 1800));

    // 自查换锚后经 rAF 应用；rAF 换成同步跑，保证断言前落地。
    runRafSynchronously();
    // 旧 800ms 节拍不再自查：801ms 时锚点已换但变量仍是旧值（top 80）。
    vi.advanceTimersByTime(801);
    expect(vars(readingView()).top).toBe("80px");
    // 2s 拍到：重锚到新节点（top 100）。
    vi.advanceTimersByTime(1200);

    expect(vars(readingView()).top).toBe("100px");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("2s 自查一拍一搜：自查拍内 findScriptAnchor 恰一次（锚点 rect 只量一次）", async () => {
    vi.useFakeTimers();
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    expect(vars(readingView()).width).toBe("540px");

    // 只统计本次自查拍：open 首拍的搜索/量测已在断言前消费。
    const rectSpy = vi.spyOn(anchor, "getBoundingClientRect");
    const querySpy = vi.spyOn(document, "querySelector");
    runRafSynchronously();
    vi.advanceTimersByTime(2001);

    // 一拍一搜：自查找到锚点并量一次 rect，结果复用进 applyScriptRect，
    // 应用侧不再 findScriptAnchor 一遍、不再重复量 rect（旧实现同一拍
    // 会搜两次、量两次）。
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(vars(readingView())).toEqual({
      left: "1380px",
      top: "80px",
      width: "540px",
      height: "688px"
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("open 幂等：重复 open 不叠加监听/定时器，rect 仍正确", async () => {
    vi.useFakeTimers();
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    scriptHost.openScriptHost();

    const setIntervalSpy = vi.spyOn(window, "setInterval");
    scriptHost.openScriptHost();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    expect(vars(readingView()).width).toBe("540px");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

// 滚动进行中材质降级（M19 / M12 巡检 P2-2）：贴栏态面板每帧随
// --biliscript-script-top 位移，header/设置抽屉的 backdrop-filter 跟着逐帧重采样。
// script-host 在滚动期间给 #biliscript-reading-view 挂 data-biliscript-script-scrolling，
// scrollend（或 150ms 静默兜底）摘除；CSS 侧由滚动属性关停毛玻璃。
describe("script-host 滚动进行中材质降级（M19）", () => {
  const SCROLLING_ATTR = "data-biliscript-script-scrolling";

  it("scroll 事件挂标记，document 上的 scrollend（视口滚动）立即摘除", async () => {
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();

    window.dispatchEvent(new Event("scroll"));
    expect(readingView().getAttribute(SCROLLING_ATTR)).toBe("1");

    document.dispatchEvent(new Event("scrollend"));
    expect(readingView().getAttribute(SCROLLING_ATTR)).toBe(null);
  });

  it("无 scrollend 时 150ms 静默兜底摘除；滚动期间每拍续命不提前恢复", async () => {
    vi.useFakeTimers();
    await loadModules();
    scriptHost.openScriptHost();

    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(100);
    // 续命：100ms 时又滚了一拍，收尾窗口重新计时。
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(100);
    expect(readingView().getAttribute(SCROLLING_ATTR)).toBe("1");

    vi.advanceTimersByTime(60);
    expect(readingView().getAttribute(SCROLLING_ATTR)).toBe(null);
    vi.useRealTimers();
  });

  it("close 摘除标记并停摆收尾定时器（再推进时间也不复活）", async () => {
    vi.useFakeTimers();
    await loadModules();
    scriptHost.openScriptHost();
    window.dispatchEvent(new Event("scroll"));
    expect(readingView().getAttribute(SCROLLING_ATTR)).toBe("1");

    scriptHost.closeScriptHost();
    const el = readingView();
    expect(el.getAttribute(SCROLLING_ATTR)).toBe(null);

    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(500);
    expect(el.getAttribute(SCROLLING_ATTR)).toBe(null);
    vi.useRealTimers();
  });
});

describe("script-host close", () => {
  it("close 后清除四个变量与浮层属性，自查定时器停摆", async () => {
    vi.useFakeTimers();
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    expect(vars(readingView()).width).toBe("540px");

    scriptHost.closeScriptHost();

    const el = readingView();
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
    expect(el.getAttribute("data-biliscript-script-float")).toBe(null);

    // 定时器停摆：close 后推进时间不再触发重算（变量保持已清除态）。
    mountAnchor(".right-container", makeRect(1500, 100, 360, 1800));
    runRafSynchronously();
    vi.advanceTimersByTime(2000);
    expect(vars(el).width).toBe("");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("close → 再 open 正常工作", async () => {
    await loadModules();
    scriptHost.openScriptHost();
    scriptHost.closeScriptHost();

    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    scriptHost.openScriptHost();
    expect(vars(readingView()).width).toBe("540px");
  });

  it("未 open 时 close 是安全 no-op", async () => {
    await loadModules();
    expect(() => scriptHost.closeScriptHost()).not.toThrow();
  });

  it("open 时 #biliscript-reading-view 不存在：静默不炸，后续重算可恢复", async () => {
    await loadModules();
    document.body.innerHTML = "";
    expect(() => scriptHost.openScriptHost()).not.toThrow();

    // 元素后来出现（ui 渲染完成），下一次重算能写上变量（经 resize 事件走
    // 事件路径合帧；原「手动重算」死槽位导出已随 arch-slim-2/03 删除）。
    const view = document.createElement("div");
    view.id = "biliscript-reading-view";
    document.body.appendChild(view);
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    runRafSynchronously();
    window.dispatchEvent(new Event("resize"));
    expect(vars(view).width).toBe("540px");
  });

  it("窄窗浮层 → 贴栏切换：重算后清浮层属性并写变量", async () => {
    await loadModules();
    window.innerWidth = 900;
    mountAnchor(".right-container-inner", makeRect(1640, 80, 280, 2000));

    scriptHost.openScriptHost();

    const el = readingView();
    expect(el.getAttribute("data-biliscript-script-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });

    // 视口变宽后重算：恢复贴栏。锚点 rect 不随 innerWidth 变（左缘 1640），
    // 可填宽 1920-1640=280 < 下限 380 → 左缘左移到 1540，宽 380。
    window.innerWidth = 1920;
    runRafSynchronously();
    window.dispatchEvent(new Event("resize"));
    expect(el.getAttribute("data-biliscript-script-float")).toBe(null);
    expect(vars(el)).toEqual({
      left: "1380px",
      top: "80px",
      width: "540px",
      height: "688px"
    });
  });
});
