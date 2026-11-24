// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { state, clipState, transitionReaderShell } from "../../extension/core/state.js";
import type { NoSubtitleReason, SubtitleBodyItem } from "../../extension/core/state.js";
import {
  acceptSubtitle,
  commitNoSubtitle,
  configureCommitUi,
  buildNoSubtitleStatusMessage
} from "../../extension/subtitle/commit.js";
import {
  STATUS_LINE_BASE,
  getAsrFailureNotice
} from "../../extension/core/asr-failure-notice.js";
import { refreshHotComments, refreshDerivedContent } from "../../extension/subtitle/core.js";
import { saveSegmentedSubtitleTrack } from "../../extension/subtitle/cache.js";
import { notifyReaderPresenter } from "../../extension/reader/reader-bus.js";
import { getSubtitleStatusPhase } from "../../extension/shared/subtitle-status-bus.js";
import { registerDebugGate } from "../../extension/shared/logging.js";

vi.mock("../../extension/subtitle/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/core.js")>();
  return {
    ...actual,
    refreshHotComments: vi.fn(async () => {}),
    refreshDerivedContent: vi.fn(async () => {})
  };
});
vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/cache.js")>();
  return {
    ...actual,
    saveSegmentedSubtitleTrack: vi.fn(actual.saveSegmentedSubtitleTrack)
  };
});
vi.mock("../../extension/reader/reader-bus.js", () => ({
  notifyReaderPresenter: vi.fn(),
  subscribeSubtitleRefresh: vi.fn(() => () => {}),
  subscribeReaderPresenter: vi.fn(() => () => {})
}));

const UNSORTED_BODY = [
  { from: 3, to: 290, content: "c-最后" },
  { from: 0, to: 1.2, content: "a-第一" },
  { from: 1.5, to: 2.4, content: "b-第二" },
  { from: 0, to: 0.5, content: "a2-同from稳定" }
];

const ALL_REASONS: NoSubtitleReason[] = [
  "upower-exclusive",
  "bili-login-required",
  "no-asr-config",
  "asr-disabled",
  "asr-auth",
  "asr-quota",
  "asr-ratelimit",
  "asr-network",
  "asr-media",
  "asr-server",
  "asr-unknown",
  "asr-empty"
];

function expectStrictlySortedByFrom(body: SubtitleBodyItem[]) {
  for (let i = 1; i < body.length; i += 1) {
    expect(Number(body[i].from)).toBeGreaterThanOrEqual(Number(body[i - 1].from));
  }
}

let commitUiMocks;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";

  commitUiMocks = {
    setStatus: vi.fn()
  };
  configureCommitUi(commitUiMocks);

  transitionReaderShell("closed");
  vi.mocked(refreshHotComments).mockClear();
  vi.mocked(refreshDerivedContent).mockClear();
  vi.mocked(notifyReaderPresenter).mockClear();
});

describe("acceptSubtitle：字幕接受事务", () => {
  it("乱序输入 → subtitleBody 严格 from 升序（同 from 保持原相对顺序），返回排序副本且不改入参", async () => {
    const result = await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });

    const body = state.clip.subtitleBody;
    expectStrictlySortedByFrom(body);
    expect(body.map((item) => item.content)).toEqual(["a-第一", "a2-同from稳定", "b-第二", "c-最后"]);
    expect(result).toEqual(body);
    expect(UNSORTED_BODY.map((item) => item.content)).toEqual(["c-最后", "a-第一", "b-第二", "a2-同from稳定"]);
  });

  it("写齐 selected 三项 + fetchState=ready + 清除陈旧 noSubtitleReason 与 detail", async () => {
    clipState.setSelectedSubtitleId("stale");
    clipState.setSubtitleBody([{ from: 9, to: 10, content: "旧字幕" }]);
    clipState.setSubtitleFetchState("empty");
    clipState.setNoSubtitleReason("asr-auth");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 401: invalid token）");

    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-2",
      selectedSubtitleUrl: "https://example.com/sub2.json",
      selectedSubtitleLang: "英语"
    });

    expect(state.clip.selectedSubtitleId).toBe("track-2");
    expect(state.clip.selectedSubtitleUrl).toBe("https://example.com/sub2.json");
    expect(state.clip.selectedSubtitleLang).toBe("英语");
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("await 热评拉取：refreshHotComments 恰好在 state 落位后被调用一次，且不触发派生三件套构建", async () => {
    let stateAtRefresh = null;
    vi.mocked(refreshHotComments).mockImplementation(async () => {
      stateAtRefresh = {
        body: state.clip.subtitleBody.map((item) => item.content),
        fetchState: state.clip.subtitleFetchState,
        reason: clipState.noSubtitleReason
      };
    });

    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });

    expect(refreshHotComments).toHaveBeenCalledTimes(1);
    expect(refreshDerivedContent).not.toHaveBeenCalled();
    expect(stateAtRefresh).toEqual({
      body: ["a-第一", "a2-同from稳定", "b-第二", "c-最后"],
      fetchState: "ready",
      reason: null
    });
  });

  it("通知发射无条件（视图门控裁决权归 reader 侧）：reader 关闭也通知 subtitle-ready", async () => {
    transitionReaderShell("closed");
    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });

    transitionReaderShell("open");
    vi.mocked(notifyReaderPresenter).mockClear();
    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });
  });

  it("幂等：已有序 body 再次接受，内容与顺序不变", async () => {
    const sorted = [...UNSORTED_BODY].sort((a, b) => a.from - b.from);
    await acceptSubtitle({
      body: sorted,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    const first = state.clip.subtitleBody;

    await acceptSubtitle({
      body: first,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });

    expect(state.clip.subtitleBody).toEqual(first);
    expectStrictlySortedByFrom(state.clip.subtitleBody);
  });

  it("发布同相位进状态总线：接受后当前相位为 subtitle-ready（chat 发送闸据此 kick）", async () => {
    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });

    expect(getSubtitleStatusPhase()).toBe("subtitle-ready");
  });

  it("saveSegmentedSubtitleTrack 返回 { ok: false } 或抛错时记录 logWarn 且不阻断字幕交付", async () => {
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      clipState.setBvid("BV1commit01");
      clipState.setCid("101");

      const okFalseError = new Error("idb quota exceeded");
      vi.mocked(saveSegmentedSubtitleTrack).mockResolvedValueOnce({
        ok: false,
        error: okFalseError as never
      });

      const res1 = await acceptSubtitle({
        body: [
          { from: 0, to: 1, content: "第一句" },
          { from: 1.1, to: 2.2, content: "第二句" }
        ],
        selectedSubtitleId: "asr",
        selectedSubtitleUrl: "",
        selectedSubtitleLang: "中文"
      });

      expect(res1?.length).toBeGreaterThan(0);
      expect(state.clip.subtitleBody).toEqual(res1);
      expect(state.clip.subtitleFetchState).toBe("ready");
      expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] failed to save segmented subtitle track",
        expect.objectContaining({
          bvid: "BV1commit01",
          cid: "101",
          error: okFalseError
        })
      );

      warnSpy.mockClear();
      vi.mocked(notifyReaderPresenter).mockClear();

      const thrownError = new Error("rpc disconnected");
      vi.mocked(saveSegmentedSubtitleTrack).mockRejectedValueOnce(thrownError);

      const res2 = await acceptSubtitle({
        body: [
          { from: 0, to: 1, content: "第三句" },
          { from: 1.1, to: 2.2, content: "第四句" }
        ],
        selectedSubtitleId: "asr",
        selectedSubtitleUrl: "",
        selectedSubtitleLang: "中文"
      });

      expect(res2?.length).toBeGreaterThan(0);
      expect(state.clip.subtitleBody).toEqual(res2);
      expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] failed to save segmented subtitle track",
        expect.objectContaining({
          bvid: "BV1commit01",
          cid: "101",
          error: thrownError
        })
      );
    } finally {
      warnSpy.mockRestore();
      registerDebugGate(() => false);
    }
  });
});

describe("commitNoSubtitle：无字幕出口（逆事务）", () => {
  it("清空完整性：selected 三项/body/派生内容全清，fetchState=empty，subtitle-ready 通知触发", async () => {
    clipState.setSelectedSubtitleId("track-1");
    clipState.setSelectedSubtitleUrl("https://example.com/sub.json");
    clipState.setSelectedSubtitleLang("中文");
    clipState.setSubtitleBody(UNSORTED_BODY);
    clipState.setSubtitleFetchState("ready");
    clipState.setHotComments([{ uname: "测试用户", message: "热评", like: 1 }]);
    clipState.setMarkdown("# 笔记");
    clipState.setSrt("1\n00:00:00,000 --> 00:00:01,000 你好");
    clipState.setTxt("你好");
    clipState.setNoSubtitleReason("asr-empty");

    transitionReaderShell("open");
    await commitNoSubtitle({});

    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.selectedSubtitleLang).toBe("");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.hotComments).toEqual([]);
    expect(state.clip.markdown).toBe("");
    expect(state.clip.srt).toBe("");
    expect(state.clip.txt).toBe("");
    expect(clipState.noSubtitleReason).toBe("asr-empty");
    expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });
  });

  it("noSubtitleReason：显式传参写入（含 null 清空），undefined 保留现有值", async () => {
    clipState.setNoSubtitleReason("asr-auth");
    await commitNoSubtitle({ noSubtitleReason: "asr-auth" });
    expect(clipState.noSubtitleReason).toBe("asr-auth");

    clipState.setNoSubtitleReason("no-asr-config");
    await commitNoSubtitle({ noSubtitleReason: null });
    expect(clipState.noSubtitleReason).toBe(null);
  });

  it("通知发射无条件（同接受事务）：reader 关闭也通知", async () => {
    clipState.setNoSubtitleReason("asr-empty");
    transitionReaderShell("closed");
    await commitNoSubtitle({});
    expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });

    transitionReaderShell("open");
    vi.mocked(notifyReaderPresenter).mockClear();
    await commitNoSubtitle({});
    expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });
  });

  it("状态栏无条件落同一句（skip 与失败不再分叉）：reader 同步通知", async () => {
    const commitUi = { setStatus: vi.fn() };
    configureCommitUi(commitUi);

    for (const reason of ALL_REASONS) {
      commitUi.setStatus.mockClear();
      vi.mocked(notifyReaderPresenter).mockClear();
      clipState.setNoSubtitleReason(reason);

      await commitNoSubtitle({});

      const message = buildNoSubtitleStatusMessage();
      expect(commitUi.setStatus).toHaveBeenCalledTimes(1);
      expect(commitUi.setStatus).toHaveBeenCalledWith(message);
      expect(notifyReaderPresenter).toHaveBeenCalledWith({ kind: "subtitle-ready" });
    }
  });
});

describe("接受 ↔ 无字幕出口 互逆", () => {
  it("接受 → 出口 → 全空；出口 → 接受 → ready 且派生被再次刷新", async () => {
    const acceptArgs = {
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    };

    await acceptSubtitle(acceptArgs);
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(refreshHotComments).toHaveBeenCalledTimes(1);

    await commitNoSubtitle({});
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.markdown).toBe("");

    await acceptSubtitle(acceptArgs);
    expect(state.clip.subtitleFetchState).toBe("ready");
    expectStrictlySortedByFrom(state.clip.subtitleBody);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(refreshHotComments).toHaveBeenCalledTimes(2);
  });
});

describe("buildNoSubtitleStatusMessage（失败文案的唯一出口）", () => {
  it("任何 reason（含 asr-empty 与 null）的文案都含基础句", () => {
    for (const reason of [...ALL_REASONS, null] as NoSubtitleReason[]) {
      clipState.setNoSubtitleReason(reason);
      expect(buildNoSubtitleStatusMessage()).toContain(STATUS_LINE_BASE);
    }
    expect(buildNoSubtitleStatusMessage()).toContain(STATUS_LINE_BASE);
  });

  it("逐类文案 = 基础句 + 病因 + 补救（与文案表单源逐字一致）", () => {
    const cases: Array<[NoSubtitleReason, string]> = [
      [
        "upower-exclusive",
        "当前视频无字幕。 该视频为充电专属视频，未开通充电无法获取完整音轨。 开通充电后可重新抓取生成字幕"
      ],
      [
        "bili-login-required",
        "当前视频无字幕。 未登录 B 站，无法获取视频自带字幕。 请登录 B 站后重新抓取"
      ],
      [
        "no-asr-config",
        "当前视频无字幕。 语音识别平台不可用：未配置平台、域名未授权，或这个模型不存在。 请到设置页检查语音转写平台"
      ],
      ["asr-disabled", "当前视频无字幕。 语音转写开关已关闭。 可在设置页开启「无字幕时自动生成字幕」后再试"],
      [
        "asr-auth",
        "当前视频无字幕。 语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。 请到设置页检查或更换 API Key"
      ],
      ["asr-quota", "当前视频无字幕。 语音识别平台的额度或余额不足。 请到平台充值，或稍后重试"],
      ["asr-ratelimit", "当前视频无字幕。 请求过于频繁，已被语音识别平台限流。 请稍后重试"],
      ["asr-network", "当前视频无字幕。 无法连接语音识别平台（网络不通或请求超时）。 请检查网络后重新抓取"],
      [
        "asr-media",
        "当前视频无字幕。 这个视频的音轨下载或解码失败（可能受保护，或文件过大）。 可换一个视频，或稍后重新抓取"
      ],
      ["asr-server", "当前视频无字幕。 语音识别平台暂时不可用（服务端错误）。 请稍后重新抓取"],
      ["asr-unknown", "当前视频无字幕。 语音识别失败，未能识别具体原因。 可重新抓取或稍后重试"],
      ["asr-empty", "当前视频无字幕。 未识别到语音内容，这个视频可能没有人声。"],
      [null, "当前视频无字幕。 可在设置页配置语音识别平台自动生成字幕。"]
    ];

    for (const [reason, expected] of cases) {
      clipState.setNoSubtitleReason(reason);
      expect(buildNoSubtitleStatusMessage()).toBe(expected);
    }
  });

  it("详情行随 noSubtitleDetail 追加（事务侧读 state，不自己格式化）", () => {
    clipState.setNoSubtitleReason("asr-auth");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 401: {\"message\":\"Invalid token\"}）");
    expect(buildNoSubtitleStatusMessage()).toBe(
      `当前视频无字幕。 语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。 请到设置页检查或更换 API Key （错误详情：HTTP 401: {"message":"Invalid token"}）`
    );

    clipState.setNoSubtitleDetail("");
    expect(buildNoSubtitleStatusMessage()).toBe(
      "当前视频无字幕。 语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。 请到设置页检查或更换 API Key"
    );
    expect(buildNoSubtitleStatusMessage()).not.toMatch(/\s$/);
  });

  it("显式 base / reason / detailLine 参数覆盖（缺省读 clipState）", () => {
    clipState.setNoSubtitleReason("no-asr-config");
    expect(buildNoSubtitleStatusMessage("这个视频没有字幕。")).toBe(
      "这个视频没有字幕。 语音识别平台不可用：未配置平台、域名未授权，或这个模型不存在。 请到设置页检查语音转写平台"
    );
    expect(buildNoSubtitleStatusMessage(STATUS_LINE_BASE, "asr-empty")).toBe(
      "当前视频无字幕。 未识别到语音内容，这个视频可能没有人声。"
    );
    expect(buildNoSubtitleStatusMessage(STATUS_LINE_BASE, "asr-auth", "（错误详情：HTTP 403）")).toBe(
      "当前视频无字幕。 语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。 请到设置页检查或更换 API Key （错误详情：HTTP 403）"
    );
  });

  it("与 single source 组合一致：文案 = 基础句 + cause + remedyText + detail", () => {
    clipState.setNoSubtitleReason("asr-quota");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 402）");
    const notice = getAsrFailureNotice("asr-quota");
    expect(buildNoSubtitleStatusMessage()).toBe(
      [STATUS_LINE_BASE, notice.cause, notice.remedyText, clipState.noSubtitleDetail].filter(Boolean).join(" ")
    );
  });
});

describe("未接线防护", () => {
  it("configureCommitUi 未注入时 commitNoSubtitle 拒绝执行（防静默丢渲染）", async () => {
    vi.resetModules();
    const freshCommit = await import("../../extension/subtitle/commit.js");
    const freshState = await import("../../extension/core/state.js");

    await expect(freshCommit.commitNoSubtitle({})).rejects.toThrow("configureCommitUi");
    expect(freshState.clipState.subtitleFetchState).toBe("idle");
  });
});
