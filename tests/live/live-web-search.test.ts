import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeLiveWebSearch } from "../../extension/live/live-web-search.js";
import { resolveWebSearchRuntime } from "../../extension/search/search-runtime.js";

vi.mock("../../extension/search/search-runtime.js", () => ({
  resolveWebSearchRuntime: vi.fn()
}));

const resolveRuntime = vi.mocked(resolveWebSearchRuntime);

beforeEach(() => {
  resolveRuntime.mockReset();
});

describe("live web search executor", () => {
  it("uses the existing search runtime and serializes verified sources", async () => {
    const executeSearch = vi.fn().mockResolvedValue({
      results: [{ title: "官方财报", url: "https://example.com/report", snippet: "营收数据" }],
      platform: "Tavily"
    });
    resolveRuntime.mockResolvedValue({ runtime: { maxToolCalls: 5, executeSearch } });
    const controller = new AbortController();

    const outcome = await executeLiveWebSearch("B 站最新财报", controller.signal);

    expect(resolveRuntime).toHaveBeenCalledWith(controller.signal);
    expect(executeSearch).toHaveBeenCalledWith("B 站最新财报");
    expect(outcome.resultCount).toBe(1);
    expect(outcome.platform).toBe("Tavily");
    expect(outcome.output).toContain("官方财报");
    expect(outcome.output).toContain("https://example.com/report");
  });

  it("preserves fallback provenance from the existing search chain", async () => {
    resolveRuntime.mockResolvedValue({
      runtime: {
        maxToolCalls: 5,
        executeSearch: vi.fn().mockResolvedValue({
          results: [{ title: "结果", url: "https://example.com", snippet: "摘要" }],
          platform: "Exa",
          downgradedFrom: "Tavily"
        })
      }
    });

    const outcome = await executeLiveWebSearch("查询", new AbortController().signal);
    expect(outcome.output).toContain("首选 Tavily 未成功");
    expect(outcome.output).toContain("来自 Exa");
  });

  it("returns an explicit no-result instruction", async () => {
    resolveRuntime.mockResolvedValue({
      runtime: {
        maxToolCalls: 5,
        executeSearch: vi.fn().mockResolvedValue({ results: [], platform: "Tavily" })
      }
    });

    const outcome = await executeLiveWebSearch("没有结果的问题", new AbortController().signal);
    expect(outcome.resultCount).toBe(0);
    expect(outcome.output).toContain("没有找到");
    expect(outcome.output).toContain("不要编造");
  });

  it("surfaces missing configuration and aborts instead of fabricating an answer", async () => {
    resolveRuntime.mockResolvedValue({ notice: "未配置搜索平台，本轮未联网" });
    await expect(executeLiveWebSearch("查询", new AbortController().signal)).rejects.toThrow(
      "未配置搜索平台，本轮未联网"
    );

    const controller = new AbortController();
    controller.abort();
    resolveRuntime.mockResolvedValue({});
    await expect(executeLiveWebSearch("查询", controller.signal)).rejects.toThrow("搜索已中止");
  });
});
