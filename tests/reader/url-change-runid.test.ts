import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { TestState } from "./reader-test-env.js";

const OTHER_VIDEO_URL = "https://www.bilibili.com/video/BV1test999999/";
const SAME_VIDEO_NOISY_URL = "https://www.bilibili.com/video/BV1test000000/?t=42";

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;
let messageHandler: typeof import("../../extension/entry/message-handler.js");
let videoIdShared: typeof import("../../extension/bilibili/video-id-shared.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(NORMAL_PAGE_URL);
  const stateModule = await import("../../extension/core/state.js") as typeof import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  messageHandler = await import("../../extension/entry/message-handler.js");
  videoIdShared = await import("../../extension/bilibili/video-id-shared.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("URL 变化的 fetchRunId 同步递增（M23 runId 协调）", () => {
  it("签名变化（换视频）→ handleUrlChange 同步段立即递增，早于异步 reset/刷新链", () => {
    clipState.setFetchRunId(5);
    messageHandler.bindUrlChangeHandler();

    history.replaceState(history.state, "", OTHER_VIDEO_URL);
    expect(clipState.fetchRunId).toBe(6);
  });

  it("签名未变（同视频同分 P 的 URL 噪声）不递增", () => {
    clipState.setFetchRunId(5);
    clipState.setCurrentClipSignature(videoIdShared.computeCurrentClipSignature());
    messageHandler.bindUrlChangeHandler();

    history.replaceState(history.state, "", SAME_VIDEO_NOISY_URL);
    expect(clipState.fetchRunId).toBe(5);
  });

  it("递增后 reset 编排照常收尾：seeded 的旧视频数据仍被清空（递增不跳过 reset）", async () => {
    state.clip.title = "旧视频标题";
    clipState.setFetchRunId(5);
    messageHandler.bindUrlChangeHandler();

    history.replaceState(history.state, "", OTHER_VIDEO_URL);
    expect(clipState.fetchRunId).toBe(6);

    await vi.waitFor(() => {
      expect(state.clip.title).toBe("");
    });
  });
});
