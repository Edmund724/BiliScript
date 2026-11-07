// 面板 header 状态行的写入策略：
//   - 播放进度不再写入；
//   - 字幕抓取与无字幕/语音转写相关的报错与状态提示不落 header 行（下方字幕列表/空态已有对应展示，避免上下重复）；
//   - 其余非字幕链路的错误/失败类文案常驻：直到下一条文案覆盖；
//   - 其余操作反馈类文案：写入即显示，5s 后清空并 hidden；
//   - 空文案：立即清空并 hidden（空闲态整行收起，不占面板网格第 2 行）；
//   - 转写中的进度文案不落 header 行，只更新 state.ui.statusText 供横幅消费。
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
  it("操作反馈类文案：写入即显示，5s 后清空并 hidden", () => {
    presentation.renderReadingStatus("操作设置已生效。");

    expect(statusNode().textContent).toBe("操作设置已生效。");
    expect(statusNode().hidden).toBe(false);

    vi.advanceTimersByTime(5000);

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("新文案重置计时：旧文案的收起点不吞掉新文案", () => {
    presentation.renderReadingStatus("正在准备会话环境...");
    vi.advanceTimersByTime(4000);

    presentation.renderReadingStatus("会话环境已就绪。");
    vi.advanceTimersByTime(4000);

    expect(statusNode().textContent).toBe("会话环境已就绪。");
    expect(statusNode().hidden).toBe(false);

    vi.advanceTimersByTime(1000);

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("字幕抓取与无字幕/语音转写报错不落 header 行（下方字幕已有展示，避免上下重复）", () => {
    const errorTexts = [
      "抓取失败：HTTP 403",
      "字幕加载失败：boom",
      "语音识别失败：超时",
      // 无字幕出口的唯一文案（subtitle/commit.buildNoSubtitleStatusMessage）：
      "当前视频无字幕。 语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。 请到设置页检查或更换 API Key",
      "当前视频无字幕。 未识别到语音内容，这个视频可能没有人声。"
    ];

    for (const text of errorTexts) {
      presentation.renderReadingStatus(text);

      expect(statusNode().textContent).toBe("");
      expect(statusNode().hidden).toBe(true);
    }
  });

  it("抓取字幕类提示文案不落 header 行（避免与下方列表重复）", () => {
    const fetchTexts = [
      "正在获取可用字幕...",
      "正在抓取视频信息...",
      "抓取完成，可以复制或下载字幕。",
      "抓取完成，阅读视图已同步最新字幕。",
      "检测到视频变化，正在自动刷新字幕..."
    ];

    for (const text of fetchTexts) {
      presentation.renderReadingStatus(text);

      expect(statusNode().textContent).toBe("");
      expect(statusNode().hidden).toBe(true);
    }
  });

  it("非字幕链路的错误类文案常驻：过了自动收起点也不消失", () => {
    const nonSubtitleErrors = [
      "当前页面没有找到可联动的视频播放器。",
      "复制失败：剪贴板拒绝访问"
    ];

    for (const text of nonSubtitleErrors) {
      presentation.renderReadingStatus(text);
      vi.advanceTimersByTime(60_000);

      expect(statusNode().textContent).toBe(text);
      expect(statusNode().hidden).toBe(false);
    }
  });

  it("操作反馈后写入抑制文案：header 行被清空并收起", () => {
    presentation.renderReadingStatus("字幕已复制到剪贴板。");
    expect(statusNode().textContent).toBe("字幕已复制到剪贴板。");
    expect(statusNode().hidden).toBe(false);

    presentation.renderReadingStatus("抓取失败：HTTP 403");

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("空文案：立即清空并 hidden（不等待计时）", () => {
    presentation.renderReadingStatus("字幕已复制到剪贴板。");
    presentation.renderReadingStatus("");

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);

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

  it("转写中：非字幕链路错误文案照常显示", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    uiStatus.setStatus("播放器连接失败：网络中断");

    expect(statusNode().textContent).toBe("播放器连接失败：网络中断");
    expect(statusNode().hidden).toBe(false);
  });

  it("转写中：空文案仍能清空该行（清除不受进度抑制口径拦住）", () => {
    presentation.renderReadingStatus("操作进行中...");
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    presentation.renderReadingStatus("");

    expect(statusNode().textContent).toBe("");
    expect(statusNode().hidden).toBe(true);
  });

  it("转写结束（相位回 idle）后：非抑制文案恢复落 header 行", () => {
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    uiStatus.setStatus("语音识别中 2 片…");
    expect(statusNode().textContent).toBe("");

    statusBus.publishSubtitleStatusPhase("idle");
    uiStatus.setMessage("导出已完成，请检查下载目录。");

    expect(statusNode().textContent).toBe("导出已完成，请检查下载目录。");
    expect(statusNode().hidden).toBe(false);
  });
});
