import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";

const lazy = vi.hoisted(() => ({
  bodies: {} as Record<string, unknown[]>,
  defaultBody: null as unknown[] | null
}));

vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({
    loadSubtitle: async (url: string, lang: string, runId: number, subtitleId: string, forceRefresh: boolean) => {
      const { acceptSubtitle } = await import("../../extension/subtitle/commit.js");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await acceptSubtitle({
        body: (forceRefresh ? [] : (lazy.bodies[lang] ?? lazy.defaultBody)) as never,
        selectedSubtitleId: subtitleId,
        selectedSubtitleUrl: url,
        selectedSubtitleLang: lang,
        runId
      });
    }
  }))
}));

vi.mock("../../extension/ui/reader-gate.js", () => ({
  withReader: vi.fn(),
  whenReaderReady: vi.fn()
}));

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let shell: typeof import("../../extension/reader/index.js");
let readerBus: typeof import("../../extension/reader/reader-bus.js");
let lazyModule: typeof import("../../extension/subtitle/lazy.js");
let readerGate: typeof import("../../extension/ui/reader-gate.js");

const SAMPLE_TRACKS: SubtitleTrack[] = [
  { id: "2120476497172283392", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json", source: "player" },
  { id: "2121827445538866944", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" },
  { id: "2121827727664517376", lan: "ai-ja", lanDoc: "日本語", subtitleUrl: "https://sub/ai-ja.json", source: "player" },
  { id: "2121827577382789888", lan: "ai-es", lanDoc: "Español", subtitleUrl: "https://sub/ai-es.json", source: "player" },
  { id: "2121827639181244928", lan: "ai-ar", lanDoc: "العربية", subtitleUrl: "https://sub/ai-ar.json", source: "player" },
  { id: "2121827571862717184", lan: "ai-pt", lanDoc: "Português", subtitleUrl: "https://sub/ai-pt.json", source: "player" },
  { id: "2121827533660947200", lan: "ai-th", lanDoc: "ภาษาไทย", subtitleUrl: "https://sub/ai-th.json", source: "player" },
  { id: "2121827596601095936", lan: "ai-id", lanDoc: "Bahasa Indonesia", subtitleUrl: "https://sub/ai-id.json", source: "player" }
];

const ZH_BODY = [{ from: 0, to: 10, content: "中文轨正文" }];
const EN_BODY = [{ from: 0, to: 10, content: "英语轨正文" }];

function loadTracks(tracks: SubtitleTrack[] = SAMPLE_TRACKS, lang = "ai-zh") {
  const selected = tracks.find((track) => track.lan === lang) ?? tracks[0];
  state.clip.setSubtitles(tracks as never);
  state.clip.setSelectedSubtitleId(selected?.id ?? "");
  state.clip.setSelectedSubtitleUrl(selected?.subtitleUrl ?? "");
  state.clip.setSelectedSubtitleLang(selected?.lanDoc ?? "");
  state.clip.setSubtitleBody((lazy.bodies[selected?.lan ?? ""] ?? (tracks.length > 0 ? ZH_BODY : [])) as never);
  state.clip.setSubtitleFetchState(tracks.length > 0 ? "ready" : "empty");
  state.clip.setNoSubtitleReason(null);
  return selected;
}

function selectNode(): HTMLSelectElement {
  return document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement;
}

function wrapper(): HTMLElement {
  return selectNode().closest(".biliscript-reading-track-picker") as HTMLElement;
}

function trigger(): HTMLButtonElement {
  return wrapper().querySelector(".custom-select-trigger") as HTMLButtonElement;
}

function triggerText(): string {
  return trigger().querySelector(".custom-select-value")?.textContent || "";
}

function optionTexts(): string[] {
  return [...selectNode().options].map((option) => option.textContent || "");
}

function optionValues(): string[] {
  return [...selectNode().options].map((option) => option.value);
}

function optionIds(): string[] {
  return [...selectNode().options].map((option) => option.dataset.id || "");
}

function listItems(): HTMLElement[] {
  const dropdown = wrapper().querySelector(".custom-select-dropdown") as HTMLElement;
  return [...dropdown.querySelectorAll<HTMLElement>(".custom-select-option")];
}

function listTexts(): string[] {
  return listItems().map((item) => item.textContent || "");
}

function panelSubtitleText(): string {
  return [
    (document.getElementById(ids.readingSubtitleList) as HTMLElement).textContent || "",
    (document.getElementById(ids.readingTranscribeBanner) as HTMLElement).textContent || ""
  ].join(" ");
}

function listText(): string {
  return (document.getElementById(ids.readingSubtitleList) as HTMLElement).textContent || "";
}

function toolbar(): HTMLElement {
  return document.querySelector(".biliscript-reading-sub-toolbar") as HTMLElement;
}

function selectViaList(text: string) {
  const item = listItems().find((node) => node.textContent === text);
  expect(item, `浮层里应有「${text}」这一项`).toBeTruthy();
  item!.click();
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  lazy.bodies = { "ai-zh": ZH_BODY, "ai-en": EN_BODY, 中文: ZH_BODY, English: EN_BODY };
  lazy.defaultBody = ZH_BODY;

  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  shell = await import("../../extension/reader/index.js");
  await import("../../extension/reader/lifecycle.js");
  readerBus = await import("../../extension/reader/reader-bus.js");
  lazyModule = await import("../../extension/subtitle/lazy.js");
  readerGate = await import("../../extension/ui/reader-gate.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("08 选轨控件：模板与落点", () => {
  it("真实模板：原生 select 在工具条内、可见选择器落在搜索框与「复制」之间", () => {
    const select = selectNode();
    expect(select).not.toBeNull();
    expect(select).toBeInstanceOf(HTMLSelectElement);

    const bar = toolbar();
    const children = [...bar.children];
    const searchIndex = children.findIndex((node) => node.classList.contains("biliscript-reading-search"));
    const selectIndex = children.findIndex((node) => node.id === ids.readingSubtitleSelect);
    const copyIndex = children.findIndex((node) => node.id === ids.readingCopySubtitleBtn);
    expect(searchIndex).toBeGreaterThanOrEqual(0);
    expect(selectIndex).toBeGreaterThan(searchIndex);
    expect(selectIndex).toBeLessThan(copyIndex);

    loadTracks();
    shell.renderReadingView();
    expect(select.style.display).toBe("none");
    expect(trigger().tagName).toBe("BUTTON");
    const after = [...bar.children];
    const pickerIndex = after.findIndex((node) => node.classList.contains("biliscript-reading-track-picker"));
    expect(pickerIndex).toBeGreaterThan(searchIndex);
    expect(pickerIndex).toBeLessThan(after.findIndex((node) => node.id === ids.readingCopySubtitleBtn));
    expect(bar.querySelector(".biliscript-reading-search-input")).not.toBeNull();
    const copyBtn = bar.querySelector<HTMLButtonElement>(`#${ids.readingCopySubtitleBtn}`);
    const exportBtn = bar.querySelector<HTMLButtonElement>(`#${ids.readingExportSubtitleBtn}`);
    expect(copyBtn?.className).toBe("biliscript-reading-icon-btn");
    expect(exportBtn?.className).toBe("biliscript-reading-icon-btn");
    expect(copyBtn?.getAttribute("title")).toBe("复制字幕");
    expect(exportBtn?.getAttribute("title")).toBe("导出字幕");
    expect(copyBtn?.querySelector("svg")).not.toBeNull();
    expect(exportBtn?.querySelector("svg")).not.toBeNull();
  });

  it("trigger 的可访问名带字段名与当前值，控件按 aria-label 建壳（Q19）", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    expect(trigger().getAttribute("aria-label")).toBe("字幕轨 中文");
    expect(triggerText()).toBe("中文");
  });

  it("水合不派发 change：渲染入口写值只走 setCustomSelectValue", async () => {
    const bus = vi.spyOn(readerBus, "notifyReaderPresenter");
    loadTracks(SAMPLE_TRACKS, "ai-en");

    shell.renderReadingView();
    await Promise.resolve();

    expect(selectNode().value).toBe("https://sub/ai-en.json");
    expect(triggerText()).toBe("English");
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(bus).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "notice" }));
  });
});

describe("08 选轨控件：列表 ≡ clip.subtitles", () => {
  it("8 条 ai-* 轨：列表恰好 8 项、文字为裸语言名、顺序＝接口原顺序（Q5/Q8′）", () => {
    loadTracks();
    shell.renderReadingView();

    const expected = ["中文", "English", "日本語", "Español", "العربية", "Português", "ภาษาไทย", "Bahasa Indonesia"];
    expect(optionTexts()).toEqual(expected);
    expect(optionTexts()).not.toEqual([...expected].sort());
    expect(listTexts()).toEqual(expected);
    expect(optionIds()).toEqual(SAMPLE_TRACKS.map((track) => track.id));
    expect(optionValues()).toEqual(SAMPLE_TRACKS.map((track) => track.subtitleUrl));
    expect(selectNode().options.length).toBe(8);
  });

  it("列表是 clip.subtitles 的纯投影：state 里的次序即列表次序，控件不另排一套（Q8′ 做减法）", () => {
    loadTracks([
      { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" },
      { id: "1", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json", source: "player" },
      { id: "3", lan: "ai-ja", lanDoc: "日本語", subtitleUrl: "https://sub/ai-ja.json", source: "player" }
    ], "ai-zh");
    shell.renderReadingView();

    expect(optionTexts()).toEqual(["English", "中文", "日本語"]);
    expect(listTexts()).toEqual(["English", "中文", "日本語"]);
  });

  it("选项行挂 dir=\"auto\"（RTL 行随方向），trigger 显示当前轨裸语言名", () => {
    loadTracks();
    shell.renderReadingView();

    expect([...selectNode().options].every((option) => option.dir === "auto")).toBe(true);
    expect(selectNode().options[4].textContent).toBe("العربية");
    expect(triggerText()).toBe("中文");
    expect(triggerText()).not.toContain("字幕");
  });

  it("（B 站 AI）标：单源列表（8 条全 ai-*）不标；混源下拉项显式标（B 站 AI），trigger 保持裸语言名", () => {
    loadTracks();
    shell.renderReadingView();
    expect(optionTexts().every((text) => !text.includes("（B 站 AI）"))).toBe(true);
    expect(listTexts().every((text) => !text.includes("（B 站 AI）"))).toBe(true);

    loadTracks([
      { id: "1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://sub/manual.json", source: "player" },
      { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" }
    ], "zh-CN");
    shell.renderReadingView();
    expect(optionTexts()).toEqual(["中文", "English（B 站 AI）"]);

    loadTracks([
      { id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）", subtitleUrl: "", source: "asr" },
      { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" }
    ], "asr");
    shell.renderReadingView();
    expect(optionTexts()).toEqual(["自配平台转写（中文）", "English（B 站 AI）"]);
  });

  it("ASR 缓存命中态：列表有伪轨且选中它，面板不出现「暂无字幕」（Q4/07 号票）", () => {
    state.clip.setSubtitles([{ id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）", subtitleUrl: "" }]);
    state.clip.setSelectedSubtitleId("asr");
    state.clip.setSelectedSubtitleUrl("");
    state.clip.setSelectedSubtitleLang("自配平台转写（中文）");
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "缓存句" }]);
    state.clip.setSubtitleFetchState("ready");

    shell.renderReadingView();

    expect(optionTexts()).toEqual(["自配平台转写（中文）"]);
    expect(optionIds()).toEqual(["asr"]);
    expect(triggerText()).toBe("自配平台转写（中文）");
    expect(trigger().disabled).toBe(false);
    expect(panelSubtitleText()).not.toContain("暂无字幕");
    expect(listText()).toContain("缓存句");
  });
});

describe("08 选轨控件：装载（只经 chain.loadSubtitle，不直调渲染）", () => {
  it("真实点击选中 English：控件写值 + 经 loadSubtitle 换轨 → state 三项与正文换轨", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    expect(state.clip.subtitleBody).toEqual(ZH_BODY);

    selectViaList("English");

    expect(state.clip.subtitleBody).toEqual(ZH_BODY);

    await vi.waitFor(() => {
      expect(state.clip.subtitleBody).toEqual(EN_BODY);
    });
    expect(state.clip.selectedSubtitleId).toBe("2121827445538866944");
    expect(state.clip.selectedSubtitleLang).toBe("English");
    expect(state.clip.selectedSubtitleUrl).toBe("https://sub/ai-en.json");
    expect(triggerText()).toBe("English");
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
  });

  it("change 只调 chain.loadSubtitle：装上目标轨三项，且不触碰渲染通道", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    const loadSpy = vi.mocked(lazyModule.ensureSummarizeChain);
    loadSpy.mockClear();

    selectNode().value = "https://sub/ai-en.json";
    selectNode().dispatchEvent(new Event("change", { bubbles: true }));

    expect(state.clip.subtitleBody).toEqual(ZH_BODY);
    expect(triggerText()).toBe("English");

    await vi.waitFor(() => {
      expect(state.clip.subtitleBody).toEqual(EN_BODY);
    });
    expect(state.clip.selectedSubtitleId).toBe("2121827445538866944");
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(state.clip.fetchRunId).toBe(0);
  });

  it("不可装载的行（ASR 伪轨的空 URL）：不发起装载，控件立刻收敛回当前轨（不留假状态）", async () => {
    loadTracks(
      [
        { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" },
        { id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）", subtitleUrl: "", source: "asr" }
      ],
      "ai-en"
    );
    shell.renderReadingView();
    const loadSpy = vi.mocked(lazyModule.ensureSummarizeChain);
    loadSpy.mockClear();

    selectViaList("自配平台转写（中文）");
    await Promise.resolve();

    expect(loadSpy).not.toHaveBeenCalled();
    expect(triggerText()).toBe("English");
    expect(optionTexts()[0]).toBe("English（B 站 AI）");
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(state.clip.selectedSubtitleId).toBe("2");
  });
});

describe("换轨进场动画：主动换轨才播，播一次", () => {
  it("真实点击换轨 → 字幕就绪的整表重建给列表容器挂 is-track-switching；其后的常规重渲染不挂", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    const list = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    expect(list.classList.contains("is-track-switching")).toBe(false);

    selectViaList("English");

    await vi.waitFor(() => {
      expect(state.clip.subtitleBody).toEqual(EN_BODY);
    });
    expect(listText()).toContain("英语轨正文");
    expect(list.classList.contains("is-track-switching")).toBe(true);

    list.classList.remove("is-track-switching");
    shell.renderReadingView();
    expect(list.classList.contains("is-track-switching")).toBe(false);

    shell.stopReadingViewSync();
  });

  it("装载失败：不起播，之后的整表重建也不挂类", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    const list = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    vi.mocked(lazyModule.ensureSummarizeChain).mockRejectedValueOnce(new Error("网络失败"));

    selectViaList("English");
    await vi.waitFor(() => {
      expect(triggerText()).toBe("中文");
    });

    shell.renderReadingView();
    expect(list.classList.contains("is-track-switching")).toBe(false);
  });

  it("装载成功但视图未开：不起播（列表没有经过重建）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    state.reader.readingViewOpen = false;
    shell.renderReadingView();
    const list = document.getElementById(ids.readingSubtitleList) as HTMLElement;

    selectViaList("English");
    await vi.waitFor(() => {
      expect(state.clip.subtitleBody).toEqual(EN_BODY);
    });

    expect(list.classList.contains("is-track-switching")).toBe(false);
  });
});

describe("切轨只装载，不直调渲染（2f974c5 防回焊锁的对应物）", () => {
  it("change 处理器：chain.loadSubtitle(url, lang, runId, id) 恰一次，参数正确，且不触碰渲染通道", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    const loadSubtitle = vi.fn(async () => {});
    vi.mocked(lazyModule.ensureSummarizeChain).mockResolvedValueOnce({ loadSubtitle } as never);
    const gate = vi.mocked(readerGate.whenReaderReady);
    gate.mockClear();
    const runIdAtDispatch = state.clip.fetchRunId;

    selectNode().value = "https://sub/ai-en.json";
    selectNode().dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(loadSubtitle).toHaveBeenCalledTimes(1);
    });
    expect(loadSubtitle).toHaveBeenCalledWith(
      "https://sub/ai-en.json",
      "English",
      runIdAtDispatch,
      "2121827445538866944"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gate).not.toHaveBeenCalled();
  });

  it("装载失败：catch 只报错 + 收敛控件，同样不触碰渲染通道", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    const loadSubtitle = vi.fn(async () => {
      throw new Error("网络失败");
    });
    vi.mocked(lazyModule.ensureSummarizeChain).mockResolvedValueOnce({ loadSubtitle } as never);
    const gate = vi.mocked(readerGate.whenReaderReady);
    gate.mockClear();

    selectNode().value = "https://sub/ai-en.json";
    selectNode().dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(loadSubtitle).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gate).not.toHaveBeenCalled();
  });
});

describe("08 选轨控件：六态（03 号票 Q13–Q15 状态机）", () => {
  it("empty：无轨且未转写 → 哨兵「暂无字幕」+ 禁用；面板不出现假字幕", () => {
    loadTracks([], "");
    expect(state.clip.subtitleBody).toEqual([]);
    shell.renderReadingView();

    expect(optionTexts()).toEqual(["暂无字幕"]);
    expect(triggerText()).toBe("暂无字幕");
    expect(trigger().disabled).toBe(true);
    expect(panelSubtitleText()).not.toContain("暂无字幕");
    expect(listText()).toContain("当前视频无字幕");
  });

  it("loading：抓取窗口（subtitleFetchState=loading）→ 哨兵「抓取中…」+ 禁用，不说「暂无字幕」", () => {
    loadTracks([], "");
    state.clip.setSubtitleFetchState("loading");
    shell.renderReadingView();

    expect(optionTexts()).toEqual(["抓取中…"]);
    expect(triggerText()).toBe("抓取中…");
    expect(trigger().disabled).toBe(true);
  });

  it("loading 优先级低于转写中：ASR 转写期间 fetchState 仍是 loading，哨兵必须是「转写中…」", async () => {
    loadTracks([], "");
    state.clip.setSubtitleFetchState("loading");
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(triggerText()).toBe("抓取中…");

    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    expect(optionTexts()).toEqual(["转写中…"]);
    expect(triggerText()).toBe("转写中…");
    expect(trigger().disabled).toBe(true);
  });

  it("loading 不改写已有列表：抓取中轨道仍在时，哨兵梯子不许顶掉非空列表", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    state.clip.setSubtitleFetchState("loading");
    shell.renderReadingView();

    expect(optionTexts()).toEqual(["中文", "English", "日本語", "Español", "العربية", "Português", "ภาษาไทย", "Bahasa Indonesia"]);
    expect(triggerText()).toBe("中文");
    expect(trigger().disabled).toBe(false);
  });

  it("transcribing：转写进行中 → 哨兵「转写中…」+ 禁用，与横幅同相（相位订阅驱动）", async () => {
    loadTracks([], "");
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(triggerText()).toBe("暂无字幕");

    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    expect((document.getElementById(ids.readingTranscribeBanner) as HTMLElement).hidden).toBe(false);
    expect(optionTexts()).toEqual(["转写中…"]);
    expect(triggerText()).toBe("转写中…");
    expect(trigger().disabled).toBe(true);
    expect(panelSubtitleText()).not.toContain("暂无字幕");
  });

  it("busy：切轨请求在飞 → trigger 乐观显示目标轨、禁用 + 忙碌，列表与正文保留旧轨", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    expect(optionTexts()).toHaveLength(8);

    vi.mocked(lazyModule.ensureSummarizeChain).mockImplementationOnce(() => new Promise(() => {}) as never);

    selectViaList("English");

    expect(triggerText()).toBe("English");
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(optionTexts()).toHaveLength(8);
    expect(optionIds()).toEqual(SAMPLE_TRACKS.map((track) => track.id));
    expect(listText()).toContain("中文轨正文");
  });

  it("revert：装载失败 → trigger 回退到旧轨、恢复可用、经 notice 通道报错；state 不变", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    const bus = vi.spyOn(readerBus, "notifyReaderPresenter");
    vi.mocked(lazyModule.ensureSummarizeChain).mockRejectedValueOnce(new Error("网络失败"));

    selectViaList("English");
    expect(triggerText()).toBe("English");

    await vi.waitFor(() => {
      expect(triggerText()).toBe("中文");
    });
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(state.clip.selectedSubtitleId).toBe(SAMPLE_TRACKS[0].id);
    expect(listText()).toContain("中文轨正文");
    expect(bus).toHaveBeenCalledWith({ kind: "notice", text: expect.stringContaining("网络失败") });
  });

  it("busy 期间的重渲不把乐观 trigger 拉回旧轨（一次只有一个请求在飞）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    vi.mocked(lazyModule.ensureSummarizeChain).mockImplementationOnce(() => new Promise(() => {}) as never);

    selectViaList("日本語");
    expect(triggerText()).toBe("日本語");

    shell.renderReadingView();
    expect(triggerText()).toBe("日本語");
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
  });

  it("busy：在飞期间重复 change 只发起一次装载（禁用消解连点，同副列那条口径）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    const loadSubtitle = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(lazyModule.ensureSummarizeChain).mockResolvedValue({ loadSubtitle } as never);

    selectViaList("English");
    await vi.waitFor(() => expect(loadSubtitle).toHaveBeenCalledTimes(1));
    expect(triggerText()).toBe("English");
    expect(selectNode().disabled).toBe(true);

    selectNode().value = "https://sub/ai-ja.json";
    selectNode().dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadSubtitle).toHaveBeenCalledTimes(1);
    expect(triggerText()).toBe("English");
    expect(trigger().disabled).toBe(true);
  });

  it("相位订阅只服务 asr-*：发布 subtitle-ready 不重渲控件，asr-transcribing / asr-done 才触发", async () => {
    loadTracks([], "");
    state.clip.setSubtitleFetchState("loading");
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(triggerText()).toBe("抓取中…");

    const customSelect = await import("../../extension/ui/custom-select.js");
    const rebuild = vi.spyOn(customSelect, "rebuildCustomSelectOptions");
    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");

    statusBus.publishSubtitleStatusPhase("subtitle-ready");
    expect(rebuild).not.toHaveBeenCalled();
    expect(triggerText()).toBe("抓取中…");

    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect(rebuild).toHaveBeenCalled();
    expect(triggerText()).toBe("转写中…");

    rebuild.mockClear();
    statusBus.publishSubtitleStatusPhase("asr-done");
    expect(rebuild).toHaveBeenCalled();
    expect(triggerText()).toBe("抓取中…");
  });
});

describe("08 选轨控件：壳重建（forceRecreate）后的接线", () => {
  it("在飞期间壳重建：trigger 仍显示乐观目标轨，落定后按 state 收敛，新壳改选仍发起装载", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    const JA = SAMPLE_TRACKS[2];
    let failLoad: (error: Error) => void = () => {};
    const loadSubtitle = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failLoad = reject;
        })
    );
    vi.mocked(lazyModule.ensureSummarizeChain).mockResolvedValue({ loadSubtitle } as never);

    selectViaList("日本語");
    await vi.waitFor(() => expect(loadSubtitle).toHaveBeenCalledTimes(1));
    expect(triggerText()).toBe("日本語");

    const oldSelect = selectNode();
    uiRenderer.ensureUiReady({ forceRecreate: true });
    mountPlayerChain();
    shell.renderReadingView();

    expect(selectNode()).not.toBe(oldSelect);
    expect(oldSelect.isConnected).toBe(false);
    expect(triggerText()).toBe("日本語");
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");

    failLoad(new Error("网络失败"));
    await vi.waitFor(() => {
      expect(triggerText()).toBe("中文");
    });
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(state.clip.selectedSubtitleId).toBe(SAMPLE_TRACKS[0].id);

    selectViaList("日本語");
    await vi.waitFor(() => expect(loadSubtitle).toHaveBeenCalledTimes(2));
    expect(loadSubtitle).toHaveBeenLastCalledWith(JA.subtitleUrl, "日本語", state.clip.fetchRunId, JA.id);
  });
});

describe("04 深 module 实例接缝（createSubtitleToolbar）", () => {
  it("构造注入 notice：切轨失败回包经注入假身断言", async () => {
    const { createSubtitleToolbar } = await import("../../extension/reader/subtitle-tab-ui.js");
    const onNotice = vi.fn();
    const toolbar = createSubtitleToolbar({ onNotice });

    loadTracks(SAMPLE_TRACKS, "ai-zh");
    toolbar.render();

    vi.mocked(lazyModule.ensureSummarizeChain).mockRejectedValueOnce(new Error("网络超时"));
    selectViaList("English");

    await vi.waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("字幕切换失败：网络超时");
    });
  });

  it("跨「壳重建」语义：模拟重建后注入回调仍可用（替代模块闭包存活隐式依赖）", async () => {
    const { createSubtitleToolbar } = await import("../../extension/reader/subtitle-tab-ui.js");
    const onNotice = vi.fn();
    const toolbar = createSubtitleToolbar({ onNotice });

    loadTracks(SAMPLE_TRACKS, "ai-zh");
    toolbar.render();

    uiRenderer.ensureUiReady({ forceRecreate: true });
    mountPlayerChain();
    toolbar.render();

    vi.mocked(lazyModule.ensureSummarizeChain).mockRejectedValueOnce(new Error("重建后失败"));
    selectViaList("English");

    await vi.waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("字幕切换失败：重建后失败");
    });
  });

  it("相位订阅由实例 bindEvents 承载：三相位驱动 render、subtitle-ready 不驱动", async () => {
    const { createSubtitleToolbar } = await import("../../extension/reader/subtitle-tab-ui.js");
    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");
    const toolbar = createSubtitleToolbar();

    loadTracks([], "");
    state.reader.readingViewOpen = true;
    toolbar.render();
    toolbar.bindEvents();

    const customSelect = await import("../../extension/ui/custom-select.js");
    const rebuild = vi.spyOn(customSelect, "rebuildCustomSelectOptions");

    statusBus.publishSubtitleStatusPhase("subtitle-ready");
    expect(rebuild).not.toHaveBeenCalled();

    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect(rebuild).toHaveBeenCalled();

    rebuild.mockClear();
    statusBus.publishSubtitleStatusPhase("asr-done");
    expect(rebuild).toHaveBeenCalled();
  });
});

