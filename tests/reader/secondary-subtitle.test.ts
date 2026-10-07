// 副轨（双语字幕的第二路轨）的目标解析 + 装载事务（reader/secondary-subtitle.ts）。
//
// 这个模块是四个装载入口的唯一落点：reader/lifecycle 的主轨就绪自动装载、弹层开关
// 打开 / 跨上下文收敛、副列改选、副列重试。原先守卫与匹配散在两个调用点（lifecycle
// 的三重守卫、弹层的列投影 + startSecondaryLoad），本套件直接打新接口，不再经
// 「通知 → lifecycle」或「点击 → 弹层 DOM」两条远端路径才能覆盖到判定。
// 接线（通知确实会走到本模块、弹层确实把目标投影进 DOM）留在
// tests/reader/bilingual-autoload.test.ts 与 tests/reader/bilingual-picker.test.ts。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   a. 解析不再排除主轨：偏好指向主轨那一条时把**主轨**抓成副轨（列表出两份一样的正文，
//      而弹层副列同时写着「主副字幕相同」）；
//   b. 「没命中」与「命中的是主轨」两态混成一条：弹层 ②/③ 两套文案漂移；
//   c. 两级匹配退化成单级：混源视频（人工 en-US + AI ai-en）结果依赖轨序；
//   d. 槽语言按轨的 `lan` 算：轨 id 为空时缓存 source key 退到 lang 分量，自动装载与
//      弹层改选算出不同缓存键、写进槽的 lang 也不一致（本模块存在的理由之一）；
//   e. 守卫丢掉「槽非 idle 不动」：主轨每来一次 subtitle-ready 就重抓一遍副轨；
//   f. 显式目标（改选 / 重试）被槽守卫拦下：槽 ready/error 时用户再也换不了副轨；
//   g. 在飞登记漏清：弹层本列永久禁用（切轨路径踩过的同一个坑）；
//   h. 装载失败把异常抛给调用方：自动装载入口不 await 事务 ⇒ 未处理拒绝。
//
// mock 只有一条边界：总结链（subtitle/lazy.js）——它是网络入口，其余（state、模块本体）
// 全部走真实实现。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

const lazy = vi.hoisted(() => ({
  // 调用流水（元组顺序 = 形参顺序：url, lang, runId, subtitleId, forceRefresh）
  calls: [] as unknown[][],
  // ok = 立即返回；pend = 停在飞（在飞登记与弹层禁用的观察点）；reject = 模拟装载失败
  mode: "ok" as "ok" | "pend" | "reject",
  // pend 模式的放行闸：测试 resolve 它才落定（否则那条 promise 永远悬着）
  gate: null as null | (() => void)
}));

vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({
    loadSecondarySubtitle: async (url: string, lang: string, runId: number, id: string, forceRefresh: boolean) => {
      lazy.calls.push([url, lang, runId, id, forceRefresh]);
      if (lazy.mode === "pend") {
        await new Promise<void>((resolve) => {
          lazy.gate = resolve;
        });
        return;
      }
      if (lazy.mode === "reject") {
        throw new Error("副轨网络失败");
      }
    }
  }))
}));

type SecondaryModule = typeof import("../../extension/reader/secondary-subtitle.js");
type EnsureOutcome = ReturnType<SecondaryModule["ensureSecondarySubtitleLoaded"]>;

// started 分支的收窄读口（断言失败时给出原因，避免用例里堆 `kind === "started" &&`）
function started(outcome: EnsureOutcome) {
  if (outcome.kind !== "started") {
    throw new Error(`期望事务起步，实际 ${JSON.stringify(outcome)}`);
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
// 人工 CC 轨：lan 是 BCP-47（与偏好串同形），lanDoc 与 AI 轨不同——混源样本的第二条。
const CC_EN_TRACK = {
  id: "cc-en",
  lan: "en-US",
  lanDoc: "English (CC)",
  subtitleUrl: "https://sub/cc-en.json",
  source: "player-wbi-v2"
};

function setBilingual(on: boolean, lang = "en-US") {
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: on, secondarySubtitleLang: lang });
}

beforeEach(async () => {
  resetModuleState();
  module = await import("../../extension/reader/secondary-subtitle.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  lazy.calls = [];
  lazy.mode = "ok";
  lazy.gate = null;
  clipState.setFetchRunId(3);
});

afterEach(() => {
  state.setSettings({ ...DEFAULT_SETTINGS });
});

describe("resolveSecondaryTarget（目标解析：偏好 × 轨列 × 主轨身份）", () => {
  it("偏好为空 ⇒ no-preference（还没选过副轨，弹层出 ①）", () => {
    setBilingual(true, "");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    expect(module.resolveSecondaryTarget()).toEqual({ kind: "none", reason: "no-preference" });
  });

  it("精确 lan 命中优先：混源（人工 en-US + AI ai-en）不依赖轨序", () => {
    setBilingual(true, "en-US");
    // AI 轨排在前面：单级子标签匹配会先命中它 ⇒ 两级后必须仍选人工 CC 轨
    clipState.setSubtitles([ZH_TRACK, EN_TRACK, CC_EN_TRACK]);

    expect(module.resolveSecondaryTarget()).toEqual({
      kind: "target",
      target: { id: CC_EN_TRACK.id, url: CC_EN_TRACK.subtitleUrl, lang: CC_EN_TRACK.lanDoc }
    });
  });

  it("精确命中不了时退回主语言子标签（偏好 en-US 命中 ai-en）", () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    expect(module.resolveSecondaryTarget()).toEqual({
      kind: "target",
      target: { id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: EN_TRACK.lanDoc }
    });
  });

  it("槽语言统一 lanDoc || lan || unknown（轨 id 为空时它是缓存 source key 的分量）", () => {
    // 偏好路径：有 lan 才能被两级匹配命中 ⇒ 取 lanDoc
    setBilingual(true, "en-US");
    clipState.setSubtitles([{ id: "", lan: "ai-en", subtitleUrl: "https://sub/ai-en.json" }]);

    expect(module.resolveSecondaryTarget()).toEqual({
      kind: "target",
      target: { id: "", url: "https://sub/ai-en.json", lang: "ai-en" }
    });

    // 轨 lan 与 lanDoc 都没有（defensive 兜底）走显式轨身份路径：投影出 "unknown"
    clipState.setSubtitles([{ id: "", lan: "", subtitleUrl: "https://sub/x.json" }]);
    expect(module.resolveSecondaryTarget({ url: "https://sub/x.json" })).toEqual({
      kind: "target",
      target: { id: "", url: "https://sub/x.json", lang: "unknown" }
    });
  });

  it("目标命中主轨 ⇒ main-track（弹层出 ③，且不顺位退到同语言的另一条）", () => {
    setBilingual(true, "zh-CN");
    const CC_ZH = {
      id: "cc-zh",
      lan: "zh-CN",
      lanDoc: "中文（CC）",
      subtitleUrl: "https://sub/cc-zh.json",
      source: "player-wbi-v2"
    };
    clipState.setSubtitles([ZH_TRACK, CC_ZH, EN_TRACK]);
    clipState.setSelectedSubtitleId(CC_ZH.id);

    // 顺位退到 ai-zh 仍是两份中文 ⇒ 必须报 main-track（副列文案与装载守卫同一判据）
    expect(module.resolveSecondaryTarget()).toEqual({ kind: "none", reason: "main-track" });
  });

  it("对照：主轨是另一条同语言轨时照常给目标（排除按轨身份，不按语言）", () => {
    setBilingual(true, "ai-zh");
    const CC_ZH = {
      id: "cc-zh",
      lan: "zh-CN",
      lanDoc: "中文（CC）",
      subtitleUrl: "https://sub/cc-zh.json",
      source: "player-wbi-v2"
    };
    clipState.setSubtitles([ZH_TRACK, CC_ZH, EN_TRACK]);
    clipState.setSelectedSubtitleId(CC_ZH.id); // 主轨 = 人工 zh-CN，副轨目标 = ai-zh

    expect(module.resolveSecondaryTarget()).toEqual({
      kind: "target",
      target: { id: ZH_TRACK.id, url: ZH_TRACK.subtitleUrl, lang: ZH_TRACK.lanDoc }
    });
  });

  it("本视频没有该语言的真轨 ⇒ no-track（留空不猜）", () => {
    setBilingual(true, "ja-JP");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    expect(module.resolveSecondaryTarget()).toEqual({ kind: "none", reason: "no-track" });
  });

  it("ASR 伪轨（subtitleUrl 为空）不进候选 ⇒ no-track", () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([{ id: "asr", lan: "en-US", lanDoc: "English", subtitleUrl: "" }]);

    expect(module.resolveSecondaryTarget()).toEqual({ kind: "none", reason: "no-track" });
  });

  it("显式轨身份（副列改选）：按 id 辨认并统一投影 lang，不看偏好", () => {
    setBilingual(true, "ja-JP"); // 偏好指向别的语言：改选必须按用户点的那条走
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    expect(module.resolveSecondaryTarget({ id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: EN_TRACK.lan })).toEqual({
      kind: "target",
      target: { id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: EN_TRACK.lanDoc }
    });
  });

  it("显式轨身份命中主轨 ⇒ main-track（弹层的 Q8 防呆在事务层再兜一道）", () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);
    clipState.setSelectedSubtitleId(EN_TRACK.id);

    expect(module.resolveSecondaryTarget({ id: EN_TRACK.id, url: EN_TRACK.subtitleUrl })).toEqual({
      kind: "none",
      reason: "main-track"
    });
  });

  it("显式轨身份在轨列里辨认不出（轨列已被换掉）⇒ 沿用选项行自己的身份与 lang", () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK]);

    expect(module.resolveSecondaryTarget({ id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: "ai-en" })).toEqual({
      kind: "target",
      target: { id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: "ai-en" }
    });
    expect(module.resolveSecondaryTarget({ id: "", url: "" })).toEqual({ kind: "none", reason: "no-track" });
  });
});

describe("ensureSecondarySubtitleLoaded（装载事务：守卫 + 在飞登记 + 参数）", () => {
  it("双语关 ⇒ skipped(bilingual-off)，零装载", () => {
    setBilingual(false);
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    expect(module.ensureSecondarySubtitleLoaded()).toEqual({ kind: "skipped", reason: "bilingual-off" });
    expect(lazy.calls).toHaveLength(0);
  });

  it("槽非 idle（在飞 / 已就绪 / 已失败）⇒ skipped(slot-busy)，不重来", () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    clipState.markSecondarySubtitleLoading({ id: EN_TRACK.id, url: EN_TRACK.subtitleUrl });
    expect(module.ensureSecondarySubtitleLoaded()).toEqual({ kind: "skipped", reason: "slot-busy" });

    clipState.applySecondarySubtitle({ id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, body: [] });
    expect(module.ensureSecondarySubtitleLoaded()).toEqual({ kind: "skipped", reason: "slot-busy" });

    clipState.markSecondarySubtitleError();
    expect(module.ensureSecondarySubtitleLoaded()).toEqual({ kind: "skipped", reason: "slot-busy" });
    expect(lazy.calls).toHaveLength(0);
  });

  it("无目标（偏好没命中本视频轨列）⇒ skipped(no-track)，零装载", () => {
    setBilingual(true, "ja-JP");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    expect(module.ensureSecondarySubtitleLoaded()).toEqual({ kind: "skipped", reason: "no-track" });
    expect(lazy.calls).toHaveLength(0);
  });

  it("偏好为空 ⇒ skipped(no-preference)（没选过就不抓，等用户在副列选）", () => {
    setBilingual(true, "");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    expect(module.ensureSecondarySubtitleLoaded()).toEqual({ kind: "skipped", reason: "no-preference" });
    expect(lazy.calls).toHaveLength(0);
  });

  it("起步：started + 目标轨；链调用参数 = (url, lanDoc, runId, id, forceRefresh=false)", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    const outcome = started(module.ensureSecondarySubtitleLoaded());
    expect(outcome.target).toEqual({
      id: EN_TRACK.id,
      url: EN_TRACK.subtitleUrl,
      lang: EN_TRACK.lanDoc
    });
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));
    // runId 取链装载之后的 fetchRunId（事务门口的 runId 自检窗口与重构前一致）
    expect(lazy.calls[0]).toEqual([EN_TRACK.subtitleUrl, EN_TRACK.lanDoc, 3, EN_TRACK.id, false]);
  });

  it("显式目标（改选 / 重试）：槽 ready/error 也照装，forceRefresh 透传", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);
    clipState.markSecondarySubtitleError();

    const outcome = started(
      module.ensureSecondarySubtitleLoaded({
        target: { id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: EN_TRACK.lanDoc },
        forceRefresh: true
      })
    );

    expect(outcome.target.id).toBe(EN_TRACK.id);
    await vi.waitFor(() => expect(lazy.calls).toHaveLength(1));
    expect(lazy.calls[0]).toEqual([EN_TRACK.subtitleUrl, EN_TRACK.lanDoc, 3, EN_TRACK.id, true]);
  });

  it("在飞登记：起步即置位（弹层本列据此禁用），落定后清空", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);
    lazy.mode = "pend";

    const outcome = started(module.ensureSecondarySubtitleLoaded());
    await vi.waitFor(() => expect(lazy.gate).toBeTruthy());
    expect(module.isSecondarySubtitleLoadInFlight()).toBe(true);

    lazy.gate?.();
    await expect(outcome.settled).resolves.toEqual({ error: null });
    expect(module.isSecondarySubtitleLoadInFlight()).toBe(false);
  });

  it("在飞登记按枚计：两条重叠装载，先落定的那条不清掉另一条的在飞", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);
    lazy.mode = "pend";

    const auto = started(module.ensureSecondarySubtitleLoaded());
    await vi.waitFor(() => expect(lazy.gate).toBeTruthy());
    const releaseAuto = lazy.gate!;
    lazy.gate = null;
    const immediate = started(
      module.ensureSecondarySubtitleLoaded({
        target: { id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: EN_TRACK.lanDoc },
        forceRefresh: true
      })
    );
    await vi.waitFor(() => expect(lazy.gate).toBeTruthy());
    const releaseImmediate = lazy.gate!;

    releaseAuto();
    await expect(auto.settled).resolves.toEqual({ error: null });
    expect(module.isSecondarySubtitleLoadInFlight()).toBe(true); // 即时那条还在飞

    releaseImmediate();
    await expect(immediate.settled).resolves.toEqual({ error: null });
    expect(module.isSecondarySubtitleLoadInFlight()).toBe(false);
  });

  it("装载失败：事务自己吞异常（自动入口不 await，抛出即未处理拒绝），落定句柄报错", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);
    lazy.mode = "reject";

    const outcome = started(module.ensureSecondarySubtitleLoaded());
    await expect(outcome.settled).resolves.toEqual({ error: expect.any(Error) });
    expect(module.isSecondarySubtitleLoadInFlight()).toBe(false);
  });
});
