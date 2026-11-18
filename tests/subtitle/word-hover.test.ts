import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { TestState } from "../reader/reader-test-env.js";

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  document.body.innerHTML = "";
  const stateMod = await import("../../extension/core/state.js");
  state = stateMod.state as TestState;
  clipState = stateMod.clipState;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, "fullscreenElement", {
    value: null,
    configurable: true
  });
  document.body.innerHTML = "";
});

describe("word-hover：轨道语种分级包裹与防纯中文缩写误触", () => {
  it("主轨 zh-CN + 副轨 en-US：主行 CPU 不包裹，副行英文完整包裹且文本复制不断裂", async () => {
    const { buildReadingSubtitleItemHtml } = await import("../../extension/reader/batched-render.js");
    const { getMainLineText, getSubtextNode } = await import("../../extension/reader/subtitle-item-dom.js");

    state.setSettings({
      ...state.settings,
      bilingualSubtitles: true,
      wordHoverEnabled: true,
      wordHoverZhEmbeddedEnabled: false
    });
    clipState.setSubtitles([
      { id: "track-zh", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://sub/zh.json" },
      { id: "track-en", lan: "en-US", lanDoc: "English", subtitleUrl: "https://sub/en.json" }
    ]);
    clipState.setSelectedSubtitleId("track-zh");
    clipState.setSelectedSubtitleUrl("https://sub/zh.json");
    clipState.setSelectedSubtitleLang("中文");
    clipState.setSubtitleBody([{ from: 0, to: 6, content: "现代 CPU 与 AI 架构" }]);
    clipState.applySecondarySubtitle({
      id: "track-en",
      url: "https://sub/en.json",
      body: [{ from: 0, to: 6, content: "Modern CPU and AI architecture" }]
    });

    const html = buildReadingSubtitleItemHtml(
      { index: 0, from: 0, to: 6, content: "现代 CPU 与 AI 架构" },
      false
    );
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const item = wrap.querySelector<HTMLElement>(".biliscript-reading-item")!;
    const textSpan = item.querySelector<HTMLElement>(".biliscript-reading-text")!;
    const subtext = getSubtextNode(item)!;

    // 主行 zh-CN 中不得有任何包裹 span
    const mainWordSpans = Array.from(textSpan.children).filter(
      (child) => child !== subtext && child.classList.contains("biliscript-subtitle-word")
    );
    expect(mainWordSpans).toHaveLength(0);
    expect(getMainLineText(item)).toBe("现代 CPU 与 AI 架构");

    // 副行 en-US 全部单词均被包裹且空格与全文完整保留
    const subWords = Array.from(subtext.querySelectorAll<HTMLElement>(".biliscript-subtitle-word")).map(
      (el) => el.dataset.word
    );
    expect(subWords).toEqual(["Modern", "CPU", "and", "AI", "architecture"]);
    expect(subtext.textContent).toBe("Modern CPU and AI architecture");
  });

  it("纯中文轨道开启进阶开关时仍跳过纯大写长度<=3缩写（CPU/GPU/AI），仅包裹常规英文术语", async () => {
    const { buildWordWrappedHtml } = await import("../../extension/subtitle/word-hover.js");

    const disabledHtml = buildWordWrappedHtml("这个 CPU 和 benchmark 测试", {
      enabled: true,
      trackLang: "ai-zh",
      zhEmbeddedEnabled: false
    });
    expect(disabledHtml).not.toContain("biliscript-subtitle-word");

    const enabledHtml = buildWordWrappedHtml("这个 CPU 和 benchmark 测试", {
      enabled: true,
      trackLang: "ai-zh",
      zhEmbeddedEnabled: true
    });
    const host = document.createElement("div");
    host.innerHTML = enabledHtml;
    const wrapped = Array.from(host.querySelectorAll<HTMLElement>(".biliscript-subtitle-word")).map(
      (el) => el.dataset.word
    );
    expect(wrapped).toEqual(["benchmark"]);
    expect(host.textContent).toBe("这个 CPU 和 benchmark 测试");
  });
});

describe("word-hover：300ms 防抖、Issue #1292 防闪烁锁、全屏重挂载与自动暂停锁", () => {
  it("300ms 移入防抖、isCardInteractionActive 防闪烁锁及 fullscreenchange 容器切换", async () => {
    vi.useFakeTimers();
    const { createWordHoverController } = await import("../../extension/subtitle/word-hover.js");

    const container = document.createElement("div");
    container.innerHTML = `
      <div class="biliscript-reading-item" data-index="0" data-seconds="12">
        <span class="biliscript-reading-text">
          主句
          <span class="biliscript-reading-subtext" data-state="ready">
            <span class="biliscript-subtitle-word" data-word="architecture">architecture</span>
          </span>
        </span>
      </div>
    `;
    document.body.appendChild(container);
    const wordEl = container.querySelector<HTMLElement>(".biliscript-subtitle-word")!;

    const lookupWord = vi.fn(async () => ({
      word: "architecture",
      phonetic: "/ˈɑːrkɪtektʃər/",
      defs: ["n. 架构，体系结构"],
      contextMeaning: "系统架构"
    }));

    const controller = createWordHoverController({
      root: container,
      getEnabled: () => true,
      getAutoPause: () => false,
      lookupWord
    });

    // 1. 悬停不足 300ms 移出：不触发查词
    wordEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(lookupWord).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(false);
    wordEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(lookupWord).not.toHaveBeenCalled();

    // 2. 悬停满 300ms：触发查词并打开浮窗
    wordEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(lookupWord).toHaveBeenCalledTimes(1);
    expect(controller.isOpen()).toBe(true);

    // 等待异步查词完成并渲染
    await vi.runAllTimersAsync();
    const card = controller.getCardElement()!;
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain("architecture");
    expect(card.textContent).toContain("系统架构");

    // 3. 移出单词进入卡片：isCardInteractionActive 锁定不关闭（Issue #1292）
    wordEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: card }));
    card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(controller.isCardInteractionActive()).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(controller.isOpen()).toBe(true);

    // 4. 全屏切换：动态重挂载到 document.fullscreenElement
    const fsHost = document.createElement("div");
    document.body.appendChild(fsHost);
    Object.defineProperty(document, "fullscreenElement", {
      value: fsHost,
      configurable: true
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(card.parentElement).toBe(fsHost);

    // 退出全屏：切回 document.body
    Object.defineProperty(document, "fullscreenElement", {
      value: null,
      configurable: true
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(card.parentElement).toBe(document.body);

    // 5. 移出卡片后经过延迟定时器自动关闭
    card.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    expect(controller.isCardInteractionActive()).toBe(false);
    vi.advanceTimersByTime(1700);
    expect(controller.isOpen()).toBe(false);

    controller.dispose();
  });

  it("pausedByWordHover 状态锁：播放中悬停暂停、移出恢复；原本已暂停或用户手动播放则不越权操作", async () => {
    vi.useFakeTimers();
    const { createWordHoverController } = await import("../../extension/subtitle/word-hover.js");

    const container = document.createElement("div");
    container.innerHTML = `<span class="biliscript-subtitle-word" data-word="kernel">kernel</span>`;
    document.body.appendChild(container);
    const wordEl = container.querySelector<HTMLElement>(".biliscript-subtitle-word")!;

    let paused = false;
    const videoMock = {
      get paused() {
        return paused;
      },
      pause: vi.fn(() => {
        paused = true;
      }),
      play: vi.fn(async () => {
        paused = false;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as HTMLVideoElement;

    const controller = createWordHoverController({
      root: container,
      getEnabled: () => true,
      getAutoPause: () => true,
      getVideoElement: () => videoMock,
      lookupWord: async () => ({ word: "kernel", phonetic: "", defs: ["内核"], contextMeaning: "" })
    });

    // 播放中悬停 300ms：调用 pause 并置锁
    wordEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(videoMock.pause).toHaveBeenCalledTimes(1);
    expect(controller.isPausedByHover()).toBe(true);

    // 移出关闭卡片：恢复播放
    wordEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    vi.advanceTimersByTime(1700);
    expect(videoMock.play).toHaveBeenCalledTimes(1);
    expect(controller.isPausedByHover()).toBe(false);

    // 本就暂停时悬停：不调用 pause，关闭时也不调用 play
    paused = true;
    (videoMock.pause as ReturnType<typeof vi.fn>).mockClear();
    (videoMock.play as ReturnType<typeof vi.fn>).mockClear();
    wordEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(videoMock.pause).not.toHaveBeenCalled();
    expect(controller.isPausedByHover()).toBe(false);
    wordEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    vi.advanceTimersByTime(1700);
    expect(videoMock.play).not.toHaveBeenCalled();

    controller.dispose();
  });

  it("单击单词保留冒泡跳播、划词选区让位、靠近视口底部向上翻转", async () => {
    vi.useFakeTimers();
    const { createWordHoverController } = await import("../../extension/subtitle/word-hover.js");

    const container = document.createElement("div");
    container.innerHTML = `<button type="button" class="biliscript-reading-item"><span class="biliscript-subtitle-word" data-word="memory">memory</span></button>`;
    document.body.appendChild(container);
    const wordEl = container.querySelector<HTMLElement>(".biliscript-subtitle-word")!;
    wordEl.getBoundingClientRect = () =>
      ({ left: 100, top: 680, bottom: 700, right: 160, width: 60, height: 20 } as DOMRect);

    const itemClick = vi.fn();
    container.querySelector(".biliscript-reading-item")!.addEventListener("click", itemClick);

    const controller = createWordHoverController({
      root: container,
      getEnabled: () => true,
      lookupWord: async () => ({ word: "memory", phonetic: "", defs: ["内存"], contextMeaning: "" })
    });

    // 单击单词不阻止冒泡
    wordEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(itemClick).toHaveBeenCalledTimes(1);

    // 靠近视口底部弹出时向上翻转
    wordEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    const card = controller.getCardElement()!;
    expect(card.dataset.placement).toBe("top");

    // 存在划词选区时隐藏悬停浮窗
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "memory" } as Selection);
    document.dispatchEvent(new Event("selectionchange"));
    expect(controller.isOpen()).toBe(false);

    controller.dispose();
  });
});
