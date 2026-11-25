// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as biliGateway from "../../extension/bilibili/gateway.js";
import { clipState, state } from "../../extension/core/state.js";
import { resolveChapterSource } from "../../extension/shared/chapter-outline.js";
import { refreshHotComments } from "../../extension/subtitle/core.js";
import {
  clearYoutubeGatewayCacheForTests,
  fetchYoutubeHotComments
} from "../../extension/youtube/gateway.js";
import {
  fetchYoutubeHotCommentsFromNext,
  parseYoutubeCommentsFromNextPayload,
  parseYoutubeLikeCount
} from "../../extension/youtube/hot-comments.js";
import {
  setYoutubeMainWorldReaderForTests,
  setYoutubeSameOriginFetchForTests,
  type YoutubeFetchResponse,
  type YoutubePageSnapshot,
  type YoutubeSameOriginFetch
} from "../../extension/youtube/main-world-bridge.js";

function makeJsonResponse(data: unknown, status = 200): YoutubeFetchResponse {
  const raw = data === null ? "" : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => data
  };
}

function makeSnapshot(overrides: Partial<YoutubePageSnapshot> = {}): YoutubePageSnapshot {
  return {
    videoId: "dQw4w9WgXcQ",
    title: "Demo Video",
    author: "Demo Channel",
    description: "No timestamps here",
    duration: 300,
    publishDate: "2026-01-01",
    isLiveContent: false,
    isLiveNow: false,
    captionTracks: [],
    chapters: [],
    innertubeContext: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20260401.00.00",
        visitorData: "Cgt2aXNpdG9yLWRhdGE"
      }
    },
    innertubeApiKey: "AIzaSyDemoKey",
    transcriptParams: "",
    commentsContinuation: "Eg0SC2RRdzR3OVdnWGNRIAYyBAgAEAE%3D",
    commentsDisabled: false,
    observedTimedtextUrls: [],
    ...overrides
  };
}

const MODERN_NEXT_PAYLOAD = {
  onResponseReceivedEndpoints: [
    {
      reloadContinuationItemsCommand: {
        slot: "RELOAD_CONTINUATION_SLOT_BODY",
        continuationItems: [
          {
            commentThreadRenderer: {
              renderingPriority: "RENDERING_PRIORITY_PINNED_COMMENT",
              commentViewModel: {
                commentViewModel: {
                  commentKey: "key-pinned"
                }
              }
            }
          },
          {
            commentThreadRenderer: {
              commentViewModel: {
                commentViewModel: {
                  commentKey: "key-top-1"
                }
              }
            }
          },
          {
            commentThreadRenderer: {
              commentViewModel: {
                commentViewModel: {
                  commentKey: "key-dup"
                }
              }
            }
          }
        ]
      }
    }
  ],
  frameworkUpdates: {
    entityBatchUpdate: {
      mutations: [
        {
          payload: {
            commentEntityPayload: {
              key: "key-pinned",
              properties: {
                content: {
                  content: "00:00 Intro\n01:15 Architecture\n03:40 Summary"
                }
              },
              author: { displayName: "@creator" },
              toolbar: { likeCountNotliked: "1.2K" }
            }
          }
        },
        {
          payload: {
            commentEntityPayload: {
              key: "key-top-1",
              properties: {
                content: {
                  content: "Very clear walkthrough!"
                }
              },
              author: { displayName: "@viewerA" },
              toolbar: { likeCountNotliked: "3.4万" }
            }
          }
        },
        {
          payload: {
            commentEntityPayload: {
              key: "key-dup",
              properties: {
                content: {
                  content: "Very clear walkthrough!"
                }
              },
              author: { displayName: "@viewerA" },
              toolbar: { likeCountNotliked: "3.4万" }
            }
          }
        }
      ]
    }
  }
};

describe("YouTube 热门评论解析与抓取", () => {
  beforeEach(() => {
    clearYoutubeGatewayCacheForTests();
    setYoutubeMainWorldReaderForTests(null);
    setYoutubeSameOriginFetchForTests(null);
    clipState.setSite("bilibili");
    clipState.setBvid("");
    clipState.setHotComments([]);
    clipState.setHotCommentsNotice("");
  });

  afterEach(() => {
    clearYoutubeGatewayCacheForTests();
    setYoutubeMainWorldReaderForTests(null);
    setYoutubeSameOriginFetchForTests(null);
    vi.restoreAllMocks();
  });

  it("parseYoutubeLikeCount 正确解析数字、千分位、英文 K/M/B 与中文万/亿单位", () => {
    expect(parseYoutubeLikeCount(42)).toBe(42);
    expect(parseYoutubeLikeCount("1,234")).toBe(1234);
    expect(parseYoutubeLikeCount("1.2K")).toBe(1200);
    expect(parseYoutubeLikeCount("2.5M")).toBe(2500000);
    expect(parseYoutubeLikeCount("3.4万")).toBe(34000);
    expect(parseYoutubeLikeCount("1.5千")).toBe(1500);
    expect(parseYoutubeLikeCount("1.2亿")).toBe(120000000);
    expect(parseYoutubeLikeCount("856 likes")).toBe(856);
    expect(parseYoutubeLikeCount("")).toBe(0);
    expect(parseYoutubeLikeCount(null)).toBe(0);
  });

  it("parseYoutubeCommentsFromNextPayload 解析现代 commentViewModel + frameworkUpdates 并保留置顶与多行时间戳", () => {
    const comments = parseYoutubeCommentsFromNextPayload(MODERN_NEXT_PAYLOAD, 20);
    expect(comments).toEqual([
      {
        uname: "@creator",
        like: 1200,
        message: "00:00 Intro\n01:15 Architecture\n03:40 Summary"
      },
      {
        uname: "@viewerA",
        like: 34000,
        message: "Very clear walkthrough!"
      }
    ]);

    const chapterSource = resolveChapterSource("", comments, []);
    expect(chapterSource.kind).toBe("outline");
    expect(chapterSource.chapters.map((c) => c.title)).toEqual([
      "Intro",
      "Architecture",
      "Summary"
    ]);
  });

  it("parseYoutubeCommentsFromNextPayload 兼容旧版 commentRenderer 结构并尊重 limit 上限", () => {
    const legacyPayload = {
      onResponseReceivedEndpoints: [
        {
          appendContinuationItemsAction: {
            continuationItems: [
              {
                commentThreadRenderer: {
                  comment: {
                    commentRenderer: {
                      authorText: { simpleText: "Alice" },
                      contentText: { runs: [{ text: "First " }, { text: "comment" }] },
                      voteCount: { simpleText: "2.3K" }
                    }
                  }
                }
              },
              {
                commentThreadRenderer: {
                  comment: {
                    commentRenderer: {
                      authorText: { simpleText: "Bob" },
                      contentText: { simpleText: "Second comment" },
                      likeCount: 15
                    }
                  }
                }
              }
            ]
          }
        }
      ]
    };

    expect(parseYoutubeCommentsFromNextPayload(legacyPayload, 1)).toEqual([
      { uname: "Alice", like: 2300, message: "First comment" }
    ]);
  });

  it("fetchYoutubeHotCommentsFromNext 发送同源 WEB youtubei/v1/next 请求并拦截移动端伪装", async () => {
    const fetchMock = vi.fn<YoutubeSameOriginFetch>(async () => makeJsonResponse(MODERN_NEXT_PAYLOAD));
    const snapshot = makeSnapshot();

    const comments = await fetchYoutubeHotCommentsFromNext({
      innertubeContext: snapshot.innertubeContext,
      innertubeApiKey: snapshot.innertubeApiKey,
      commentsContinuation: snapshot.commentsContinuation!,
      limit: 20,
      fetchFn: fetchMock
    });

    expect(comments).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.youtube.com/youtubei/v1/next?key=AIzaSyDemoKey");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": "1",
      "X-Origin": "https://www.youtube.com",
      "X-Youtube-Client-Version": "2.20260401.00.00",
      "X-Goog-Visitor-Id": "Cgt2aXNpdG9yLWRhdGE"
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      context: snapshot.innertubeContext,
      continuation: snapshot.commentsContinuation
    });

    await expect(
      fetchYoutubeHotCommentsFromNext({
        innertubeContext: { client: { clientName: "ANDROID" } },
        commentsContinuation: "token",
        fetchFn: fetchMock
      })
    ).rejects.toThrow("禁止伪装 ANDROID InnerTube 客户端");
  });

  it("fetchYoutubeHotCommentsFromNext 在 HTTP 错误或网络异常时抛出可读错误", async () => {
    const snapshot = makeSnapshot();
    await expect(
      fetchYoutubeHotCommentsFromNext({
        innertubeContext: snapshot.innertubeContext,
        commentsContinuation: snapshot.commentsContinuation!,
        fetchFn: async () => makeJsonResponse({}, 429)
      })
    ).rejects.toThrow("热评请求失败：HTTP 429");

    await expect(
      fetchYoutubeHotCommentsFromNext({
        innertubeContext: snapshot.innertubeContext,
        commentsContinuation: snapshot.commentsContinuation!,
        fetchFn: async () => {
          throw new Error("network down");
        }
      })
    ).rejects.toThrow("热评请求失败：network down");
  });

  it("评论已关闭或无 continuation 时静默返回空数组且不发起网络请求", async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(MODERN_NEXT_PAYLOAD));
    setYoutubeSameOriginFetchForTests(fetchMock);
    setYoutubeMainWorldReaderForTests(async () =>
      makeSnapshot({ commentsContinuation: "", commentsDisabled: true })
    );

    const comments = await fetchYoutubeHotComments(20, { videoId: "dQw4w9WgXcQ" });
    expect(comments).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshHotComments 在 YouTube 站点走 youtubei/v1/next 而不触发 B 站热评接口", async () => {
    setYoutubeMainWorldReaderForTests(async () => makeSnapshot());
    setYoutubeSameOriginFetchForTests(async () => makeJsonResponse(MODERN_NEXT_PAYLOAD));
    const biliSpy = vi.spyOn(biliGateway, "fetchHotComments");

    clipState.setSite("youtube");
    clipState.setBvid("dQw4w9WgXcQ");

    await refreshHotComments({ refreshComments: true });

    expect(biliSpy).not.toHaveBeenCalled();
    expect(state.clip.hotComments).toHaveLength(2);
    expect(state.clip.hotComments[0].uname).toBe("@creator");
    expect(state.clip.hotCommentsNotice).toBe("");
  });
});
