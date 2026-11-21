import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";

const lazy = vi.hoisted(() => ({
  bodies: {} as Record<string, unknown[]>,
  defaultBody: null as unknown[] | null,
  secondaryCalls: [] as unknown[][],
  secondaryMode: "ok" as "ok" | "pend" | "reject",
  secondaryBody: [] as unknown[]
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
    },
    loadSecondarySubtitle: async (
      url: string,
      lang: string,
      runId: number,
      subtitleId: string,
      forceRefresh: boolean
    ) => {
      lazy.secondaryCalls.push([url, lang, runId, subtitleId, forceRefresh]);
      const { clipState } = await import("../../extension/core/state.js");
      clipState.markSecondarySubtitleLoading({ id: subtitleId, url });
      if (lazy.secondaryMode === "pend") {
        return new Promise<void>(() => {});
      }
      if (lazy.secondaryMode === "reject") {
        clipState.markSecondarySubtitleError();
        throw new Error("副轨网络失败");
      }
      clipState.applySecondarySubtitle({ id: subtitleId, url, body: lazy.secondaryBody as never });
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

const ASR_TRACK: SubtitleTrack = {
  id: "asr",
  lan: "asr-zh",
  lanDoc: "自配平台转写（本机 ASR）",
  subtitleUrl: "",
  source: "asr"
};

const SAMPLE_TRACKS: SubtitleTrack[] = [
  { id: "2120476497172283392", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json", source: "player" },
  { id: "2121827445538866944", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json", source: "player" },
  { id: "2121827727664517376", lan: "ai-ja", lanDoc: "日本語", subtitleUrl: "https://sub/ai-ja.json", source: "player" },
  { id: "2121827577382789888", lan: "ai-es", lanDoc: "Español", subtitleUrl: "https://sub/ai-es.json", source: "player" },
  { id: "2121827596601095936", lan: "ai-id", lanDoc: "Bahasa Indonesia", subtitleUrl: "https://sub/ai-id.json", source: "player" }
];

const EN_ID = "2121827445538866944";
const EN_URL = "https://sub/ai-en.json";
const JA_ID = "2121827727664517376";
const JA_URL = "https://sub/ai-ja.json";
const ZH_ID = "2120476497172283392";
const ZH_URL = "https://sub/ai-zh.json";

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

function setBilingual(on: boolean, lang = "en-US"): void {
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: on, secondarySubtitleLang: lang });
}

function mainSelect(): HTMLSelectElement {
  return document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement;
}

function pickerWrapper(): HTMLElement {
  return mainSelect().closest(".biliscript-reading-track-picker") as HTMLElement;
}

function secondarySelect(): HTMLSelectElement {
  return document.getElementById("biliscript-reading-secondary-subtitle-select") as HTMLSelectElement;
}

function card(): HTMLElement {
  return pickerWrapper().querySelector(".custom-select-dropdown") as HTMLElement;
}

function cardRoot(): HTMLElement | null {
  return card().querySelector(":scope > .biliscript-bilingual-popover");
}

function col(name: "main" | "sub"): HTMLElement | null {
  const node = card().querySelector<HTMLElement>(`.biliscript-bilingual-col[data-col="${name}"]`);
  return node && !node.hidden ? node : null;
}

function colRows(name: "main" | "sub"): HTMLElement[] {
  return [...(col(name)?.querySelectorAll<HTMLElement>(".custom-select-option") ?? [])];
}

function colTexts(name: "main" | "sub"): string[] {
  return colRows(name).map((row) => row.textContent || "");
}

function secondaryOptionTexts(): string[] {
  return [...secondarySelect().options].map((option) => option.textContent || "");
}

function shown(node: HTMLElement | null | undefined): node is HTMLElement {
  return !!node && !node.hidden;
}

function placeholder(): HTMLElement | null {
  const node = col("sub")?.querySelector<HTMLElement>(".biliscript-bilingual-empty") ?? null;
  return shown(node) ? node : null;
}

function placeholderText(): string {
  return placeholder()?.textContent || "";
}

function hintText(): string {
  const node = card().querySelector<HTMLElement>(".biliscript-bilingual-hint") ?? null;
  return shown(node) ? node.textContent || "" : "";
}

function footer(): HTMLElement {
  return card().querySelector(".biliscript-bilingual-footer") as HTMLElement;
}

function footerNoteText(): string {
  const node = footer().querySelector<HTMLElement>(".biliscript-bilingual-footer-note") ?? null;
  return shown(node) ? node.textContent || "" : "";
}

function switchButton(): HTMLButtonElement {
  return card().querySelector(".biliscript-bilingual-switch") as HTMLButtonElement;
}

function retryButton(): HTMLButtonElement | null {
  const node = col("sub")?.querySelector<HTMLButtonElement>(".biliscript-bilingual-retry") ?? null;
  return shown(node) ? node : null;
}

function badge(): HTMLElement | null {
  return pickerWrapper().querySelector(".custom-select-trigger .biliscript-bilingual-badge");
}

function trigger(): HTMLButtonElement {
  return pickerWrapper().querySelector(".custom-select-trigger") as HTMLButtonElement;
}

function triggerValueText(): string {
  return trigger().querySelector(".custom-select-value")?.textContent || "";
}

function clickMainOption(text: string): void {
  const row = colRows("main").find((node) => node.textContent === text);
  expect(row, `主列浮层里应有「${text}」这一项`).toBeTruthy();
  row!.click();
}

function clickSubOption(text: string): void {
  const row = colRows("sub").find((node) => node.textContent === text);
  expect(row, `副列浮层里应有「${text}」这一项`).toBeTruthy();
  row!.click();
}

let storageListenerBase = 0;

function storageListenerCount(): number {
  const spy = chrome.storage.onChanged.addListener as unknown as { mock: { calls: unknown[][] } };
  return spy.mock.calls.length;
}

function fireStorageChange(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area = "sync"): void {
  const spy = chrome.storage.onChanged.addListener as unknown as { mock: { calls: unknown[][] } };
  spy.mock.calls.slice(storageListenerBase).forEach(([listener]) => {
    (listener as (value: unknown, areaName: string) => void)(changes, area);
  });
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  lazy.bodies = { "ai-zh": ZH_BODY, "ai-en": EN_BODY, 中文: ZH_BODY, English: EN_BODY };
  lazy.defaultBody = ZH_BODY;
  lazy.secondaryCalls = [];
  lazy.secondaryMode = "ok";
  lazy.secondaryBody = EN_BODY;
  storageListenerBase = storageListenerCount();

  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  shell = await import("../../extension/reader/index.js");
  await import("../../extension/reader/lifecycle.js");
  readerBus = await import("../../extension/reader/reader-bus.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("双语关：单列 + 页脚开关，主列行为不变", () => {
  it("双语关：卡片只有主列 + 页脚开关，没有副列、没有徽标", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    expect(col("main")).not.toBeNull();
    expect(col("sub")).toBeNull();
    expect(badge()).toBeNull();
    expect(triggerValueText()).toBe("中文");
    expect(footer().textContent?.trim()).toBe("双语字幕");
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(switchButton().dataset.on).toBe("false");
    expect(switchButton().disabled).toBe(false);
    const scrollArea = card().querySelector(".biliscript-bilingual-main") as HTMLElement;
    expect(scrollArea.contains(footer())).toBe(false);
    expect(card().contains(footer())).toBe(true);
  });

  it("双语关：主列仍是组件那批选项行（顺序/文案/身份/URL 逐项不变）", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    expect(colTexts("main")).toEqual(["中文", "English", "日本語", "Español", "Bahasa Indonesia"]);
    expect([...mainSelect().options].map((option) => option.value)).toEqual([
      ZH_URL,
      EN_URL,
      JA_URL,
      "https://sub/ai-es.json",
      "https://sub/ai-id.json"
    ]);
    expect(colRows("main").map((row) => row.dataset.value)).toEqual([...mainSelect().options].map((option) => option.value));
  });

  it("双语关：主列装载行为不回归（点浮层 → 乐观 trigger + 本列禁用 + 列表保留旧轨）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    expect(state.clip.subtitleBody).toEqual(ZH_BODY);

    clickMainOption("English");
    expect(triggerValueText()).toBe("English");
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(colTexts("main")).toContain("中文");

    await vi.waitFor(() => expect(state.clip.subtitleBody).toEqual(EN_BODY));
    expect(state.clip.selectedSubtitleId).toBe(EN_ID);
    expect(trigger().disabled).toBe(false);
  });
});

describe("双语开：两列 + 页脚开关 + 徽标", () => {
  it("开关打开 → 双列出现、副列只列有 subtitleUrl 的真轨（ASR 伪轨被排除）、徽标出现", async () => {
    loadTracks([...SAMPLE_TRACKS, ASR_TRACK], "ai-zh");
    shell.renderReadingView();
    expect(col("sub")).toBeNull();

    switchButton().click();

    expect(state.settings.bilingualSubtitles).toBe(true);
    expect(col("main")).not.toBeNull();
    expect(col("sub")).not.toBeNull();
    expect(secondarySelect().disabled).toBe(true);
    expect(placeholder()).toBeNull();
    expect(colRows("sub").length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false));
    expect(colTexts("sub")).toEqual(["中文", "English", "日本語", "Español", "Bahasa Indonesia"]);
    expect(secondaryOptionTexts()).toEqual(["中文", "English", "日本語", "Español", "Bahasa Indonesia"]);
    expect([...secondarySelect().options].map((option) => option.dataset.id)).toEqual([
      ZH_ID,
      EN_ID,
      JA_ID,
      "2121827577382789888",
      "2121827596601095936"
    ]);
    expect([...secondarySelect().options].map((option) => option.value)).not.toContain("");
    expect(colTexts("main")).toContain("自配平台转写（本机 ASR）");
    expect(colTexts("sub").some((text) => text.includes("转写"))).toBe(false);
    expect(switchButton().getAttribute("aria-checked")).toBe("true");
    expect(switchButton().dataset.on).toBe("true");
    expect(badge()?.textContent).toBe("双语");
    expect(triggerValueText()).toBe("中文");
    expect(colTexts("main")).toContain("中文（B 站 AI）");
  });

  it("打开开关那一刻立即抓目标轨（forceRefresh=false，参数取轨道身份）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    switchButton().click();

    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    expect(lazy.secondaryCalls[0]).toEqual([EN_URL, "English", state.clip.fetchRunId, EN_ID, false]);
    expect(mainSelect().disabled).toBe(false);
  });

  it("副列的选中行 = 目标 lan 的投影（偏好 en-US 命中 ai-en），恰一项选中", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();

    const selected = colRows("sub").filter((row) => row.dataset.selected === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe("English");
    expect(secondarySelect().value).toBe(EN_URL);
    expect([...secondarySelect().options].filter((option) => option.selected)).toHaveLength(1);
  });
});

describe("副列在飞 / 失败：只牵本列，不阻塞主列", () => {
  it("副列在飞：本列禁用、语言列表留在原地，主列可点、在飞期间重复 change 不再发装载", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    switchButton().click();
    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false));
    lazy.secondaryCalls.length = 0;
    lazy.secondaryMode = "pend";
    const rowsBefore = colRows("sub").length;

    clickSubOption("日本語");

    expect(secondarySelect().disabled).toBe(true);
    expect(placeholder()).toBeNull();
    expect(colRows("sub")).toHaveLength(rowsBefore);
    expect(mainSelect().disabled).toBe(false);
    expect(trigger().disabled).toBe(false);

    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    expect(lazy.secondaryCalls[0]).toEqual([JA_URL, "日本語", state.clip.fetchRunId, JA_ID, false]);

    secondarySelect().dispatchEvent(new Event("change", { bubbles: true }));
    expect(lazy.secondaryCalls).toHaveLength(1);
  });

  it("副列失败：开关保持开、副列出「加载失败 · 重试」，重试以 forceRefresh=true 重抓这一条", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    switchButton().click();
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false));
    lazy.secondaryMode = "reject";
    lazy.secondaryCalls.length = 0;

    clickSubOption("日本語");

    await vi.waitFor(() => expect(state.clip.secondarySubtitle.state).toBe("error"));
    expect(state.settings.bilingualSubtitles).toBe(true);
    expect(placeholder()).toBeNull();
    expect(retryButton()?.textContent).toBe("加载失败 · 重试");
    expect(state.clip.subtitleFetchState).not.toBe("error");
    expect(state.clip.subtitleBody).toEqual(ZH_BODY);
    expect(mainSelect().disabled).toBe(false);

    const callsBeforeRetry = lazy.secondaryCalls.length;
    lazy.secondaryMode = "ok";
    retryButton()!.click();
    await vi.waitFor(() => expect(lazy.secondaryCalls.length).toBe(callsBeforeRetry + 1));
    expect(lazy.secondaryCalls.at(-1)).toEqual([JA_URL, "日本語", state.clip.fetchRunId, JA_ID, true]);
  });
});

describe("主副互不牵连（Q8 / Q9）", () => {
  it("切主轨不动副列：主列三项换轨，副列选中与目标偏好不变", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();
    state.clip.applySecondarySubtitle({ id: EN_ID, url: EN_URL, body: EN_BODY as never });
    shell.renderReadingView();

    clickMainOption("日本語");
    await vi.waitFor(() => expect(state.clip.selectedSubtitleId).toBe(JA_ID));

    expect(state.settings.secondarySubtitleLang).toBe("en-US");
    expect(state.clip.secondarySubtitle.id).toBe(EN_ID);
    const selected = colRows("sub").filter((row) => row.dataset.selected === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe("English");
  });

  it("副列选了主轨那一条 ⇒ 副列清空并说明「主副字幕相同」", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();
    state.clip.applySecondarySubtitle({ id: EN_ID, url: EN_URL, body: EN_BODY as never });
    shell.renderReadingView();

    clickSubOption("中文");

    expect(state.clip.secondarySubtitle.state).toBe("idle");
    expect(state.clip.secondarySubtitle.body).toEqual([]);
    expect(state.settings.secondarySubtitleLang).toBe("ai-zh");
    expect(col("sub")).not.toBeNull();
    expect(footerNoteText()).toBe("主副字幕相同");
    expect(placeholder()).toBeNull();
    expect(colTexts("sub")).toContain("English");
  });

  it("主轨切到副列指向的同一条轨（反方向）⇒ 副轨槽清空、副列出同一条空态文案", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "ja-JP");
    shell.renderReadingView();
    state.clip.applySecondarySubtitle({ id: JA_ID, url: JA_URL, body: EN_BODY as never });
    shell.renderReadingView();
    expect(placeholder()).toBeNull();

    clickMainOption("日本語");
    await vi.waitFor(() => expect(state.clip.selectedSubtitleId).toBe(JA_ID));

    expect(state.clip.secondarySubtitle.state).toBe("idle");
    expect(footerNoteText()).toBe("主副字幕相同");
    expect(placeholder()).toBeNull();
    expect(colTexts("sub")).toContain("English");
  });

  it("关开关只停显示、不清副轨槽（反复开关不闪加载中）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    switchButton().click();
    await vi.waitFor(() => expect(state.clip.secondarySubtitle.state).toBe("ready"));

    switchButton().click();

    expect(state.settings.bilingualSubtitles).toBe(false);
    expect(col("sub")).toBeNull();
    expect(state.clip.secondarySubtitle.state).toBe("ready");
    expect(state.clip.secondarySubtitle.body).toEqual(EN_BODY);

    lazy.secondaryCalls.length = 0;
    switchButton().click();
    expect(lazy.secondaryCalls).toHaveLength(0);
    expect(state.clip.secondarySubtitle.state).toBe("ready");
  });
});

describe("副列的三套空态 + 单轨禁用", () => {
  it("① 还没选过副轨 → 「选择副字幕语言」+ 列表在场（不发装载）", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "");
    shell.renderReadingView();

    expect(placeholderText()).toBe("选择副字幕语言");
    expect(colTexts("sub")).toContain("English");
    expect(lazy.secondaryCalls).toHaveLength(0);
  });

  it("② 本视频没有目标语言的轨 → 「本视频没有日语轨」（语言名查表，不出机器码）+ 列表在场，留空不猜、不发装载", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "ja-JP");
    state.clip.setSubtitles(SAMPLE_TRACKS.filter((track) => track.lan !== "ai-ja") as never);
    shell.renderReadingView();

    expect(placeholderText()).toBe("本视频没有日语轨");
    expect(colTexts("sub")).toEqual(["中文", "English", "Español", "Bahasa Indonesia"]);
    expect(lazy.secondaryCalls).toHaveLength(0);
    expect(state.clip.secondarySubtitle.state).toBe("idle");
    expect(colTexts("main")).toContain("中文");
  });

  it("③ 主副指向同一条轨 → 提示进页脚（紧挨「双语字幕」）+ 语言列表仍在场（改选得回来）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "ai-zh");
    shell.renderReadingView();

    expect(footerNoteText()).toBe("主副字幕相同");
    expect(footer().textContent?.trim()).toBe("双语字幕主副字幕相同");
    expect(placeholder()).toBeNull();
    expect(lazy.secondaryCalls).toHaveLength(0);
    expect(colTexts("sub")).toEqual(["中文", "English", "日本語", "Español", "Bahasa Indonesia"]);

    clickSubOption("日本語");
    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    expect(lazy.secondaryCalls[0]).toEqual([JA_URL, "日本語", state.clip.fetchRunId, JA_ID, false]);
  });

  it("单轨真轨解锁双语：开关可用，进入译文副列且自动过滤同语种族选项（中文源轨默认切为 English）", () => {
    loadTracks([SAMPLE_TRACKS[0]], "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();

    expect(switchButton().disabled).toBe(false);
    expect(hintText()).toBe("");
    expect(footer().textContent?.trim()).toBe("双语字幕");
    expect(col("sub")).not.toBeNull();
    expect(colTexts("sub")).not.toContain("中文");
    expect(secondarySelect().value).toBe("en");
    expect(lazy.secondaryCalls).toHaveLength(0);
  });

  it("零轨（抓取中/空态）：开关禁用，主列哨兵说明一切，不叠单轨说明", () => {
    loadTracks([], "");
    setBilingual(true, "en-US");
    shell.renderReadingView();

    expect(switchButton().disabled).toBe(true);
    expect(hintText()).toBe("");
    expect(colTexts("main")).toEqual(["暂无字幕"]);
  });
});

describe("偏好落盘与跨上下文收敛", () => {
  it("开关与副列改选都走 persist seam（全局偏好：跨设备/跨视频记忆）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    const persist = vi.spyOn(readerBus, "persistReaderSettingsThroughSeam");

    switchButton().click();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(state.settings.bilingualSubtitles).toBe(true);
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false));

    clickSubOption("日本語");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(state.settings.secondarySubtitleLang).toBe("ai-ja");
  });

  it("别的标签页打开双语：本页控件跟着收敛（开关翻 on、两列出现、目标轨被抓）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(col("sub")).toBeNull();

    fireStorageChange({ bilingualSubtitles: { oldValue: false, newValue: true } });

    expect(state.settings.bilingualSubtitles).toBe(true);
    expect(switchButton().getAttribute("aria-checked")).toBe("true");
    expect(col("sub")).not.toBeNull();
    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    expect(lazy.secondaryCalls[0]).toEqual([EN_URL, "English", state.clip.fetchRunId, EN_ID, false]);
  });

  it("别的设备换了副轨语言：本页副列选中行跟着换", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();
    expect(colRows("sub").find((row) => row.dataset.selected === "true")?.textContent).toBe("English");

    fireStorageChange({ secondarySubtitleLang: { oldValue: "en-US", newValue: "ja-JP" } });

    expect(state.settings.secondarySubtitleLang).toBe("ja-JP");
    await vi.waitFor(() =>
      expect(colRows("sub").find((row) => row.dataset.selected === "true")?.textContent).toBe("日本語")
    );
    expect(lazy.secondaryCalls.at(-1)).toEqual([JA_URL, "日本語", state.clip.fetchRunId, JA_ID, false]);
  });
});

describe("骨架与壳重建（forceRecreate）", () => {
  it("面板重建后骨架按引用重认领：旧节点作废、新开关真的接上处理器", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();
    const oldToggle = switchButton();
    const oldSelect = secondarySelect();
    expect(secondarySelect().id).toBe("biliscript-reading-secondary-subtitle-select");

    uiRenderer.ensureUiReady({ forceRecreate: true });
    mountPlayerChain();
    shell.renderReadingView();

    expect(switchButton()).not.toBe(oldToggle);
    expect(secondarySelect()).not.toBe(oldSelect);
    expect(oldToggle.isConnected).toBe(false);
    expect(oldSelect.isConnected).toBe(false);
    switchButton().click();
    expect(state.settings.bilingualSubtitles).toBe(false);
    expect(col("sub")).toBeNull();
  });
});

describe("真机反向发现的修复锁", () => {

  it("关闭开关：请列表属主重渲（副行不能挂在列表上）", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    state.clip.applySecondarySubtitle({ id: EN_ID, url: EN_URL, body: EN_BODY as never });
    shell.renderReadingView();
    expect(document.querySelectorAll(".biliscript-reading-subtext").length).toBeGreaterThan(0);

    const kinds: string[] = [];
    readerBus.subscribeReaderPresenter((event) => kinds.push(event.kind));
    switchButton().click();

    expect(state.settings.bilingualSubtitles).toBe(false);
    expect(kinds).toContain("rerender");
  });

  it("同轨防呆清副轨槽：同样请列表属主重渲（否则列表还挂着已清空的译文）", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    state.clip.applySecondarySubtitle({ id: EN_ID, url: EN_URL, body: EN_BODY as never });
    shell.renderReadingView();

    const kinds: string[] = [];
    readerBus.subscribeReaderPresenter((event) => kinds.push(event.kind));
    clickSubOption("中文");

    expect(state.clip.secondarySubtitle.state).toBe("idle");
    expect(kinds).toContain("rerender");
  });
});

