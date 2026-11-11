// 伪轨视频（自配平台转写）的副列投影：副列的选项来源换成译文目标语言、列首标题
// 换成「译文」、说明行承担进度、按钮承担启动/补齐（票 asr-panel-translation）。
//
// 同一张双列卡、同一套节点骨架与度量——本套件只锁「换来源后的投影」，不重复锁
// 骨架/度量（那些在 bilingual-picker 与 bilingual-subtitles.css 的用例里）。
//
// 系统可能怎么坏：
//   a. 副列仍按轨列表铺：伪轨 url 空被过滤 ⇒ 副列空着一排，用户没有可选语言；
//   b. 列首标题仍写「副字幕」：这一列装的是译文语言，不是第二条字幕轨；
//   c. 说明行/按钮不投影：开关亮着却什么都不发生（控件与状态两说）；
//   d. 在飞不禁用副列：同一视频被点成两份目标语言。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";
import type { SecondaryColumnView } from "../../extension/reader/secondary-subtitle.js";
import type {
  SubtitleToolbarFacts
} from "../../extension/reader/subtitle-tab-ui.js";
import type { AsrTranslationView } from "../../extension/reader/asr-translation.js";
import { LIVE_INTERPRET_TARGET_LANG_OPTIONS } from "../../extension/live/interpret-subtitle-preferences.js";

const SECONDARY_SELECT_ID = "biliscript-reading-secondary-subtitle-select";
const READER_MODE_URL = "https://www.bilibili.com/video/BV1test000000/?biliscript_reader=1";

const ASR_TRACK: SubtitleTrack = {
  id: "asr",
  lan: "asr-zh",
  lanDoc: "自配平台转写（中文）",
  subtitleUrl: "",
  source: "asr"
};

let tabUi: typeof import("../../extension/reader/subtitle-tab-ui.js");
let toolbar: import("../../extension/reader/subtitle-tab-ui.js").SubtitleToolbar;
let ids: typeof import("../../extension/reader/state.js").ids;
let state: (typeof import("../../extension/core/state.js"))["state"];

function emptyColumn(): SecondaryColumnView {
  return { note: "", footerNote: "", selectedUrl: "", retry: false, busy: false };
}

function translationView(overrides: Partial<AsrTranslationView> = {}): AsrTranslationView {
  return {
    lang: "en",
    inFlight: false,
    note: "",
    action: { label: "开始生成译文", kind: "start" },
    ...overrides
  };
}

function asrFacts(overrides: Partial<SubtitleToolbarFacts> = {}): SubtitleToolbarFacts {
  return {
    tracks: [ASR_TRACK],
    bilingual: true,
    switchDisabled: false,
    transcribing: false,
    loading: false,
    marked: false,
    selectedTrackId: "asr",
    switchInFlight: null,
    secondaryColumn: emptyColumn(),
    asrScenario: true,
    asrTranslation: translationView(),
    ...overrides
  };
}

function render(facts: SubtitleToolbarFacts): void {
  toolbar.render(() => facts);
}

function mountAnchor(): void {
  const select = document.createElement("select");
  select.id = ids.readingSubtitleSelect;
  document.body.appendChild(select);
}

function wrapper(): HTMLElement {
  return document.getElementById(ids.readingSubtitleSelect)!.closest(".biliscript-reading-track-picker") as HTMLElement;
}

function card(): HTMLElement {
  return wrapper().querySelector(".custom-select-dropdown") as HTMLElement;
}

function shown(node: HTMLElement | null | undefined): node is HTMLElement {
  return !!node && !node.hidden;
}

function col(name: "main" | "sub"): HTMLElement | null {
  const node = card().querySelector<HTMLElement>(`.biliscript-bilingual-col[data-col="${name}"]`);
  return shown(node) ? node : null;
}

function subHeadText(): string {
  return col("sub")?.querySelector(".biliscript-bilingual-col-head")?.textContent || "";
}

function secondarySelect(): HTMLSelectElement {
  return document.getElementById(SECONDARY_SELECT_ID) as HTMLSelectElement;
}

function subRowTexts(): string[] {
  return [...(col("sub")?.querySelectorAll<HTMLElement>(".custom-select-option") ?? [])].map(
    (row) => row.textContent || ""
  );
}

function emptyNote(): string {
  const node = card().querySelector<HTMLElement>(".biliscript-bilingual-empty");
  return shown(node) ? node.textContent || "" : "";
}

function retryButton(): HTMLButtonElement | null {
  const node = card().querySelector<HTMLButtonElement>(".biliscript-bilingual-retry");
  return shown(node) ? node : null;
}

function hintText(): string {
  const node = card().querySelector<HTMLElement>(".biliscript-bilingual-hint");
  return shown(node) ? node.textContent || "" : "";
}

function footer(): HTMLElement {
  return card().querySelector(".biliscript-bilingual-footer") as HTMLElement;
}

function toggle(): HTMLButtonElement {
  return footer().querySelector(".biliscript-bilingual-switch") as HTMLButtonElement;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  location.href = READER_MODE_URL;
  tabUi = await import("../../extension/reader/subtitle-tab-ui.js");
  toolbar = tabUi.createSubtitleToolbar();
  ids = (await import("../../extension/reader/state.js")).ids;
  state = (await import("../../extension/core/state.js")).state;
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
  mountAnchor();
});

describe("伪轨视频的副列（译文目标语言）", () => {
  it("副列 = 14 个译文语言行（与浮层同一份词表），选中 = 当前目标语言", () => {
    render(asrFacts());

    expect(col("sub")).not.toBeNull();
    expect(subRowTexts()).toEqual(LIVE_INTERPRET_TARGET_LANG_OPTIONS.map((option) => option.label));
    // 原生值源同构：value = 语言码，data-id = 副轨槽身份
    expect([...secondarySelect().options].map((option) => option.value)).toEqual(
      LIVE_INTERPRET_TARGET_LANG_OPTIONS.map((option) => option.value)
    );
    expect(secondarySelect().value).toBe("en");
    expect(secondarySelect().options[secondarySelect().selectedIndex].dataset.id).toBe("translate-en");
  });

  it("列首标题是「译文」，不是「副字幕」（这一列装的是译文语言）", () => {
    render(asrFacts());
    expect(subHeadText()).toBe("译文");
  });

  it("单轨说明不再出现，页脚只留「双语字幕 + 开关」", () => {
    render(asrFacts());

    expect(hintText()).toBe("");
    expect(footer().textContent?.trim()).toBe("双语字幕");
    expect(toggle().disabled).toBe(false);
  });

  it("双语关：副列不出，但开关可用（伪轨视频可配对）", () => {
    render(asrFacts({ bilingual: false }));

    expect(col("sub")).toBeNull();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});

describe("副列的说明行与按钮（进度 / 启动 / 补齐）", () => {
  it("未开始：按钮 =「开始生成译文」，说明行为空", () => {
    render(asrFacts());

    expect(retryButton()?.textContent).toBe("开始生成译文");
    expect(retryButton()?.disabled).toBe(false);
    expect(emptyNote()).toBe("");
  });

  it("在飞：说明行出进度，按钮收起，副列整列禁用", () => {
    render(
      asrFacts({
        asrTranslation: translationView({
          inFlight: true,
          note: "正在生成译文 3/12 片",
          action: null
        })
      })
    );

    expect(emptyNote()).toBe("正在生成译文 3/12 片");
    expect(retryButton()).toBeNull();
    expect(secondarySelect().disabled).toBe(true);
  });

  it("部分失败：说明行 +「补齐失败的 2 片」", () => {
    render(
      asrFacts({
        asrTranslation: translationView({
          note: "译文已生成，部分分片失败",
          action: { label: "补齐失败的 2 片", kind: "fill" }
        })
      })
    );

    expect(emptyNote()).toBe("译文已生成，部分分片失败");
    expect(retryButton()?.textContent).toBe("补齐失败的 2 片");
  });

  it("零产出：按钮 =「重试」，副列仍可点新语言", () => {
    render(
      asrFacts({
        asrTranslation: translationView({ action: { label: "重试", kind: "retry" } })
      })
    );

    expect(retryButton()?.textContent).toBe("重试");
    expect(secondarySelect().disabled).toBe(false);
  });
});
