// tests/reader/selection-pill.test.ts
// 划词悬浮胶囊：上方定位与边界翻转防裁切、字幕/概览 4 动作、简介省略时间戳、点击外部与 Esc 关闭。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  bindReadingExplainEvents,
  buildExplainCardHostHtml,
  buildExplainPopHtml,
  computeSelectionPopPosition,
  formatSelectionTimestampCopy
} from "../../extension/reader/explain-pop-ui.js";
import { ids } from "../../extension/reader/state.js";
import { clipState } from "../../extension/core/state.js";
import { loadVideoHighlights, resetHighlightMemoryStoreForTests } from "../../extension/notes/highlights-store.js";

const readerMocks = vi.hoisted(() => ({
  openReaderExplainCard: vi.fn(),
  onReaderExplainCardClick: vi.fn(),
  openQuoteShareModal: vi.fn()
}));

vi.mock("../../extension/ui/reader-gate.js", () => ({
  withReader: (_label: string | null, fn: (reader: typeof readerMocks) => void) => {
    fn(readerMocks);
  }
}));

function mountSelectionDom(): void {
  document.body.innerHTML = `
    <section id="${ids.readingView}">
      <aside id="${ids.readingScriptPanel}">
        <div id="${ids.readingTabBodySubtitle}">
          <div id="${ids.readingSubtitleList}">
            <button type="button" class="biliscript-reading-item" data-index="0" data-seconds="85">
              <span class="biliscript-reading-time">01:25</span>
              <span class="biliscript-reading-text">这是第一句很重要的字幕</span>
            </button>
          </div>
        </div>
        <div id="${ids.readingTabBodyOverview}">
          <div id="${ids.readingOverviewBody}">
            <p class="biliscript-reading-ov-summary">这里是全片核心简介文本</p>
            <button type="button" class="biliscript-reading-ov-chapter" data-seconds="130">
              <span class="biliscript-reading-ov-chapter-copy">第二章原理推导</span>
            </button>
          </div>
        </div>
        ${buildExplainPopHtml()}
        ${buildExplainCardHostHtml()}
      </aside>
    </section>
  `;
}

function selectTextNode(node: Text, start = 0, end = node.data.length): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("computeSelectionPopPosition 视口与面板边界防裁切", () => {
  it("上方空间充足时优先置于选区上方并水平居中", () => {
    const pos = computeSelectionPopPosition({
      containerRect: { left: 800, top: 0, width: 480, height: 800 },
      selectionRect: { left: 960, top: 200, right: 1080, bottom: 220, width: 120, height: 20 },
      popWidth: 280,
      popHeight: 34,
      viewportWidth: 1280,
      viewportHeight: 800
    });
    expect(pos.placedAbove).toBe(true);
    expect(pos.top).toBe(200 - 34 - 4);
    expect(pos.left).toBe(80); // center=220, 220-140=80
  });

  it("选区贴近顶部时自动翻转至选区下方，贴右侧时向左收敛防裁切", () => {
    const pos = computeSelectionPopPosition({
      containerRect: { left: 800, top: 0, width: 400, height: 800 },
      selectionRect: { left: 1120, top: 18, right: 1190, bottom: 38, width: 70, height: 20 },
      popWidth: 280,
      popHeight: 34,
      viewportWidth: 1200,
      viewportHeight: 800
    });
    expect(pos.placedAbove).toBe(false);
    expect(pos.top).toBe(38 + 4);
    expect(pos.left).toBeLessThanOrEqual(400 - 280 - 8);
  });
});

describe("formatSelectionTimestampCopy", () => {
  it("带时间戳输出 [M:SS] 文本；无时间戳（简介）仅输出纯文本", () => {
    expect(formatSelectionTimestampCopy("核心观点", 85, false)).toBe("[1:25] 核心观点");
    expect(formatSelectionTimestampCopy("长视频片段", 3661, true)).toBe("[1:01:01] 长视频片段");
    expect(formatSelectionTimestampCopy("全片简介句子", null, false)).toBe("全片简介句子");
  });
});

describe("划词悬浮胶囊交互（4 动作 + 自动关闭）", () => {
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    resetModuleState();
    resetHighlightMemoryStoreForTests();
    const localBag: Record<string, unknown> = {};
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      vi.spyOn(chrome.storage.local, "get").mockImplementation(async (keys?: unknown) => {
        if (typeof keys === "string") {
          return keys in localBag ? { [keys]: localBag[keys] } : {};
        }
        return { ...localBag };
      });
      vi.spyOn(chrome.storage.local, "set").mockImplementation(async (items: Record<string, unknown>) => {
        Object.assign(localBag, items);
      });
    }
    readerMocks.openReaderExplainCard.mockClear();
    readerMocks.openQuoteShareModal.mockClear();
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    mountSelectionDom();
    bindReadingExplainEvents();
  });

  it("字幕选区浮出 4 动作胶囊：高亮存笔记 / AI 解释 / 生成金句卡 / 复制带时间戳", async () => {
    clipState.setBvid("BV1sel00001");
    clipState.setSubtitleBody([{ from: 85, to: 90, content: "这是第一句很重要的字幕" }]);

    const textNode = document.querySelector(".biliscript-reading-text")!.firstChild as Text;
    const pop = document.getElementById(ids.readingExplainPop)!;

    // 1. 高亮存笔记 + 字幕原位高亮标示
    selectTextNode(textNode, 4, 11);
    expect(pop.hidden).toBe(false);
    pop.querySelector<HTMLButtonElement>('[data-selection-action="highlight"]')!.click();
    await vi.waitFor(async () => {
      const saved = await loadVideoHighlights("BV1sel00001");
      expect(saved).toHaveLength(1);
      expect(saved[0].text).toBe("句很重要的字幕");
      expect(saved[0].from).toBe(85);
    });
    const item = document.querySelector<HTMLElement>(".biliscript-reading-item")!;
    expect(item.classList.contains("is-note-highlighted")).toBe(true);
    expect(item.querySelector(".biliscript-reading-note-badge")).not.toBeNull();

    // 2. AI 解释
    selectTextNode(textNode, 0, 5);
    pop.querySelector<HTMLButtonElement>('[data-selection-action="explain"]')!.click();
    expect(readerMocks.openReaderExplainCard).toHaveBeenCalledWith(
      expect.objectContaining({ selection: "这是第一句", from: 85, index: 0 })
    );

    // 3. 生成金句卡
    selectTextNode(textNode, 0, 6);
    pop.querySelector<HTMLButtonElement>('[data-selection-action="quote-card"]')!.click();
    expect(readerMocks.openQuoteShareModal).toHaveBeenCalledWith(
      expect.objectContaining({ content: "这是第一句很" })
    );

    // 4. 复制带时间戳
    selectTextNode(textNode, 5, 11);
    pop.querySelector<HTMLButtonElement>('[data-selection-action="copy-timestamp"]')!.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("[1:25] 很重要的字幕");
    });
  });

  it("概览简介选区复制时省略时间戳；Esc 与点击外部自动关闭", async () => {
    const summaryText = document.querySelector(".biliscript-reading-ov-summary")!.firstChild as Text;
    const pop = document.getElementById(ids.readingExplainPop)!;

    selectTextNode(summaryText, 3, 9);
    expect(pop.hidden).toBe(false);
    pop.querySelector<HTMLButtonElement>('[data-selection-action="copy-timestamp"]')!.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("全片核心简介");
    });

    // Esc 关闭
    selectTextNode(summaryText, 0, 5);
    expect(pop.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pop.hidden).toBe(true);

    // 点击外部关闭
    selectTextNode(summaryText, 0, 5);
    expect(pop.hidden).toBe(false);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop.hidden).toBe(true);
  });
});
