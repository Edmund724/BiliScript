// 伴看上下文的概览投影：相位 → 可用产物 / 覆盖完整性 / 状态文案。
// 只测纯函数，不触碰 reader 协调器与协议层（那两处各自的用例覆盖订阅与指令渲染）。

import { describe, expect, it } from "vitest";
import { projectLiveOverview } from "../../extension/live/live-overview-context.js";

const READY_ANALYSIS = {
  summary: "全片介绍测试驱动开发。",
  chapters: [
    { from: 0, to: 120, title: "开场", summary: "为什么要写测试" },
    { from: 120, to: 300, title: "误区", summary: "mock 一切" }
  ],
  quotes: [{ from: 125, content: "测试不是目的，而是反馈。" }]
};

describe("projectLiveOverview", () => {
  it("暴露 ready 概览的简介、章节与金句，并保留真实时刻文本", () => {
    const overview = projectLiveOverview(
      { phase: "ready", analysis: READY_ANALYSIS, errorText: "" },
      { fetchState: "ready" }
    );

    expect(overview).toEqual({
      phase: "ready",
      coverage: "complete",
      summary: "全片介绍测试驱动开发。",
      chapters: [
        { from: 0, to: 120, time: "0:00", title: "开场", summary: "为什么要写测试" },
        { from: 120, to: 300, time: "2:00", title: "误区", summary: "mock 一切" }
      ],
      quotes: [{ from: 125, time: "2:05", content: "测试不是目的，而是反馈。" }],
      statusText: ""
    });
  });

  it("分段失败标记为覆盖不完整，并给出明确的 incomplete 文案", () => {
    const overview = projectLiveOverview(
      {
        phase: "partial",
        analysis: { ...READY_ANALYSIS, failedRanges: [{ from: 120, to: 300 }] }
      },
      { fetchState: "ready" }
    );

    expect(overview?.coverage).toBe("partial");
    expect(overview?.failedRanges).toEqual([{ from: 120, to: 300 }]);
    expect(overview?.statusText).toContain("覆盖不完整");
    expect(overview?.statusText).toContain("不得当作完整全片总结");
  });

  it("简介归并失败同样标记为覆盖不完整", () => {
    const overview = projectLiveOverview(
      {
        phase: "partial",
        analysis: { ...READY_ANALYSIS, summary: "", summaryFailed: true }
      },
      { fetchState: "ready" }
    );

    expect(overview?.coverage).toBe("partial");
    expect(overview?.summaryFailed).toBe(true);
    expect(overview?.statusText).toContain("全片简介");
    expect(overview?.statusText).toContain("不完整");
  });

  it("生成中不携带任何产物，只给出等待提示", () => {
    const overview = projectLiveOverview({ phase: "generating", analysis: null }, { fetchState: "ready" });

    expect(overview).toMatchObject({ phase: "generating", coverage: "none", summary: "", chapters: [], quotes: [] });
    expect(overview?.statusText).toContain("正在生成");
  });

  it("无字幕空态按字幕相位区分等待与失败，不编造概览", () => {
    expect(projectLiveOverview({ phase: "empty", analysis: null }, { fetchState: "loading" })?.statusText)
      .toContain("字幕仍在加载");
    expect(projectLiveOverview({ phase: "empty", analysis: null }, { fetchState: "empty" })?.statusText)
      .toContain("没有可用字幕");
    expect(projectLiveOverview({ phase: "empty", analysis: null }, { fetchState: "error" })?.statusText)
      .toContain("字幕加载失败");
  });

  it("尚未生成时如实说明可等待或重试，不冒充已有概览", () => {
    const overview = projectLiveOverview({ phase: "idle", analysis: null }, { fetchState: "ready" });

    expect(overview?.coverage).toBe("none");
    expect(overview?.statusText).toContain("尚未生成");
    expect(overview?.statusText).toContain("重试");
  });

  it("生成失败透出原因与重试方式", () => {
    const overview = projectLiveOverview(
      { phase: "error", analysis: null, errorText: "模型请求失败" },
      { fetchState: "ready" }
    );

    expect(overview?.phase).toBe("error");
    expect(overview?.statusText).toContain("模型请求失败");
    expect(overview?.statusText).toContain("重试");
  });

  it("取消态不携带旧产物", () => {
    const overview = projectLiveOverview({ phase: "cancelled", analysis: READY_ANALYSIS }, { fetchState: "ready" });

    expect(overview?.phase).toBe("cancelled");
    expect(overview?.coverage).toBe("none");
    expect(overview?.summary).toBe("");
    expect(overview?.chapters).toEqual([]);
  });

  it("未知相位按未就绪处理，畸形产物不抛错也不冒充内容", () => {
    const overview = projectLiveOverview(
      { phase: "surprising", analysis: { summary: 12, chapters: "nope", quotes: [{ from: "x" }] } },
      { fetchState: "ready" }
    );

    expect(overview?.phase).toBe("idle");
    expect(overview?.coverage).toBe("none");
    expect(overview?.summary).toBe("");
  });

  it("没有概览来源时返回 null，由协议层决定如何表述", () => {
    expect(projectLiveOverview(null, { fetchState: "ready" })).toBeNull();
    expect(projectLiveOverview(undefined, { fetchState: "ready" })).toBeNull();
  });
});
