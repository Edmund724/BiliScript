import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { YOUTUBE_UNIT_CID } from "../../extension/shared/site.js";

const lazy = vi.hoisted(() => ({
  nativeCalls: [] as unknown[][],
  nativeMode: "ok" as "ok" | "pend" | "reject",
  nativeGates: [] as Array<() => void>,
  primaryCalls: [] as unknown[][],
  translationCalls: [] as Array<{
    mode: string;
    targetLang: string;
    runId: number;
    signal: AbortSignal;
    onProgress: (progress: { total: number; done: number; failed: number }) => void;
  }>,
  translationMode: "done" as "done" | "pending" | "pend" | "reject",
  translationFailed: 0,
  translationGates: [] as Array<() => void>
}));

const CHAIN_PROGRESS = { total: 4, done: 2, failed: 0 };

vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({
    loadSubtitle: async (url: string, lang: string, runId: number, id: string) => {
      lazy.primaryCalls.push([url, lang, runId, id]);
      const { clipState } = await import("../../extension/core/state.js");
      clipState.setSelectedSubtitleId(id);
      clipState.setSelectedSubtitleUrl(url);
      clipState.setSelectedSubtitleLang(lang);
    },
    loadSecondarySubtitle: async (url: string, lang: string, runId: number, id: string, forceRefresh: boolean) => {
      lazy.nativeCalls.push([url, lang, runId, id, forceRefresh]);
      if (lazy.nativeMode === "pend") {
        await new Promise<void>((resolve) => {
          lazy.nativeGates.push(resolve);
        });
        return;
      }
      if (lazy.nativeMode === "reject") {
        throw new Error("副轨网络失败");
      }
    },
    ensureAsrTranslation: async (args: (typeof lazy.translationCalls)[number]) => {
      lazy.translationCalls.push(args);
      args.onProgress?.({
        total: CHAIN_PROGRESS.total,
        done: CHAIN_PROGRESS.done,
        failed: lazy.translationFailed
      });
      if (lazy.translationMode === "pend") {
        await new Promise<void>((resolve) => {
          lazy.translationGates.push(resolve);
        });
      }
      if (lazy.translationMode === "reject") {
        throw new Error("翻译平台失败");
      }
      return {
        kind: lazy.translationMode === "pending" ? "pending" : "done",
        total: CHAIN_PROGRESS.total,
        done: CHAIN_PROGRESS.done,
        failed: lazy.translationFailed
      };
    }
  }))
}));

type SecondaryModule = typeof import("../../extension/reader/secondary-subtitle.js");
type EnsureOutcome = ReturnType<SecondaryModule["ensureSecondarySubtitleForCurrentClip"]>;
type SelectionOutcome = ReturnType<SecondaryModule["selectSecondaryOption"]>;

function expectStarted(outcome: EnsureOutcome | SelectionOutcome) {
  if (outcome.kind !== "started") {
    throw new Error(`期望原生副轨起步，实际 ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectTranslation(outcome: EnsureOutcome | SelectionOutcome) {
  if (outcome.kind !== "translation") {
    throw new Error(`期望译文副轨起步，实际 ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

let module: SecondaryModule;
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];

const EN_TRACK = {
  id: "2121827445538866944",
  lan: "ai-en",
  lanDoc: "English",
  subtitleUrl: "https://sub/ai-en.json",
  source: "player"
};
const ZH_TRACK = {
  id: "2120476497172283392",
  lan: "ai-zh",
  lanDoc: "中文",
  subtitleUrl: "https://sub/ai-zh.json",
  source: "player"
};
const CC_EN_TRACK = {
  id: "cc-en",
  lan: "en-US",
  lanDoc: "English (CC)",
  subtitleUrl: "https://sub/cc-en.json",
  source: "player-wbi-v2"
};
const CC_ZH_TRACK = {
  id: "cc-zh",
  lan: "zh-CN",
  lanDoc: "中文（CC）",
  subtitleUrl: "https://sub/cc-zh.json",
  source: "player-wbi-v2"
};
const ASR_TRACK = {
  id: "asr",
  lan: "asr-zh",
  lanDoc: "自配平台转写（中文）",
  subtitleUrl: "",
  source: "asr",
  origin: "asr" as const
};
const BODY = [
  { from: 0, to: 3, content: "第一句" },
  { from: 3, to: 6, content: "第二句" }
];

function setBilingual(on: boolean, lang = "en-US") {
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: on, secondarySubtitleLang: lang });
}

function seedNativePair(tracks = [ZH_TRACK, EN_TRACK], mainTrack = ZH_TRACK) {
  clipState.setSite("bilibili");
  clipState.setBvid("BV1native0000");
  clipState.setCid("101");
  clipState.setSubtitles(tracks as never);
  clipState.setSelectedSubtitleId(mainTrack.id);
  clipState.setSelectedSubtitleUrl(mainTrack.subtitleUrl);
  clipState.setSubtitleBody(BODY as never);
  clipState.setFetchRunId(3);
}

function seedTranslationClip(tracks: unknown[] = [ASR_TRACK], mainId = "asr", body = BODY) {
  clipState.setSite("bilibili");
  clipState.setBvid("BV1trans00000");
  clipState.setCid("202");
  clipState.setSubtitles(tracks as never);
  clipState.setSelectedSubtitleId(mainId);
  clipState.setSubtitleBody(body as never);
  clipState.setFetchRunId(7);
}

beforeEach(async () => {
  resetModuleState();
  module = await import("../../extension/reader/secondary-subtitle.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  lazy.nativeCalls = [];
  lazy.nativeMode = "ok";
  lazy.nativeGates = [];
  lazy.primaryCalls = [];
  lazy.translationCalls = [];
  lazy.translationMode = "done";
  lazy.translationFailed = 0;
  lazy.translationGates = [];
  state.setSettings({ ...DEFAULT_SETTINGS });
  clipState.setFetchRunId(3);
});

afterEach(() => {
  state.setSettings({ ...DEFAULT_SETTINGS });
});

describe("统一视图投影 resolveBilingualPickerView（原生副轨与译文副轨双态）", () => {
  it("原生多轨：偏好为空 / 缺失轨（中文名与机器码回落）/ 主副同轨或同语种族 / 已命中 / error / loading", () => {
    seedNativePair([ZH_TRACK, EN_TRACK], ZH_TRACK);

    setBilingual(true, "");
    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "native",
      heading: "副字幕",
      note: "选择副字幕语言",
      footerNote: "",
      selectedValue: "",
      action: null,
      busy: false,
      selectDisabled: false
    });

    setBilingual(true, "ai-ja");
    expect(module.resolveBilingualPickerView().note).toBe("本视频没有日语轨");
    setBilingual(true, "xx-XX");
    expect(module.resolveBilingualPickerView().note).toBe("本视频没有 xx-XX 轨");

    setBilingual(true, "ai-zh");
    seedNativePair([ZH_TRACK, CC_ZH_TRACK, EN_TRACK], CC_ZH_TRACK);
    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "native",
      note: "",
      footerNote: "主副字幕相同",
      selectedValue: ""
    });

    setBilingual(true, "en-US");
    seedNativePair([ZH_TRACK, EN_TRACK, CC_EN_TRACK], ZH_TRACK);
    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "native",
      selectedValue: CC_EN_TRACK.subtitleUrl,
      action: null,
      aiRefineAction: { kind: "foreign-refine", label: "基于原版外语轨 AI 精翻" }
    });

    clipState.markSecondarySubtitleError();
    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "native",
      selectedValue: CC_EN_TRACK.subtitleUrl,
      action: { kind: "retry", label: "加载失败 · 重试", disabled: false },
      busy: false
    });

    clipState.markSecondarySubtitleLoading({ id: CC_EN_TRACK.id, url: CC_EN_TRACK.subtitleUrl });
    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "native",
      selectedValue: CC_EN_TRACK.subtitleUrl,
      action: null,
      busy: true,
      selectDisabled: true
    });
  });

  it("纯繁简同族多轨与 YouTube 多语种原生轨禁用原生配对，统一进入译文模式并过滤同语种族选项", () => {
    const zhHans = { id: "zh-hans", lan: "zh-Hans", lanDoc: "中文（简体）", subtitleUrl: "https://sub/hans.json", source: "player" };
    const zhHant = { id: "zh-hant", lan: "zh-Hant", lanDoc: "中文（繁體）", subtitleUrl: "https://sub/hant.json", source: "player" };
    seedNativePair([zhHans, zhHant], zhHans);
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true, liveInterpretTargetLang: "zh" });

    const zhView = module.resolveBilingualPickerView();
    expect(zhView.mode).toBe("translation");
    expect(zhView.heading).toBe("译文");
    expect(zhView.selectedValue).toBe("en");
    expect(zhView.translationOptions.map((o) => o.value)).not.toContain("zh");
    expect(zhView.aiRefineAction).toBeNull();

    seedNativePair([CC_EN_TRACK, CC_ZH_TRACK], CC_EN_TRACK);
    clipState.setSite("youtube");
    clipState.setCid(YOUTUBE_UNIT_CID);
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true, liveInterpretTargetLang: "en" });

    const ytView = module.resolveBilingualPickerView();
    expect(ytView.mode).toBe("translation");
    expect(ytView.selectedValue).toBe("zh");
    expect(ytView.translationOptions.map((o) => o.value)).not.toContain("en");
    expect(ytView.aiRefineAction).toBeNull();
  });

  it("译文模式视图态：待开始 / 无正文隐藏按钮 / 在飞进度 / 槽 error 重试 / 部分分片失败补齐", async () => {
    seedTranslationClip();
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true, liveInterpretTargetLang: "en" });

    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "translation",
      selectedValue: "en",
      busy: false,
      selectDisabled: false,
      note: "",
      action: { kind: "start", label: "开始生成译文", disabled: false }
    });

    clipState.setSubtitleBody([] as never);
    expect(module.resolveBilingualPickerView().action).toBeNull();

    clipState.setSubtitleBody(BODY as never);
    lazy.translationMode = "pend";
    const run = expectTranslation(module.triggerSecondaryAction());
    await vi.waitFor(() => expect(lazy.translationCalls).toHaveLength(1));
    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "translation",
      busy: true,
      selectDisabled: false,
      note: "正在生成译文 2/4 片",
      action: null
    });
    lazy.translationGates.splice(0).forEach((release) => release());
    await run.settled;

    clipState.markSecondarySubtitleLoading({ id: "translate-en", url: "" });
    clipState.markSecondarySubtitleError();
    expect(module.resolveBilingualPickerView().action).toEqual({
      kind: "retry",
      label: "重试",
      disabled: false
    });

    clipState.applySecondarySubtitle({
      id: "translate-en",
      url: "",
      body: [{ from: 0, to: 3, content: "First" }] as never
    });
    lazy.translationMode = "done";
    lazy.translationFailed = 0;
    await expectTranslation(module.ensureSecondarySubtitleForCurrentClip()).settled;
    expect(module.resolveBilingualPickerView().action).toBeNull();

    lazy.translationFailed = 1;
    await expectTranslation(module.triggerSecondaryAction()).settled;
    expect(module.resolveBilingualPickerView()).toMatchObject({
      note: "译文已生成，部分分片失败",
      action: { kind: "fill", label: "补齐失败的 1 片", disabled: false }
    });
  });
});

describe("自动装载入口 ensureSecondarySubtitleForCurrentClip（单入口分流原生与译文）", () => {
  it("双语关 / 槽非 idle / 无偏好 / 缺轨均跳过；命中原生副轨时透传 (url, lanDoc, runId, id, false) 并正确记在飞", async () => {
    seedNativePair([ZH_TRACK, EN_TRACK], ZH_TRACK);

    setBilingual(false);
    expect(module.ensureSecondarySubtitleForCurrentClip()).toEqual({ kind: "skipped", reason: "bilingual-off" });

    setBilingual(true, "");
    expect(module.ensureSecondarySubtitleForCurrentClip()).toEqual({ kind: "skipped", reason: "no-preference" });

    setBilingual(true, "ja-JP");
    expect(module.ensureSecondarySubtitleForCurrentClip()).toEqual({ kind: "skipped", reason: "no-track" });

    setBilingual(true, "en-US");
    clipState.applySecondarySubtitle({ id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, body: [] });
    expect(module.ensureSecondarySubtitleForCurrentClip()).toEqual({ kind: "skipped", reason: "slot-busy" });
    expect(lazy.nativeCalls).toHaveLength(0);

    clipState.clearSecondarySubtitle();
    lazy.nativeMode = "pend";
    const outcome = expectStarted(module.ensureSecondarySubtitleForCurrentClip());
    expect(outcome.target).toEqual({
      id: EN_TRACK.id,
      url: EN_TRACK.subtitleUrl,
      lang: EN_TRACK.lanDoc,
      origin: "bilibili"
    });
    expect(module.resolveBilingualPickerView().busy).toBe(true);
    await vi.waitFor(() => expect(lazy.nativeCalls).toHaveLength(1));
    expect(lazy.nativeCalls[0]).toEqual([EN_TRACK.subtitleUrl, EN_TRACK.lanDoc, 3, EN_TRACK.id, false]);

    lazy.nativeGates.splice(0).forEach((release) => release());
    await expect(outcome.settled).resolves.toEqual({ error: null });
    expect(module.resolveBilingualPickerView().busy).toBe(false);
  });

  it("原生装载失败内部吞异常，通过 settled 返回 error 且解除 busy", async () => {
    seedNativePair([ZH_TRACK, EN_TRACK], ZH_TRACK);
    setBilingual(true, "en-US");
    lazy.nativeMode = "reject";

    const outcome = expectStarted(module.ensureSecondarySubtitleForCurrentClip());
    await expect(outcome.settled).resolves.toEqual({ error: expect.any(Error) });
    expect(module.resolveBilingualPickerView().busy).toBe(false);
  });

  it("译文场景：自动入口走 cache-only（缺片返回 pending 不自动付费）；未就绪时点开始后由自动入口兑现", async () => {
    seedTranslationClip([ASR_TRACK], "asr", BODY);
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true, liveInterpretTargetLang: "ja" });
    lazy.translationMode = "pending";

    const cached = expectTranslation(module.ensureSecondarySubtitleForCurrentClip());
    await expect(cached.settled).resolves.toEqual({ kind: "pending" });
    expect(lazy.translationCalls[0].mode).toBe("cache-only");
    expect(lazy.translationCalls[0].targetLang).toBe("ja");
    expect(lazy.translationCalls[0].runId).toBe(7);

    lazy.translationCalls = [];
    lazy.translationMode = "done";
    clipState.setSubtitleBody([] as never);
    await expect(expectTranslation(module.triggerSecondaryAction()).settled).resolves.toEqual({ kind: "skipped" });
    expect(lazy.translationCalls).toHaveLength(0);

    clipState.setSubtitleBody(BODY as never);
    await expect(expectTranslation(module.ensureSecondarySubtitleForCurrentClip()).settled).resolves.toEqual({
      kind: "done"
    });
    expect(lazy.translationCalls).toHaveLength(1);
    expect(lazy.translationCalls[0].mode).toBe("translate");
  });

  it("译文在飞不重入；链层抛错吞成 skipped 不崩溃；换视频自动 abort 在飞译文", async () => {
    seedTranslationClip();
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
    lazy.translationMode = "pend";

    const first = expectTranslation(module.triggerSecondaryAction());
    await vi.waitFor(() => expect(lazy.translationCalls).toHaveLength(1));
    await expect(expectTranslation(module.triggerSecondaryAction()).settled).resolves.toEqual({ kind: "skipped" });
    expect(lazy.translationCalls).toHaveLength(1);

    clipState.setBvid("BV1another000");
    clipState.setCid("999");
    expect(module.resolveBilingualPickerView().busy).toBe(false);
    expect(lazy.translationCalls[0].signal.aborted).toBe(true);
    lazy.translationGates.splice(0).forEach((release) => release());
    await first.settled;

    lazy.translationCalls = [];
    lazy.translationMode = "reject";
    await expect(expectTranslation(module.triggerSecondaryAction()).settled).resolves.toEqual({ kind: "skipped" });
  });
});

describe("统一用户意图：开关 / 副列选择 / 重试 / AI 精翻 / 主轨切换 / storage 同步", () => {
  it("selectSecondaryOption（原生）：选主轨清空副轨并返 main-track，选非主轨写偏好并装载", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const persist = vi.spyOn(readerBus, "persistReaderSettingsThroughSeam");
    const notify = vi.spyOn(readerBus, "notifyReaderPresenter");

    seedNativePair([ZH_TRACK, EN_TRACK], ZH_TRACK);
    setBilingual(true, "en-US");
    clipState.applySecondarySubtitle({
      id: EN_TRACK.id,
      url: EN_TRACK.subtitleUrl,
      body: [{ from: 0, to: 5, content: "hello" }]
    });

    const same = module.selectSecondaryOption({
      id: ZH_TRACK.id,
      url: ZH_TRACK.subtitleUrl,
      lang: ZH_TRACK.lan
    });
    expect(same).toEqual({ kind: "main-track" });
    expect(state.settings.secondarySubtitleLang).toBe(ZH_TRACK.lan);
    expect(state.clip.secondarySubtitle.state).toBe("idle");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ kind: "rerender" });
    expect(lazy.nativeCalls).toHaveLength(0);

    const other = expectStarted(
      module.selectSecondaryOption({
        id: EN_TRACK.id,
        url: EN_TRACK.subtitleUrl,
        lang: EN_TRACK.lan
      })
    );
    expect(state.settings.secondarySubtitleLang).toBe(EN_TRACK.lan);
    await other.settled;
    expect(lazy.nativeCalls[0]).toEqual([EN_TRACK.subtitleUrl, EN_TRACK.lanDoc, 3, EN_TRACK.id, false]);
  });

  it("selectSecondaryOption（译文）：在飞改选目标语言 abort 旧请求并按新语言重发，非法值 auto 归一", async () => {
    seedTranslationClip();
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
    lazy.translationMode = "pend";

    const first = expectTranslation(module.triggerSecondaryAction());
    await vi.waitFor(() => expect(lazy.translationCalls).toHaveLength(1));

    const switched = expectTranslation(module.selectSecondaryOption({ value: "ja" }));
    expect(state.settings.liveInterpretTargetLang).toBe("ja");
    expect(clipState.secondarySubtitle.state).toBe("idle");
    expect(lazy.translationCalls[0].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(lazy.translationCalls).toHaveLength(2));
    expect(lazy.translationCalls[1].targetLang).toBe("ja");

    lazy.translationGates.splice(0).forEach((release) => release());
    await Promise.all([first.settled, switched.settled]);

    module.selectSecondaryOption({ value: "auto" });
    expect(state.settings.liveInterpretTargetLang).toBe("zh");
  });

  it("handleMainSubtitleSwitched：主轨切到同轨清理原生副轨；切入 ASR 打断并清槽预载缓存；切回原生恢复原生副轨", async () => {
    seedNativePair([ZH_TRACK, EN_TRACK, ASR_TRACK], ZH_TRACK);
    setBilingual(true, "ai-en");
    clipState.applySecondarySubtitle({
      id: EN_TRACK.id,
      url: EN_TRACK.subtitleUrl,
      body: [{ from: 0, to: 5, content: "hello" }]
    });

    clipState.setSelectedSubtitleId(EN_TRACK.id);
    clipState.setSelectedSubtitleUrl(EN_TRACK.subtitleUrl);
    expect(module.handleMainSubtitleSwitched(true)).toEqual({ kind: "skipped", reason: "main-track" });
    expect(state.clip.secondarySubtitle.state).toBe("idle");

    clipState.setSelectedSubtitleId(ASR_TRACK.id);
    clipState.setSelectedSubtitleUrl("");
    lazy.translationMode = "pend";
    const asrRun = expectTranslation(module.handleMainSubtitleSwitched(true));
    await vi.waitFor(() => expect(lazy.translationCalls).toHaveLength(1));
    expect(lazy.translationCalls[0].mode).toBe("cache-only");

    clipState.applySecondarySubtitle({
      id: "translate-en",
      url: "",
      body: [{ from: 0, to: 5, content: "translated" }]
    });
    clipState.setSelectedSubtitleId(ZH_TRACK.id);
    clipState.setSelectedSubtitleUrl(ZH_TRACK.subtitleUrl);
    const backToNative = expectStarted(module.handleMainSubtitleSwitched(true));
    expect(lazy.translationCalls[0].signal.aborted).toBe(true);
    expect(backToNative.target.id).toBe(EN_TRACK.id);
    lazy.translationGates.splice(0).forEach((release) => release());
    await Promise.all([asrRun.settled, backToNative.settled]);
  });

  it("triggerAiRefineAction：混源外语精翻切主轨并进译文态；exit-refine 退出精翻并恢复原生副轨", async () => {
    seedNativePair([ZH_TRACK, CC_EN_TRACK], ZH_TRACK);
    setBilingual(true, "en-US");

    expect(module.resolveBilingualPickerView().aiRefineAction).toEqual({
      kind: "foreign-refine",
      label: "基于原版外语轨 AI 精翻"
    });

    const refine = expectTranslation(module.triggerAiRefineAction("foreign-refine"));
    await refine.settled;
    expect(lazy.primaryCalls).toHaveLength(1);
    expect(lazy.primaryCalls[0][3]).toBe(CC_EN_TRACK.id);
    expect(lazy.translationCalls).toHaveLength(1);
    expect(lazy.translationCalls[0].targetLang).toBe("zh");
    expect(module.resolveBilingualPickerView()).toMatchObject({
      mode: "translation",
      aiRefineAction: { kind: "exit-refine", label: "返回原生副字幕" }
    });

    lazy.nativeCalls = [];
    const exited = expectStarted(module.triggerAiRefineAction("exit-refine"));
    await exited.settled;
    expect(module.resolveBilingualPickerView().mode).toBe("native");
    expect(lazy.nativeCalls).toHaveLength(1);
    expect(lazy.nativeCalls[0][3]).toBe(ZH_TRACK.id);
  });

  it("toggleBilingualSubtitles / triggerSecondaryAction（重试）/ syncBilingualSettingsFromStorage", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const persist = vi.spyOn(readerBus, "persistReaderSettingsThroughSeam");
    const notify = vi.spyOn(readerBus, "notifyReaderPresenter");

    seedNativePair([ZH_TRACK, EN_TRACK], ZH_TRACK);
    setBilingual(false, "en-US");

    const opened = expectStarted(module.toggleBilingualSubtitles(true));
    expect(state.settings.bilingualSubtitles).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ kind: "rerender" });
    await opened.settled;
    expect(lazy.nativeCalls).toHaveLength(1);

    lazy.nativeCalls = [];
    clipState.clearSecondarySubtitle();
    const synced = module.syncBilingualSettingsFromStorage({
      secondarySubtitleLang: { oldValue: "en-US", newValue: "ai-en" },
      liveInterpretTargetLang: { oldValue: "zh", newValue: "ja" },
      bilingualDisplayOrder: { oldValue: "original-first", newValue: "translation-first" }
    });
    expect(synced.changed).toBe(true);
    expect(state.settings.secondarySubtitleLang).toBe("ai-en");
    expect(state.settings.liveInterpretTargetLang).toBe("ja");
    expect(state.settings.bilingualDisplayOrder).toBe("translation-first");
    await expectStarted(synced.loadOutcome).settled;

    const invalidSync = module.syncBilingualSettingsFromStorage({
      liveInterpretTargetLang: { oldValue: "ja", newValue: "auto" }
    });
    expect(invalidSync.changed).toBe(true);
    expect(state.settings.liveInterpretTargetLang).toBe("zh");
    await expectStarted(invalidSync.loadOutcome).settled;

    lazy.nativeCalls = [];
    clipState.markSecondarySubtitleError();
    const retried = expectStarted(module.triggerSecondaryAction());
    await retried.settled;
    expect(lazy.nativeCalls).toEqual([[EN_TRACK.subtitleUrl, EN_TRACK.lanDoc, 3, EN_TRACK.id, true]]);

    seedTranslationClip();
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: false });
    lazy.translationMode = "pend";
    const enabledTrans = expectTranslation(module.toggleBilingualSubtitles(true));
    await vi.waitFor(() => expect(lazy.translationCalls).toHaveLength(1));
    expect(module.toggleBilingualSubtitles(false)).toEqual({ kind: "skipped", reason: "bilingual-off" });
    expect(lazy.translationCalls[0].signal.aborted).toBe(true);
    lazy.translationGates.splice(0).forEach((release) => release());
    await enabledTrans.settled;
  });
});
