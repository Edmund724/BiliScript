// 伪轨视频的译文副轨（reader/asr-translation.ts）：场景判据、视图模型、启动/中止/
// 换语言，以及跨上下文的目标语言收敛。
//
// 这个模块是面板那边唯一的同步读口：字幕工具条每次重渲都要读「在飞、进度、要不要
// 用户点一下」，所以它不许在投影里发起装载；真正的分片调度在链层
//（subtitle/asr-translation），本套件只 mock 那条懒装载链。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   a. 判据退化成「可装载轨 < 2」：有 CC 但只有一条轨的视频被拖进译文场景；
//   b. 主轨未就绪时点「开始生成译文」丢掉意图：转写完成后什么都不发生；
//   c. 在飞不设门：连点两次开关把整片翻译跑两遍（双倍账单）；
//   d. 换视频不收场：旧视频的译文进度落到新视频的列上；
//   e. 中止只停显示、不 abort：关开关后还在烧 token；
//   f. 换目标语言不清副轨槽：英文译文挂在中文目标下面。

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

const lazy = vi.hoisted(() => ({
  // 每次链层调用的参数快照（mode / targetLang / runId / signal）
  calls: [] as Array<{
    mode: string;
    targetLang: string;
    runId: number;
    signal: AbortSignal;
    onProgress: (progress: { total: number; done: number; failed: number }) => void;
  }>,
  // pending = 缺片；pend = 停在飞；reject = 链层抛错；done = 全片有译文
  mode: "done" as "done" | "pending" | "pend" | "reject",
  // 链层回报的失败分片数（面板「补齐失败的 N 片」的唯一来源）
  failed: 0,
  // pend 模式的放行闸（按次登记：改选语言会让两轮同时在飞，单槽会把先卡住那轮吊死）
  gates: [] as Array<() => void>
}));

const CHAIN_PROGRESS = { total: 4, done: 2, failed: 0 };

vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({
    ensureAsrTranslation: async (args: (typeof lazy.calls)[number]) => {
      lazy.calls.push(args);
      args.onProgress?.({ total: CHAIN_PROGRESS.total, done: CHAIN_PROGRESS.done, failed: lazy.failed });
      if (lazy.mode === "pend") {
        await new Promise<void>((resolve) => {
          lazy.gates.push(resolve);
        });
      }
      if (lazy.mode === "reject") {
        throw new Error("翻译平台失败");
      }
      return {
        kind: lazy.mode === "pending" ? "pending" : "done",
        total: CHAIN_PROGRESS.total,
        done: CHAIN_PROGRESS.done,
        failed: 0
      };
    }
  }))
}));

const ASR_TRACK = {
  id: "asr",
  lan: "asr-zh",
  lanDoc: "自配平台转写（中文）",
  subtitleUrl: "",
  source: "asr"
};
const REAL_TRACK = {
  id: "t-zh",
  lan: "zh-CN",
  lanDoc: "中文",
  subtitleUrl: "https://sub/zh.json",
  source: "player"
};

const BODY = [
  { from: 0, to: 3, content: "第一句" },
  { from: 3, to: 6, content: "第二句" }
];

type Module = typeof import("../../extension/reader/asr-translation.js");

let module: Module;
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];

function seedAsrClip(tracks: unknown[] = [ASR_TRACK], body = BODY) {
  clipState.setSubtitles(tracks as never);
  clipState.setSubtitleBody(body as never);
  clipState.setSelectedSubtitleId("asr");
  clipState.setFetchRunId(7);
}

beforeEach(async () => {
  resetModuleState();
  module = await import("../../extension/reader/asr-translation.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  lazy.calls = [];
  lazy.mode = "done";
  lazy.failed = 0;
  lazy.gates = [];
  state.setSettings({ ...DEFAULT_SETTINGS });
});

afterEach(() => {
  state.setSettings({ ...DEFAULT_SETTINGS });
});

describe("判据（伪轨身份，不按轨数）", () => {
  it("伪轨（id=asr、url 空）命中；单条真轨不命中", () => {
    expect(module.hasAsrPseudoTrack([ASR_TRACK])).toBe(true);
    expect(module.hasAsrPseudoTrack([REAL_TRACK])).toBe(false);
    expect(module.hasAsrPseudoTrack([])).toBe(false);
  });
});

describe("ensureAsrTranslation（装载入口）", () => {
  it("非伪轨视频：skipped，链层一次都不装载", async () => {
    seedAsrClip([REAL_TRACK]);

    await expect(module.ensureAsrTranslation("translate")).resolves.toEqual({ kind: "skipped" });
    expect(lazy.calls).toHaveLength(0);
  });

  it("cache-only 缺片 ⇒ pending（不自动花钱）", async () => {
    seedAsrClip();
    lazy.mode = "pending";

    await expect(module.ensureAsrTranslation("cache-only")).resolves.toEqual({ kind: "pending" });
    expect(lazy.calls).toHaveLength(1);
    expect(lazy.calls[0].mode).toBe("cache-only");
  });

  it("translate 用当前目标语言与抓取代次，signal 交给链层", async () => {
    seedAsrClip();
    state.setSettings({ ...DEFAULT_SETTINGS, liveInterpretTargetLang: "ja" });

    await module.ensureAsrTranslation("translate");
    expect(lazy.calls[0].targetLang).toBe("ja");
    expect(lazy.calls[0].runId).toBe(7);
    expect(lazy.calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("主轨未就绪时点开始：记住意图，主轨到站后由自动入口兑现（b）", async () => {
    clipState.setSubtitles([ASR_TRACK] as never);
    clipState.setSubtitleBody([] as never);
    clipState.setFetchRunId(7);

    expect(await module.ensureAsrTranslation("translate")).toEqual({ kind: "skipped" });
    expect(lazy.calls).toHaveLength(0);

    // 转写完成：字幕体到站，接着的自动挂载（cache-only 调用）必须升级成 translate
    clipState.setSubtitleBody(BODY as never);
    await module.ensureAsrTranslation("cache-only");
    expect(lazy.calls).toHaveLength(1);
    expect(lazy.calls[0].mode).toBe("translate");
  });

  it("在飞不重入（c）：第二次调用 skipped，链层只跑一次", async () => {
    seedAsrClip();
    lazy.mode = "pend";

    const first = module.ensureAsrTranslation("translate");
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));
    await expect(module.ensureAsrTranslation("translate")).resolves.toEqual({ kind: "skipped" });
    expect(module.resolveAsrTranslationView().inFlight).toBe(true);

    lazy.gates.splice(0).forEach((release) => release());
    await first;
    expect(module.resolveAsrTranslationView().inFlight).toBe(false);
  });

  it("链层抛错不外抛：吞成 skipped（面板不崩）", async () => {
    seedAsrClip();
    lazy.mode = "reject";

    await expect(module.ensureAsrTranslation("translate")).resolves.toEqual({ kind: "skipped" });
  });
});

describe("视图模型（列投影的同步读口）", () => {
  it("主轨就绪、槽 idle ⇒ 出「开始生成译文」", () => {
    seedAsrClip();
    state.setSettings({ ...DEFAULT_SETTINGS, liveInterpretTargetLang: "en" });

    expect(module.resolveAsrTranslationView()).toEqual({
      lang: "en",
      inFlight: false,
      note: "",
      action: { label: "开始生成译文", kind: "start" }
    });
  });

  it("主轨还没到（转写中）⇒ 不摆一个现在点不动的按钮", () => {
    clipState.setSubtitles([ASR_TRACK] as never);
    clipState.setSubtitleBody([] as never);

    expect(module.resolveAsrTranslationView().action).toBeNull();
  });

  it("在飞 ⇒ 进度进说明行、按钮收起", async () => {
    seedAsrClip();
    lazy.mode = "pend";

    const run = module.ensureAsrTranslation("translate");
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));

    expect(module.resolveAsrTranslationView()).toEqual({
      lang: "zh",
      inFlight: true,
      note: "正在生成译文 2/4 片",
      action: null
    });

    lazy.gates.splice(0).forEach((release) => release());
    await run;
  });

  it("槽 error ⇒ 「重试」", () => {
    seedAsrClip();
    clipState.markSecondarySubtitleLoading({ id: "translate-zh", url: "" });
    clipState.markSecondarySubtitleError();

    expect(module.resolveAsrTranslationView().action).toEqual({ label: "重试", kind: "retry" });
  });

  it("部分分片失败（槽 ready + failed）⇒ 补齐按钮；failed=0 时不虚报", async () => {
    seedAsrClip();
    clipState.applySecondarySubtitle({
      id: "translate-zh",
      url: "",
      body: [{ from: 0, to: 3, content: "First" }] as never
    });

    await module.ensureAsrTranslation("cache-only");
    expect(module.resolveAsrTranslationView().action).toBeNull();

    lazy.failed = 1;
    const run = module.ensureAsrTranslation("translate");
    await run;
    expect(module.resolveAsrTranslationView()).toEqual({
      lang: "zh",
      inFlight: false,
      note: "译文已生成，部分分片失败",
      action: { label: "补齐失败的 1 片", kind: "fill" }
    });
  });
});

describe("中止与换语言", () => {
  it("cancelAsrTranslation abort 在飞 signal（e）", async () => {
    seedAsrClip();
    lazy.mode = "pend";

    const run = module.ensureAsrTranslation("translate");
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));
    module.cancelAsrTranslation();

    expect(lazy.calls[0].signal.aborted).toBe(true);
    expect(module.resolveAsrTranslationView().inFlight).toBe(false);
    lazy.gates.splice(0).forEach((release) => release());
    await run;
  });

  it("换目标语言：写偏好、清副轨槽、按新语言发起（f）", async () => {
    seedAsrClip();
    clipState.applySecondarySubtitle({
      id: "translate-en",
      url: "",
      body: [{ from: 0, to: 3, content: "First" }] as never
    });

    module.selectAsrTranslationLanguage("ja");

    expect(state.settings.liveInterpretTargetLang).toBe("ja");
    expect(clipState.secondarySubtitle.state).toBe("idle");
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));
    expect(lazy.calls[0].mode).toBe("translate");
    expect(lazy.calls[0].targetLang).toBe("ja");
  });

  it("在飞时改选语言：旧一轮 abort，新一轮按新语言发起", async () => {
    seedAsrClip();
    lazy.mode = "pend";
    const run = module.ensureAsrTranslation("translate");
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));

    module.selectAsrTranslationLanguage("ja");
    expect(lazy.calls[0].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(lazy.calls.length).toBeGreaterThanOrEqual(2));
    expect(lazy.calls[lazy.calls.length - 1].targetLang).toBe("ja");

    lazy.gates.splice(0).forEach((release) => release());
    await run;
  });

  it("词表外的值归一回默认（auto 不是译文语言）", () => {
    module.selectAsrTranslationLanguage("auto");
    expect(state.settings.liveInterpretTargetLang).toBe("zh");
  });
});

describe("换视频收场（d）", () => {
  it("bvid/cid 变了：进度清零、在飞中止", async () => {
    seedAsrClip();
    lazy.mode = "pend";
    const run = module.ensureAsrTranslation("translate");
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));

    clipState.setBvid("BV1another000");
    clipState.setCid("999");

    // 收场点是「下一次投影/装载」：换片的重渲会走到这里
    const view = module.resolveAsrTranslationView();
    expect(lazy.calls[0].signal.aborted).toBe(true);
    expect(view.inFlight).toBe(false);
    lazy.gates.splice(0).forEach((release) => release());
    await run;
  });
});
