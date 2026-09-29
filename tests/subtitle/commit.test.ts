// subtitle/commit.js 字幕接受事务测试（CONTEXT.md「字幕接受」词条的契约锁）。
//
// 一段字幕成为当前视频生效字幕的唯一事务：稳定排序（from 升序，读路径
// findActiveSubtitleIndex 二分依赖）→ 写 state（selectedSubtitleId/Url/Lang +
// subtitleBody）→ fetchState="ready" → 清 noSubtitleReason/noSubtitleDetail →
// await refreshHotComments()（热评拉取；markdown/SRT/TXT 派生三件套自
// opt-backlog-2026-09/04 起改为首次消费时懒生成，落账不再触发）→ 通知
// "subtitle-ready"（发射无条件，视图过滤归 reader 侧）。本套件在纯
// state 级锁死这些不变量；无字幕出口（逆事务）与接受互为逆，同样锁清空完整性。
//
// 无字幕出口是**失败文案的唯一出口**（asr-error-reporting/07 Q1）：reader 通知
// 与状态栏吃同一句（buildNoSubtitleStatusMessage = 基础句 + core/asr-failure-notice
// 的病因/补救/详情行），不再有 asrResult 分叉。
//
// mock 结构：refreshHotComments / refreshDerivedContent mock（落账只拉热评、
// 不建派生的调用/时序断言是本套件职责，懒生成本体归 core 测试）、reader-bus
// mock（notifyReaderPresenter 可观察）。状态栏回调（setStatus）不静态可达，经
// configureCommitUi 注入 vi.fn——与生产由 fetcher 注入同一条接线。
// view-state / dom-utils / reader-ids / selection / state 保持真实：纯叶子。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { state, clipState } from "../../extension/core/state.js";
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
import { notifyReaderPresenter } from "../../extension/reader/reader-bus.js";

vi.mock("../../extension/subtitle/core.js", () => ({
  refreshHotComments: vi.fn(async () => {}),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/reader/reader-bus.js", () => ({
  notifyReaderPresenter: vi.fn(),
  subscribeSubtitleRefresh: vi.fn(() => () => {}),
  subscribeReaderPresenter: vi.fn(() => () => {})
}));

// 乱序字幕体（含同 from 条目验证稳定排序）：内容字段编码了期望顺序
const UNSORTED_BODY = [
  { from: 3, to: 290, content: "c-最后" },
  { from: 0, to: 1.2, content: "a-第一" },
  { from: 1.5, to: 2.4, content: "b-第二" },
  { from: 0, to: 0.5, content: "a2-同from稳定" }
];

// 票 04 的十个非 null 值（文案表按 reason 逐个断言，不许用一个循环糊过去：
// 循环会在文案表本身写错时仍然通过——那正是本票要防的漂移）。
const ALL_REASONS: NoSubtitleReason[] = [
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

  // 与生产一致：fetcher 在模块求值期注入的状态栏回调，这里注入 vi.fn
  commitUiMocks = {
    setStatus: vi.fn()
  };
  configureCommitUi(commitUiMocks);

  state.reader.setViewOpen(false);
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
    // 稳定排序：同 from=0 的两条保持输入中的相对顺序（a 先于 a2）
    expect(body.map((item) => item.content)).toEqual(["a-第一", "a2-同from稳定", "b-第二", "c-最后"]);
    // 返回值即落 state 的有序副本
    expect(result).toEqual(body);
    // 不原地修改入参（调用方持有的原引用——如缓存副本——保持不变）
    expect(UNSORTED_BODY.map((item) => item.content)).toEqual(["c-最后", "a-第一", "b-第二", "a2-同from稳定"]);
  });

  it("写齐 selected 三项 + fetchState=ready + 清除陈旧 noSubtitleReason 与 detail", async () => {
    // 预放脏状态：出口残留的 empty 态、失败原因与详情必须被接受事务一次性翻转
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
    // 详情与原因同生命周期：接受后不得留下旧失败的报文明细
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
    // 派生内容（笔记/SRT/TXT）自 opt-backlog-2026-09/04 起首次消费时才懒生成，
    // 落账路径零构建（refreshDerivedContent 是消费侧入口，落账不得触达）。
    expect(refreshDerivedContent).not.toHaveBeenCalled();
    // 热评拉取读到的是已接受完成的状态，不是半事务态
    expect(stateAtRefresh).toEqual({
      body: ["a-第一", "a2-同from稳定", "b-第二", "c-最后"],
      fetchState: "ready",
      reason: null
    });
  });

  it("通知发射无条件（视图门控裁决权归 reader 侧）：reader 关闭也通知 subtitle-ready", async () => {
    // 视图未开时截断通知会让「抓取完成时视图未开」的轮次永久丢渲染；发射
    // 改为无条件，视图过滤由 init-essentials 分派门与 lifecycle 处理体负责。
    state.reader.setViewOpen(false);
    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready");

    state.reader.setViewOpen(true);
    vi.mocked(notifyReaderPresenter).mockClear();
    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready");
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
});

describe("commitNoSubtitle：无字幕出口（逆事务）", () => {
  it("清空完整性：selected 三项/body/派生内容全清，fetchState=empty，subtitle-ready 通知触发", async () => {
    // 预放脏状态：与接受后的 state 互为镜像
    clipState.setSelectedSubtitleId("track-1");
    clipState.setSelectedSubtitleUrl("https://example.com/sub.json");
    clipState.setSelectedSubtitleLang("中文");
    clipState.setSubtitleBody(UNSORTED_BODY);
    clipState.setSubtitleFetchState("ready");
    clipState.setHotComments([{ content: "热评", like: 1 }]);
    clipState.setMarkdown("# 笔记");
    clipState.setSrt("1\n00:00:00,000 --> 00:00:01,000 你好");
    clipState.setTxt("你好");
    clipState.setNoSubtitleReason("asr-empty");

    state.reader.setViewOpen(true);
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
    // 原因未显式传参：保留 maybeRunAsrFallback 终态分支写入的值，不覆盖
    expect(clipState.noSubtitleReason).toBe("asr-empty");
    // 阅读视图的落空态渲染由 subtitle-ready 通知驱动（renderReadingView），
    // 且通知带完整文案（票 07 Q1：失败文案唯一出口，reader 侧直接显示这句）
    expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready", buildNoSubtitleStatusMessage());
  });

  it("noSubtitleReason：显式传参写入（含 null 清空），undefined 保留现有值", async () => {
    clipState.setNoSubtitleReason("asr-auth");
    await commitNoSubtitle({ noSubtitleReason: "asr-auth" });
    expect(clipState.noSubtitleReason).toBe("asr-auth");

    // fallback 失败出口的形状：原因随出口写入事务
    clipState.setNoSubtitleReason("no-asr-config");
    await commitNoSubtitle({ noSubtitleReason: null });
    expect(clipState.noSubtitleReason).toBe(null);
  });

  it("通知发射无条件（同接受事务）：reader 关闭也通知（带完整文案）", async () => {
    clipState.setNoSubtitleReason("asr-empty");
    state.reader.setViewOpen(false);
    await commitNoSubtitle({});
    expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready", buildNoSubtitleStatusMessage());

    state.reader.setViewOpen(true);
    vi.mocked(notifyReaderPresenter).mockClear();
    await commitNoSubtitle({});
    expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready", buildNoSubtitleStatusMessage());
  });

  it("状态栏无条件落同一句（skip 与失败不再分叉）：reader 通知与 setStatus 同文案", async () => {
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
      expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready", message);
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
  // 票 07 Q2 的不变量：状态栏文案永远含基础句 → 命中 reading-status-line 的
  // /无字幕/ 常驻词表 → 5 秒自动收起不会吞掉失败原因。这里按面锁住它。
  it("任何 reason（含 asr-empty 与 null）的文案都含基础句", () => {
    for (const reason of [...ALL_REASONS, null] as NoSubtitleReason[]) {
      clipState.setNoSubtitleReason(reason);
      expect(buildNoSubtitleStatusMessage()).toContain(STATUS_LINE_BASE);
    }
    // 缺省读 clipState（上一步刚设为 null）
    expect(buildNoSubtitleStatusMessage()).toContain(STATUS_LINE_BASE);
  });

  it("逐类文案 = 基础句 + 病因 + 补救（与文案表单源逐字一致）", () => {
    const cases: Array<[NoSubtitleReason, string]> = [
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
      // asr-empty 无补救句：平台成功、只是没人声，没有可做的事
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

    // 详情为空串 → 整段不出现（不留尾空格）
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
    // 新纪元拿到未经 configureCommitUi 的 commit 实例（守卫在触碰 state 前抛出）
    vi.resetModules();
    const freshCommit = await import("../../extension/subtitle/commit.js");
    const freshState = await import("../../extension/core/state.js");

    await expect(freshCommit.commitNoSubtitle({})).rejects.toThrow("configureCommitUi");
    // 守卫先于任何 state 写入
    expect(freshState.clipState.subtitleFetchState).toBe("idle");
  });
});
