import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBiliHostAdapter } from "../../extension/bilibili/host-adapter.js";

describe("bilibili/host-adapter（BiliHostAdapter）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("按降级链路解析视频播放器容器与直播间容器", () => {
    const adapter = createBiliHostAdapter();

    document.body.innerHTML = `
      <div id="playerWrap">
        <div class="player-wrap">
          <div id="bilibili-player">
            <div class="bpx-player-container"><video></video></div>
          </div>
        </div>
      </div>`;

    const bpx = document.querySelector(".bpx-player-container")!;
    expect(adapter.findVideoPlayerContainer()).toBe(bpx);

    bpx.classList.remove("bpx-player-container");
    expect(adapter.findVideoPlayerContainer()).toBe(document.getElementById("bilibili-player"));

    document.body.innerHTML = `<div id="live-player-ctnr"><div class="live-player-mounter"></div></div>`;
    expect(adapter.findLiveRoomPlayerHost()).toBe(document.querySelector(".live-player-mounter"));
    expect(adapter.findAnyPlayerHost()).toBe(document.querySelector(".live-player-mounter"));
  });

  it("同一容器多订阅方共享单一 MutationObserver，按各自选项过滤派发且互不误断", async () => {
    const adapter = createBiliHostAdapter();
    const container = document.createElement("div");
    container.className = "bpx-player-container";
    document.body.appendChild(container);

    const childListOnly = vi.fn();
    const attrWatcher = vi.fn();
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const obs1History: Array<MutationObserver | null> = [];
    const obs2History: Array<MutationObserver | null> = [];

    adapter.observeContainer({
      containerSelector: ".bpx-player-container",
      containerObserveOptions: { childList: true, subtree: true },
      signal: ac1.signal,
      onMutations: childListOnly,
      onObserverChange: (obs) => obs1History.push(obs)
    });

    adapter.observeContainer({
      containerSelector: ".bpx-player-container",
      containerObserveOptions: {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"]
      },
      signal: ac2.signal,
      onMutations: attrWatcher,
      onObserverChange: (obs) => obs2History.push(obs)
    });

    expect(adapter.getActiveObserverCount()).toBe(1);
    expect(adapter.getSubscriberCount()).toBe(2);
    expect(obs1History[0]).toBe(obs2History[0]);

    container.setAttribute("style", "opacity: 0.9");
    await Promise.resolve();
    expect(attrWatcher).toHaveBeenCalledTimes(1);
    expect(childListOnly).not.toHaveBeenCalled();

    container.appendChild(document.createElement("span"));
    await Promise.resolve();
    expect(attrWatcher).toHaveBeenCalledTimes(2);
    expect(childListOnly).toHaveBeenCalledTimes(1);

    ac2.abort();
    expect(obs2History.at(-1)).toBeNull();
    expect(adapter.getActiveObserverCount()).toBe(1);
    expect(adapter.getSubscriberCount()).toBe(1);

    container.appendChild(document.createElement("em"));
    await Promise.resolve();
    expect(childListOnly).toHaveBeenCalledTimes(2);
    expect(attrWatcher).toHaveBeenCalledTimes(2);

    ac1.abort();
    expect(adapter.getActiveObserverCount()).toBe(0);
    expect(adapter.getSubscriberCount()).toBe(0);
  });

  it("容器未就绪时共用单一 body 回退观察，SPA 容器替换脱离后自动重绑新宿主", async () => {
    const adapter = createBiliHostAdapter();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const h1 = adapter.observeContainer({ containerSelector: ".bpx-player-container", onMutations: cb1 });
    const h2 = adapter.observeContainer({ containerSelector: ".bpx-player-container", onMutations: cb2 });

    expect(adapter.getActiveObserverCount()).toBe(1);

    const firstContainer = document.createElement("div");
    firstContainer.className = "bpx-player-container";
    document.body.appendChild(firstContainer);
    await Promise.resolve();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(adapter.getActiveObserverCount()).toBe(1);

    const secondContainer = document.createElement("div");
    secondContainer.className = "bpx-player-container";
    firstContainer.remove();
    document.body.appendChild(secondContainer);
    firstContainer.appendChild(document.createElement("i"));
    await Promise.resolve();

    secondContainer.appendChild(document.createElement("b"));
    await Promise.resolve();
    expect(cb1.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cb2.mock.calls.length).toBeGreaterThanOrEqual(2);

    h1.disconnect();
    h2.disconnect();
    expect(adapter.getActiveObserverCount()).toBe(0);
    expect(adapter.getSubscriberCount()).toBe(0);
  });
});
