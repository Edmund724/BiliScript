import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type StateModule = typeof import("../../extension/core/state.js");

let resident: StateModule;
let lazy: StateModule;

beforeEach(async () => {
  resetModuleState();
  resident = await import("../../extension/core/state.js");
  vi.resetModules();
  lazy = await import("../../extension/core/state.js");
});

describe("core/state 单例跨实例共享", () => {
  it("两侧拿到同一份 state / clipState / uiState（对象同一性）", () => {
    expect(lazy.state).toBe(resident.state);
    expect(lazy.clipState).toBe(resident.clipState);
    expect(lazy.uiState).toBe(resident.uiState);
    expect(lazy.state.clip).toBe(resident.clipState);
    expect(lazy.state.reader).toBe(resident.state.reader);
  });

  it("一侧写入、另一侧读到（clip 业务字段与状态行文案）", () => {
    resident.clipState.setBvid("BV1shared0000");
    resident.clipState.setSubtitleFetchState("loading");
    resident.uiState.setStatusText("正在获取可用字幕...");

    expect(lazy.state.clip.bvid).toBe("BV1shared0000");
    expect(lazy.state.clip.subtitleFetchState).toBe("loading");
    expect(lazy.state.ui.statusText).toBe("正在获取可用字幕...");

    lazy.clipState.setSubtitleBody([{ from: 0, to: 10, content: "大家好" }]);
    expect(resident.state.clip.subtitleBody).toHaveLength(1);
  });

  it("reader 视图开关跨侧可见（通知门控读的就是它）", () => {
    expect("setViewOpen" in resident.state.reader).toBe(false);
    expect(Object.getOwnPropertyDescriptor(resident.state.reader, "readingViewOpen")?.set).toBeUndefined();
    expect(lazy.transitionReaderShell("open")).toBe(true);
    expect(resident.state.reader.readingViewOpen).toBe(true);
    expect(resident.state.reader).toBe(lazy.state.reader);
  });

  it("初始值由先求值的实例创建（currentUrl 读 location，两实例一致）", () => {
    expect(lazy.state.clip.currentUrl).toBe(resident.state.clip.currentUrl);
    expect(lazy.state.clip.currentUrl).toContain("/video/BV1test000000");
  });
});
