// 面板 header 状态行的写入策略（2026-09 用户决议）：
//   - 播放进度（「当前进度 0:12」）不再写入——它每 250ms 覆盖该行，且字幕列表
//     的自动高亮本身就是位置反馈；
//   - 提示/进度/操作成功类文案（默认）：写入即显示，5s 后清空并 hidden；
//   - 错误/失败类文案：常驻，不自动消失（用户明确要求）；
//   - 空文案：立即清空并 hidden（空闲态整行收起，不占面板网格第 2 行）；
//   - 转写中的进度文案不落 header 行（字幕 tab 的转写横幅已有独立进度行），
//     只更新 state.ui.statusText 供横幅消费；错误类文案不受此抑制。
//
// 写入方有两个（core/ui-status 的 setStatus/setMessage 与 reader/presentation 的
// renderReadingStatus），共用 core/reading-status-line.js 的同一策略。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let presentation: typeof import("../../extension/reader/presentation.js");
let uiStatus: typeof import("../../extension/core/ui-status.js");
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");

function statusNode(): HTMLElement {
  return document.getElementById(ids.readingStatus) as HTMLElement;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  await import("../../extension/reader/index.js");
  presentation = await import("../../extension/reader/presentation.js");
  uiStatus = await import("../../extension/core/ui-status.js");
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  mountReaderSkeleton(ids);
  mountPlayerChain();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("面板 header 状态行的显示策略", () => {
  it("非错误文案：写入即显示，5s 后清空并 hidden", () => {
    presentation.renderReadingStatus("抓取完成，可以复制或下载字幕。");

    expect(statusNode().textContent).toBe("抓取完成，可以复制或下载字幕。");
    expect(statusNode().hidden).toBe(false);

    vi.advanceTimersByTime(5000);

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("新文案重置计时：旧文案的收起点不吞掉新文案", () => {
    presentation.renderReadingStatus("正在获取可用字幕...");
    vi.advanceTimersByTime(4000);

    presentation.renderReadingStatus("抓取完成，可以复制或下载字幕。");
    vi.advanceTimersByTime(4000);

    expect(statusNode().textContent).toBe("抓取完成，可以复制或下载字幕。");
    expect(statusNode().hidden).toBe(false);

    vi.advanceTimersByTime(1000);

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("错误/失败类文案常驻：过了自动收起点也不消失", () => {
    const persistentTexts = [
      "抓取失败：HTTP 403",
      "字幕加载失败：boom",
      "语音识别失败：超时",
      "当前页面没有找到可联动的视频播放器。",
      "没有可复制的字幕，请先刷新抓取。",
      "当前视频无字幕。请配置语音识别平台。"
    ];

    for (const text of persistentTexts) {
      presentation.renderReadingStatus(text);
      vi.advanceTimersByTime(60_000);

      expect(statusNode().textContent).toBe(text);
      expect(statusNode().hidden).toBe(false);
    }
  });

  it("错误后写入非错误文案：恢复 5s 收起", () => {
    presentation.renderReadingStatus("抓取失败：HTTP 403");
    vi.advanceTimersByTime(60_000);
    expect(statusNode().textContent).toBe("抓取失败：HTTP 403");

    presentation.renderReadingStatus("字幕已复制到剪贴板。");
    vi.advanceTimersByTime(5000);

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("空文案：立即清空并 hidden（不等待计时）", () => {
    presentation.renderReadingStatus("抓取完成，可以复制或下载字幕。");
    presentation.renderReadingStatus("");

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);

    // 旧计时器已作废：再等一秒不会把新状态写坏
    vi.advanceTimersByTime(1000);
    expect(statusNode().hidden).toBe(true);
  });

  it("setMessage 走同一策略（金句复制反馈同样 5s 收起）", () => {
    uiStatus.setMessage("金句已复制到剪贴板。");
    expect(statusNode().textContent).toBe("金句已复制到剪贴板。");

    vi.advanceTimersByTime(5000);
    expect(statusNode().hidden).toBe(true);
  });

  it("转写中：进度文案不落 header 行，只更新 statusText（横幅消费）", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    uiStatus.setStatus("语音识别中 2 片…");

    expect(statusNode().textContent).toBe("");
    expect(state.ui.statusText).toBe("语音识别中 2 片…");
  });

  it("转写中：错误文案照常显示（不被进度抑制口径吞掉）", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    uiStatus.setStatus("语音识别失败：网络中断");

    expect(statusNode().textContent).toBe("语音识别失败：网络中断");
    expect(statusNode().hidden).toBe(false);
  });

  it("转写中：空文案仍能清空该行（清除不受进度抑制口径拦住）", () => {
    presentation.renderReadingStatus("抓取失败：HTTP 403");
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    presentation.renderReadingStatus("");

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("转写结束（相位回 idle）后：进度文案恢复落 header 行", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    uiStatus.setStatus("语音识别中 2 片…");
    expect(statusNode().textContent).toBe("");

    statusBus.publishSubtitleStatusPhase("idle");
    uiStatus.setStatus("语音识别完成，已生成 12 条字幕。");

    expect(statusNode().textContent).toBe("语音识别完成，已生成 12 条字幕。");
  });
});
