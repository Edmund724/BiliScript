import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterpretSubtitleOverlay } from "../../extension/live/interpret-subtitle-overlay.js";
import type { LiveInterpretTargetLang } from "../../extension/live/interpret-subtitle-preferences.js";

let playerHost: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  playerHost = document.createElement("div");
  playerHost.className = "bpx-player-container";
  document.body.appendChild(playerHost);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function createOverlay(
  displayMode: "auto" | "translation" | "bilingual" = "auto",
  targetLang: LiveInterpretTargetLang = "zh"
) {
  return createInterpretSubtitleOverlay({
    getPlayerHost: () => playerHost,
    getTargetLang: () => targetLang,
    getDisplayMode: () => displayMode
  });
}

describe("同声传译字幕浮层", () => {
  it("原文与译文快照即时覆盖，原文在上译文在下", () => {
    const overlay = createOverlay("bilingual");
    overlay.handleTranscript({ kind: "input.updated", turn: "turn-1", text: "Hello" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-1", runId: "run-1", text: "你" });

    const root = overlay.getElement()!;
    const original = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translation = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(root.hidden).toBe(false);
    expect(playerHost.contains(root)).toBe(true);
    expect(original.textContent).toBe("Hello");
    expect(translation.textContent).toBe("你");
    expect(original.compareDocumentPosition(translation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    overlay.handleTranscript({ kind: "input.updated", turn: "turn-1", text: "Hello world" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-1", runId: "run-1", text: "你好，世界" });
    expect(root.querySelectorAll(".biliscript-interpret-subtitle-original")).toHaveLength(1);
    expect(root.querySelectorAll(".biliscript-interpret-subtitle-translation")).toHaveLength(1);
    expect(original.textContent).toBe("Hello world");
    expect(translation.textContent).toBe("你好，世界");
    overlay.dispose();
  });

  it("同一原文段的多句译文按 run_id 顺序拼接，作废句子被丢弃", () => {
    const overlay = createOverlay("bilingual");
    overlay.handleTranscript({ kind: "input.done", turn: "turn-1", text: "Hello world" });
    overlay.handleTranscript({ kind: "output.done", sourceTurn: "turn-1", runId: "run-10", text: "世界" });
    overlay.handleTranscript({ kind: "output.done", sourceTurn: "turn-1", runId: "run-2", text: "你好" });

    const root = overlay.getElement()!;
    const translation = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(translation.textContent).toBe("你好世界");

    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-1", runId: "run-2", text: "你好，" });
    expect(translation.textContent).toBe("你好，世界");

    overlay.handleTranscript({ kind: "response.ended", sourceTurn: "turn-1", runId: "run-2", status: "cancelled" });
    expect(translation.textContent).toBe("世界");
    overlay.handleTranscript({ kind: "response.ended", sourceTurn: "turn-1", runId: "run-10", status: "failed" });
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");
    overlay.dispose();
  });

  it("旧原文段迟到的 done 不覆盖新原文段或清除其译文", () => {
    const overlay = createOverlay("bilingual");
    overlay.handleTranscript({ kind: "input.updated", turn: "turn-1", text: "旧原文" });
    overlay.handleTranscript({ kind: "input.updated", turn: "turn-2", text: "新原文" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-2", runId: "run-2", text: "新译文" });

    overlay.handleTranscript({ kind: "input.done", turn: "turn-1", text: "旧原文最终快照" });
    overlay.handleTranscript({ kind: "output.done", sourceTurn: "turn-1", runId: "run-1", text: "旧译文" });

    const root = overlay.getElement()!;
    expect(root.textContent).toBe("新原文新译文");
    overlay.dispose();
  });

  it("作废事件缺少 run_id 时丢弃当前句，避免保留无法确认有效性的译文", () => {
    const overlay = createOverlay("bilingual");
    overlay.handleTranscript({ kind: "input.done", turn: "turn-1", text: "原文" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-1", runId: "run-1", text: "疑似译文" });

    overlay.handleTranscript({ kind: "response.ended", sourceTurn: "turn-1", runId: "", status: "cancelled" });

    const root = overlay.getElement()!;
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");
    overlay.dispose();
  });

  it("正常结束后停留 3 秒再淡出，新快照会取消旧淡出", () => {
    vi.useFakeTimers();
    const overlay = createOverlay();
    overlay.handleTranscript({ kind: "input.done", turn: "turn-1", text: "你好" });
    overlay.handleTranscript({ kind: "output.done", sourceTurn: "turn-1", runId: "run-1", text: "你好" });
    overlay.handleTranscript({ kind: "response.ended", sourceTurn: "turn-1", runId: "run-1", status: "completed" });

    const root = overlay.getElement()!;
    vi.advanceTimersByTime(2999);
    expect(root.hidden).toBe(false);
    expect(root.classList.contains("is-fading")).toBe(false);

    overlay.handleTranscript({ kind: "input.updated", turn: "turn-2", text: "下一句" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-2", runId: "run-2", text: "下一句" });
    vi.advanceTimersByTime(3000);
    expect(root.hidden).toBe(false);
    expect(root.textContent).toBe("下一句下一句");

    overlay.handleTranscript({ kind: "response.ended", sourceTurn: "turn-2", runId: "run-2", status: "completed" });
    vi.advanceTimersByTime(3000);
    expect(root.hidden).toBe(false);
    expect(root.classList.contains("is-fading")).toBe(true);
    vi.advanceTimersByTime(300);
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");
    overlay.dispose();
  });

  it("独立同传提示无需伴看浮窗，自动消失后可再次显示", () => {
    vi.useFakeTimers();
    const overlay = createOverlay();
    overlay.showNotice("同传连接失败", 1000);

    let notice = playerHost.querySelector<HTMLElement>(".biliscript-interpret-notice");
    expect(notice?.textContent).toBe("同传连接失败");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(document.getElementById("biliscript-fullscreen-live-overlay")).toBeNull();

    vi.advanceTimersByTime(1000);
    expect(playerHost.querySelector(".biliscript-interpret-notice")).toBeNull();
    overlay.showNotice("实时翻译已关闭", 0);
    notice = playerHost.querySelector<HTMLElement>(".biliscript-interpret-notice");
    expect(notice?.textContent).toBe("实时翻译已关闭");
    overlay.dispose();
    expect(playerHost.querySelector(".biliscript-interpret-notice")).toBeNull();
  });

  it("clear 立即清空当前字幕，之后可继续显示新快照", () => {
    const overlay = createOverlay("bilingual");
    overlay.handleTranscript({ kind: "input.updated", turn: "turn-1", text: "旧原文" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-1", runId: "run-1", text: "旧译文" });
    const root = overlay.getElement()!;

    overlay.clear();
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");

    overlay.handleTranscript({ kind: "input.updated", turn: "turn-2", text: "新原文" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-2", runId: "run-2", text: "新译文" });
    expect(root.hidden).toBe(false);
    expect(root.textContent).toBe("新原文新译文");
    overlay.dispose();
  });

  it("seek 清空后立即接受同一 turn 的新快照", () => {
    const overlay = createOverlay("bilingual");
    overlay.handleTranscript({ kind: "input.updated", turn: "turn-1", text: "seek 前" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-1", runId: "run-1", text: "旧译文" });
    const root = overlay.getElement()!;

    overlay.clearForSeek();
    expect(root.hidden).toBe(true);
    overlay.handleTranscript({ kind: "input.updated", turn: "turn-1", text: "seek 后" });
    overlay.handleTranscript({ kind: "output.updated", sourceTurn: "turn-1", runId: "run-1", text: "新译文" });

    expect(root.hidden).toBe(false);
    expect(root.textContent).toBe("seek 后新译文");
    overlay.dispose();
  });
});
