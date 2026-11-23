import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  clampDetachedWindowBounds,
  DEFAULT_DETACHED_WINDOW_HEIGHT,
  DETACHED_WINDOW_BOUNDS_KEY,
  loadDetachedWindowBounds,
  MIN_DETACHED_WINDOW_HEIGHT,
  MIN_DETACHED_WINDOW_WIDTH,
  parseDetachedWindowBounds,
  resetDetachedWindowBounds,
  resolveInitialDetachedWindowBounds,
  saveDetachedWindowBounds
} from "../../extension/core/detached-bounds-store.js";

beforeEach(() => {
  resetModuleState();
});

describe("detached-bounds-store 尺寸钳制与初始几何计算", () => {
  it("clampDetachedWindowBounds 钳制最小 360×420 并四舍五入浮点输入", () => {
    expect(clampDetachedWindowBounds({ width: 200, height: 300 })).toEqual({
      width: MIN_DETACHED_WINDOW_WIDTH,
      height: MIN_DETACHED_WINDOW_HEIGHT
    });
    expect(clampDetachedWindowBounds({ width: 400.6, height: 500.2 })).toEqual({
      width: 401,
      height: 500
    });
    expect(clampDetachedWindowBounds({ width: 640, height: 720 })).toEqual({
      width: 640,
      height: 720
    });
    expect(clampDetachedWindowBounds({ width: Number.NaN, height: Number.POSITIVE_INFINITY })).toEqual({
      width: 360,
      height: 420
    });
  });

  it("parseDetachedWindowBounds 拒绝非对象、数组、非数字与非正数，合法对象自动钳制", () => {
    expect(parseDetachedWindowBounds(null)).toBeNull();
    expect(parseDetachedWindowBounds("bad")).toBeNull();
    expect(parseDetachedWindowBounds([400, 500])).toBeNull();
    expect(parseDetachedWindowBounds({ width: 0, height: 500 })).toBeNull();
    expect(parseDetachedWindowBounds({ width: "400", height: 500 })).toBeNull();
    expect(parseDetachedWindowBounds({ width: Number.NaN, height: 500 })).toBeNull();
    expect(parseDetachedWindowBounds({ width: 280, height: 380 })).toEqual({
      width: 360,
      height: 420
    });
    expect(parseDetachedWindowBounds({ width: 560, height: 680 })).toEqual({
      width: 560,
      height: 680
    });
  });

  it("resolveInitialDetachedWindowBounds 优先使用已保存尺寸，其次回落默认面板宽度与屏幕高度 80%", () => {
    expect(
      resolveInitialDetachedWindowBounds({
        saved: { width: 480, height: 600 },
        customPanelWidthEnabled: true,
        customPanelWidth: 620,
        availHeight: 1080
      })
    ).toEqual({ width: 480, height: 600 });

    expect(
      resolveInitialDetachedWindowBounds({
        saved: { width: 200, height: 300 },
        availHeight: 1080
      })
    ).toEqual({ width: 360, height: 420 });

    expect(
      resolveInitialDetachedWindowBounds({
        customPanelWidthEnabled: false,
        customPanelWidth: 620,
        availHeight: 1080
      })
    ).toEqual({ width: 540, height: DEFAULT_DETACHED_WINDOW_HEIGHT });

    expect(
      resolveInitialDetachedWindowBounds({
        customPanelWidthEnabled: true,
        customPanelWidth: 460,
        availHeight: 900
      })
    ).toEqual({ width: 460, height: 720 });

    expect(
      resolveInitialDetachedWindowBounds({
        customPanelWidthEnabled: true,
        customPanelWidth: 320,
        availHeight: 400
      })
    ).toEqual({ width: 360, height: 420 });

    expect(
      resolveInitialDetachedWindowBounds({
        availHeight: 0
      })
    ).toEqual({ width: 540, height: DEFAULT_DETACHED_WINDOW_HEIGHT });

    expect(
      resolveInitialDetachedWindowBounds({
        availHeight: Number.NaN
      })
    ).toEqual({ width: 540, height: DEFAULT_DETACHED_WINDOW_HEIGHT });
  });
});

describe("detached-bounds-store chrome.storage.local 读写隔离", () => {
  it("load/save/reset 仅读写 chrome.storage.local 且绝不触碰 chrome.storage.sync", async () => {
    const syncGetSpy = vi.spyOn(chrome.storage.sync, "get");
    const syncSetSpy = vi.spyOn(chrome.storage.sync, "set");
    const syncRemoveSpy = vi.spyOn(chrome.storage.sync, "remove");

    expect(await loadDetachedWindowBounds()).toBeNull();

    const saved = await saveDetachedWindowBounds({ width: 280, height: 390 });
    expect(saved).toEqual({ width: 360, height: 420 });
    expect(await loadDetachedWindowBounds()).toEqual({ width: 360, height: 420 });

    await resetDetachedWindowBounds();
    expect(await loadDetachedWindowBounds()).toBeNull();

    expect(syncGetSpy).not.toHaveBeenCalled();
    expect(syncSetSpy).not.toHaveBeenCalled();
    expect(syncRemoveSpy).not.toHaveBeenCalled();
  });

  it("遇到损坏存储形态或 storage.local 异常时安全返回 null", async () => {
    await chrome.storage.local.set({ [DETACHED_WINDOW_BOUNDS_KEY]: { width: "bad", height: 0 } });
    expect(await loadDetachedWindowBounds()).toBeNull();

    vi.spyOn(chrome.storage.local, "get").mockRejectedValueOnce(new Error("local read failure"));
    expect(await loadDetachedWindowBounds()).toBeNull();
  });

  it("chrome.storage.local 同步抛出 Extension context invalidated 时 load/save/reset 均安全降级", async () => {
    vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(() => {
      throw new Error("Extension context invalidated");
    });
    await expect(loadDetachedWindowBounds()).resolves.toBeNull();

    vi.spyOn(chrome.storage.local, "set").mockImplementationOnce(() => {
      throw new Error("Extension context invalidated");
    });
    await expect(saveDetachedWindowBounds({ width: 200, height: 600 })).resolves.toEqual({
      width: 360,
      height: 600
    });

    vi.spyOn(chrome.storage.local, "remove").mockImplementationOnce(() => {
      throw new Error("Extension context invalidated");
    });
    await expect(resetDetachedWindowBounds()).resolves.toBeUndefined();
  });
});
