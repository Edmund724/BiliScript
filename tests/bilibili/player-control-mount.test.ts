import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyControlBarPlacement,
  isControlBarItemMounted,
  observePlayerContainer,
  resolveControlBarPlacement
} from "../../extension/bilibili/player-control-mount.js";

describe("bilibili/player-control-mount 控制栏锚点解析与两段式局部观察", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("优先级：直播扩展区 > 清晰度控件前 > 控制栏右侧容器首部 > host 末尾兜底", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    // 1. 仅有 host 且开启 fallbackToHost -> append 到 host
    expect(resolveControlBarPlacement({ host, fallbackToHost: true })).toEqual({
      kind: "append",
      parent: host
    });
    expect(resolveControlBarPlacement({ host, fallbackToHost: false })).toBeNull();

    // 2. 挂载 .bpx-player-control-bottom-right -> prepend 到控制栏右侧
    const bottomRight = document.createElement("div");
    bottomRight.className = "bpx-player-control-bottom-right";
    host.appendChild(bottomRight);
    expect(resolveControlBarPlacement({ host })).toEqual({
      kind: "prepend",
      parent: bottomRight
    });

    // 3. 出现清晰度按钮 -> before 清晰度按钮
    const qualityBtn = document.createElement("div");
    qualityBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-quality";
    bottomRight.appendChild(qualityBtn);
    expect(resolveControlBarPlacement({ host })).toEqual({
      kind: "before",
      parent: bottomRight,
      reference: qualityBtn
    });

    // 4. 开启 preferLiveRoomExtNodes 且存在直播间扩展区 -> prepend 到扩展区
    const liveExt = document.createElement("div");
    liveExt.innerHTML = `<div class="live-web-player-controller"><div class="right-area"><div class="ext-nodes"></div></div></div>`;
    host.appendChild(liveExt);
    const extNodes = host.querySelector<HTMLElement>(".ext-nodes")!;
    expect(resolveControlBarPlacement({ host, preferLiveRoomExtNodes: true })).toEqual({
      kind: "prepend",
      parent: extNodes
    });
  });

  it("applyControlBarPlacement 具备幂等性：已在目标位置时零 DOM 写操作", () => {
    const parent = document.createElement("div");
    const quality = document.createElement("div");
    const item = document.createElement("button");
    parent.appendChild(quality);
    document.body.appendChild(parent);

    const placement = { kind: "before" as const, parent, reference: quality };
    expect(isControlBarItemMounted(item, placement)).toBe(false);

    const insertSpy = vi.spyOn(parent, "insertBefore");
    expect(applyControlBarPlacement(item, placement)).toBe(true);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(isControlBarItemMounted(item, placement)).toBe(true);

    // 再次调用应短路返回 false，不触发 insertBefore
    expect(applyControlBarPlacement(item, placement)).toBe(false);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("observePlayerContainer：容器迟到时由 body 回退观察自动切换到局部容器观察", async () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const onMutations = vi.fn();
    const activeObservers: Array<MutationObserver | null> = [];

    const handle = observePlayerContainer({
      containerSelector: ".bpx-player-container",
      onMutations,
      onObserverChange: (obs) => activeObservers.push(obs)
    });

    // 启动时容器不在，回退观察 document.body
    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy.mock.calls[0]?.[0]).toBe(document.body);

    // 动态插入播放器容器
    const container = document.createElement("div");
    container.className = "bpx-player-container";
    document.body.appendChild(container);
    await Promise.resolve();

    // 自动切换为观察局部容器，并触发一次空记录同步回调
    expect(observeSpy).toHaveBeenCalledTimes(2);
    expect(observeSpy.mock.calls[1]?.[0]).toBe(container);
    expect(onMutations).toHaveBeenCalledTimes(1);

    // 局部容器内部变化可被捕获
    const child = document.createElement("span");
    container.appendChild(child);
    await Promise.resolve();
    expect(onMutations).toHaveBeenCalledTimes(2);

    handle.disconnect();
    expect(activeObservers.at(-1)).toBeNull();
  });
});
