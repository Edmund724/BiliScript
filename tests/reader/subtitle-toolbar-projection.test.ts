import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";
import type { SecondaryColumnView } from "../../extension/reader/secondary-subtitle.js";
import type { SubtitleToolbarFacts } from "../../extension/reader/subtitle-tab-ui.js";

const SENTINEL_EMPTY = "暂无字幕";
const SENTINEL_LOADING = "抓取中…";
const SENTINEL_TRANSCRIBING = "转写中…";
const AI_MARK = "（B 站 AI）";

const SAMPLE_TRACKS: SubtitleTrack[] = [
  { id: "t-zh", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://sub/zh.json", source: "player" },
  { id: "t-en", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/en.json", source: "player" },
  { id: "t-ja", lan: "ai-ja", lanDoc: "日本語", subtitleUrl: "https://sub/ja.json", source: "player" }
];

let tabUi: typeof import("../../extension/reader/subtitle-tab-ui.js");
let toolbar: import("../../extension/reader/subtitle-tab-ui.js").SubtitleToolbar;
let ids: typeof import("../../extension/reader/state.js").ids;
let secondarySubtitle: typeof import("../../extension/reader/secondary-subtitle.js");

function emptyColumn(overrides: Partial<SecondaryColumnView> = {}): SecondaryColumnView {
  return { note: "", footerNote: "", selectedUrl: "", retry: false, busy: false, ...overrides };
}

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
    asrScenario: false,
    asrTranslation: {
      lang: "zh",
      inFlight: false,
      note: "",
      action: null
    },
    ...overrides
  };
}

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
  toolbar.render(() => facts);
}

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
  return document.getElementById(ids.readingSecondarySubtitleSelect) as HTMLSelectElement;
}

function secondaryTrigger(): HTMLButtonElement {
  return secondarySelect().closest(".custom-select-wrapper")!.querySelector(".custom-select-trigger") as HTMLButtonElement;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  tabUi = await import("../../extension/reader/subtitle-tab-ui.js");
  toolbar = tabUi.createSubtitleToolbar();
  ids = (await import("../../extension/reader/state.js")).ids;
  secondarySubtitle = await import("../../extension/reader/secondary-subtitle.js");
});

describe("投影入口：取数在锚点之后", () => {
  it("工具条缺席：整段早退，事实一次都不取、一个节点都不建", () => {
    const selectFacts = vi.fn(() => makeFacts());
    toolbar.render(selectFacts);

    expect(selectFacts).not.toHaveBeenCalled();
    expect(mainWrapper()).toBeNull();

    mountAnchor();
    toolbar.render(selectFacts);
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

    expect(mainRows().map((row) => row.textContent)).toEqual(SAMPLE_TRACKS.map((track) => track.lanDoc));
    expect(mainRows().map((row) => row.dataset.value)).toEqual(optionValues());
    expect(mainRows().every((row) => row.dir === "auto")).toBe(true);
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
    expect(trigger().contains(badgeNode!)).toBe(true);
    expect(trigger().querySelector(".custom-select-value")?.contains(badgeNode!)).toBe(false);

    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(toggle().dataset.on).toBe("true");
    expect(toggle().disabled).toBe(false);

    expect(mainRows().map((row) => row.textContent)).toEqual(SAMPLE_TRACKS.map((track) => track.lanDoc));
  });

  it("switchDisabled=true：副列收起、开关禁用、单轨说明进列表区且不占页脚", () => {
    mountAnchor();
    const single = [SAMPLE_TRACKS[0]];
    render(makeFacts({ tracks: single, selectedTrackId: single[0].id, bilingual: true, switchDisabled: true }));

    expect(toggle().disabled).toBe(true);
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
    expect(optionValues(secondarySelect())).toEqual(loadable);

    expect(secondarySelect().disabled).toBe(true);
    expect(secondaryTrigger().disabled).toBe(true);
    expect(secondaryTrigger().getAttribute("aria-busy")).toBe("true");
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
      expect(optionValues(secondarySelect())).toEqual(loadable);
      expect(retryButton()).toBeNull();
      expect(secondarySelect().disabled).toBe(false);
    }

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
      `${SAMPLE_TRACKS[1].lanDoc}${AI_MARK}`,
      `${SAMPLE_TRACKS[2].lanDoc}${AI_MARK}`
    ]);
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

    expect(optionValues(mainSelect())).toEqual(tracks.map((track) => track.subtitleUrl));
    expect(optionValues(secondarySelect())).toEqual(SAMPLE_TRACKS.map((track) => track.subtitleUrl));
  });
});
