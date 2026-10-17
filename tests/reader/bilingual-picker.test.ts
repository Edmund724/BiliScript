// 双语选轨弹层（票 bilingual-subtitles/06；形态 01 号票、状态机 02 号票、槽与偏好 05 号票）。
//
// 覆盖同一个叶子（reader/subtitle-tab-ui.ts）里新长出来的两件事：页脚「双语字幕」开关
// 与主/副两列弹层；列表副行（.biliscript-reading-subtext）的样式与注册面在最后一节
// 按源码/表面锁（它的 DOM 由另一处渲染器产出，本文件不造那份 DOM）。
//
// 口径来源（本文件不重述理由，只落断言）：
//   - 形态：01 号票裁定「几何 A 双列 max-content / trigger 主轨名 + 双语徽标 @120px /
//     页脚在列表底部（不进设置抽屉）」+ prototypes/README.md §4/§5/§7/§8 的实测；
//   - 状态机：02 号票 —— 开关打开即抓（forceRefresh=false）、每列各持一枚在飞值且
//     只禁自己那列、失败不回退目标且重试入口唯一在副列、副列只列有 subtitleUrl 的
//     真轨（排除 ASR 伪轨）、三套空态文案、关开关不清副轨槽、Q8 同轨自动清空；
//   - 槽与偏好：05 号票 —— settings.bilingualSubtitles/secondarySubtitleLang 是全局
//     偏好（进键面 ⇒ 跨设备同步），clip.secondarySubtitle 是 per-video 槽，DOM 只投影。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   1. 形态层：双语关时卡片结构或主列行为被改动（多出副列/徽标、主列选项行被重排或
//      丢失）／双语开时没有两列／页脚开关不在列表底部或说明文字挤进页脚／徽标写进
//      .custom-select-value（被组件的值投影在下一次写值时抹掉）／trigger 被徽标撑宽；
//   2. 几何层（硬约束 §5.1–§5.4）：卡片没右锚（左锚 @380 越界）／滚动留在卡片上
//      （第 9 条轨就把页脚开关滚出视野）／空态文案能把列顶宽（长文案把卡片顶出面板）／
//      单轨禁用态页脚折行；
//   3. 装载层：选副列语言没调 loadSecondarySubtitle 或参数取错（url/槽语言/runId/id，
//      槽语言 = 轨的 lanDoc，与 reader 侧自动装载同一口径）／forceRefresh 不是 false
//      （切轨语义变成每次走网络）／重试不是 true／在飞期间重复 change 又发一次装载／
//      副列在飞把主列一起禁掉（或反之）；
//   4. 失败层：副列失败把双语开关弹回关闭／把主列的 subtitleFetchState 洗成失败面／
//      重试入口不在副列；
//   5. 投影层：三套空态文案混用或缺席（未选 / 本视频无该语言 / 主副同轨被清）／副列
//      列了 ASR 伪轨／副列的选中行不按目标 lan 投影／主列切轨把副列选择带跑／关开关
//      清了副轨槽；
//   6. 偏好层：开关或目标语言不落盘（persist seam 没调）／别的标签页改了这两个键，
//      本页控件不收敛（控件与 state 两说）。
//
// 端到端形态：真实模板（buildUiHtml/ensureUiReady，含真实壳与真实事件绑定）+ 真实
// ui/custom-select 建壳（两列各一枚），jsdom 只走 DOM 事件。mock 只有两条运行时边界
// ——总结链（loadSubtitle / loadSecondarySubtitle 的网络入口）与 reader-gate（装载
// reader 域的转发助手）。字幕接受事务（subtitle/commit）保持真实：主轨换轨链路是被测
// 的一部分，不 mock。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";

// ===== mock（hoisted）：总结链装载器（主轨 + 副轨）+ reader-gate 转发助手 =====

const lazy = vi.hoisted(() => ({
  bodies: {} as Record<string, unknown[]>,
  defaultBody: null as unknown[] | null,
  // 副轨装载器的调用流水（元组顺序 = 形参顺序：url, lang, runId, subtitleId, forceRefresh）
  secondaryCalls: [] as unknown[][],
  // ok    = 接受事务落 body；
  // pend  = 停在飞（断言「本列禁用、主列不受牵连」）；
  // reject= 写 error 态后抛（真实装载器的失败语义：槽写 error，异常上浮）
  secondaryMode: "ok" as "ok" | "pend" | "reject",
  secondaryBody: [] as unknown[]
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

// ===== 被测模块（mock 之后导入） =====

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let shell: typeof import("../../extension/reader/index.js");
let readerBus: typeof import("../../extension/reader/reader-bus.js");

// 样本：8 条 ai-* 真轨（research/01-track-shape.md 的接口原顺序）+ 一条 ASR 伪轨
//（lan: asr-*、subtitleUrl: ""：02 号票第 4 条要它在副列之外）。
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

// ===== DOM 取用口（真实壳；两列各一枚原生 select，组件浮层即卡片） =====

function mainSelect(): HTMLSelectElement {
  return document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement;
}

function pickerWrapper(): HTMLElement {
  return mainSelect().closest(".biliscript-reading-track-picker") as HTMLElement;
}

function secondarySelect(): HTMLSelectElement {
  return document.getElementById("biliscript-reading-secondary-subtitle-select") as HTMLSelectElement;
}

// 卡片 = 组件浮层本体（双语卡片根 li.biliscript-bilingual-popover 就装在里面）。
function card(): HTMLElement {
  return pickerWrapper().querySelector(".custom-select-dropdown") as HTMLElement;
}

function cardRoot(): HTMLElement | null {
  return card().querySelector(":scope > .biliscript-bilingual-popover");
}

function col(name: "main" | "sub"): HTMLElement | null {
  const node = card().querySelector<HTMLElement>(`.biliscript-bilingual-col[data-col="${name}"]`);
  // 骨架常驻（节点身份不变量）：列「不出场」= hidden，取用口按不出场返回 null，
  // 让用例读起来仍是「副列在不在」。
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

// 页脚状态提示（③ 主副同轨）：空串 = 不显示（2026-10-06 用户裁决把它从副列列表挪到页脚）。
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

// 真实点击路径：点浮层里的选项行 → 组件 chooseOption（写值 + 派发 change）。
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

// 跨上下文存储事件：只喂**本轮用例注册**的监听器（resetModules 后旧实例的监听器
// 还挂在同一个 stub 上，一起喂会把旧 state 的重渲混进当前 DOM）。
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
  lazy.bodies = { "ai-zh": ZH_BODY, "ai-en": EN_BODY };
  lazy.defaultBody = ZH_BODY;
  lazy.secondaryCalls = [];
  lazy.secondaryMode = "ok";
  lazy.secondaryBody = EN_BODY;

  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  shell = await import("../../extension/reader/index.js");
  // reader-bus 的 presenter 订阅注册在 lifecycle 模块求值期——只有该模块被装载，
  // 通知链才会驱动 renderReadingView（本文件同样把 withReader mock 掉，故显式装载）。
  await import("../../extension/reader/lifecycle.js");
  readerBus = await import("../../extension/reader/reader-bus.js");
  storageListenerBase = storageListenerCount();
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
    // 页脚开关在场（不然用户永远打不开双语），默认关
    expect(footer().textContent?.trim()).toBe("双语字幕");
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(switchButton().dataset.on).toBe("false");
    expect(switchButton().disabled).toBe(false);
    // 页脚在滚动区之外（硬约束 §5.2：第 9 条轨也不能把它滚走）
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
    // 浮层项与原生选项同值同序（组件不变式：一列一枚 select、显示 = 现值）
    expect(colRows("main").map((row) => row.dataset.value)).toEqual([...mainSelect().options].map((option) => option.value));
  });

  it("双语关：主列装载行为不回归（点浮层 → 乐观 trigger + 本列禁用 + 列表保留旧轨）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    expect(state.clip.subtitleBody).toEqual(ZH_BODY);

    clickMainOption("English");
    expect(triggerValueText()).toBe("English"); // 乐观显示目标轨
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(colTexts("main")).toContain("中文"); // 列表保留旧轨

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
    // 打开那一刻目标轨（English）就在抓：语言列表**留在原地**、本列当场禁用
    //（2026-10-06 用户裁决：在飞不换列表，否则用户刚滚到底的列表会跳回顶部）。
    expect(secondarySelect().disabled).toBe(true);
    expect(placeholder()).toBeNull();
    expect(colRows("sub").length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false)); // 首次自动抓取落定
    // 副列选项 = 真轨（5 条），伪轨不在其中；主列仍含伪轨（主列行为不动）
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
    // 页脚开关仍是列表底部那一行，且翻到 on
    expect(switchButton().getAttribute("aria-checked")).toBe("true");
    expect(switchButton().dataset.on).toBe("true");
    // 徽标：主轨名 + 「双语」；值区仍是裸语言名（徽标不在 .custom-select-value 里）。
    // 主列这条轨道列表混了 ASR 伪轨 ⇒ 主列自己的 [AI] 标照旧（上一张图的口径，未动）。
    expect(badge()?.textContent).toBe("双语");
    expect(triggerValueText()).toBe("中文 [AI]");
  });

  it("打开开关那一刻立即抓目标轨（forceRefresh=false，参数取轨道身份）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();

    switchButton().click();

    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    // 槽语言（元组第 2 位）统一取轨的 lanDoc——与 reader 侧自动装载同口径
    expect(lazy.secondaryCalls[0]).toEqual([EN_URL, "English", state.clip.fetchRunId, EN_ID, false]);
    expect(mainSelect().disabled).toBe(false); // 副轨装载不阻塞主列
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
    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1)); // 打开开关的自动抓取
    // 落定屏障 = 本列恢复可点（列表在飞期间就在场，行数不再是落定的证据）
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false));
    lazy.secondaryCalls.length = 0;
    lazy.secondaryMode = "pend";
    const rowsBefore = colRows("sub").length;

    clickSubOption("日本語");

    // 乐观收尾是同步的：本列当场禁用（装载器调用在下一拍）。语言列表**留在原地**：
    // 2026-10-06 用户裁决「选完应该滚动条不动」——在飞把列表换成一行「译文加载中…」
    // 会当场抽掉本列的滚动高度，用户刚滚到底选中的那条语言，下一秒整列跳回列表顶部
    //（真机读数见 walkthrough run13）。在飞的可见反馈由两处承担：本列 disabled /
    // aria-busy（点不动），以及列表里副行的「译文加载中…」占位。
    expect(secondarySelect().disabled).toBe(true);
    expect(placeholder()).toBeNull();
    expect(colRows("sub")).toHaveLength(rowsBefore);
    // 主列不受牵连（02 号票 Q9）：可点、不 busy
    expect(mainSelect().disabled).toBe(false);
    expect(trigger().disabled).toBe(false);

    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    expect(lazy.secondaryCalls[0]).toEqual([JA_URL, "日本語", state.clip.fetchRunId, JA_ID, false]);

    // 在飞期间再来一次 change（组件浮层的点击不查 disabled，禁用只是视觉/键盘守卫）
    secondarySelect().dispatchEvent(new Event("change", { bubbles: true }));
    expect(lazy.secondaryCalls).toHaveLength(1);
  });

  it("副列失败：开关保持开、副列出「加载失败 · 重试」，重试以 forceRefresh=true 重抓这一条", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    switchButton().click();
    // 首次自动抓取落定的屏障是「本列恢复可点」——语言列表在飞期间就在场（裁决后
    // 不再换成占位），故「行数 > 0」不再是「装载已落定」的证据。
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false));
    lazy.secondaryMode = "reject";
    lazy.secondaryCalls.length = 0;

    clickSubOption("日本語");

    await vi.waitFor(() => expect(state.clip.secondarySubtitle.state).toBe("error"));
    expect(state.settings.bilingualSubtitles).toBe(true); // 绝不弹回关闭（Q9）
    expect(placeholder()).toBeNull();
    expect(retryButton()?.textContent).toBe("加载失败 · 重试");
    // 失败**不写**主列相位（整片单相位不能被副轨污染，02 号票第 6 条）
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
    // 副轨已就绪（槽非 idle ⇒ 主轨到站不会触发自动装载，本用例只看「切主轨不动副列」）
    state.clip.applySecondarySubtitle({ id: EN_ID, url: EN_URL, body: EN_BODY as never });
    shell.renderReadingView();

    clickMainOption("日本語");
    await vi.waitFor(() => expect(state.clip.selectedSubtitleId).toBe(JA_ID));

    expect(state.settings.secondarySubtitleLang).toBe("en-US");
    expect(state.clip.secondarySubtitle.id).toBe(EN_ID); // 副轨槽未被清
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
    // 目标 lan 记成用户刚点的那条轨（= 主轨的 lan）：第三套空态文案由此投影出来
    expect(state.settings.secondarySubtitleLang).toBe("ai-zh");
    expect(col("sub")).not.toBeNull(); // 开关保持开，副列仍在场（只是空）
    // 提示进页脚、紧挨「双语字幕」；副列列表顶上不再占一行（2026-10-06 用户裁决）
    expect(footerNoteText()).toBe("主副字幕相同");
    expect(placeholder()).toBeNull();
    // 语言列表照旧在场：点错一条不该把整列锁死（列表没了就再也改不回来）
    expect(colTexts("sub")).toContain("English");
  });

  it("主轨切到副列指向的同一条轨（反方向）⇒ 副轨槽清空、副列出同一条空态文案", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "ja-JP"); // 目标 = 日本語
    shell.renderReadingView();
    state.clip.applySecondarySubtitle({ id: JA_ID, url: JA_URL, body: EN_BODY as never });
    shell.renderReadingView();
    expect(placeholder()).toBeNull(); // 目标轨在场 ⇒ 列里出语言列表，不出占位行

    clickMainOption("日本語");
    await vi.waitFor(() => expect(state.clip.selectedSubtitleId).toBe(JA_ID));

    expect(state.clip.secondarySubtitle.state).toBe("idle");
    expect(footerNoteText()).toBe("主副字幕相同");
    expect(placeholder()).toBeNull(); // 副列列表顶上不多占一行，语言列表仍可点
    expect(colTexts("sub")).toContain("English");
  });

  it("关开关只停显示、不清副轨槽（反复开关不闪加载中）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    shell.renderReadingView();
    switchButton().click();
    // 自动装载落定的唯一屏障是「槽 ready」——列表自本图起从第一帧就在场，
    // 用行数当屏障会立刻通过（空转的假绿，2026-10-06 踩过同一个坑）。
    await vi.waitFor(() => expect(state.clip.secondarySubtitle.state).toBe("ready"));

    switchButton().click(); // 关

    expect(state.settings.bilingualSubtitles).toBe(false);
    expect(col("sub")).toBeNull();
    expect(state.clip.secondarySubtitle.state).toBe("ready"); // 槽没被清（02 号票第 7(d) 条）
    expect(state.clip.secondarySubtitle.body).toEqual(EN_BODY);

    lazy.secondaryCalls.length = 0;
    switchButton().click(); // 再开：槽仍是 ready ⇒ 不重抓
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
    // 偏好在本视频落不到轨，但列表照出：用户就地改选（而不是被一行说明锁死）
    expect(colTexts("sub")).toEqual(["中文", "English", "Español", "Bahasa Indonesia"]);
    expect(lazy.secondaryCalls).toHaveLength(0);
    expect(state.clip.secondarySubtitle.state).toBe("idle");
    // 三套文案只影响副列：主列照常
    expect(colTexts("main")).toContain("中文");
  });

  it("③ 主副指向同一条轨 → 提示进页脚（紧挨「双语字幕」）+ 语言列表仍在场（改选得回来）", async () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "ai-zh"); // 目标语言 = 主轨自己的语言
    shell.renderReadingView();

    expect(footerNoteText()).toBe("主副字幕相同");
    expect(footer().textContent?.trim()).toBe("双语字幕主副字幕相同");
    expect(placeholder()).toBeNull(); // 不在副列列表里（2026-10-06 用户裁决）
    expect(lazy.secondaryCalls).toHaveLength(0);
    // 列表仍在场：用户的下一步动作就是「换一条语言」，列表必须在场
    //（2026-10-06 图外回访：原样只剩一行说明 ⇒ 副语言再也改不回来）。
    expect(colTexts("sub")).toEqual(["中文", "English", "日本語", "Español", "Bahasa Indonesia"]);

    // 改选得回来：从同轨说明态点另一条语言 ⇒ 正常发起装载
    clickSubOption("日本語");
    await vi.waitFor(() => expect(lazy.secondaryCalls).toHaveLength(1));
    expect(lazy.secondaryCalls[0]).toEqual([JA_URL, "日本語", state.clip.fetchRunId, JA_ID, false]);
  });

  it("单轨禁用：开关禁用 + 说明进列表区、页脚只留「双语字幕 + 开关」，不出双列", () => {
    loadTracks([ASR_TRACK], "asr");
    setBilingual(true, "en-US");
    shell.renderReadingView();

    expect(switchButton().disabled).toBe(true);
    expect(hintText()).toBe("本视频只有一条字幕轨");
    expect(footer().textContent?.trim()).toBe("双语字幕"); // 说明没挤进页脚（硬约束 §5.4）
    expect(col("sub")).toBeNull();
    // 双语偏好没被改写：还是开着的（本视频不可配对而已）
    expect(state.settings.bilingualSubtitles).toBe(true);
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
    await vi.waitFor(() => expect(secondarySelect().disabled).toBe(false)); // 首次自动抓取落定

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
    // 目标变了 ⇒ 立即抓新目标（Q1），落定后副列选中行跟着换
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

    // 壳整块重建（阅读面板 forceRecreate）：pickerWrapper 与浮层都是新节点
    uiRenderer.ensureUiReady({ forceRecreate: true });
    mountPlayerChain();
    shell.renderReadingView();

    expect(switchButton()).not.toBe(oldToggle);
    expect(secondarySelect()).not.toBe(oldSelect);
    expect(oldToggle.isConnected).toBe(false);
    expect(oldSelect.isConnected).toBe(false);
    // 新骨架的开关不是只剩外观：点一下真的改偏好
    switchButton().click();
    expect(state.settings.bilingualSubtitles).toBe(false);
    expect(col("sub")).toBeNull();
  });
});

describe("形态与三处登记（源码/表面锁）", () => {
  const CSS = "extension/entry/styles/bilingual-subtitles.css";
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("卡片右锚 + flex 列 + 滚动区下移 + 页脚在滚动区外（硬约束 §5.1/§5.2）", () => {
    const css = read(CSS);
    const cardRule =
      css.match(/\.custom-select-dropdown:has\(> \.biliscript-bilingual-popover\)\s*\{[^}]*\}/)?.[0] || "";
    expect(cardRule).toContain("right: 0");
    expect(cardRule).toContain("left: auto");
    expect(cardRule).toContain("display: flex");
    expect(cardRule).toContain("flex-direction: column");
    expect(cardRule).toContain("overflow: hidden");
    expect(cardRule).toContain("max-height: 320px");
    // 收起态正确性规则必须在场（组件表那条与 display: flex 同分）
    expect(css).toContain(".custom-select-dropdown:has(> .biliscript-bilingual-popover)[hidden]");
    // 卡片根不产生盒子：滚动区与页脚才是浮层的 flex 项
    expect(css).toMatch(/\.biliscript-bilingual-popover\s*\{[^}]*display:\s*contents/);
    // 滚动不落在卡片上，也不落在跨两列的主区上（主区只裁剪，滚动归属每一列）
    const mainRule = css.match(/\.biliscript-bilingual-main\s*\{[^}]*\}/)?.[0] || "";
    expect(mainRule).toContain("overflow: hidden");
    expect(mainRule).not.toContain("overflow-y: auto");
    expect(mainRule).toContain("min-height: 0");
    // 页脚不可收缩（固定在列表之外）
    const footerRule = css.match(/\.biliscript-bilingual-footer\s*\{[^}]*\}/)?.[0] || "";
    expect(footerRule).toContain("flex: 0 0 auto");
  });

  it("空态不参与列宽（硬约束 §5.3）+ 色值一律走 --biliscript-reader-* 令牌", () => {
    const css = read(CSS);
    expect(css).toContain("max-width: calc(var(--biliscript-script-width, 380px) - 78px)");
    expect(css).toMatch(/\.biliscript-bilingual-empty\s*\{[^}]*max-width:\s*140px/);
    expect(css).toContain("text-overflow: ellipsis");
    // 新增样式不写字面色（原型里的 rgba 阴影换成令牌）
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    // 副行与徽标都用面板色板令牌
    expect(css).toMatch(/\.biliscript-reading-subtext\s*\{[^}]*--biliscript-reader-faint/);
    expect(css).toMatch(/\.biliscript-reading-subtext\[data-state="fail"\]\s*\{[^}]*--biliscript-reader-accent/);
  });

  it("副列组件壳收起：宿主与壳都无盒、自带 trigger 隐藏、壳内浮层退回普通列表", () => {
    const css = read(CSS);
    // 宿主/壳 display: contents（副列选项行直接是列的流内容）
    expect(css).toMatch(/\.biliscript-bilingual-secondary\s*\{[^}]*display:\s*contents/);
    expect(css).toMatch(/\.biliscript-bilingual-secondary-picker\s*\{[^}]*display:\s*contents/);
    // 宿主收起态：声明了 display 就必须重述 [hidden]
    expect(css).toContain(".biliscript-bilingual-secondary[hidden]");
    // 壳自带 trigger 不可见（一行里只有工具条那枚 affordance）
    expect(css).toContain(".biliscript-bilingual-secondary-picker > .custom-select-trigger");
    // 壳内浮层取消定位/边框/滚动
    const subDropdownRule =
      css.match(/\.biliscript-bilingual-col\[data-col="sub"\] \.custom-select-dropdown\s*\{[^}]*\}/)?.[0] || "";
    expect(subDropdownRule).toContain("position: static");
    expect(subDropdownRule).toContain("overflow: visible");
    expect(subDropdownRule).toContain("box-shadow: none");
    expect(css).toMatch(/\[data-col="sub"\] \.custom-select-dropdown\[hidden\]\s*\{[^}]*display:\s*block/);
  });

  it("卡片骨架是节点身份不变量：连续重渲后槽位内容仍在场、开关与副列 select 还是同一批节点", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();
    const toggle = switchButton();
    const select = secondarySelect();
    const hostWrappers = () => pickerWrapper().querySelectorAll(".biliscript-bilingual-secondary").length;
    const dropdowns = () => pickerWrapper().querySelectorAll(".custom-select-dropdown").length;
    expect(hostWrappers()).toBe(1);
    expect(dropdowns()).toBe(2);

    // 换轨（组件整批换自己那批选项行）+ 关/开双语：骨架与副列壳都不重建（否则监听器丢、
    // 副列 select 会一份份堆积出来）
    clickMainOption("日本語");
    switchButton().click();
    switchButton().click();
    shell.renderReadingView();

    // 骨架的落位归组件的槽位声明（setCustomSelectSlots）：不再断言「被搬回原位」，
    // 只断言槽位内容仍在场——换项摘不到调用方的节点。
    expect(cardRoot()).not.toBeNull();
    expect(card().contains(footer())).toBe(true);
    expect(switchButton()).toBe(toggle);
    expect(secondarySelect()).toBe(select);
    expect(hostWrappers()).toBe(1);
    expect(dropdowns()).toBe(2);
    expect(colRows("main").length).toBe(5);
  });

  it("列表副行：块级子节点、13px/19px、muted 色；loading/fail 斜体、fail 不可点", () => {
    const css = read(CSS);
    const subRule =
      css.match(/#biliscript-reading-view \.biliscript-reading-text \.biliscript-reading-subtext\s*\{[^}]*\}/)?.[0] || "";
    expect(subRule).toContain("display: block");
    expect(subRule).toContain("font-size: 13px");
    expect(subRule).toContain("line-height: 19px");
    expect(subRule).toContain("margin-top: 1px");
    expect(subRule).toContain("color: var(--biliscript-reader-faint)");
    expect(css).toContain('[data-state="loading"]');
    expect(css).toContain("font-style: italic");
    // 失败行不可点：光标保持默认，且全表没有给副行挂 click 的痕迹
    expect(css).toMatch(/\[data-state="fail"\][^}]*cursor:\s*default/);
    expect(css).not.toContain("cursor: pointer;\n}\n\n#biliscript-reading-view .biliscript-reading-text");
  });

  it("trigger 徽标不在值区里（组件值投影会抹掉它），且 trigger 定宽仍是 120px", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    shell.renderReadingView();

    const badgeNode = badge();
    expect(badgeNode).not.toBeNull();
    expect(trigger().querySelector(".custom-select-value")?.contains(badgeNode!)).toBe(false);
    expect(trigger().contains(badgeNode!)).toBe(true);
    // 定宽 120px 的可锁判据在 reader.css（本票不动它）
    const readerCss = read("extension/entry/styles/reader.css");
    const pickerRule =
      readerCss.match(/\.biliscript-reading-track-picker\s*\{[^}]*\}/g)?.join("\n") || "";
    expect(pickerRule).toContain("width: 120px");
  });

  it("登记面：injector 的 ensure + 表住在 build 入口目录里 + manifest 的 WAR 通配", () => {
    const injector = read("extension/shared/style-injector.ts");
    expect(injector).toMatch(/export function ensureBilingualSubtitleStyles/);
    expect(injector).toContain("entry/styles/bilingual-subtitles.css");

    // dist 侧（build.js 的 cssEntries 按 entry/styles/ 目录派生，见
    // tests/entry/reader-settings-css-split.test.ts 的目录派生守卫）：表住在这个
    // 目录里 ⇒ 必被 minify 进 dist；manifest 的 entry/styles/* 通配只放行不改产物。
    expect(existsSync(join(process.cwd(), CSS)), `${CSS} 不在 build 入口目录里`).toBe(true);

    const manifest = JSON.parse(read("extension/manifest.json")) as {
      web_accessible_resources: { resources: string[] }[];
    };
    expect(manifest.web_accessible_resources[0].resources).toContain("entry/styles/*");
  });

  it("叶子在模块顶层挂表（组件表同款先例），且静态 import 组件 ⇒ 组件表随叶子一同在场", () => {
    const source = read("extension/reader/subtitle-tab-ui.ts");
    expect(source).toMatch(/ensureBilingualSubtitleStyles\(\);/);
    // 静态 import（不是动态装载）：组件模块体求值即挂组件表，与该叶子同一次装载在场
    expect(source).toMatch(/^import \{[^}]*initCustomSelect[^}]*\} from "\.\.\/ui\/custom-select\.js";$/m);
  });

  it("级联不靠挂载序：卡片度量靠特异度压过组件表，收起态靠本表重述的 [hidden]", () => {
    const componentCss = read("extension/entry/styles/custom-select.css");
    const bilingualCss = read(CSS);

    const probe = (order: "component-first" | "bilingual-first") => {
      // 用环境自带的 document 临时注入两张真表（jsdom 不加载 link 资源，故真实
      // 挂载路径下的 link 不带进规则）；测完把 style 与探针节点都摘掉。
      const view = document.createElement("div");
      view.id = "biliscript-reading-view";
      const dropdown = document.createElement("ul");
      dropdown.className = "custom-select-dropdown";
      const popover = document.createElement("li");
      popover.className = "biliscript-bilingual-popover";
      dropdown.appendChild(popover);
      view.appendChild(dropdown);
      document.body.appendChild(view);
      const sheets = (order === "component-first" ? [componentCss, bilingualCss] : [bilingualCss, componentCss]).map((css) => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
        return style;
      });
      const metrics = () => {
        const cs = window.getComputedStyle(dropdown);
        // 只取 jsdom 可靠解析的字段：overflow 简写在 jsdom 里不回填长手
        //（本表 overflow: hidden 压不过组件表的 overflow-y: auto 长手），
        // 真机判据是 overflow-y: hidden，测试里改用 left/max-width/display 判归属。
        return { display: cs.display, left: cs.left, maxWidth: cs.maxWidth };
      };
      const expanded = metrics();
      dropdown.setAttribute("hidden", "");
      const collapsed = metrics();
      for (const style of sheets) {
        style.remove();
      }
      view.remove();
      return { expanded, collapsed };
    };

    const componentFirst = probe("component-first");
    const bilingualFirst = probe("bilingual-first");

    // 卡片度量归本表：组件表默认 left: 0 / max-width: 260px，本表是右锚 + calc 宽度
    expect(componentFirst.expanded.display).toBe("flex");
    expect(componentFirst.expanded.left).toBe("auto");
    expect(componentFirst.expanded.maxWidth).not.toBe("260px");
    // 收起态：本表重述的 [hidden] 在场，两种挂载序都收得干净（组件表先挂就会列表常开）
    expect(componentFirst.collapsed.display).toBe("none");
    expect(bilingualFirst.collapsed.display).toBe("none");
    // 顺序无关：两遍逐字段一致——谁先挂都不改变结论
    expect(bilingualFirst).toEqual(componentFirst);
  });
});

// ===== 真机走查（headless Edge + CDP，真实 B 站页面）反向发现的两条缺陷及其锁 =====
//
// jsdom 看不见这两条：① 靠的是**页面**样式表（jsdom 里没有 B 站的 `video.*.css`），
// ② 靠的是「列表属主是谁」（jsdom 里列表是由测试手动 renderReadingView 出来的，
// 不重渲也看不出差别——真机上副行就一直挂在列表上）。
describe("真机反向发现的修复锁", () => {
  it("副列浮层的展开覆盖必须带 !important（压 B 站页面的全局 [hidden] 重置）", () => {
    const css = readFileSync(join(process.cwd(), "extension/entry/styles/bilingual-subtitles.css"), "utf8");
    const rule =
      css.match(/\.biliscript-bilingual-col\[data-col="sub"\] \.custom-select-dropdown\[hidden\]\s*\{[^}]*\}/)?.[0] || "";
    // B 站样式表里有 `[hidden] { display: none !important }`：不带 !important 时
    // 本选择器特异性再高也压不过它 ⇒ 副列 8 行 rect 全 0、列宽塌成表头宽（真机实测）。
    expect(rule, "副列浮层展开覆盖丢了 !important").toContain("display: block !important");
  });

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
    // 关双语改的是 settings，而副行在列表里 ⇒ 必须请列表属主重渲（叶子不自绘列表）
    expect(kinds).toContain("rerender");
  });

  it("同轨防呆清副轨槽：同样请列表属主重渲（否则列表还挂着已清空的译文）", () => {
    loadTracks(SAMPLE_TRACKS, "ai-zh");
    setBilingual(true, "en-US");
    state.clip.applySecondarySubtitle({ id: EN_ID, url: EN_URL, body: EN_BODY as never });
    shell.renderReadingView();

    const kinds: string[] = [];
    readerBus.subscribeReaderPresenter((event) => kinds.push(event.kind));
    clickSubOption("中文"); // 副列选到主轨那一条

    expect(state.clip.secondarySubtitle.state).toBe("idle");
    expect(kinds).toContain("rerender");
  });
});

// ===== 弹层滚动（2026-10-06 用户真机裁决：两列各自滚；选完滚动条不动）========
//
// 用户报的两条缺陷都是 jsdom 够不着的（真实布局 / 真实浏览器行为），权威读数在
// `.scratch/tickets/bilingual-subtitles/walkthrough` 的 run13：
//   1. 两列共用一条滚动条：滚动盒是跨两列的主区，滚一列另一列跟着动 —— 用户要求
//      改成「分开有两个滚动条」；
//   2. 选完副语言整列跳回列表顶部：组件重铺选项把卡片整块摘下再装回（节点身份不变），
//      而**滚动位置不在节点身份里**——真机上子树脱离文档后布局盒销毁，两列 scrollTop
//      一起归零。
// 第 2 条自 2026-10 深化起是**组件侧不变式**而不是本叶子的快照/恢复：卡片根与选项行
// 落点都走 setCustomSelectSlots 的槽位声明，组件换项只摘自己产出的 <li>，骨架（连带
// 两列）全程不脱离文档 ⇒ scrollTop 自然保住。行为面用例在
// tests/ui/custom-select.test.ts 的「弹层槽位」组（含「槽位节点不得在重铺期间脱离
// 浮层」这条真机语义的替身断言）；这里只锁定滚动归属（源码面）。
describe("弹层滚动：两列各自滚（源码锁）", () => {
  const BILINGUAL_CSS = "extension/entry/styles/bilingual-subtitles.css";

  it("滚动归属每一列：列是滚动盒、主区只裁剪、交叉轴不再收缩（源码锁）", () => {
    const css = readFileSync(join(process.cwd(), BILINGUAL_CSS), "utf8");
    const mainRule = css.match(/\.biliscript-bilingual-main\s*\{[^}]*\}/)?.[0] || "";
    expect(mainRule).toContain("display: flex");
    expect(mainRule).toContain("overflow: hidden");
    const colsRule = css.match(/\.biliscript-bilingual-cols\s*\{[^}]*\}/)?.[0] || "";
    // align-items: flex-start 会把列收缩到内容高 ⇒ 滚动盒没有高度可滚，两列又只能
    // 回到共用一个滚动区。交叉轴必须是默认的 stretch。
    expect(colsRule).not.toContain("align-items");
    expect(colsRule).toContain("min-height: 0");
    const colRule = css.match(/\.biliscript-bilingual-col\s*\{[^}]*\}/)?.[0] || "";
    expect(colRule).toContain("overflow-y: auto");
    expect(colRule).toContain("min-height: 0");
    expect(colRule).toContain("min-width: 0");
    // 细滚动条跟 reader.css 三处滚动容器同一套：只走 ::-webkit-scrollbar 定制
    //（Chrome 121+ 设标准 scrollbar-color/width 会跳过 webkit 定制、回退原生粗灰条）
    expect(css).not.toContain("scrollbar-width:");
    expect(css).not.toContain("scrollbar-color:");
    expect(css).not.toContain("@supports not (scrollbar-color: auto)");
    expect(css).toContain(".biliscript-bilingual-col::-webkit-scrollbar");
    expect(css).toContain(".biliscript-bilingual-col::-webkit-scrollbar-button");
  });
});
