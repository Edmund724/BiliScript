import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");
let bannerCopy: typeof import("../../extension/reader/transcribe-banner.js");
let video: HTMLVideoElement;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  const stateMod = await import("../../extension/core/state.js");
  state = stateMod.state as TestState;
  transitionReaderShell = stateMod.transitionReaderShell;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  bannerCopy = await import("../../extension/reader/transcribe-banner.js");
}

function banner(): HTMLElement {
  return document.getElementById(ids.readingTranscribeBanner) as HTMLElement;
}

function tabBodySubtitle(): HTMLElement {
  return document.getElementById(ids.readingTabBodySubtitle) as HTMLElement;
}

function progressText(): string {
  return (document.getElementById(ids.readingTranscribeProgress) as HTMLElement).textContent || "";
}

function bannerTitleText(): string {
  return (document.getElementById(ids.readingTranscribeBannerTitle) as HTMLElement).textContent || "";
}

function bannerCopyText(): string {
  return (document.getElementById(ids.readingTranscribeBannerCopy) as HTMLElement).textContent || "";
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  video = mountPlayerChain();
  statusBus.publishSubtitleStatusPhase("idle");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("字幕状态相位总线（shared/subtitle-status-bus）", () => {
  it("publish 通知订阅者，get 返回最后相位，退订后不再通知", () => {
    const seen: string[] = [];
    const unsubscribe = statusBus.subscribeSubtitleStatusPhase((phase) => seen.push(phase));
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect(seen).toEqual(["asr-transcribing"]);
    expect(statusBus.getSubtitleStatusPhase()).toBe("asr-transcribing");

    unsubscribe();
    statusBus.publishSubtitleStatusPhase("asr-done");
    expect(seen).toEqual(["asr-transcribing"]);
    expect(statusBus.getSubtitleStatusPhase()).toBe("asr-done");
  });

  it("订阅者回调抛错不影响其他订阅者", () => {
    const seen: string[] = [];
    statusBus.subscribeSubtitleStatusPhase(() => {
      throw new Error("呈现回调异常");
    });
    statusBus.subscribeSubtitleStatusPhase((phase) => seen.push(phase));
    expect(() => statusBus.publishSubtitleStatusPhase("asr-transcribing")).not.toThrow();
    expect(seen).toEqual(["asr-transcribing"]);
  });
});

describe("转写中间态横幅", () => {
  it("asr-transcribing 且字幕体为空：横幅显示 + 列表淡出禁用 + 进度行显示状态栏文本", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    state.ui.setStatusText("音频下载与解码中…");
    shell.updateReadingTranscribeBanner();

    expect(banner().hidden).toBe(false);
    expect(tabBodySubtitle().classList.contains("is-transcribing")).toBe(true);
    expect(progressText()).toBe("音频下载与解码中…");
  });

  it("asr-done：横幅隐藏、淡出禁用解除", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    shell.updateReadingTranscribeBanner();
    expect(banner().hidden).toBe(false);

    statusBus.publishSubtitleStatusPhase("asr-done");
    shell.updateReadingTranscribeBanner();
    expect(banner().hidden).toBe(true);
    expect(tabBodySubtitle().classList.contains("is-transcribing")).toBe(false);
  });

  it("相位残留防御：字幕体已就绪（非空）时强制隐藏", () => {
    state.clip.subtitleBody = [{ from: 0, to: 2, content: "已成稿字幕" }];
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    shell.updateReadingTranscribeBanner();

    expect(banner().hidden).toBe(true);
    expect(tabBodySubtitle().classList.contains("is-transcribing")).toBe(false);
  });

  it("相位订阅驱动：视图开着时 publish 直接收敛横幅（lifecycle 组装根已订阅）", () => {
    transitionReaderShell("open");
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    expect(banner().hidden).toBe(false);
    expect(tabBodySubtitle().classList.contains("is-transcribing")).toBe(true);
  });

  it("横幅文案按相位取：标题/副文案写入 id 节点（不是硬编码在模板里）", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    shell.updateReadingTranscribeBanner();

    expect(bannerTitleText()).toBe(bannerCopy.TRANSCRIBE_BANNER_COPY["asr-transcribing"].title);
    expect(bannerCopyText()).toBe(bannerCopy.TRANSCRIBE_BANNER_COPY["asr-transcribing"].copy);
    expect(bannerTitleText()).toBe("当前视频无字幕，正在进行语音转写…");
    expect(bannerCopyText()).toBe("转写完成后将自动展示字幕与概览，期间可继续观看视频");
  });

  it("横幅文案幂等：同相位重复收敛不改写节点（脏检查）", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    shell.updateReadingTranscribeBanner();
    const titleNode = document.getElementById(ids.readingTranscribeBannerTitle) as HTMLElement;

    shell.updateReadingTranscribeBanner();

    expect(titleNode.textContent).toBe(bannerCopy.TRANSCRIBE_BANNER_COPY["asr-transcribing"].title);
    expect(bannerTitleText()).toBe("当前视频无字幕，正在进行语音转写…");
  });

  it("renderReadingView 恢复呈现：打开视图晚于转写发起（相位先于渲染发布）", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    shell.renderReadingView();

    expect(banner().hidden).toBe(false);
    expect(tabBodySubtitle().classList.contains("is-transcribing")).toBe(true);
  });

  it("sync tick 收敛进度行：onProgress 改写状态栏文本后 250ms 拍内刷新", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    shell.renderReadingView();
    transitionReaderShell("open");
    shell.bindReadingViewVideo(video);

    state.ui.setStatusText("音频下载与解码中…");
    shell.updateReadingTranscribeBanner();
    expect(progressText()).toBe("音频下载与解码中…");

    state.ui.setStatusText("语音识别中 2 片…");
    shell.syncReadingViewPlayback();
    expect(progressText()).toBe("语音识别中 2 片…");
  });
});
