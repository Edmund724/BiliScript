// 字幕工具条选轨控件（票 subtitle-track-picker/08）。
//
// 本文件取代 2f974c5 的 tests/reader/subtitle-toolbar.test.ts：那条锁断言「真实
// 模板的工具条里**没有** select」（下拉被删时的防回焊锁），08 号票把控件按
// 02–10 号票的裁定重新长回工具条，负向锁随之翻面——现在锁的是「控件在场、且
// 可见 affordance 只有 custom-select 的 trigger」。
//
// 口径来源（本文件不重述理由，只落断言）：
//   - 形态：02 号票变体 A「一行内插入」，trigger 定宽 120px、文本＝裸语言名、
//     字段名走 aria-label（prototypes/README.md §4/§7/§11）；
//   - 列表：Q4/Q8′——列表 ≡ clip.subtitles（含 ASR 伪轨），按接口顺序渲染；
//   - 标签：Q5′——选项文字 = lanDoc 原文；`[AI]` 标只在列表内来源不唯一时显示；
//   - 六态：03 号票 Q13–Q15（busy / revert / transcribing / empty）；
//   - 装载：change 只经 chain.loadSubtitle，不直调渲染。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   1. 模板层：工具条里根本没有控件（改回「无 select」的老态）／控件不在搜索框与
//      「复制」之间（变体 A 的落点）／原生 select 变成可见的第二族 affordance；
//   2. 列表层：轨道条数被少列/多列／顺序被另排一套（未跟随 clip.subtitles）／
//      选项文字被归一（Q5 要求原文）／单源列表也挂 [AI]（8 条 ai-* 样本会挂满）；
//   3. 装载层：change 只改控件不装载（正文不换）／装了不写回 selected 三项／
//      在处理器里直调渲染（与 subtitle-ready 通知构成双渲染，被删测试锁过）；
//   4. 空态层：无轨时列表为空 + trigger 空按钮（组件没有选项时就是空按钮）／
//      控件空态掩盖正文／ASR 缓存命中态（subtitles:[] + selectedSubtitleId:"asr"
//      + body 有内容）又露出「暂无字幕」；
//   5. 状态机层：busy 期间 trigger 没显示目标轨／列表被清成目标轨（正文还是旧轨）／
//      失败后不回退（控件停在用户选的轨，与 state 两说）／失败不报错；
//   6. 水合层：渲染入口用派发 change 的方式写值（会把水合当用户改选，触发装载）；
//   7. 转写层：转写进行中控件不禁用、不显示「转写中…」，与横幅两说。
//
// 端到端形态：真实模板（buildUiHtml/ensureUiReady，含真实壳与真实事件绑定）+
// 真实 ui/custom-select 建壳，jsdom 只走 DOM 事件。mock 只有两条运行时边界——
// 总结链（loadSubtitle 的缓存/网络入口，隔离网络）与 reader-gate（装载 reader 域
// 的转发助手，其失败口不参与断言）。字幕接受事务（subtitle/commit）保持真实：
// 「正文换轨 + subtitle-ready 通知」是被测链的一部分，不 mock。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";

// ===== mock（hoisted）：总结链装载器 + reader-gate 转发助手 =====

// loadSubtitle 的应答：按 lang 取这份测试字幕库（空数组放行到真实网络入口 =
// 抛「字幕文件为空」）。成功后走真实字幕接受事务——写 state + 通知 reader
//（subtitle-ready），这条通知正是 03 号票的收尾驱动。
const lazy = vi.hoisted(() => ({
  bodies: {} as Record<string, unknown[]>,
  defaultBody: null as unknown[] | null
}));

vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({
    loadSubtitle: async (url: string, lang: string, runId: number, subtitleId: string, forceRefresh: boolean) => {
      const { acceptSubtitle } = await import("../../extension/subtitle/commit.js");
      // 一拍的异步窗口（与真实缓存/网络路径同形）：busy 态断言才有观察点。
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

// ===== 被测模块（mock 之后导入） =====

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let shell: typeof import("../../extension/reader/index.js");
let readerBus: typeof import("../../extension/reader/reader-bus.js");
let lazyModule: typeof import("../../extension/subtitle/lazy.js");
// reader-gate 在本文件被 mock：它的 whenReaderReady 是「直调渲染通道」本身
// （2f974c5 防回焊锁锁的那条缝），锁三据此断言「一次都没碰」。
let readerGate: typeof import("../../extension/ui/reader-gate.js");

// 样本视频 BV1mAam6tEL8 的 8 条 ai-* 轨（research/01-track-shape.md，接口原顺序）。
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
  state.clip.setSubtitles(tracks as never); // 轨形状（SubtitleTrack）与 state 的 SubtitleOption 只差索引签名
  state.clip.setSelectedSubtitleId(selected?.id ?? "");
  state.clip.setSelectedSubtitleUrl(selected?.subtitleUrl ?? "");
  state.clip.setSelectedSubtitleLang(selected?.lanDoc ?? "");
  state.clip.setSubtitleBody((lazy.bodies[selected?.lan ?? ""] ?? (tracks.length > 0 ? ZH_BODY : [])) as never);
  state.clip.setSubtitleFetchState(tracks.length > 0 ? "ready" : "empty");
  state.clip.setNoSubtitleReason(null);
  return selected;
}

// ===== DOM 取用口（真实壳；原生 select 是值源，trigger 是可见 affordance） =====

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

// 字幕轨这一面的面板文案（排除工具条：工具条的 trigger 本来就会写当前轨名）。
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

// 真实点击路径：点浮层里的选项行 → 组件 chooseOption（写值 + 派发 change）。
function selectViaList(text: string) {
  const item = listItems().find((node) => node.textContent === text);
  expect(item, `浮层里应有「${text}」这一项`).toBeTruthy();
  item!.click();
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  lazy.bodies = { "ai-zh": ZH_BODY, "ai-en": EN_BODY };
  lazy.defaultBody = ZH_BODY;

  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  shell = await import("../../extension/reader/index.js");
  // reader-bus 的 presenter 订阅注册在 lifecycle 模块求值期——只有该模块被装载，
  // subtitle-ready 才会驱动 renderReadingView。生产里由 withReader 的 reader 域
  // 装载触达；本文件把 withReader mock 掉了（隔离装载路径），故显式装载它。
  await import("../../extension/reader/lifecycle.js");
  readerBus = await import("../../extension/reader/reader-bus.js");
  lazyModule = await import("../../extension/subtitle/lazy.js");
  readerGate = await import("../../extension/ui/reader-gate.js");
  // 真实模板 + 真实事件绑定（bindUiEvents 里 bindSubtitleTabEvents）
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

    // 建壳前（工具条初值）：原生 select 是工具条的直接子节点，落在搜索框与「复制」之间
    const bar = toolbar();
    const children = [...bar.children];
    const searchIndex = children.findIndex((node) => node.classList.contains("biliscript-reading-search"));
    const selectIndex = children.findIndex((node) => node.id === ids.readingSubtitleSelect);
    const copyIndex = children.findIndex((node) => node.id === ids.readingCopySubtitleBtn);
    expect(searchIndex).toBeGreaterThanOrEqual(0);
    expect(selectIndex).toBeGreaterThan(searchIndex);
    expect(selectIndex).toBeLessThan(copyIndex);

    // 建壳后（真实渲染入口）：wrapper 落在原 select 的位置，原生 select 被组件
    // 视觉隐藏（内联 display:none）——可见 affordance 只有 custom-select 的 trigger
    loadTracks();
    shell.renderReadingView();
    expect(select.style.display).toBe("none");
    expect(trigger().tagName).toBe("BUTTON");
    const after = [...bar.children];
    const pickerIndex = after.findIndex((node) => node.classList.contains("biliscript-reading-track-picker"));
    expect(pickerIndex).toBeGreaterThan(searchIndex);
    expect(pickerIndex).toBeLessThan(after.findIndex((node) => node.id === ids.readingCopySubtitleBtn));
    // 其余工具条控件没被顶掉
    expect(bar.querySelector(".biliscript-reading-search-input")).not.toBeNull();
    // 复制/导出是图标键（文字 mini-btn 已图标化）：class 走 icon-btn 母题、
    // 作用由 title 文字提示、图标在键内（不再有可见文字）
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

    // 渲染只投影：水合若派发 change，会经 change 处理器触发一次装载 + busy
    expect(selectNode().value).toBe("https://sub/ai-en.json");
    expect(triggerText()).toBe("English");
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(bus).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "status" }));
  });
});

describe("08 选轨控件：列表 ≡ clip.subtitles", () => {
  it("8 条 ai-* 轨：列表恰好 8 项、文字为裸语言名、顺序＝接口原顺序（Q5/Q8′）", () => {
    loadTracks();
    shell.renderReadingView();

    const expected = ["中文", "English", "日本語", "Español", "العربية", "Português", "ภาษาไทย", "Bahasa Indonesia"];
    // 原生选项、组件浮层项、渲染顺序三者一致——控件不另排一套（06 号票已定序）
    expect(optionTexts()).toEqual(expected);
    expect(optionTexts()).not.toEqual([...expected].sort());
    expect(listTexts()).toEqual(expected);
    expect(optionIds()).toEqual(SAMPLE_TRACKS.map((track) => track.id));
    expect(optionValues()).toEqual(SAMPLE_TRACKS.map((track) => track.subtitleUrl));
    expect(selectNode().options.length).toBe(8);
  });

  it("列表是 clip.subtitles 的纯投影：state 里的次序即列表次序，控件不另排一套（Q8′ 做减法）", () => {
    // 上面那条样本的接口原顺序恰好以中文打头（ai-zh 是第 1 条），所以「按
    // clip.subtitles 顺序渲染」与「控件自己再排一次中文优先」在样本上同解。
    // 这条用例把中文挪到第 2 位（抓取链产出的 clip.subtitles 恒是规范序，
    // 故此输入是投影纪律的探针，不是可达数据）：控件若保留任何第二套排序，
    // 列表会被重排成中文打头 → 红。
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

    // RTL 行（العربية）跟文字方向走：选项行带 dir=auto 是组件表 text-align:start
    //（10 号票）生效的前提。注：组件当前只用该选项的文本与选中态建浮层项，
    // 不镜像 dir——浮层行的方向继承 select 的 dir；这是组件侧未补的口子，08
    // 只落「选项行带 dir」，不 poke 组件内部节点。
    expect([...selectNode().options].every((option) => option.dir === "auto")).toBe(true);
    expect(selectNode().options[4].textContent).toBe("العربية");
    // 裸语言名（无「字幕：」前缀），字段名只在 aria-label 里
    expect(triggerText()).toBe("中文");
    expect(triggerText()).not.toContain("字幕");
  });

  it("[AI] 标：单源列表（8 条全 ai-*）不标；混源（人工轨/ASR 伪轨 + AI 轨）才标", () => {
    loadTracks();
    shell.renderReadingView();
    expect(optionTexts().every((text) => !text.includes("[AI]"))).toBe(true);
    expect(listTexts().every((text) => !text.includes("[AI]"))).toBe(true);

    // 混源：人工上传轨 + B站 AI 轨 → AI 轨挂标，人工轨不挂
    loadTracks([
      { id: "1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://sub/manual.json", source: "player" },
      { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" }
    ], "zh-CN");
    shell.renderReadingView();
    expect(optionTexts()).toEqual(["中文", "English [AI]"]);

    // 混源：ASR 伪轨（asr-zh）与 AI 轨同列 → AI 轨挂标，伪轨（自带来源串）不挂
    loadTracks([
      { id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）", subtitleUrl: "", source: "asr" },
      { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" }
    ], "asr");
    shell.renderReadingView();
    expect(optionTexts()).toEqual(["自配平台转写（中文）", "English [AI]"]);
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
    // 空 value 不参与选中（原生语义：多空值项取首个），控件按 id 命中伪轨
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

    // 点浮层里的 English 行（组件 chooseOption：写值 + 派发 change）
    selectViaList("English");

    // change 处理器**只装载**：重渲归 subtitle-ready 通知（唯一 emit 点），自己
    // 不许直调渲染——同步阶段（await 之前）正文必须还是旧轨。本壳未开阅读视图
    //（readingViewOpen=false，隔离 withReader 装载路径），subtitle-ready 通知的
    // 渲染分支因此不出场；换轨的 DOM 收尾由 lifecycle/overview 的用例覆盖，
    // 本用例锁的是「state 换轨 + 控件收敛」。
    expect(state.clip.subtitleBody).toEqual(ZH_BODY);

    await vi.waitFor(() => {
      expect(state.clip.subtitleBody).toEqual(EN_BODY);
    });
    expect(state.clip.selectedSubtitleId).toBe("2121827445538866944");
    expect(state.clip.selectedSubtitleLang).toBe("ai-en");
    expect(state.clip.selectedSubtitleUrl).toBe("https://sub/ai-en.json");
    // 收尾收敛：控件回到「显示 = 现值」且解除忙碌/禁用。漏掉这次收敛，一次成功的
    // 换轨会让控件永久停在「禁用 + 忙碌」（2026-10-06 红检：撤掉 finally 里的收敛
    // → 本断言红，trigger.disabled 恒 true）。
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

    // 同步阶段（await 之前）：state 与正文都还是旧轨——没有直调渲染
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
    // 混源列表在本仓现状下不可达（ASR 回退只从无轨出口进入），这里手工构造，锁的
    // 是「点到不可装载的行，控件不许停在用户点的那一行而正文还是旧轨」。
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
    // 收敛回 state 的当前轨。trigger 与列表项同文（显示 = 现值）：混源列表下
    // 当前轨是 AI 轨，故带 [AI] 标（Q5′ 的标只在混源时出现）。
    expect(triggerText()).toBe("English [AI]");
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(state.clip.selectedSubtitleId).toBe("2");
  });
});

// 2f974c5 删下拉时一并删掉的防回焊锁（tests/reader/subtitle-tab-switch.test.ts）
// 的对应物。旧锁的失败方式清单：处理器在 loadSubtitle 之后还经 whenReaderReady
// 直调 renderReadingView + syncReadingViewPlayback，与「接受事务的 subtitle-ready
// 通知」构成双渲染。08 的处理器把这条纪律重新实现，本 describe 重新钉住——
// reader-gate 在本文件被 mock，故「直调渲染」= whenReaderReady 被调用。
describe("切轨只装载，不直调渲染（2f974c5 防回焊锁的对应物）", () => {
  it("change 处理器：chain.loadSubtitle(url, lang, runId, id) 恰一次，参数正确，且不触碰渲染通道", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    // 换掉默认 mock 链：本用例要逐步断言 loadSubtitle 的实参（默认 mock 吞掉入参自己
    // 走接受事务，没有可断言的调用记录）。
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
    // 四个实参逐一钉住：URL 取选项 value、语言取 data-lang、代次取 state 的抓取代次、
    // 身份取 data-id（Q11 的 id_str）。少传/错位都会红。
    expect(loadSubtitle).toHaveBeenCalledWith(
      "https://sub/ai-en.json",
      "ai-en",
      runIdAtDispatch,
      "2121827445538866944"
    );
    // 把处理器的收尾彻底排干再断言渲染通道：直调渲染若写在 finally 末尾，不排干
    // 会被这条断言从时间缝里漏过去。
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 处理器**只**调 chain.loadSubtitle 与两次组件入口（setCustomSelectValue /
    // setCustomSelectState），收尾也只收敛控件自己——不许经 whenReaderReady 直调
    // renderReadingView（那会与 subtitle-ready 通知双渲染）。
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
    // 失败路径是回焊的高危点（历史上正是「装载完再补一次渲染」）：catch 里不许出现
    // 任何直调渲染，回退只走 finally 的那次控件收敛。
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
    // 字幕这一面不出现「暂无字幕」假话，也不出现任何假字幕
    expect(panelSubtitleText()).not.toContain("暂无字幕");
    expect(listText()).toContain("当前视频无字幕");
  });

  it("loading：抓取窗口（subtitleFetchState=loading）→ 哨兵「抓取中…」+ 禁用，不说「暂无字幕」", () => {
    // 切视频/刷新抓取路径：reset 清空轨道 → refreshClip 先置 loading 再抓（用户
    // 2026-10-06 实测：这段窗口控件原本写着「暂无字幕」，是断言了尚不知道的事）。
    loadTracks([], "");
    state.clip.setSubtitleFetchState("loading");
    shell.renderReadingView();

    expect(optionTexts()).toEqual(["抓取中…"]);
    expect(triggerText()).toBe("抓取中…");
    expect(trigger().disabled).toBe(true);
  });

  it("loading 优先级低于转写中：ASR 转写期间 fetchState 仍是 loading，哨兵必须是「转写中…」", async () => {
    // 真实相位关系（subtitle/fetcher.ts 的 finishNoSubtitle）：无字幕出口的逆事务
    // commitNoSubtitle 要等 maybeRunAsrFallback 走完才把 fetchState 落 "empty"，整段
    // 转写期间它一直是 refreshClip 置的 "loading"。判据顺序写反（loading 先于转写）
    // 就会在转写期间把控件写成「抓取中…」，与面板横幅两说——这条锁的就是顺序。
    loadTracks([], "");
    state.clip.setSubtitleFetchState("loading");
    // 相位订阅只对开着的视图收敛（与横幅同一条判据）
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
    // 同视频「刷新抓取」不清轨道（resetClipState 只在 URL 变化路径跑），此时
    // clip.subtitles 仍是上一轮的结果——哨兵梯子只服务空列表那一支。
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    state.clip.setSubtitleFetchState("loading");
    shell.renderReadingView();

    expect(optionTexts()).toEqual(["中文", "English", "日本語", "Español", "العربية", "Português", "ภาษาไทย", "Bahasa Indonesia"]);
    expect(triggerText()).toBe("中文");
    expect(trigger().disabled).toBe(false);
  });

  it("transcribing：转写进行中 → 哨兵「转写中…」+ 禁用，与横幅同相（相位订阅驱动）", async () => {
    loadTracks([], "");
    // 相位订阅只对开着的视图收敛（与横幅同一条判据）；这里开视图即为了验证
    // 「转写相位变化本身就能把控件收敛过去」——不再补调 renderReadingView，
    // 因为 asr-transcribing 期间生产里不会有任何渲染通知（fetcher 注释）。
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(triggerText()).toBe("暂无字幕");

    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    // 与横幅同相（相位订阅驱动横幅与控件，同一订阅总线）
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

    // 让这次装载停在飞（不触达接受事务）：断言 busy 窗口
    vi.mocked(lazyModule.ensureSummarizeChain).mockImplementationOnce(() => new Promise(() => {}) as never);

    selectViaList("English");

    expect(triggerText()).toBe("English"); // 乐观显示目标轨（Q13）
    expect(trigger().disabled).toBe(true); // 禁用消解连点
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(optionTexts()).toHaveLength(8); // 列表保留旧轨
    expect(optionIds()).toEqual(SAMPLE_TRACKS.map((track) => track.id));
    expect(listText()).toContain("中文轨正文"); // 正文仍是旧轨
  });

  it("revert：装载失败 → trigger 回退到旧轨、恢复可用、经 status 通道报错；state 不变", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    const bus = vi.spyOn(readerBus, "notifyReaderPresenter");
    vi.mocked(lazyModule.ensureSummarizeChain).mockRejectedValueOnce(new Error("网络失败"));

    selectViaList("English");
    expect(triggerText()).toBe("English"); // 在飞期先乐观显示

    await vi.waitFor(() => {
      expect(triggerText()).toBe("中文"); // 失败回退到 state 里仍在的旧轨
    });
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    // state 未变：控件不得自说自话（Q14）
    expect(state.clip.selectedSubtitleId).toBe(SAMPLE_TRACKS[0].id);
    expect(listText()).toContain("中文轨正文");
    expect(bus).toHaveBeenCalledWith({ kind: "status", text: expect.stringContaining("网络失败") });
  });

  it("busy 期间的重渲不把乐观 trigger 拉回旧轨（一次只有一个请求在飞）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    vi.mocked(lazyModule.ensureSummarizeChain).mockImplementationOnce(() => new Promise(() => {}) as never);

    selectViaList("日本語");
    expect(triggerText()).toBe("日本語");

    // 在飞期间到达的重渲（如抓取对账）不得改写 trigger / 解除禁用
    shell.renderReadingView();
    expect(triggerText()).toBe("日本語");
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
  });

  it("busy：在飞期间重复 change 只发起一次装载（禁用消解连点，同副列那条口径）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    // 停在飞的装载（可控计数）：loadSubtitle 挂起 ⇒ 在飞窗口保持
    const loadSubtitle = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(lazyModule.ensureSummarizeChain).mockResolvedValue({ loadSubtitle } as never);

    selectViaList("English");
    await vi.waitFor(() => expect(loadSubtitle).toHaveBeenCalledTimes(1));
    expect(triggerText()).toBe("English");
    expect(selectNode().disabled).toBe(true); // 控件在飞即禁用

    // 在飞期间再改一次选（原生 select 写值 + 派发 change）：禁用期一律忽略，
    // 不许起第二个请求，也不许把乐观 trigger 换成第二拍的值
    selectNode().value = "https://sub/ai-ja.json";
    selectNode().dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadSubtitle).toHaveBeenCalledTimes(1);
    expect(triggerText()).toBe("English");
    expect(trigger().disabled).toBe(true);
  });

  it("相位订阅只服务 asr-*：发布 subtitle-ready 不重渲控件，asr-transcribing / asr-done 才触发", async () => {
    loadTracks([], "");
    // 重渲若发生，触发态文案会从「抓取中…」变成「转写中…」——重渲本身由此可观测
    state.clip.setSubtitleFetchState("loading");
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(triggerText()).toBe("抓取中…");

    const customSelect = await import("../../extension/ui/custom-select.js");
    const rebuild = vi.spyOn(customSelect, "rebuildCustomSelectOptions");
    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");

    // subtitle-ready 相位只驱动 chat 等待闸（见 shared/subtitle-status-bus 的相位清单），
    // 渲染归 reader-bus 的 subtitle-ready 通知 ⇒ 订阅到它不重渲本控件
    statusBus.publishSubtitleStatusPhase("subtitle-ready");
    expect(rebuild).not.toHaveBeenCalled();
    expect(triggerText()).toBe("抓取中…");

    // 转写相位照旧收敛（转写中优先于抓取中）
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect(rebuild).toHaveBeenCalled();
    expect(triggerText()).toBe("转写中…");

    // 收尾相位同样触发：转写结束 ⇒ 投影退回「抓取中…」
    rebuild.mockClear();
    statusBus.publishSubtitleStatusPhase("asr-done");
    expect(rebuild).toHaveBeenCalled();
    expect(triggerText()).toBe("抓取中…");
  });
});

// 壳被整块重建（阅读面板 forceRecreate）后的接线与在飞值：change 接线随建壳走
// （组件 initCustomSelect 的 onChange），在飞值（switchInFlight）是模块级值、跨重建存活。
describe("08 选轨控件：壳重建（forceRecreate）后的接线", () => {
  it("在飞期间壳重建：trigger 仍显示乐观目标轨，落定后按 state 收敛，新壳改选仍发起装载", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    const JA = SAMPLE_TRACKS[2];
    // 可控装载：停在飞，等用例放行后按失败落定（state 不变 ⇒ 收敛回旧轨可观测）
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

    // 壳整块重建：select 与壳都是新节点
    const oldSelect = selectNode();
    uiRenderer.ensureUiReady({ forceRecreate: true });
    mountPlayerChain();
    shell.renderReadingView();

    expect(selectNode()).not.toBe(oldSelect);
    expect(oldSelect.isConnected).toBe(false);
    // 模块级在飞值跨壳重建存活 ⇒ 新壳第一拍仍是乐观目标轨 + 忙碌禁用
    expect(triggerText()).toBe("日本語");
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");

    // 放行（失败落定）：收尾收敛按 state 投影 —— 回退到仍在的旧轨、解除忙碌
    failLoad(new Error("网络失败"));
    await vi.waitFor(() => {
      expect(triggerText()).toBe("中文");
    });
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(state.clip.selectedSubtitleId).toBe(SAMPLE_TRACKS[0].id);

    // 新壳的改选真的发起装载（change 接线在建壳时完成，不靠任何按节点去重的补绑）
    selectViaList("日本語");
    await vi.waitFor(() => expect(loadSubtitle).toHaveBeenCalledTimes(2));
    expect(loadSubtitle).toHaveBeenLastCalledWith(JA.subtitleUrl, "ai-ja", state.clip.fetchRunId, JA.id);
  });
});
