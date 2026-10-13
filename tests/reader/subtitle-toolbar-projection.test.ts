// 字幕工具条选轨控件的**投影级**孤测（reader/subtitle-tab-ui.ts 的
// renderReadingSubtitleTrackPicker）。
//
// 这一层是「事实 → DOM」的纯投影：取数（读 state 袋、模块内在飞值、副列六态判定）
// 全收在 selectSubtitleToolbarFacts，投影体只消费 SubtitleToolbarFacts。故本文件
// 用一份假事实直接驱动投影入口，无需阅读壳：不挂真实模板、不挂播放器链、不 import
// reader-bus 的通知面、不 mock 总结链。「六态 + 双语量矩阵」因此可以逐格孤测。
//
// 最小 DOM：投影按 id 找原生 select，找不到就整段早退（取数也在早退之后）。壳
//（custom-select-wrapper）、浮层、卡片骨架（主/副两列、页脚、副列那枚原生 select）
// 全部由投影自己建，故这里只放一枚锚点 select——工具条、阅读面板、字幕列表、转写
// 横幅一律不搭：它们不是本投影的输入，也不是它的输出。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   1. 取数前置：工具条缺席时仍去取事实（把锚点判据挪到取数之后，壳缺席路径会读 state 袋）；
//   2. 主列三态：无轨时不塞哨兵（组件没有选项时 trigger 是空按钮）／抓取窗口说「暂无
//      字幕」（断言了尚不知道的事）／转写中与抓取中的判据顺序写反（转写期间控件写
//      「抓取中…」，与面板横幅两说）；
//   3. 列表投影：轨道被少列/多列/另排一套（要严格跟随 tracks 原顺序）／选项文字被
//      归一（要 lanDoc 原文）／丢 dir="auto"／选中项不按 selectedTrackId 落；
//   4. 在飞：trigger 不显示乐观目标轨（用户点了没反馈）／不置禁用与忙碌（连点起两个
//      请求）／列表被乐观目标改写（控件与正文两说）；
//   5. 双语量：双语关时副列或徽标漏出／开关的 on 态与偏好两说／单轨禁用态把说明挤进
//      页脚或副列仍出席；
//   6. 副列模型投影：note/footerNote 被改写（模型与 DOM 两说）／重试行常显／
//      selectedUrl 不落值源／busy 不落本列禁用与忙碌（本列可连点）；
//   7. [AI] 标：marked 为真时不带标（混源列表读不出来源）／为假时挂标；
//   8. 副列列表：空 URL 的 ASR 伪轨被列进副列（副列只列可装载的真轨）。
//
// 文案口径：期望值一律现算——ids 取 reader/state 的导出、副列文案取判定叶
// resolveSecondaryColumnView 的模型字段（本文件**不重算**那三套空态的判定与文案）、
// 选项文字取轨自己的 lanDoc、页脚标签取开关自己的 aria-label。[AI] 后缀与三条主列
// 哨兵是投影叶里的私有字面量（无导出），只能按字面量钉住；副列值源的 id 同理。
//
// 本文件不碰真实壳与播放器链：端到端的形态/落点/装载/失败口径归
// tests/reader/subtitle-track-picker.test.ts 与 tests/reader/bilingual-picker.test.ts。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";
import type { SecondaryColumnView } from "../../extension/reader/secondary-subtitle.js";
import type { SubtitleToolbarFacts } from "../../extension/reader/subtitle-tab-ui.js";

// ===== 私有字面量（投影叶无导出，只能按字面量钉住）=====
// 主列哨兵的取值优先级是本文件要锁的东西，故这三条必须逐字在场。
const SENTINEL_EMPTY = "暂无字幕";
const SENTINEL_LOADING = "抓取中…";
const SENTINEL_TRANSCRIBING = "转写中…";
const AI_MARK = "[AI]";
const SECONDARY_SELECT_ID = "biliscript-reading-secondary-subtitle-select";

// 轨样本：lan 与 lanDoc 逐条不同（断言「选项文字 = lanDoc 原文」时不会与 lan 同解），
// 三条都有 subtitleUrl（副列只列可装载的真轨），混 ai-* 与非 ai 两种来源。
const SAMPLE_TRACKS: SubtitleTrack[] = [
  { id: "t-zh", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://sub/zh.json", source: "player" },
  { id: "t-en", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/en.json", source: "player" },
  { id: "t-ja", lan: "ai-ja", lanDoc: "日本語", subtitleUrl: "https://sub/ja.json", source: "player" }
];

// ===== 假事实 =====

let tabUi: typeof import("../../extension/reader/subtitle-tab-ui.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let secondarySubtitle: typeof import("../../extension/reader/secondary-subtitle.js");

function emptyColumn(overrides: Partial<SecondaryColumnView> = {}): SecondaryColumnView {
  return { note: "", footerNote: "", selectedUrl: "", retry: false, busy: false, ...overrides };
}

// 缺省事实取「零轨、未转写、未抓取、无标记、无在飞」；switchDisabled 默认 true
//（零轨在真实取数里不可配对），用例按需覆写。
function makeFacts(overrides: Partial<SubtitleToolbarFacts> = {}): SubtitleToolbarFacts {
  return {
    tracks: [],
    bilingual: false,
    switchDisabled: true,
    transcribing: false,
    loading: false,
    marked: false,
    selectedTrackId: "",
    switchInFlight: null,
    secondaryColumn: emptyColumn(),
    ...overrides
  };
}

// 双语态（可配对）+ 有轨的公共事实：副列在场的用例都从它派生。
function dualBase(overrides: Partial<SubtitleToolbarFacts> = {}): Partial<SubtitleToolbarFacts> {
  return {
    tracks: SAMPLE_TRACKS,
    selectedTrackId: SAMPLE_TRACKS[0].id,
    bilingual: true,
    switchDisabled: false,
    ...overrides
  };
}

function render(facts: SubtitleToolbarFacts): void {
  tabUi.renderReadingSubtitleTrackPicker(() => facts);
}

// ===== 最小 DOM：只放投影自己找不到的那一枚锚点 =====

function mountAnchor(): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = ids.readingSubtitleSelect;
  document.body.appendChild(select);
  return select;
}

function mainSelect(): HTMLSelectElement {
  return document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement;
}

function mainWrapper(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".biliscript-reading-track-picker");
}

function wrapper(): HTMLElement {
  return mainSelect().closest(".biliscript-reading-track-picker") as HTMLElement;
}

// 卡片 = 组件浮层本体（双语卡片根 li.biliscript-bilingual-popover 装在里面）；
// 副列那枚组件壳的浮层嵌在卡片里，故这条取的是外层（主列）浮层。
function card(): HTMLElement {
  return wrapper().querySelector(".custom-select-dropdown") as HTMLElement;
}

function trigger(): HTMLButtonElement {
  return wrapper().querySelector(".custom-select-trigger") as HTMLButtonElement;
}

function triggerText(): string {
  return trigger().querySelector(".custom-select-value")?.textContent || "";
}

function optionTexts(select: HTMLSelectElement = mainSelect()): string[] {
  return [...select.options].map((option) => option.textContent || "");
}

function optionValues(select: HTMLSelectElement = mainSelect()): string[] {
  return [...select.options].map((option) => option.value);
}

function shown(node: HTMLElement | null | undefined): node is HTMLElement {
  return !!node && !node.hidden;
}

// 列「不出场」= 列自身 hidden（骨架常驻，投影只切显隐）：取用口按不出场返回 null，
// 用例读起来仍是「副列在不在」。
function col(name: "main" | "sub"): HTMLElement | null {
  const node = card().querySelector<HTMLElement>(`.biliscript-bilingual-col[data-col="${name}"]`);
  return shown(node) ? node : null;
}

function mainRows(): HTMLElement[] {
  return [...(col("main")?.querySelectorAll<HTMLElement>(".custom-select-option") ?? [])];
}

function hintText(): string {
  const node = card().querySelector<HTMLElement>(".biliscript-bilingual-hint");
  return shown(node) ? node.textContent || "" : "";
}

function emptyNote(): string {
  const node = card().querySelector<HTMLElement>(".biliscript-bilingual-empty");
  return shown(node) ? node.textContent || "" : "";
}

function footer(): HTMLElement {
  return card().querySelector(".biliscript-bilingual-footer") as HTMLElement;
}

function footerNoteText(): string {
  const node = footer().querySelector<HTMLElement>(".biliscript-bilingual-footer-note");
  return shown(node) ? node.textContent || "" : "";
}

function toggle(): HTMLButtonElement {
  return footer().querySelector(".biliscript-bilingual-switch") as HTMLButtonElement;
}

// 页脚只容纳「双语字幕 + 状态提示 + 开关」——标签就是开关自己的 aria-label。
function footerLabel(): string {
  return toggle().getAttribute("aria-label") || "";
}

function badge(): HTMLElement | null {
  return trigger().querySelector(".biliscript-bilingual-badge");
}

function retryButton(): HTMLButtonElement | null {
  const node = card().querySelector<HTMLButtonElement>(".biliscript-bilingual-retry");
  return shown(node) ? node : null;
}

function secondarySelect(): HTMLSelectElement {
  return document.getElementById(SECONDARY_SELECT_ID) as HTMLSelectElement;
}

function secondaryTrigger(): HTMLButtonElement {
  return secondarySelect().closest(".custom-select-wrapper")!.querySelector(".custom-select-trigger") as HTMLButtonElement;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  tabUi = await import("../../extension/reader/subtitle-tab-ui.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  secondarySubtitle = await import("../../extension/reader/secondary-subtitle.js");
});

describe("投影入口：取数在锚点之后", () => {
  it("工具条缺席：整段早退，事实一次都不取、一个节点都不建", () => {
    const selectFacts = vi.fn(() => makeFacts());
    tabUi.renderReadingSubtitleTrackPicker(selectFacts);

    expect(selectFacts).not.toHaveBeenCalled();
    expect(mainWrapper()).toBeNull();

    mountAnchor();
    tabUi.renderReadingSubtitleTrackPicker(selectFacts);
    expect(selectFacts).toHaveBeenCalledTimes(1);
  });
});

describe("主列：三态与优先级", () => {
  it("无轨且未转写、未抓取：哨兵「暂无字幕」+ 控件禁用", () => {
    mountAnchor();
    render(makeFacts());

    expect(optionTexts()).toEqual([SENTINEL_EMPTY]);
    expect(mainSelect().value).toBe("");
    expect(triggerText()).toBe(SENTINEL_EMPTY);
    expect(trigger().disabled).toBe(true);
    expect(mainSelect().disabled).toBe(true);
  });

  it("抓取窗口（loading）：哨兵「抓取中…」+ 控件禁用，不说「暂无字幕」", () => {
    mountAnchor();
    render(makeFacts({ loading: true }));

    expect(optionTexts()).toEqual([SENTINEL_LOADING]);
    expect(optionTexts()).not.toContain(SENTINEL_EMPTY);
    expect(triggerText()).toBe(SENTINEL_LOADING);
    expect(trigger().disabled).toBe(true);
  });

  it("转写中压过抓取中：两者同时为真时哨兵是「转写中…」", () => {
    mountAnchor();
    render(makeFacts({ loading: true, transcribing: true }));

    expect(optionTexts()).toEqual([SENTINEL_TRANSCRIBING]);
    expect(optionTexts()).not.toContain(SENTINEL_LOADING);
    expect(triggerText()).toBe(SENTINEL_TRANSCRIBING);
    expect(trigger().disabled).toBe(true);
  });

  it("有轨：列表 = tracks 原顺序、选项文字 = lanDoc 原文、dir=auto、选中项按 selectedTrackId", () => {
    mountAnchor();
    render(makeFacts({ tracks: SAMPLE_TRACKS, selectedTrackId: SAMPLE_TRACKS[1].id }));

    expect(optionTexts()).toEqual(SAMPLE_TRACKS.map((track) => track.lanDoc));
    expect(optionValues()).toEqual(SAMPLE_TRACKS.map((track) => track.subtitleUrl));
    expect([...mainSelect().options].every((option) => option.dir === "auto")).toBe(true);

    const selected = [...mainSelect().options].filter((option) => option.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.id).toBe(SAMPLE_TRACKS[1].id);
    expect(mainSelect().value).toBe(SAMPLE_TRACKS[1].subtitleUrl);
    expect(triggerText()).toBe(SAMPLE_TRACKS[1].lanDoc);
    expect(trigger().disabled).toBe(false);

    // 卡片主列那批浮层行是同一批选项行的落点：同序、同文、同值
    expect(mainRows().map((row) => row.textContent)).toEqual(SAMPLE_TRACKS.map((track) => track.lanDoc));
    expect(mainRows().map((row) => row.dataset.value)).toEqual(optionValues());
  });
});

describe("在飞：乐观目标轨与保留旧列表", () => {
  it("switchInFlight 非空：trigger 显示乐观目标轨、控件禁用 + 忙碌、列表仍是 tracks", () => {
    mountAnchor();
    const target = SAMPLE_TRACKS[2];
    render(
      makeFacts({
        tracks: SAMPLE_TRACKS,
        selectedTrackId: SAMPLE_TRACKS[0].id,
        switchInFlight: target.subtitleUrl
      })
    );

    expect(triggerText()).toBe(target.lanDoc);
    expect(triggerText()).not.toBe(SAMPLE_TRACKS[0].lanDoc);
    expect(mainSelect().value).toBe(target.subtitleUrl);
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(mainSelect().disabled).toBe(true);

    // 列表不被乐观目标改写：仍是 tracks 原顺序原内容（换轨由接受事务后的整体重渲落定）
    expect(optionTexts()).toEqual(SAMPLE_TRACKS.map((track) => track.lanDoc));
    expect(optionValues()).toEqual(SAMPLE_TRACKS.map((track) => track.subtitleUrl));
  });

  it("在飞归空：trigger 与值回到 selectedTrackId，解除禁用与忙碌", () => {
    mountAnchor();
    render(
      makeFacts({
        tracks: SAMPLE_TRACKS,
        selectedTrackId: SAMPLE_TRACKS[0].id,
        switchInFlight: SAMPLE_TRACKS[2].subtitleUrl
      })
    );
    expect(trigger().disabled).toBe(true);

    render(makeFacts({ tracks: SAMPLE_TRACKS, selectedTrackId: SAMPLE_TRACKS[0].id, switchInFlight: null }));

    expect(triggerText()).toBe(SAMPLE_TRACKS[0].lanDoc);
    expect(mainSelect().value).toBe(SAMPLE_TRACKS[0].subtitleUrl);
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
  });
});

describe("双语量：bilingual × switchDisabled", () => {
  it("bilingual=false：单列 + 页脚开关 off、无徽标、无副列", () => {
    mountAnchor();
    render(makeFacts({ tracks: SAMPLE_TRACKS, selectedTrackId: SAMPLE_TRACKS[0].id, switchDisabled: false }));

    expect(col("main")).not.toBeNull();
    expect(col("sub")).toBeNull();
    expect(badge()).toBeNull();
    expect(hintText()).toBe("");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().dataset.on).toBe("false");
    expect(toggle().disabled).toBe(false);
    // 页脚只有标签与开关（说明/提示不占页脚）
    expect(footer().textContent?.trim()).toBe(footerLabel());
  });

  it("bilingual=true 且可配对：双列在场、徽标落在 trigger 里、页脚开关 on", () => {
    mountAnchor();
    render(makeFacts(dualBase()));

    expect(col("main")).not.toBeNull();
    expect(col("sub")).not.toBeNull();

    const badgeNode = badge();
    expect(badgeNode).not.toBeNull();
    expect(badgeNode!.textContent).toBeTruthy();
    // 徽标是 trigger 的成员，且不进值区（组件的值投影会抹掉值区内容）
    expect(trigger().contains(badgeNode!)).toBe(true);
    expect(trigger().querySelector(".custom-select-value")?.contains(badgeNode!)).toBe(false);

    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(toggle().dataset.on).toBe("true");
    expect(toggle().disabled).toBe(false);

    // 双语量不改主列列表
    expect(mainRows().map((row) => row.textContent)).toEqual(SAMPLE_TRACKS.map((track) => track.lanDoc));
  });

  it("switchDisabled=true：副列收起、开关禁用、单轨说明进列表区且不占页脚", () => {
    mountAnchor();
    const single = [SAMPLE_TRACKS[0]];
    render(makeFacts({ tracks: single, selectedTrackId: single[0].id, bilingual: true, switchDisabled: true }));

    expect(toggle().disabled).toBe(true);
    // 偏好本身没被改写：开关仍是 on，只是本视频不可配对
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(col("sub")).toBeNull();
    expect(badge()).toBeNull();

    const hintNode = card().querySelector<HTMLElement>(".biliscript-bilingual-hint");
    expect(shown(hintNode)).toBe(true);
    expect(hintText()).toBeTruthy();
    expect(card().querySelector(".biliscript-bilingual-main")!.contains(hintNode!)).toBe(true);
    expect(footer().contains(hintNode!)).toBe(false);
    expect(footer().textContent?.trim()).toBe(footerLabel());
  });
});

describe("副列：六态模型的事实投影", () => {
  it("note / footerNote 逐字落位：说明进副列列首、页脚提示进页脚", () => {
    mountAnchor();
    render(
      makeFacts(
        dualBase({ secondaryColumn: emptyColumn({ note: "列首说明探针", footerNote: "页脚提示探针" }) })
      )
    );

    expect(emptyNote()).toBe("列首说明探针");
    expect(footerNoteText()).toBe("页脚提示探针");

    const noteNode = card().querySelector(".biliscript-bilingual-empty")!;
    const footerNoteNode = card().querySelector(".biliscript-bilingual-footer-note")!;
    expect(col("sub")!.contains(noteNode)).toBe(true);
    expect(footer().contains(footerNoteNode)).toBe(true);
    expect(card().querySelector(".biliscript-bilingual-main")!.contains(footerNoteNode)).toBe(false);
  });

  it("note / footerNote 转空：同一骨架下一次投影即清空（不留残文）", () => {
    mountAnchor();
    render(makeFacts(dualBase({ secondaryColumn: emptyColumn({ note: "先来一行", footerNote: "再留一句" }) })));
    expect(emptyNote()).toBe("先来一行");
    expect(footerNoteText()).toBe("再留一句");

    render(makeFacts(dualBase()));

    expect(emptyNote()).toBe("");
    expect(footerNoteText()).toBe("");
    // 骨架幂等：开关与副列值源还是原节点（列不被重建）
    expect(col("sub")).not.toBeNull();
    expect(footer().textContent?.trim()).toBe(footerLabel());
  });

  it("retry：只在 retry=true 时出重试行，且只出在副列里", () => {
    mountAnchor();
    render(makeFacts(dualBase({ secondaryColumn: emptyColumn({ selectedUrl: SAMPLE_TRACKS[1].subtitleUrl }) })));
    expect(retryButton()).toBeNull();

    render(
      makeFacts(
        dualBase({ secondaryColumn: emptyColumn({ selectedUrl: SAMPLE_TRACKS[1].subtitleUrl, retry: true }) })
      )
    );
    const retry = retryButton();
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toBeTruthy();
    expect(col("sub")!.contains(retry!)).toBe(true);

    render(makeFacts(dualBase({ secondaryColumn: emptyColumn({ selectedUrl: SAMPLE_TRACKS[1].subtitleUrl }) })));
    expect(retryButton()).toBeNull();
  });

  it("selectedUrl 落副列值源；busy 落本列禁用与忙碌，busy=false 恢复可用", () => {
    mountAnchor();
    const target = SAMPLE_TRACKS[2];
    const loadable = SAMPLE_TRACKS.map((track) => track.subtitleUrl);

    render(
      makeFacts(dualBase({ secondaryColumn: emptyColumn({ selectedUrl: target.subtitleUrl, busy: true }) }))
    );

    expect(secondarySelect().value).toBe(target.subtitleUrl);
    const selected = [...secondarySelect().options].filter((option) => option.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].value).toBe(target.subtitleUrl);
    // 语言列表照铺（在飞不换列表、不锁死改选）：按轨身份（URL）读，不重算标签口径
    expect(optionValues(secondarySelect())).toEqual(loadable);

    expect(secondarySelect().disabled).toBe(true);
    expect(secondaryTrigger().disabled).toBe(true);
    expect(secondaryTrigger().getAttribute("aria-busy")).toBe("true");
    // 只禁本列：主列不牵连
    expect(trigger().disabled).toBe(false);

    render(
      makeFacts(dualBase({ secondaryColumn: emptyColumn({ selectedUrl: target.subtitleUrl, busy: false }) }))
    );

    expect(secondarySelect().disabled).toBe(false);
    expect(secondaryTrigger().disabled).toBe(false);
    expect(secondaryTrigger().getAttribute("aria-busy")).toBe("false");
    expect(secondarySelect().value).toBe(target.subtitleUrl);
  });

  it("三套空态：直接投影判定叶给出的 note / footerNote 字段，本文件不重算", () => {
    mountAnchor();
    // 判定与文案属 reader/secondary-subtitle.ts：这里只要它产出的模型，DOM 必须逐字等于模型。
    const noPreference = secondarySubtitle.resolveSecondaryColumnView({
      resolution: { kind: "none", reason: "no-preference" },
      preferenceLang: "",
      slotState: "idle",
      loadInFlight: false
    });
    const noTrack = secondarySubtitle.resolveSecondaryColumnView({
      resolution: { kind: "none", reason: "no-track" },
      preferenceLang: "ja-JP",
      slotState: "idle",
      loadInFlight: false
    });
    const mainTrack = secondarySubtitle.resolveSecondaryColumnView({
      resolution: { kind: "none", reason: "main-track" },
      preferenceLang: "ja-JP",
      slotState: "idle",
      loadInFlight: false
    });
    const loadable = SAMPLE_TRACKS.map((track) => track.subtitleUrl);

    for (const model of [noPreference, noTrack, mainTrack]) {
      render(makeFacts(dualBase({ secondaryColumn: model })));

      expect(emptyNote()).toBe(model.note);
      expect(footerNoteText()).toBe(model.footerNote);
      // 三套空态都不换掉语言列表（点错一条不该把改选锁死），也不出重试行/忙碌
      expect(optionValues(secondarySelect())).toEqual(loadable);
      expect(retryButton()).toBeNull();
      expect(secondarySelect().disabled).toBe(false);
    }

    // ①② 是两句不同的说明（不许并成一句）；③ 走页脚而不是说明行
    expect(noPreference.note).not.toBe(noTrack.note);
    expect(mainTrack.note).toBe("");
    expect(mainTrack.footerNote).not.toBe("");
  });
});

describe("[AI] 标：marked 事实", () => {
  it("marked=true：只给 ai-* 行挂标；marked=false：一律不带标", () => {
    mountAnchor();
    render(makeFacts({ tracks: SAMPLE_TRACKS, selectedTrackId: SAMPLE_TRACKS[0].id, marked: true }));

    expect(optionTexts()).toEqual([
      SAMPLE_TRACKS[0].lanDoc,
      `${SAMPLE_TRACKS[1].lanDoc} ${AI_MARK}`,
      `${SAMPLE_TRACKS[2].lanDoc} ${AI_MARK}`
    ]);
    // trigger 显示当前行（当前行非 AI ⇒ 无标）
    expect(triggerText()).toBe(SAMPLE_TRACKS[0].lanDoc);

    render(makeFacts({ tracks: SAMPLE_TRACKS, selectedTrackId: SAMPLE_TRACKS[1].id, marked: false }));
    expect(optionTexts().every((text) => !text.includes(AI_MARK))).toBe(true);
    expect(triggerText()).toBe(SAMPLE_TRACKS[1].lanDoc);
  });
});

describe("副列列表：只列可装载的真轨", () => {
  it("空 subtitleUrl 的 ASR 伪轨不进副列，主列照旧列全量（含伪轨）", () => {
    const pseudoTrack: SubtitleTrack = {
      id: "t-asr",
      lan: "asr",
      lanDoc: "转写",
      subtitleUrl: "",
      source: "asr"
    };
    const tracks = [...SAMPLE_TRACKS, pseudoTrack];
    mountAnchor();
    render(makeFacts(dualBase({ tracks })));

    // 主列 = 组件那批选项行（含 ASR 伪轨）；副列 = 只列有 subtitleUrl 的真轨，顺序不变。
    expect(optionValues(mainSelect())).toEqual(tracks.map((track) => track.subtitleUrl));
    expect(optionValues(secondarySelect())).toEqual(SAMPLE_TRACKS.map((track) => track.subtitleUrl));
  });
});
