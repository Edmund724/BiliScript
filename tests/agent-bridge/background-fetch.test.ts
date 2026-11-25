import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createAgentBridge } from "../../extension/agent-bridge/background.js";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(_url: string, _protocol: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    const event = new Event("open");
    this.dispatchEvent(event);
    this.onopen?.(event);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    this.dispatchEvent(event);
    this.onclose?.(event);
  }

  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

beforeEach(() => {
  resetModuleState();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("Agent Bridge background fetch 路由", () => {
  it("fetch 命令为已打开标签页注入 content 字幕采集钩子，为未打开 BV 直接走 videoService", async () => {
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

    vi.stubGlobal("chrome", {
      ...chrome,
      tabs: {
        query: vi.fn(async () => [{ id: 7, url: "https://www.bilibili.com/video/BV1open000000/" }]),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://www.bilibili.com/video/BV1open000000/" })),
        sendMessage: vi.fn((_tabId: number, msg: { type: string }, cb: (resp: unknown) => void) => {
          if (msg.type === "agent-bridge-snapshot") {
            cb({ ok: true, snapshot: { bvid: "BV1open000000", cid: "100", title: "打开的视频" } });
            return;
          }
          if (msg.type === "agent-bridge-subtitles") {
            cb({
              ok: true,
              result: {
                bvid: "BV1open000000",
                cid: "100",
                pageIndex: 1,
                chapters: [{ title: "章", from: 0, to: 10, source: "bilibili" }],
                subtitle: { source: "bilibili", trackId: "tab-t", language: "中文", items: [{ from: 1, to: 2, content: "句" }] }
              }
            });
          }
        })
      }
    });

    const bridge = createAgentBridge({
      getConfig: async () => ({ enabled: true, url: "ws://127.0.0.1:18492" }),
      videoService: {
        resolveVideoInfo: vi.fn(),
        completeContentSubtitles: vi.fn(),
        getSubtitles: vi.fn(),
        getComments: vi.fn(),
        getVideoBundle
      }
    });

    await bridge.sync();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    ws.receive({ type: "request", id: "req-open", command: "fetch", options: { tabId: 7, from: 1, to: 5 } });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(2));
    const openResp = JSON.parse(ws.sent[1]);
    expect(openResp).toMatchObject({
      type: "response",
      id: "req-open",
      ok: true,
      result: {
        chapters: [{ title: "章" }],
        subtitle: { trackId: "tab-t", items: [{ content: "句" }] },
        comments: [{ message: "热评" }]
      }
    });

    ws.receive({ type: "request", id: "req-bvid", command: "fetch", options: { bvid: "BV1other00000" } });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(3));
    const bvidResp = JSON.parse(ws.sent[2]);
    expect(bvidResp).toMatchObject({ type: "response", id: "req-bvid", ok: true });
    expect(getVideoBundle).toHaveBeenNthCalledWith(2, expect.objectContaining({ bvid: "BV1other00000" }), undefined);
  });

  it("YouTube 已打开标签页支持 tabs/fetch/subtitles/comments/frame，拒绝未打开 URL 与历史截帧，且不泄漏转义存储键", async () => {
    const ytId = "abc_def-123";
    const ytUrl = `https://www.youtube.com/watch?v=${ytId}`;
    let failComments = false;
    const getVideoBundle = vi.fn();

    vi.stubGlobal("chrome", {
      ...chrome,
      tabs: {
        query: vi.fn(async () => [
          { id: 12, url: ytUrl, title: "YT Demo - YouTube", active: true },
          { id: 13, url: "https://www.youtube.com/watch", title: "YouTube" }
        ]),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: ytUrl, title: "YT Demo - YouTube" })),
        sendMessage: vi.fn((tabId: number, msg: { type: string }, cb: (resp: unknown) => void) => {
          if (msg.type === "agent-bridge-snapshot") {
            if (tabId === 13) {
              cb({ ok: true, snapshot: { site: "youtube", bvid: "", cid: "yt", title: "YouTube" } });
              return;
            }
            cb({
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
            });
            return;
          }
          if (msg.type === "agent-bridge-subtitles") {
            cb({
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
            });
            return;
          }
          if (msg.type === "agent-bridge-comments") {
            if (failComments) {
              cb({ ok: false, error: "评论区已关闭" });
              return;
            }
            cb({
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
            });
            return;
          }
          if (msg.type === "agent-bridge-frame") {
            cb({
              ok: true,
              result: {
                site: "youtube",
                bvid: ytId,
                cid: "yt",
                frames: [{ data: "/9j/2Q==", targetTime: 18, currentTime: 18 }]
              }
            });
          }
        })
      }
    });

    const bridge = createAgentBridge({
      getConfig: async () => ({ enabled: true, url: "ws://127.0.0.1:18492" }),
      videoService: {
        resolveVideoInfo: vi.fn(),
        completeContentSubtitles: vi.fn(),
        getSubtitles: vi.fn(),
        getComments: vi.fn(),
        getVideoBundle
      }
    });

    await bridge.sync();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const sendReq = async (id: string, command: string, options?: Record<string, unknown>) => {
      const before = ws.sent.length;
      ws.receive({ type: "request", id, command, ...(options ? { options } : {}) });
      await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(before));
      return JSON.parse(ws.sent[ws.sent.length - 1]);
    };

    const tabsResp = await sendReq("yt-tabs", "tabs");
    expect(tabsResp).toMatchObject({
      ok: true,
      result: {
        tabs: [{ site: "youtube", tabId: 12, bvid: ytId, cid: "yt", active: true }]
      }
    });
    expect(tabsResp.result.tabs).toHaveLength(1);

    const fetchResp = await sendReq("yt-fetch", "fetch", { bvid: `https://youtu.be/${ytId}`, from: 8, to: 20 });
    expect(fetchResp).toMatchObject({
      ok: true,
      result: {
        video: { site: "youtube", bvid: ytId, cid: "yt", title: "YT Demo" },
        pages: [],
        chapters: [{ title: "Intro", source: "youtube" }],
        subtitle: { source: "youtube", items: [{ from: 10, to: 15, content: "second" }] },
        comments: [{ uname: "viewer", like: 42, message: "great video" }]
      }
    });
    expect(JSON.stringify(fetchResp)).not.toContain("yt~");
    expect(getVideoBundle).not.toHaveBeenCalled();

    failComments = true;
    const fetchFallbackResp = await sendReq("yt-fetch-fallback", "fetch", { bvid: ytId });
    expect(fetchFallbackResp).toMatchObject({
      ok: true,
      result: {
        video: { site: "youtube", bvid: ytId },
        comments: [],
        commentsError: "评论区已关闭"
      }
    });

    const unopenedResp = await sendReq("yt-unopened", "fetch", { bvid: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(unopenedResp).toMatchObject({
      ok: false,
      error: expect.stringContaining("未在浏览器标签页中打开")
    });

    const frameResp = await sendReq("yt-frame", "frame", { tabId: 12 });
    expect(frameResp).toMatchObject({
      ok: true,
      result: { site: "youtube", bvid: ytId, cid: "yt", frames: [{ targetTime: 18, currentTime: 18 }] }
    });

    const historicalResp = await sendReq("yt-frame-hist", "frame", { tabId: 12, targetTime: 30 });
    expect(historicalResp).toMatchObject({
      ok: false,
      error: expect.stringContaining("暂不支持指定时间点截帧")
    });
  });
});
