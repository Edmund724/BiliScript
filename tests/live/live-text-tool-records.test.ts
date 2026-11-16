import { describe, expect, it, vi } from "vitest";
import {
  createLiveTextToolCoordinator,
  createLiveTextToolRecordStore,
  formatLiveOverviewMarkdown,
  formatLiveOverviewRecordResult,
  summarizeLiveTextToolMarkdown,
  type LiveTextToolRecordEvent
} from "../../extension/live/live-text-tool-records.js";

describe("LiveTextToolRecordStore", () => {
  it("按调用 id 合并流式片段与重复终态，显式重试才重置同一记录", () => {
    const store = createLiveTextToolRecordStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const started: LiveTextToolRecordEvent = {
      type: "started",
      callId: "call-1",
      source: "gemini",
      objective: "梳理全片论点",
      startedAt: 100
    };
    store.apply(started);
    store.apply(started);
    store.apply({ type: "progress", callId: "call-1", summary: "第一段", markdown: "第一段" });
    store.apply({ type: "progress", callId: "call-1", summary: "第一段第二段", markdown: "第一段第二段" });
    store.apply({ type: "progress", callId: "call-1", summary: "第一段第二段", markdown: "第一段第二段" });

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({ status: "running", startedAt: 100, summary: "第一段第二段" });
    expect(listener).toHaveBeenCalledTimes(3);

    store.apply({
      type: "completed",
      callId: "call-1",
      summary: "完整摘要",
      markdown: "# 完整结果\n\n正文",
      endedAt: 1450
    });
    store.apply({ type: "failed", callId: "call-1", error: "迟到失败", endedAt: 1600 });
    store.apply({ type: "progress", callId: "call-1", summary: "迟到片段", markdown: "迟到片段" });
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({
      status: "completed",
      summary: "完整摘要",
      markdown: "# 完整结果\n\n正文",
      durationMs: 1350,
      endedAt: 1450
    });

    store.apply({ ...started, retry: true, startedAt: 2000 });
    expect(store.getSnapshot()[0]).toMatchObject({ status: "running", startedAt: 2000, summary: "", markdown: "" });
    store.apply({ type: "failed", callId: "call-1", error: "请求超时", endedAt: 2300 });
    expect(store.getSnapshot()[0]).toMatchObject({ status: "failed", error: "请求超时", durationMs: 300 });
  });

  it("失败全部在途记录并可忽略已继续伴看的失败记录", () => {
    const store = createLiveTextToolRecordStore();
    for (const callId of ["a", "b"]) {
      store.apply({ type: "started", callId, source: "moss", objective: "总结全片", startedAt: 10 });
    }
    store.failRunning("连接中断", 50);
    expect(store.getSnapshot().every((record) => record.status === "failed" && record.error === "连接中断")).toBe(true);

    store.apply({ type: "dismissed", callId: "a" });
    store.apply({ type: "completed", callId: "a", summary: "迟到", markdown: "迟到", endedAt: 60 });
    expect(store.getSnapshot().map((record) => record.callId)).toEqual(["b"]);
  });

  it("事件载荷只投影白名单字段，不带系统提示词、字幕、上下文或凭据", () => {
    const store = createLiveTextToolRecordStore();
    const secretFields = {
      systemPrompt: "SYSTEM-SECRET",
      subtitleBody: "FULL-SUBTITLES",
      context: ["PRIVATE-CONTEXT"],
      apiKey: "CREDENTIAL"
    };
    store.apply({
      type: "started",
      callId: "safe",
      source: "gemini",
      objective: "回答用户问题",
      startedAt: 0,
      ...secretFields
    } as LiveTextToolRecordEvent);
    store.apply({
      type: "completed",
      callId: "safe",
      summary: "公开摘要",
      markdown: "公开结果",
      endedAt: 20,
      ...secretFields
    } as LiveTextToolRecordEvent);

    const serialized = JSON.stringify(store.getSnapshot());
    expect(serialized).not.toContain("SYSTEM-SECRET");
    expect(serialized).not.toContain("FULL-SUBTITLES");
    expect(serialized).not.toContain("PRIVATE-CONTEXT");
    expect(serialized).not.toContain("CREDENTIAL");
    expect(store.getSnapshot()[0]).toEqual({
      callId: "safe",
      source: "gemini",
      status: "completed",
      objective: "回答用户问题",
      summary: "公开摘要",
      markdown: "公开结果",
      startedAt: 0,
      endedAt: 20,
      durationMs: 20
    });
  });

  it("失败原因脱敏且订阅者异常不影响记录状态", () => {
    const store = createLiveTextToolRecordStore();
    store.subscribe(() => {
      throw new Error("UI 渲染异常");
    });
    expect(() => store.apply({
      type: "started",
      callId: "safe-error",
      source: "moss",
      objective: "总结全片",
      startedAt: 0
    })).not.toThrow();
    expect(() => store.apply({
      type: "failed",
      callId: "safe-error",
      error: "请求失败 Bearer sk-live-secret apiKey=CREDENTIAL",
      endedAt: 10
    })).not.toThrow();

    const record = store.getSnapshot()[0];
    expect(record.status).toBe("failed");
    expect(record.error).toContain("请求失败");
    expect(record.error).not.toContain("sk-live-secret");
    expect(record.error).not.toContain("CREDENTIAL");
  });

  it("摘要只取模型结果并限制长度", () => {
    const summary = summarizeLiveTextToolMarkdown(`# 标题\n\n**核心结论**与[链接](https://example.com)。${"长".repeat(300)}`);
    expect(summary).toContain("核心结论与链接。");
    expect(summary).not.toContain("#");
    expect(summary).not.toContain("https://example.com");
    expect(Array.from(summary).length).toBe(180);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("formatLiveOverviewMarkdown 与 formatLiveOverviewRecordResult 共用全片概览 Markdown 拼装", () => {
    const markdown = formatLiveOverviewMarkdown({
      summary: "全片总结",
      chapters: [{ from: 65, title: "开场", summary: "说明背景" }],
      quotes: [{ from: 125, content: "核心原话" }]
    });
    expect(markdown).toBe(
      "# 全片概览\n\n全片总结\n\n## 分章节详细笔记\n\n### [1:05] 开场\n说明背景\n\n## 关键原话\n\n- [2:05] 核心原话"
    );

    expect(formatLiveOverviewRecordResult({ ok: false, summary: "bad" })).toBeNull();
    expect(
      formatLiveOverviewRecordResult({
        ok: true,
        summary: "核心摘要",
        chapters: [{ time: "01:05", title: "主题", summary: "内容" }],
        quotes: [{ time: "02:05", content: "金句" }]
      })
    ).toEqual({
      summary: "核心摘要",
      markdown: "# 全片概览\n\n核心摘要\n\n## 分章节详细笔记\n\n### [01:05] 主题\n内容\n\n## 关键原话\n\n- [02:05] 金句"
    });
  });

  it("createLiveTextToolCoordinator 管理尝试代次、重试、失败兜底、忽略与持久化去重", async () => {
    const persisted: string[] = [];
    let canRetry = false;
    const retrySpy = vi.fn();
    const coordinator = createLiveTextToolCoordinator({
      canRetry: () => canRetry,
      persistRecord: async (record) => {
        persisted.push(`${record.callId}:${record.status}`);
      }
    });

    const firstAttempt = coordinator.startAttempt({
      callId: "c1",
      source: "moss",
      objective: "分析",
      startedAt: 100,
      onRetry: retrySpy
    });
    expect(firstAttempt).toBe(1);
    expect(coordinator.startAttempt({
      callId: "c1",
      source: "moss",
      objective: "分析",
      startedAt: 110,
      onRetry: retrySpy
    })).toBeNull();
    expect(coordinator.isCurrentAttempt("c1", 1)).toBe(true);

    coordinator.failRunning("中断");
    expect(coordinator.isCurrentAttempt("c1", 1)).toBe(false);
    expect(coordinator.getSnapshot()[0].status).toBe("failed");
    expect(coordinator.retry("c1")).toBe(false);

    canRetry = true;
    expect(coordinator.retry("c1")).toBe(true);
    expect(retrySpy).toHaveBeenCalledTimes(1);

    coordinator.dismiss("c1");
    expect(coordinator.getSnapshot()).toHaveLength(0);
    await Promise.resolve();
    expect(persisted).toEqual(["c1:failed"]);
  });
});
