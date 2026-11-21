import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl } from "../setup.js";
import type { TestState } from "../reader/reader-test-env.js";

const WATCHLATER_URL_A =
  "https://www.bilibili.com/list/watchlater?oid=111&bvid=BV1aaaTestA";
const WATCHLATER_URL_B =
  "https://www.bilibili.com/list/watchlater?oid=222&bvid=BV1bbbTestB";

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;
let messageHandler: typeof import("../../extension/entry/message-handler.js");
let videoIdShared: typeof import("../../extension/bilibili/video-id-shared.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(WATCHLATER_URL_A);
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  messageHandler = await import("../../extension/entry/message-handler.js");
  videoIdShared = await import("../../extension/bilibili/video-id-shared.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function seedFetchedClip() {
  clipState.setBvid("BV1aaaTestA");
  state.clip.title = "视频 A";
  state.clip.chapters = [{ title: "正片", from: 0 }];
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "视频 A 字幕" }];
  clipState.setCurrentClipSignature(videoIdShared.computeCurrentClipSignature());
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("稍后再看列表内 SPA 换片的 URL 检测（轮询兜底）", () => {
  it("主世界导航绕过 history 补丁：轮询发现一个节拍内的 URL 变化并重置 clip", async () => {
    seedFetchedClip();
    vi.useFakeTimers();
    messageHandler.bindUrlChangeHandler();

    History.prototype.replaceState.call(history, {}, "", WATCHLATER_URL_B);

    expect(state.clip.chapters.length).toBe(1);
    expect(state.clip.bvid).toBe("BV1aaaTestA");

    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => {
      expect(state.clip.chapters.length).toBe(0);
      expect(state.clip.subtitleBody.length).toBe(0);
    });
    expect(state.clip.currentClipSignature).toBe(videoIdShared.computeCurrentClipSignature());
  });
});
