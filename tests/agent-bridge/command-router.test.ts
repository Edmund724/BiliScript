import { describe, expect, it, vi } from "vitest";
import {
  createAgentBridgeCommandRouter,
  type AgentBridgeHostAdapter,
  type AgentBridgeTabMessage
} from "../../extension/agent-bridge/command-router.js";
import type { AgentBridgeVideoService } from "../../extension/agent-bridge/video-service.js";

function createVideoServiceStub(overrides: Partial<AgentBridgeVideoService> = {}): AgentBridgeVideoService {
  return {
    resolveVideoInfo: vi.fn(),
    completeContentSubtitles: vi.fn(),
    getSubtitles: vi.fn(),
    getComments: vi.fn(),
    getVideoBundle: vi.fn(),
    ...overrides
  };
}

function createHostStub(overrides: Partial<AgentBridgeHostAdapter> = {}): AgentBridgeHostAdapter {
  return {
    queryTabs: vi.fn(async () => []),
    getTab: vi.fn(async (tabId: number) => ({ id: tabId } as chrome.tabs.Tab)),
    sendTabMessage: vi.fn(async () => undefined) as AgentBridgeHostAdapter["sendTabMessage"],
    captureOffscreenFrames: vi.fn(async () => {
      throw new Error("unexpected captureOffscreenFrames");
    }),
    ...overrides
  };
}

describe("Agent Bridge 命令路由", () => {
  it("tabs 标记当前窗口活动视频标签页为 active，并过滤无视频 ID 的 YouTube 标签页", async () => {
    const allTabs = [
      { id: 10, url: "https://www.bilibili.com/video/BV1one000001/", title: "后台", active: false },
      { id: 20, url: "https://www.bilibili.com/video/BV1two000002/", title: "活动", active: true },
      { id: 30, url: "https://www.youtube.com/watch", title: "YouTube", active: false }
    ] as chrome.tabs.Tab[];

    const router = createAgentBridgeCommandRouter({
      host: createHostStub({
        queryTabs: vi.fn(async (queryInfo) => (queryInfo.active ? [allTabs[1]] : allTabs)),
        sendTabMessage: vi.fn(async (tabId: number) => {
          if (tabId === 30) {
            return { ok: true, snapshot: { site: "youtube", bvid: "", cid: "yt", title: "YouTube" } };
          }
          return { ok: false };
        }) as AgentBridgeHostAdapter["sendTabMessage"]
      }),
      videoService: createVideoServiceStub()
    });

    const result = (await router.execute("tabs")) as { tabs: Array<{ tabId: number; bvid: string; active?: boolean }> };
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0]).toMatchObject({ tabId: 10, bvid: "BV1one000001" });
    expect(result.tabs[0].active).toBeUndefined();
    expect(result.tabs[1]).toMatchObject({ tabId: 20, bvid: "BV1two000002", active: true });
  });

  it("B 站 fetch/subtitles 为已打开标签页注入页内字幕采集，为未打开 BV 直接走 videoService", async () => {
    const getVideoBundle = vi.fn(async (_query, loadContent) => {
      const content = loadContent ? await loadContent() : null;
      return {
        video: {
          bvid: "BV1test000000",
          aid: "123",
          cid: "100",
          title: "视频",
          author: "作者",
          description: "",
          uploadDate: "",
          duration: 60,
          page: 1,
          pageCount: 1
        },
        pages: [{ cid: "100", page: 1, part: "P1", duration: 60 }],
        chapters: content?.chapters || [],
        subtitle: content?.subtitle || { source: "bilibili", trackId: "t1", language: "中文", items: [] },
        comments: [{ uname: "用户", like: 5, message: "热评" }]
      };
    });
    const completeContentSubtitles = vi.fn(async (_query, content) => ({
      video: {
        bvid: content.bvid,
        aid: "123",
        cid: content.cid,
        title: "视频",
        author: "作者",
        description: "",
        uploadDate: "",
        duration: 60,
        page: 1,
        pageCount: 1
      },
      pages: [],
      chapters: content.chapters,
      subtitle: content.subtitle
    }));
    const getSubtitles = vi.fn();

    const openTab = { id: 7, url: "https://www.bilibili.com/video/BV1open000000/" } as chrome.tabs.Tab;
    const router = createAgentBridgeCommandRouter({
      host: createHostStub({
        queryTabs: vi.fn(async () => [openTab]),
        getTab: vi.fn(async () => openTab),
        sendTabMessage: vi.fn(async (_tabId: number, msg: AgentBridgeTabMessage) => {
          if (msg.type === "agent-bridge-snapshot") {
            return { ok: true, snapshot: { bvid: "BV1open000000", cid: "100", title: "打开的视频" } };
          }
          if (msg.type === "agent-bridge-subtitles") {
            return {
              ok: true,
              result: {
                bvid: "BV1open000000",
                cid: "100",
                pageIndex: 1,
                chapters: [{ title: "章", from: 0, to: 10, source: "bilibili" }],
                subtitle: {
                  source: "bilibili",
                  trackId: "tab-t",
                  language: "中文",
                  items: [{ from: 1, to: 2, content: "句" }]
                }
              }
            };
          }
          return undefined;
        }) as AgentBridgeHostAdapter["sendTabMessage"]
      }),
      videoService: createVideoServiceStub({ getVideoBundle, completeContentSubtitles, getSubtitles })
    });

    const openFetch = await router.execute("fetch", { tabId: 7, from: 1, to: 5 });
    expect(openFetch).toMatchObject({
      chapters: [{ title: "章" }],
      subtitle: { trackId: "tab-t", items: [{ content: "句" }] },
      comments: [{ message: "热评" }]
    });

    await router.execute("fetch", { bvid: "BV1other00000" });
    expect(getVideoBundle).toHaveBeenNthCalledWith(2, expect.objectContaining({ bvid: "BV1other00000" }), undefined);

    const openSubtitles = await router.execute("subtitles", { tabId: 7 });
    expect(openSubtitles).toMatchObject({ subtitle: { trackId: "tab-t" } });
    expect(completeContentSubtitles).toHaveBeenCalledTimes(1);
    expect(getSubtitles).not.toHaveBeenCalled();
  });

  it("YouTube 已打开标签页支持 tabs/fetch/subtitles/comments/frame，拒绝未打开 URL 且不泄漏转义存储键", async () => {
    const ytId = "abc_def-123";
    const ytUrl = `https://www.youtube.com/watch?v=${ytId}`;
    let failComments = false;
    const getVideoBundle = vi.fn();

    const ytTab = { id: 12, url: ytUrl, title: "YT Demo - YouTube", active: true } as chrome.tabs.Tab;
    const emptyYtTab = { id: 13, url: "https://www.youtube.com/watch", title: "YouTube" } as chrome.tabs.Tab;

    const router = createAgentBridgeCommandRouter({
      host: createHostStub({
        queryTabs: vi.fn(async (queryInfo) => (queryInfo.active ? [ytTab] : [ytTab, emptyYtTab])),
        getTab: vi.fn(async (tabId: number) => ({ id: tabId, url: ytUrl, title: "YT Demo - YouTube" } as chrome.tabs.Tab)),
        sendTabMessage: vi.fn(async (tabId: number, msg: AgentBridgeTabMessage) => {
          if (msg.type === "agent-bridge-snapshot") {
            if (tabId === 13) {
              return { ok: true, snapshot: { site: "youtube", bvid: "", cid: "yt", title: "YouTube" } };
            }
            return {
              ok: true,
              snapshot: {
                site: "youtube",
                bvid: ytId,
                cid: "yt",
                title: "YT Demo",
                currentTime: 18,
                duration: 120,
                subtitlesReady: true
              }
            };
          }
          if (msg.type === "agent-bridge-subtitles") {
            return {
              ok: true,
              result: {
                site: "youtube",
                bvid: ytId,
                cid: "yt",
                pageIndex: 1,
                video: {
                  site: "youtube",
                  bvid: ytId,
                  aid: "",
                  cid: "yt",
                  title: "YT Demo",
                  author: "Channel",
                  description: "desc",
                  uploadDate: "2026-01-01",
                  duration: 120,
                  page: 1,
                  pageCount: 1
                },
                chapters: [{ title: "Intro", from: 0, to: 30, source: "youtube" }],
                subtitle: {
                  source: "youtube",
                  trackId: "en-asr",
                  language: "英语（YouTube 自动）",
                  items: [
                    { from: 1, to: 3, content: "first" },
                    { from: 10, to: 15, content: "second" }
                  ]
                }
              }
            };
          }
          if (msg.type === "agent-bridge-comments") {
            if (failComments) {
              return { ok: false, error: "评论区已关闭" };
            }
            return {
              ok: true,
              result: {
                site: "youtube",
                video: {
                  site: "youtube",
                  bvid: ytId,
                  aid: "",
                  cid: "yt",
                  title: "YT Demo",
                  author: "Channel",
                  description: "desc",
                  uploadDate: "2026-01-01",
                  duration: 120,
                  page: 1,
                  pageCount: 1
                },
                comments: [{ uname: "viewer", like: 42, message: "great video" }]
              }
            };
          }
          if (msg.type === "agent-bridge-frame") {
            return {
              ok: true,
              result: {
                site: "youtube",
                bvid: ytId,
                cid: "yt",
                frames: [{ data: "/9j/2Q==", targetTime: msg.targetTime ?? 18, currentTime: 18 }]
              }
            };
          }
          return undefined;
        }) as AgentBridgeHostAdapter["sendTabMessage"]
      }),
      videoService: createVideoServiceStub({ getVideoBundle })
    });

    const tabsResult = await router.listTabs();
    expect(tabsResult.tabs).toEqual([
      expect.objectContaining({ site: "youtube", tabId: 12, bvid: ytId, cid: "yt", active: true })
    ]);

    const fetchResult = await router.execute("fetch", { bvid: `https://youtu.be/${ytId}`, from: 8, to: 20 });
    expect(fetchResult).toMatchObject({
      video: { site: "youtube", bvid: ytId, cid: "yt", title: "YT Demo" },
      pages: [],
      chapters: [{ title: "Intro", source: "youtube" }],
      subtitle: { source: "youtube", items: [{ from: 10, to: 15, content: "second" }] },
      comments: [{ uname: "viewer", like: 42, message: "great video" }]
    });
    expect(JSON.stringify(fetchResult)).not.toContain("yt~");
    expect(getVideoBundle).not.toHaveBeenCalled();

    const subtitlesResult = await router.execute("subtitles", { bvid: ytId, from: 0, to: 5 });
    expect(subtitlesResult).toMatchObject({
      subtitle: { items: [{ from: 1, to: 3, content: "first" }] }
    });

    const commentsResult = await router.execute("comments", { tabId: 12 });
    expect(commentsResult).toMatchObject({
      video: { site: "youtube", bvid: ytId },
      comments: [{ uname: "viewer", like: 42 }]
    });

    failComments = true;
    const fetchFallback = await router.execute("fetch", { bvid: ytId });
    expect(fetchFallback).toMatchObject({
      video: { site: "youtube", bvid: ytId },
      comments: [],
      commentsError: "评论区已关闭"
    });

    await expect(
      router.execute("fetch", { bvid: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
    ).rejects.toThrow("未在浏览器标签页中打开");

    await expect(router.execute("subtitles", { tabId: 12, from: 20, to: 10 })).rejects.toThrow("--to 不能小于 --from");

    const currentFrame = await router.execute("frame", { tabId: 12 });
    expect(currentFrame).toMatchObject({
      site: "youtube",
      bvid: ytId,
      cid: "yt",
      frames: [{ targetTime: 18, currentTime: 18 }]
    });

    const historicalFrame = await router.execute("frame", { tabId: 12, targetTime: 30 });
    expect(historicalFrame).toMatchObject({
      site: "youtube",
      bvid: ytId,
      cid: "yt",
      frames: [{ targetTime: 30, currentTime: 18 }]
    });
  });

  it("B 站历史截帧在无可用 B 站标签页时回落到 captureOffscreenFrames", async () => {
    const captureOffscreenFrames = vi.fn(async (input) => ({
      bvid: input.bvid,
      cid: input.cid,
      frames: [{ data: "offscreen", targetTime: input.targetTime, currentTime: input.targetTime }]
    }));
    const resolveVideoInfo = vi.fn(async () => ({
      bvid: "BV1off000000",
      aid: "1",
      cid: "999",
      title: "",
      author: "",
      description: "",
      uploadDate: "",
      duration: 60,
      page: 1,
      pageCount: 1
    }));

    const router = createAgentBridgeCommandRouter({
      host: createHostStub({
        queryTabs: vi.fn(async () => [
          { id: 12, url: "https://www.youtube.com/watch?v=abc_def-123" } as chrome.tabs.Tab
        ]),
        captureOffscreenFrames
      }),
      videoService: createVideoServiceStub({ resolveVideoInfo })
    });

    const result = await router.execute("frame", { bvid: "BV1off000000", targetTime: 42 });
    expect(resolveVideoInfo).toHaveBeenCalledTimes(1);
    expect(captureOffscreenFrames).toHaveBeenCalledWith({
      bvid: "BV1off000000",
      cid: "999",
      targetTime: 42
    });
    expect(result).toMatchObject({
      bvid: "BV1off000000",
      cid: "999",
      frames: [{ data: "offscreen", targetTime: 42 }]
    });
  });

  it("拒绝非法命令、非法标签页 ID 与无效目标", async () => {
    const router = createAgentBridgeCommandRouter({
      host: createHostStub(),
      videoService: createVideoServiceStub()
    });

    await expect(router.execute("unknown")).rejects.toThrow("不支持的桥接命令");
    await expect(router.execute("fetch", { tabId: 0 })).rejects.toThrow("--tab 必须是正整数标签页 ID");
    await expect(router.execute("fetch", { bvid: "invalid-target" })).rejects.toThrow("请传入有效的 BV 号");
    await expect(router.execute("fetch", { bvid: "https://example.com/watch?v=abc_def-123" })).rejects.toThrow(
      "请传入有效的 BV 号"
    );
  });
});
