// 全轨道双语字幕状态机端到端矩阵测试：
// 先列出系统可能的失败方式：
//   1. 语种族未归一（zh-Hans / zh-Hant / ai-zh / asr-zh 未同属 "zh"），导致繁简双轨被配成假双语；
//   2. 单轨外语 CC（en-US）被旧单轨死锁置灰，或翻译时把主轨篡改写成 "asr" 伪轨；
//   3. 纯中文轨（zh-CN / ai-zh / 繁简双轨）默认误触发 LLM 翻译或误隐藏原生播放器字幕，或手动开双语时出现 zh -> zh 自翻译；
//   4. 跨语种真人工双轨（en-US + zh-CN）开启双语时误发 LLM 请求，或按 1:1 行号硬配导致错位；
//   5. 人工外语 CC + 机器 ai-zh 混源场景未标注（B 站 AI），或切「基于原版外语轨 AI 精翻」时未切回 en-US 主轨、缓存键与原生轨/ASR 译文键串位；
//   6. 播放器叠层与原生字幕未互斥恢复，或 bilingualDisplayOrder 在播放器/侧边栏/搜索高亮/导出四处顺序不一致。

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import type { SubtitleTrack } from "../../extension/bilibili/gateway.js";

const mockRuntime = vi.hoisted(() => ({
  llmCalls: [] as Array<{
    items: Array<{ from: number; to: number; content: string }>;
    targetLang: string;
    selectedSubtitleId?: string;
    trackLan?: string;
  }>,
  loadedPrimaryCalls: [] as Array<{ url: string; lang: string; id: string }>,
  loadedSecondaryCalls: [] as Array<{ url: string; lang: string; id: string }>,
  trackBodiesByUrl: new Map<string, Array<{ from: number; to: number; content: string }>>()
}));

vi.mock("../../extension/ai/subtitle-translate.js", async () => {
  const actual = await vi.importActual<typeof import("../../extension/ai/subtitle-translate.js")>(
    "../../extension/ai/subtitle-translate.js"
  );
  return {
    ...actual,
    translateSubtitleItems: vi.fn(async (input: {
      items: Array<{ from: number; to: number; content: string }>;
      targetLang: string;
      selectedSubtitleId?: string;
      trackLan?: string;
    }) => {
      mockRuntime.llmCalls.push({
        items: input.items,
        targetLang: input.targetLang,
        selectedSubtitleId: input.selectedSubtitleId,
        trackLan: input.trackLan
      });
      return input.items.map((item) => ({
        from: item.from,
        to: item.to,
        content: `[AI-${input.targetLang}] ${item.content}`
      }));
    })
  };
});

const EN_CC_TRACK: SubtitleTrack = {
  id: "cc-en",
  lan: "en-US",
  lanDoc: "English",
  subtitleUrl: "https://sub.test/cc-en.json",
  source: "player"
};

const ZH_CC_TRACK: SubtitleTrack = {
  id: "cc-zh",
  lan: "zh-CN",
  lanDoc: "中文（简体）",
  subtitleUrl: "https://sub.test/cc-zh.json",
  source: "player"
};

const ZH_HANS_TRACK: SubtitleTrack = {
  id: "cc-zh-hans",
  lan: "zh-Hans",
  lanDoc: "中文（简体）",
  subtitleUrl: "https://sub.test/zh-hans.json",
  source: "player"
};

const ZH_HANT_TRACK: SubtitleTrack = {
  id: "cc-zh-hant",
  lan: "zh-Hant",
  lanDoc: "中文（繁體）",
  subtitleUrl: "https://sub.test/zh-hant.json",
  source: "player"
};

const AI_ZH_TRACK: SubtitleTrack = {
  id: "bili-ai-zh",
  lan: "ai-zh",
  lanDoc: "中文",
  subtitleUrl: "https://sub.test/ai-zh.json",
  source: "player"
};

const EN_BODY = [
  { from: 0.0, to: 2.4, content: "Welcome to GPU architecture." },
  { from: 2.4, to: 5.0, content: "Let us inspect warp scheduling." }
];

// 人工中文字幕：存在 0.2s–0.4s 偏移且两句英文合并为一句中文（非 1:1 行号）
const ZH_MANUAL_SHIFTED_BODY = [
  { from: 0.2, to: 4.8, content: "欢迎来到 GPU 架构课，下面来看线程束调度。" }
];

const AI_ZH_INFERIOR_BODY = [
  { from: 0.0, to: 5.0, content: "欢迎来到吉普架构我们检查经纱时间表" }
];

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(
    (message: any, callback?: (res: unknown) => void) => {
      if (message?.type === "resolve-subtitle-translate-provider") {
        callback?.({
          ok: true,
          provider: {
            id: "mock-ai",
            name: "Mock AI",
            baseUrl: "https://api.mock",
            models: ["m1"],
            enabled: true
          },
          apiKey: "sk-mock",
          model: "m1",
          isFallback: false
        });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    }
  );
  mockRuntime.llmCalls = [];
  mockRuntime.loadedPrimaryCalls = [];
  mockRuntime.loadedSecondaryCalls = [];
  mockRuntime.trackBodiesByUrl.clear();
  mockRuntime.trackBodiesByUrl.set(EN_CC_TRACK.subtitleUrl, EN_BODY);
  mockRuntime.trackBodiesByUrl.set(ZH_CC_TRACK.subtitleUrl, ZH_MANUAL_SHIFTED_BODY);
  mockRuntime.trackBodiesByUrl.set(AI_ZH_TRACK.subtitleUrl, AI_ZH_INFERIOR_BODY);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("1. 语种族归一化、轨道分类器与目标语言防自翻", () => {
  it("getLangFamily 归一繁简/AI/ASR 语种族，classifySubtitleTrack 严格区分三类轨道性质", async () => {
    const {
      classifySubtitleTrack,
      getAvailableTargetLangOptions,
      getLangFamily,
      resolveTargetLang,
      resolveTargetLangBcp47
    } = await import("../../extension/subtitle/selection.js");

    expect(
      ["zh-CN", "zh-Hans", "zh-TW", "zh-HK", "zh-Hant", "ai-zh", "asr-zh"].map(getLangFamily)
    ).toEqual(["zh", "zh", "zh", "zh", "zh", "zh", "zh"]);
    expect(["en-US", "en-GB", "ai-en"].map(getLangFamily)).toEqual(["en", "en", "en"]);
    expect(["ja", "ja-JP", "ai-ja"].map(getLangFamily)).toEqual(["ja", "ja", "ja"]);

    expect(classifySubtitleTrack(EN_CC_TRACK)).toBe("manual-cc");
    expect(classifySubtitleTrack(AI_ZH_TRACK)).toBe("bili-ai");
    expect(classifySubtitleTrack({ id: "asr", lan: "asr-zh", subtitleUrl: "" })).toBe("asr");

    // 源轨为中文族时：候选剔除 zh，默认切为 en / en-US，同时保留非中文历史偏好（如 ja）
    expect(getAvailableTargetLangOptions("zh-Hant").map((o) => o.value)).not.toContain("zh");
    expect(resolveTargetLang("zh-CN", "zh")).toBe("en");
    expect(resolveTargetLangBcp47("zh-CN", "zh-CN")).toBe("en-US");
    expect(resolveTargetLang("zh-Hans", "ja")).toBe("ja");

    // 源轨为英文族时：候选剔除 en，默认切为 zh / zh-CN
    expect(getAvailableTargetLangOptions("en-US").map((o) => o.value)).not.toContain("en");
    expect(resolveTargetLang("en-US", "en-US")).toBe("zh");
    expect(resolveTargetLangBcp47("en-US", "en")).toBe("zh-CN");
  });
});

describe("2. 矩阵场景 1：仅有单条 en-US CC", () => {
  it("双语开关可用，默认目标语言 zh-CN，走 CC 流式翻译且缓存键独立、不篡改 CC 主轨身份", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const tabUi = await import("../../extension/reader/subtitle-tab-ui.js");
    const readerAsr = await import("../../extension/reader/asr-translation.js");
    const subtitleAsr = await import("../../extension/subtitle/asr-translation.js");
    const cache = await import("../../extension/subtitle/cache.js");

    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: false, liveInterpretTargetLang: "en" });
    clipState.setBvid("BV1singleEn00");
    clipState.setCid("101");
    clipState.setFetchRunId(1);
    clipState.setSubtitles([EN_CC_TRACK] as never);
    clipState.setSelectedSubtitleId(EN_CC_TRACK.id);
    clipState.setSelectedSubtitleUrl(EN_CC_TRACK.subtitleUrl);
    clipState.setSelectedSubtitleLang(EN_CC_TRACK.lanDoc);
    clipState.setSubtitleBody(EN_BODY as never);
    clipState.setSubtitleFetchState("ready");

    const facts = tabUi.selectSubtitleToolbarFacts();
    expect(facts.switchDisabled).toBe(false);
    expect(facts.asrScenario).toBe(true);
    expect(facts.asrTranslation.lang).toBe("zh");
    expect(readerAsr.resolveAsrTranslationTargetBcp47()).toBe("zh-CN");

    const result = await subtitleAsr.ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: facts.asrTranslation.lang,
      runId: 1
    });

    expect(result.kind).toBe("done");
    expect(mockRuntime.llmCalls).toHaveLength(1);
    expect(mockRuntime.llmCalls[0].selectedSubtitleId).toBe("cc-en");
    expect(mockRuntime.llmCalls[0].trackLan).toBe("en-US");
    expect(state.clip.selectedSubtitleId).toBe("cc-en");
    expect(clipState.secondarySubtitle.id).toBe("id_cc-en_translate-zh-CN");

    const expectedCacheKey = cache.getSubtitleCacheKey({
      bvid: "BV1singleEn00",
      cid: "101",
      identity: { kind: "track-translated", sourceKey: "id_cc-en", targetLang: "zh-CN" }
    });
    expect(expectedCacheKey).toBe("biliscript_subtitle_cache_BV1singleEn00_101_id_cc-en_translate-zh-CN");
    await expect(cache.loadSubtitleFromCache(expectedCacheKey)).resolves.toHaveLength(2);
  });
});

describe("3. 矩阵场景 2：仅有单条 zh-CN CC 或 zh-Hans + zh-Hant 繁简双轨", () => {
  it("默认零 LLM 请求且不接管原生播放器字幕；繁简双轨严禁假双语配对，手动开双语候选不含中文且默认切为 en-US", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const secondary = await import("../../extension/reader/secondary-subtitle.js");
    const readerAsr = await import("../../extension/reader/asr-translation.js");
    const interpret = await import("../../extension/live/player-interpret.js");
    const { isMonolingualNativeTracks } = await import("../../extension/subtitle/selection.js");

    const playerHost = document.createElement("div");
    playerHost.className = "bpx-player-container";
    const nativeSubWrap = document.createElement("div");
    nativeSubWrap.className = "bpx-player-subtitle-wrap";
    playerHost.appendChild(nativeSubWrap);
    document.body.appendChild(playerHost);

    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: false, liveInterpretTargetLang: "zh" });
    clipState.setBvid("BV1zhOnly0000");
    clipState.setCid("202");
    clipState.setSubtitles([ZH_HANS_TRACK, ZH_HANT_TRACK] as never);
    clipState.setSelectedSubtitleId(ZH_HANS_TRACK.id);
    clipState.setSelectedSubtitleUrl(ZH_HANS_TRACK.subtitleUrl);
    clipState.setSelectedSubtitleLang(ZH_HANS_TRACK.lanDoc);
    clipState.setSubtitleBody(ZH_MANUAL_SHIFTED_BODY as never);
    clipState.setSubtitleFetchState("ready");

    interpret.syncPlayerInterpretQuickAction();

    // 默认零打扰：不发起任何翻译、不挂接管属性、繁简双轨判定为单语种不自动配对
    expect(mockRuntime.llmCalls).toHaveLength(0);
    expect(playerHost.hasAttribute("data-biliscript-subtitle-takeover")).toBe(false);
    expect(isMonolingualNativeTracks([ZH_HANS_TRACK, ZH_HANT_TRACK])).toBe(true);
    expect(secondary.resolveSecondaryTarget()).toEqual({ kind: "none", reason: "no-track" });

    // 手动查看/开启双语：候选列表剔除中文，默认目标语言自动切为 en / en-US
    const options = readerAsr.resolveAsrTranslationOptions();
    expect(options.map((item) => item.value)).not.toContain("zh");
    expect(readerAsr.resolveAsrTranslationLang()).toBe("en");
    expect(readerAsr.resolveAsrTranslationTargetBcp47()).toBe("en-US");
  });
});

describe("4. 矩阵场景 3（场景 A）：同时有人工 en-US + 人工 zh-CN", () => {
  it("开启双语默认零 LLM 请求直接配对原生双轨，面板与播放器统一通过时间交集对齐错位句", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const { acceptSubtitle, acceptSecondarySubtitle } = await import("../../extension/subtitle/commit.js");
    const { secondaryContentFor } = await import("../../extension/subtitle/alignment.js");
    const { createInterpretSessionController } = await import(
      "../../extension/live/interpret-session-controller.js"
    );

    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true, secondarySubtitleLang: "en-US" });
    clipState.setBvid("BV1manualPair");
    clipState.setCid("303");
    clipState.setFetchRunId(2);
    clipState.setSubtitles([EN_CC_TRACK, ZH_CC_TRACK] as never);
    await acceptSubtitle({
      body: EN_BODY,
      selectedSubtitleId: EN_CC_TRACK.id,
      selectedSubtitleUrl: EN_CC_TRACK.subtitleUrl,
      selectedSubtitleLang: EN_CC_TRACK.lanDoc,
      skipHotComments: true
    });

    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 3.0, writable: true, configurable: true });
    const setSubtitle = vi.fn();
    const resolveProviderSpy = vi.fn(async () => {
      throw new Error("严禁在原生人工双轨配对时检查或调用翻译平台");
    });

    const controller = createInterpretSessionController({
      getVideoElement: () => video,
      setSubtitle,
      resolveTranslateProvider: resolveProviderSpy,
      loadNativeSecondaryTrack: async (target) => {
        mockRuntime.loadedSecondaryCalls.push(target);
        await acceptSecondarySubtitle({
          body: ZH_MANUAL_SHIFTED_BODY,
          subtitleId: target.id,
          subtitleUrl: target.url
        });
      }
    });

    const started = await controller.start();
    expect(started).toBe(true);
    expect(resolveProviderSpy).not.toHaveBeenCalled();
    expect(mockRuntime.llmCalls).toHaveLength(0);
    expect(mockRuntime.loadedSecondaryCalls).toEqual([
      { id: ZH_CC_TRACK.id, url: ZH_CC_TRACK.subtitleUrl, lang: ZH_CC_TRACK.lanDoc }
    ]);

    // 第二句英文 [2.4, 5.0] 与唯一一句错位中文 [0.2, 4.8] 重叠时长 2.4s > 0 ⇒ 两侧一致对齐
    expect(secondaryContentFor(EN_BODY[1])).toBe("欢迎来到 GPU 架构课，下面来看线程束调度。");
    expect(setSubtitle).toHaveBeenLastCalledWith(
      "Let us inspect warp scheduling.",
      "欢迎来到 GPU 架构课，下面来看线程束调度。"
    );
    await controller.stop();
  });
});

describe("5. 矩阵场景 4（场景 C）：同时有人工 en-US + 机器 ai-zh", () => {
  it("混源标注（B 站 AI），一键切至基于 en-US 源轨的 AI 精翻并切换主轨、生成独立缓存键", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const { acceptSubtitle } = await import("../../extension/subtitle/commit.js");
    const { formatSubtitleTrackOptionLabel, shouldMarkAiSubtitleTracks } = await import(
      "../../extension/subtitle/labels.js"
    );
    const subtitleAsr = await import("../../extension/subtitle/asr-translation.js");
    const cache = await import("../../extension/subtitle/cache.js");
    const { createInterpretSessionController } = await import(
      "../../extension/live/interpret-session-controller.js"
    );

    const tracks = [AI_ZH_TRACK, EN_CC_TRACK];
    const marked = shouldMarkAiSubtitleTracks(tracks);
    expect(marked).toBe(true);
    expect(formatSubtitleTrackOptionLabel(AI_ZH_TRACK, marked)).toBe("中文（B 站 AI）");
    expect(formatSubtitleTrackOptionLabel(EN_CC_TRACK, marked)).toBe("English");

    // 初始主轨为排序靠前的劣质 ai-zh
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
    clipState.setBvid("BV1mixedAiZh0");
    clipState.setCid("404");
    clipState.setFetchRunId(3);
    clipState.setSubtitles(tracks as never);
    await acceptSubtitle({
      body: AI_ZH_INFERIOR_BODY,
      selectedSubtitleId: AI_ZH_TRACK.id,
      selectedSubtitleUrl: AI_ZH_TRACK.subtitleUrl,
      selectedSubtitleLang: AI_ZH_TRACK.lanDoc,
      skipHotComments: true
    });

    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 1.0, writable: true, configurable: true });
    const setSubtitle = vi.fn();

    const controller = createInterpretSessionController({
      getVideoElement: () => video,
      getAiRefineMode: () => "foreign-refine",
      setSubtitle,
      loadNativePrimaryTrack: async (target) => {
        mockRuntime.loadedPrimaryCalls.push(target);
        await acceptSubtitle({
          body: EN_BODY,
          selectedSubtitleId: target.id,
          selectedSubtitleUrl: target.url,
          selectedSubtitleLang: target.lang,
          skipHotComments: true
        });
      }
    });

    const ok = await controller.start();
    expect(ok).toBe(true);
    // 自动将主轨从 ai-zh 切换为高质量原版人工 en-US 轨，随后基于 en-US 发起中文精翻
    expect(mockRuntime.loadedPrimaryCalls).toEqual([
      { id: EN_CC_TRACK.id, url: EN_CC_TRACK.subtitleUrl, lang: EN_CC_TRACK.lanDoc }
    ]);
    await vi.waitFor(() => expect(mockRuntime.llmCalls).toHaveLength(1));
    expect(mockRuntime.llmCalls[0].selectedSubtitleId).toBe("cc-en");
    expect(mockRuntime.llmCalls[0].targetLang).toBe("zh");
    expect(state.clip.selectedSubtitleId).toBe("cc-en");

    const independentKey = cache.getSubtitleCacheKey({
      bvid: "BV1mixedAiZh0",
      cid: "404",
      identity: { kind: "track-translated", sourceKey: "id_cc-en", targetLang: "zh-CN" }
    });
    const nativeAiZhKey = cache.getSubtitleCacheKey({
      bvid: "BV1mixedAiZh0",
      cid: "404",
      identity: { kind: "track", trackId: AI_ZH_TRACK.id }
    });
    expect(independentKey).not.toBe(nativeAiZhKey);
    await vi.waitFor(async () => {
      const saved = await cache.loadSubtitleFromCache(independentKey);
      expect(saved).toHaveLength(2);
    });

    // 侧边栏批量器复用同一份独立精翻缓存：零额外 LLM 请求直接命中
    clipState.clearSecondarySubtitle();
    const callCountBeforePanel = mockRuntime.llmCalls.length;
    const panelRes = await subtitleAsr.ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: "zh",
      runId: 3
    });
    expect(panelRes.kind).toBe("done");
    expect(mockRuntime.llmCalls).toHaveLength(callCountBeforePanel);
    expect(clipState.secondarySubtitle.id).toBe("id_cc-en_translate-zh-CN");
    await controller.stop();
  });
});

describe("6. 双层互斥接管与 bilingualDisplayOrder 三端语序统一", () => {
  it("开启叠层挂接管属性、关闭立即恢复；original-first 与 translation-first 同步控制浮层、面板与导出", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const core = await import("../../extension/subtitle/core.js");
    const { buildReadingSubtitleItemHtml } = await import("../../extension/reader/batched-render.js");
    const { getMainLineText, replaceMainLineContent } = await import(
      "../../extension/reader/subtitle-item-dom.js"
    );
    const {
      createInterpretSubtitleOverlay,
      syncNativePlayerSubtitleTakeover
    } = await import("../../extension/live/player-interpret.js");

    const playerHost = document.createElement("div");
    playerHost.className = "bpx-player-container";
    document.body.appendChild(playerHost);

    syncNativePlayerSubtitleTakeover(true, playerHost);
    expect(playerHost.getAttribute("data-biliscript-subtitle-takeover")).toBe("true");
    syncNativePlayerSubtitleTakeover(false, playerHost);
    expect(playerHost.hasAttribute("data-biliscript-subtitle-takeover")).toBe(false);

    state.setSettings({
      ...DEFAULT_SETTINGS,
      bilingualSubtitles: true,
      bilingualDisplayOrder: "translation-first"
    });
    clipState.setSubtitleBody([{ from: 0, to: 4, content: "Original line" }] as never);
    clipState.applySecondarySubtitle({
      id: "sub-zh",
      url: "https://sub.test/zh.json",
      body: [{ from: 0, to: 4, content: "译文在上" }] as never
    });

    // 1) 播放器叠层：translation-first 时译文节点排在原文节点之前
    const overlay = createInterpretSubtitleOverlay({
      getPlayerHost: () => playerHost,
      getTargetLang: () => "zh",
      getDisplayMode: () => "bilingual",
      getDisplayOrder: () => state.settings.bilingualDisplayOrder
    });
    overlay.setSubtitle("Original line", "译文在上");
    const overlayRoot = overlay.getElement()!;
    expect(overlayRoot.firstElementChild?.className).toBe("biliscript-interpret-subtitle-translation");
    expect(overlayRoot.lastElementChild?.className).toBe("biliscript-interpret-subtitle-original");

    // 2) 文摘面板条目 DOM（含主行重写后）：副行仍保持在首子节点，且 getMainLineText 不混入副行
    const listWrap = document.createElement("div");
    listWrap.innerHTML = buildReadingSubtitleItemHtml(
      { index: 0, from: 0, to: 4, content: "Original line" },
      false
    );
    const itemEl = listWrap.firstElementChild as HTMLElement;
    const textSpan = itemEl.querySelector(".biliscript-reading-text")!;
    expect((textSpan.firstChild as HTMLElement).className).toBe("biliscript-reading-subtext");
    expect(getMainLineText(itemEl)).toBe("Original line");

    const rewritten = document.createDocumentFragment();
    rewritten.appendChild(document.createTextNode("Highlighted original"));
    replaceMainLineContent(itemEl, rewritten);
    expect((textSpan.firstChild as HTMLElement).className).toBe("biliscript-reading-subtext");
    expect(getMainLineText(itemEl)).toBe("Highlighted original");

    // 3) 导出（TXT / Markdown / SRT）：遵循 translation-first，切回 original-first 自动失效重算
    core.ensureDerivedContent();
    expect(state.clip.txt).toBe("0:00 译文在上\n  Original line");
    expect(state.clip.markdown).toBe("## 字幕\n\n`0:00` 译文在上\n  Original line");
    expect(state.clip.srt).toBe("1\n00:00:00,000 --> 00:00:04,000\n译文在上\nOriginal line");

    state.setSettings({ ...state.settings, bilingualDisplayOrder: "original-first" });
    core.ensureDerivedContent();
    expect(state.clip.txt).toBe("0:00 Original line\n  译文在上");
    expect(state.clip.srt).toBe("1\n00:00:00,000 --> 00:00:04,000\nOriginal line\n译文在上");
    overlay.dispose();
  });
});
