// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

const translator = vi.hoisted(() => ({
  calls: [] as Array<{
    count: number;
    targetLang: string;
    startSec: number;
    origin?: string;
    kind?: string;
    source?: string;
  }>,
  protocolInputs: [] as Array<{
    selectedSubtitleId?: string;
    origin?: string;
    kind?: string;
    source?: string;
  }>,
  failStarts: new Set<number>(),
  gate: null as null | (() => void)
}));

vi.mock("../../extension/ai/subtitle-translate.js", async () => {
  const actual = await vi.importActual<typeof import("../../extension/ai/subtitle-translate.js")>(
    "../../extension/ai/subtitle-translate.js"
  );
  return {
    ...actual,
    resolveSubtitleTranslateProtocolMode: (input: Parameters<typeof actual.resolveSubtitleTranslateProtocolMode>[0]) => {
      translator.protocolInputs.push({
        selectedSubtitleId: input.selectedSubtitleId,
        origin: input.origin,
        kind: input.kind,
        source: input.source
      });
      return actual.resolveSubtitleTranslateProtocolMode(input);
    },
    translateSubtitleTrack: async ({
      items,
      targetLang,
      origin,
      kind,
      source
    }: {
      items: Array<{ from: number; to: number; content: string }>;
      targetLang: string;
      origin?: string;
      kind?: string;
      source?: string;
    }) => {
      const start = Math.floor((items[0]?.from || 0) / 60) * 60;
      translator.calls.push({ count: items.length, targetLang, startSec: start, origin, kind, source });
      if (translator.failStarts.has(start)) {
        throw new Error("平台 429");
      }
      return {
        mode: "boundary-v3" as const,
        items,
        translations: items.map((item) => ({ ...item, content: `[${targetLang}] ${item.content}` }))
      };
    }
  };
});

const BODY = [
  { from: 0, to: 3, content: "第一句" },
  { from: 3, to: 6, content: "第二句" },
  { from: 65, to: 70, content: "第三句" }
];

type Module = typeof import("../../extension/subtitle/asr-translation.js");

let module: Module;
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let cache: typeof import("../../extension/subtitle/cache.js");

function seedClip(body = BODY) {
  clipState.setBvid("BV1test000000");
  clipState.setCid("100");
  clipState.setFetchRunId(5);
  clipState.setSubtitles([
    { id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）", subtitleUrl: "" }
  ] as never);
  clipState.setSubtitleBody(body as never);
}

function cacheKeyFor(lang: string): string {
  return cache.getSubtitleCacheKey({
    bvid: "BV1test000000",
    cid: "100",
    identity: { kind: "translated", targetLang: lang }
  });
}

beforeEach(async () => {
  resetModuleState();
  translator.calls = [];
  translator.protocolInputs = [];
  translator.failStarts = new Set();
  translator.gate = null;
  module = await import("../../extension/subtitle/asr-translation.js");
  cache = await import("../../extension/subtitle/cache.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  state.setSettings({ ...DEFAULT_SETTINGS });
  seedClip();
});

describe("分片与覆盖", () => {
  it("缓存全命中：零请求，直接把缓存写进副轨槽", async () => {
    const cached = BODY.map((item) => ({ ...item, content: `[en] ${item.content}` }));
    await cache.saveSubtitleToCache(cacheKeyFor("en"), cached);

    const result = await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "en" });

    expect(translator.calls).toHaveLength(0);
    expect(result).toEqual({ kind: "done", total: 2, done: 2, failed: 0 });
    expect(clipState.secondarySubtitle.state).toBe("ready");
    expect(clipState.secondarySubtitle.id).toBe("translate-en");
    expect(clipState.secondarySubtitle.body).toEqual(cached);
  });

  it("cache-only 缺片：只回报 pending，不发请求、不动副轨槽", async () => {
    const result = await module.ensureAsrSecondarySubtitle({ mode: "cache-only", targetLang: "en" });

    expect(result).toEqual({ kind: "pending", total: 2, done: 0, failed: 0 });
    expect(translator.calls).toHaveLength(0);
    expect(clipState.secondarySubtitle.state).toBe("idle");
  });

  it("只补缓存没覆盖的分片（按 60 秒窗口，两片各翻一次）", async () => {
    await cache.saveSubtitleToCache(cacheKeyFor("en"), BODY.slice(0, 2).map((item) => ({ ...item })));

    const result = await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "en" });

    expect(translator.calls).toHaveLength(1);
    expect(translator.calls[0]).toMatchObject({ count: 1, targetLang: "en" });
    expect(result).toEqual({ kind: "done", total: 2, done: 2, failed: 0 });
  });

  it("同样内容与目标语言：第二遍走缓存，不再请求（重复打开视频不重复付费）", async () => {
    await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "en" });
    const callsAfterFirst = translator.calls.length;
    clipState.clearSecondarySubtitle();

    await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "en" });
    expect(translator.calls).toHaveLength(callsAfterFirst);
    expect(clipState.secondarySubtitle.state).toBe("ready");
  });
});

describe("写入与落盘", () => {
  it("每片翻完即合入副轨槽，且整份落盘（中断可续跑）", async () => {
    await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "en" });

    const slot = clipState.secondarySubtitle;
    expect(slot.state).toBe("ready");
    expect(slot.body.map((item) => item.content)).toEqual([
      "[en] 第一句",
      "[en] 第二句",
      "[en] 第三句"
    ]);
    const cached = (await cache.loadSubtitleFromCache(cacheKeyFor("en"))) as Array<{ content: string }>;
    expect(cached).toHaveLength(3);
  });

  it("换目标语言各写各的缓存键（切回秒开、互不覆盖）", async () => {
    await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "en" });
    await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "ja" });

    const en = (await cache.loadSubtitleFromCache(cacheKeyFor("en"))) as Array<{ content: string }>;
    const ja = (await cache.loadSubtitleFromCache(cacheKeyFor("ja"))) as Array<{ content: string }>;
    expect(en[0].content).toContain("[en]");
    expect(ja[0].content).toContain("[ja]");
  });
});

describe("片级容错与终态", () => {
  it("单片失败：其余照翻，槽保持 ready，failed 计数上报", async () => {
    translator.failStarts = new Set([60]);

    const progress: Array<{ done: number; failed: number }> = [];
    const result = await module.ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: "en",
      onProgress: (next) => progress.push({ done: next.done, failed: next.failed })
    });

    expect(result).toEqual({ kind: "done", total: 2, done: 1, failed: 1 });
    expect(clipState.secondarySubtitle.state).toBe("ready");
    expect(clipState.secondarySubtitle.body).toHaveLength(2);
    expect(progress.at(-1)).toEqual({ done: 1, failed: 1 });
  });

  it("零产出：落副轨槽 error（副行出「译文加载失败」，重试入口在副列）", async () => {
    translator.failStarts = new Set([0, 60]);

    const result = await module.ensureAsrSecondarySubtitle({ mode: "translate", targetLang: "en" });

    expect(result).toEqual({ kind: "done", total: 2, done: 0, failed: 2 });
    expect(clipState.secondarySubtitle.state).toBe("error");
  });

  it("代次已被推进：整轮让位，不写副轨槽", async () => {
    clipState.setFetchRunId(6);

    const result = await module.ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: "en",
      runId: 5
    });

    expect(result.kind).toBe("aborted");
    expect(clipState.secondarySubtitle.state).toBe("idle");
    expect(translator.calls).toHaveLength(0);
  });

  it("目标语言已改选：整轮让位（旧一轮不再写槽）", async () => {
    const result = await module.ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: "en",
      isStale: () => true
    });

    expect(result.kind).toBe("aborted");
    expect(translator.calls).toHaveLength(0);
    expect(clipState.secondarySubtitle.state).toBe("idle");
  });

  it("signal 已中止：同样让位", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await module.ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: "en",
      signal: controller.signal
    });

    expect(result.kind).toBe("aborted");
    expect(translator.calls).toHaveLength(0);
  });
});

describe("YouTube 轨道元数据透传与站点感知调度", () => {
  it("youtube-auto 轨将 origin/kind/source 透传至协议路由与分块翻译，并按 YouTube readingVideoEl 播放位置优先调度", async () => {
    clipState.setSite("youtube");
    clipState.setBvid("ytAutoFix01");
    clipState.setCid("yt");
    clipState.setFetchRunId(9);
    clipState.setSubtitles([
      {
        id: "custom-yt-track",
        lan: "en",
        lanDoc: "English (auto)",
        subtitleUrl: "https://www.youtube.com/api/timedtext?v=ytAutoFix01",
        origin: "youtube",
        kind: "asr",
        source: "youtube-auto"
      }
    ] as never);
    clipState.setSelectedSubtitleId("custom-yt-track");
    clipState.setSelectedSubtitleUrl("https://www.youtube.com/api/timedtext?v=ytAutoFix01");
    clipState.setSelectedSubtitleLang("English");
    clipState.setSubtitleBody([
      { from: 2, to: 5, content: "First sentence." },
      { from: 125, to: 130, content: "Later sentence." }
    ] as never);
    state.reader.readingVideoEl = {
      isConnected: true,
      currentTime: 126,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as HTMLVideoElement;

    const result = await module.ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: "zh",
      runId: 9
    });

    expect(result).toEqual({ kind: "done", total: 2, done: 2, failed: 0 });
    expect(translator.protocolInputs).toEqual([
      {
        selectedSubtitleId: "custom-yt-track",
        origin: "youtube",
        kind: "asr",
        source: "youtube-auto"
      }
    ]);
    expect(translator.calls[0]).toMatchObject({
      startSec: 120,
      origin: "youtube",
      kind: "asr",
      source: "youtube-auto"
    });
    expect(translator.calls[1]).toMatchObject({
      startSec: 0,
      origin: "youtube",
      kind: "asr",
      source: "youtube-auto"
    });
  });
});
