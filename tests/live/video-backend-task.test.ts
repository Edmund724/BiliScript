import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { ClipState } from "../../extension/core/state.js";
import {
  VideoBackendTaskManager,
  buildSpokenBriefing,
  runVideoBackendTask,
  splitVideoBackendFacts,
  type VideoBackendTaskDeps,
  type VideoBackendTaskOptions
} from "../../extension/live/video-backend-task.js";

function makeClip(overrides: Partial<ClipState> = {}): Partial<ClipState> {
  return {
    bvid: "BV1test000000",
    cid: "123",
    title: "后台视频任务",
    subtitleFetchState: "ready",
    subtitleBody: [
      { from: 0, to: 10, content: "开场" },
      { from: 300, to: 310, content: "介绍开源项目" },
      { from: 600, to: 610, content: "总结" }
    ],
    chapters: [],
    ...overrides
  };
}

function makeOptions(overrides: Partial<VideoBackendTaskOptions> = {}): VideoBackendTaskOptions {
  return {
    taskId: "task-1",
    objective: "总结全片核心内容",
    signal: new AbortController().signal,
    onSilentProgress: vi.fn(),
    onSpokenResult: vi.fn(),
    onError: vi.fn(),
    ...overrides
  };
}

function makeDeps(overrides: VideoBackendTaskDeps = {}): VideoBackendTaskDeps {
  return {
    getClip: () => makeClip(),
    resolveProvider: async () => ({ baseUrl: "https://api.example.com", model: "text-model" }),
    ...overrides
  };
}

const ANALYSIS = {
  summary: "视频介绍后台文本模型如何辅助实时伴看。",
  chapters: [
    { from: 0, to: 300, title: "背景", summary: "为什么需要后台分析" },
    { from: 300, to: 600, title: "实现", summary: "字幕检索与模型总结" }
  ],
  quotes: [{ from: 300, content: "语音模型负责讲，文本模型负责读。" }]
};

describe("runVideoBackendTask", () => {
  it("全片总结复用概览管线，并分别注入时间戳细节与口语信封", async () => {
    let overviewInput: Parameters<NonNullable<VideoBackendTaskDeps["runOverviewAnalysis"]>>[0] | null = null;
    const options = makeOptions();
    const result = await runVideoBackendTask(options, makeDeps({
      runOverviewAnalysis: async (input) => {
        overviewInput = input;
        return ANALYSIS;
      },
      chatCompletion: vi.fn()
    }));

    expect(result).toMatchObject({ taskId: "task-1", source: "overview", rawText: ANALYSIS.summary });
    expect(overviewInput).not.toBeNull();
    expect(overviewInput!.signal).toBe(options.signal);
    expect(overviewInput!.context.subtitleBody).toHaveLength(3);
    expect(options.onSilentProgress).toHaveBeenCalledTimes(1);
    const details = vi.mocked(options.onSilentProgress).mock.calls[0][0];
    expect(details).toContain("### [0:00] 背景");
    expect(details).toContain("### [5:00] 实现");
    expect(details).toContain("语音模型负责讲，文本模型负责读");
    expect(options.onSpokenResult).toHaveBeenCalledTimes(1);
    const spoken = vi.mocked(options.onSpokenResult).mock.calls[0][0];
    expect(spoken).toContain("[后台文本模型已完成分析]");
    expect(spoken).toContain("为什么需要后台分析");
    expect(spoken).toContain("【播报要求】");
    expect(Array.from(spoken).length).toBeLessThan(1800);
  });

  it("按秒切片字幕，聚合文本模型流并把原 signal 传到请求层", async () => {
    const calls: ChatCompletionInput[] = [];
    const options = makeOptions({
      objective: "总结第 5 到 10 分钟",
      scope: "time_range",
      timeRange: { startSec: 300, endSec: 600 },
      context: ["用户刚才在问项目结构"]
    });
    await runVideoBackendTask(options, makeDeps({
      chatCompletion: async (input) => {
        calls.push(input);
        input.onEvent?.({ type: "token", data: "旧流" });
        input.onStreamReset?.();
        input.onEvent?.({ type: "token", data: "这一区间" });
        input.onEvent?.({ type: "token", data: "介绍了开源项目。" });
        return { done: true };
      }
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBe(options.signal);
    const userText = String(calls[0].messages[1].content);
    expect(userText).toContain("介绍开源项目");
    expect(userText).not.toContain("[0:00-0:10] 开场");
    expect(userText).toContain("300 秒到 600 秒");
    expect(String(calls[0].messages[0].content)).toContain("用户刚才在问项目结构");
    expect(vi.mocked(options.onSpokenResult).mock.calls[0][0]).toContain("这一区间介绍了开源项目。");
  });

  it("带时间戳的模型笔记走静默通道，播报文本去掉 Markdown 符号", async () => {
    const options = makeOptions({ objective: "查找视频中提到的开源项目", scope: "query" });
    await runVideoBackendTask(options, makeDeps({
      chatCompletion: async (input) => {
        input.onEvent?.({
          type: "token",
          data: "## 核心结论\n\n提到了 **BiliScript**。\n\n## [5:00] 项目细节\n\n[项目说明](https://example.com)。"
        });
        return { done: true };
      }
    }));

    const details = vi.mocked(options.onSilentProgress).mock.calls[0][0];
    expect(details).toContain("## [5:00] 项目细节");
    const spoken = vi.mocked(options.onSpokenResult).mock.calls[0][0];
    expect(spoken).toContain("提到了 BiliScript。");
    expect(spoken).toContain("项目说明。");
    expect(spoken).not.toContain("**");
    expect(spoken).not.toContain("https://example.com");
  });

  it("所有注入严格小于 1800 个 Unicode 字符，静默细节最多两段且不截断代理对", async () => {
    const longText = "😀".repeat(5000);
    const facts = splitVideoBackendFacts(longText);
    expect(facts).toHaveLength(2);
    expect(facts.every((item) => Array.from(item).length < 1800)).toBe(true);
    expect(facts.map((item) => item.codePointAt(item.length - 2)?.toString(16))).toEqual(["1f600", "1f600"]);

    const spoken = buildSpokenBriefing(longText);
    expect(Array.from(spoken).length).toBe(1799);
    expect(spoken).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(spoken).toContain("【播报要求】");
  });

  it("无字幕与无有效模型正文通过 onError 返回可读错误", async () => {
    const noSubtitle = makeOptions();
    const noSubtitleResult = await runVideoBackendTask(noSubtitle, makeDeps({
      getClip: () => makeClip({ subtitleBody: [], subtitleFetchState: "empty" })
    }));
    expect(noSubtitleResult).toBeNull();
    expect(noSubtitle.onError).toHaveBeenCalledWith(expect.stringContaining("没有可用字幕"));
    expect(noSubtitle.onSpokenResult).not.toHaveBeenCalled();

    const emptyModel = makeOptions({ scope: "query" });
    const emptyResult = await runVideoBackendTask(emptyModel, makeDeps({
      chatCompletion: async () => ({ done: true })
    }));
    expect(emptyResult).toBeNull();
    expect(emptyModel.onError).toHaveBeenCalledWith(expect.stringContaining("没有返回可用内容"));
  });

  it("预先中止时不读取模型配置，也不触发结果或错误回调", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolveProvider = vi.fn();
    const options = makeOptions({ signal: controller.signal });
    const result = await runVideoBackendTask(options, makeDeps({ resolveProvider }));
    expect(result).toBeNull();
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onSpokenResult).not.toHaveBeenCalled();
  });
});

describe("VideoBackendTaskManager", () => {
  it("按 taskId 注册、替换和取消 AbortController", () => {
    const manager = new VideoBackendTaskManager();
    const first = manager.registerTask("same-id");
    const second = manager.registerTask("same-id");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(manager.cancelTask("same-id")).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(manager.cancelTask("same-id")).toBe(false);

    const a = manager.registerTask("a");
    const b = manager.registerTask("b");
    manager.cancelAllTasks();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it("cancelTask 立即中止正在进行的文本模型流，且不串成错误", async () => {
    let requestSignal: AbortSignal | null | undefined;
    let started = false;
    const manager = new VideoBackendTaskManager(makeDeps({
      chatCompletion: async (input) => {
        requestSignal = input.signal;
        started = true;
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
        return { done: true };
      }
    }));
    const options = makeOptions({ scope: "query" });
    const running = manager.runTask(options);
    await vi.waitFor(() => expect(started).toBe(true));

    expect(manager.cancelTask(options.taskId)).toBe(true);
    await expect(running).resolves.toBeNull();
    expect(requestSignal?.aborted).toBe(true);
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onSpokenResult).not.toHaveBeenCalled();
  });
});
