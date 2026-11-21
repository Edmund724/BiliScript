import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

vi.mock("../../extension/reader/reader-bus.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
vi.mock("../../extension/core/ui-status.js", () => ({
  setStatus: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway.js")>();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn(),
    contentFetchJson: vi.fn(),
    readRuntimeVideoDuration: vi.fn(() => 300)
  };
});

vi.mock("../../extension/reader/page-context.js", () => ({
  resolvePageContext: vi.fn(() => ({ pageIndex: 1, cid: "101", cidSource: "test", pageTitle: "P1", duration: 300 }))
}));
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => "测试标题"),
  readVideoAuthor: vi.fn(() => "测试作者"),
  readUploadDate: vi.fn(() => "2026-01-01"),
  readVideoDescription: vi.fn(() => ""),
  refreshHotComments: vi.fn(async () => {}),
  invalidateDerived: vi.fn(),
  refreshDerivedContent: vi.fn(async () => {})
}));

let fetcher: typeof import("../../extension/subtitle/fetcher.js");
let fetchBodyMock: typeof import("../../extension/bilibili/gateway.js").contentFetchJson;

beforeEach(async () => {
  resetModuleState();
  fetcher = await import("../../extension/subtitle/fetcher.js");
  fetchBodyMock = (await import("../../extension/bilibili/gateway.js")).contentFetchJson;
  vi.mocked(fetchBodyMock).mockReset();

  Object.defineProperty(globalThis, "logWarn", { value: vi.fn(), configurable: true });
});

describe("tryLoadSubtitleCandidates 日志路径", () => {
  it("单候选成功：logInfo 不再抛 ReferenceError（修复后通过）", async () => {
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: [{ from: 0, to: 10, content: "hello" }] });

    const candidate = { id: "1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://example.com/sub.json", source: "" };
    const result = await fetcher.tryLoadSubtitleCandidates([candidate], 0, false);

    expect(result).toBe(candidate);
    expect(fetchBodyMock).toHaveBeenCalledWith(candidate.subtitleUrl);
  });

  it("候选失败：logWarn 不再抛 ReferenceError（修复后通过）", async () => {
    vi.mocked(fetchBodyMock).mockRejectedValue(new Error("network down"));

    await expect(
      fetcher.tryLoadSubtitleCandidates(
        [{ id: "1", lan: "zh-CN", lanDoc: "", subtitleUrl: "https://example.com/sub.json", source: "" }],
        0,
        false
      )
    ).rejects.toThrow("network down");
  });

  it("refreshClip 外层路径：错误被安全捕获（复现用户症状）", async () => {
    const preview = document.createElement("textarea");
    preview.id = "biliscript-preview";
    document.body.appendChild(preview);

    const fetchMetaMock = vi.mocked((await import("../../extension/bilibili/gateway.js")).fetchVideoMeta);
    fetchMetaMock.mockRejectedValue(new Error("meta down"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();
  });
});
