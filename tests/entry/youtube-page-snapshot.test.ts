import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, setupEnvironment } from "../setup.js";

function setCrossOriginLocation(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure: (opts: { url: string }) => void } }).jsdom.reconfigure({
    url
  });
}

const executeScript = vi.fn();

describe("SW youtube-page-snapshot MAIN 世界桥接", () => {
  let onMessageListener: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | void;

  beforeAll(async () => {
    setupEnvironment();
    const onMessageAddListener = vi.fn();
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      runtime: {
        ...globalThis.chrome.runtime,
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: vi.fn(),
        getManifest: () => ({ version: "9.9.9" }),
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onConnect: { addListener: vi.fn() },
        onMessage: { addListener: onMessageAddListener }
      },
      scripting: { executeScript },
      tabs: {
        ...globalThis.chrome.tabs,
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() }
      },
      action: {
        ...globalThis.chrome.action,
        onClicked: { addListener: vi.fn() }
      },
      commands: {
        ...globalThis.chrome.commands,
        onCommand: { addListener: vi.fn() }
      },
      alarms: {
        ...globalThis.chrome.alarms,
        onAlarm: { addListener: vi.fn() }
      },
      storage: {
        ...globalThis.chrome.storage,
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    await import("../../extension/entry/background.js");
    onMessageListener = onMessageAddListener.mock.calls[0][0] as typeof onMessageListener;
  });

  afterAll(() => {
    setCrossOriginLocation(NORMAL_PAGE_URL);
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    executeScript.mockReset();
    document.body.innerHTML = "";
  });

  it("缺失 sender.tab.id 时同步拒绝且不调用 executeScript", () => {
    const sendResponse = vi.fn();
    const keepOpen = onMessageListener({ type: "youtube-page-snapshot" }, {}, sendResponse);

    expect(keepOpen).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: expect.any(String)
    });
  });

  it.each([
    "https://www.bilibili.com/video/BV1abc000000/",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/"
  ])("非 YouTube watch 页拒绝采集：%s", (url) => {
    const sendResponse = vi.fn();
    const keepOpen = onMessageListener(
      { type: "youtube-page-snapshot" },
      { tab: { id: 9, url } },
      sendResponse
    );

    expect(keepOpen).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: expect.any(String)
    });
  });

  it("合法 YouTube watch 页调用 world=MAIN 采集并输出纯 JSON 快照", async () => {
    const watchUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    setCrossOriginLocation(watchUrl);

    const playerEl = document.createElement("div");
    playerEl.id = "movie_player";
    Object.assign(playerEl, {
      getPlayerResponse: () => ({
        videoDetails: {
          videoId: "dQw4w9WgXcQ",
          title: "Never Gonna Give You Up",
          author: "Rick Astley",
          shortDescription: "Official video",
          lengthSeconds: "212",
          isLiveContent: false,
          isLive: false
        },
        microformat: {
          playerMicroformatRenderer: {
            publishDate: "2009-10-25"
          }
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
                languageCode: "en",
                name: { simpleText: "English" },
                vssId: ".en",
                isTranslatable: true
              },
              {
                baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&kind=asr&lang=en",
                languageCode: "en",
                name: { runs: [{ text: "English (auto-generated)" }] },
                kind: "asr",
                vssId: "a.en"
              }
            ]
          }
        }
      })
    });
    document.body.appendChild(playerEl);

    const win = window as unknown as Record<string, unknown>;
    win.ytInitialData = {
      playerOverlays: {
        playerOverlayRenderer: {
          decoratedPlayerBarRenderer: {
            decoratedPlayerBarRenderer: {
              playerBar: {
                multiMarkersPlayerBarRenderer: {
                  markersMap: [
                    {
                      key: "DESCRIPTION_CHAPTERS",
                      value: {
                        chapters: [
                          {
                            chapterRenderer: {
                              title: { simpleText: "Intro" },
                              timeRangeStartMillis: 0
                            }
                          },
                          {
                            chapterRenderer: {
                              title: { runs: [{ text: "Chorus" }] },
                              timeRangeStartMillis: 43000
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      },
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            panelIdentifier: "engagement-panel-searchable-transcript",
            content: {
              continuationItemRenderer: {
                continuationEndpoint: {
                  getTranscriptEndpoint: {
                    params: "CgtBU1JfcGFyYW1z"
                  }
                }
              }
            }
          }
        }
      ]
    };
    win.ytcfg = {
      get: (key: string) =>
        key === "INNERTUBE_API_KEY"
          ? "AIzaTestKey"
          : key === "INNERTUBE_CONTEXT"
            ? { client: { clientName: "WEB", clientVersion: "2.2026" }, ignoreFn: () => 1 }
            : undefined
    };
    const perfSpy = vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=abc" } as PerformanceEntry,
      { name: "https://www.youtube.com/api/timedtext?v=OTHERVIDEO1&lang=en" } as PerformanceEntry
    ]);

    executeScript.mockImplementation(async (injection: { func: () => unknown }) => [
      { result: injection.func() }
    ]);

    const sendResponse = vi.fn();
    const keepOpen = onMessageListener(
      { type: "youtube-page-snapshot" },
      { tab: { id: 19, url: watchUrl } },
      sendResponse
    );

    expect(keepOpen).toBe(true);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 19 },
      world: "MAIN",
      func: expect.any(Function)
    });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    const response = sendResponse.mock.calls[0][0] as { ok: boolean; snapshot: Record<string, unknown> };
    expect(response.ok).toBe(true);
    expect(response.snapshot).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      author: "Rick Astley",
      description: "Official video",
      duration: 212,
      publishDate: "2009-10-25",
      isLiveContent: false,
      isLiveNow: false,
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
          languageCode: "en",
          name: "English",
          vssId: ".en",
          isTranslatable: true
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&kind=asr&lang=en",
          languageCode: "en",
          name: "English (auto-generated)",
          kind: "asr",
          vssId: "a.en"
        }
      ],
      chapters: [
        { title: "Intro", from: 0, to: 43 },
        { title: "Chorus", from: 43, to: 212 }
      ],
      innertubeContext: { client: { clientName: "WEB", clientVersion: "2.2026" } },
      innertubeApiKey: "AIzaTestKey",
      transcriptParams: "CgtBU1JfcGFyYW1z",
      observedTimedtextUrls: [
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=abc"
      ]
    });
    expect(() => JSON.stringify(response.snapshot)).not.toThrow();

    perfSpy.mockRestore();
    delete win.ytInitialData;
    delete win.ytcfg;
  });

  it("SPA 切至新视频时，旧视频残留 ytInitialPlayerResponse / ytInitialData / movie_player 数据不得污染新快照", async () => {
    const newUrl = "https://www.youtube.com/watch?v=NEWVID67890";
    setCrossOriginLocation(newUrl);

    const playerEl = document.createElement("div");
    playerEl.id = "movie_player";
    Object.assign(playerEl, {
      getPlayerResponse: () => ({
        videoDetails: {
          videoId: "OLDVID12345",
          title: "Old Video Title",
          author: "Old Author",
          shortDescription: "Old description",
          lengthSeconds: "999"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://www.youtube.com/api/timedtext?v=OLDVID12345&lang=en",
                languageCode: "en",
                name: { simpleText: "Old Track" }
              }
            ]
          }
        }
      }),
      getVideoData: () => ({
        video_id: "OLDVID12345",
        title: "Old Player Data Title",
        author: "Old Player Author"
      }),
      getDuration: () => 999
    });
    document.body.appendChild(playerEl);

    const win = window as unknown as Record<string, unknown>;
    win.ytInitialPlayerResponse = {
      videoDetails: {
        videoId: "OLDVID12345",
        title: "Old Initial Player Title",
        author: "Old Initial Author"
      }
    };
    win.ytInitialData = {
      currentVideoEndpoint: {
        watchEndpoint: {
          videoId: "OLDVID12345"
        }
      },
      playerOverlays: {
        playerOverlayRenderer: {
          decoratedPlayerBarRenderer: {
            decoratedPlayerBarRenderer: {
              playerBar: {
                multiMarkersPlayerBarRenderer: {
                  markersMap: [
                    {
                      key: "DESCRIPTION_CHAPTERS",
                      value: {
                        chapters: [
                          {
                            chapterRenderer: {
                              title: { simpleText: "Old Chapter" },
                              timeRangeStartMillis: 0
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      },
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            panelIdentifier: "engagement-panel-searchable-transcript",
            content: {
              continuationItemRenderer: {
                continuationEndpoint: {
                  getTranscriptEndpoint: {
                    params: "OLD_TRANSCRIPT_PARAMS"
                  }
                }
              }
            }
          }
        }
      ]
    };

    const perfSpy = vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
    executeScript.mockImplementation(async (injection: { func: () => unknown }) => [
      { result: injection.func() }
    ]);

    const sendResponse = vi.fn();
    onMessageListener({ type: "youtube-page-snapshot" }, { tab: { id: 29, url: newUrl } }, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));

    const response = sendResponse.mock.calls[0][0] as { ok: boolean; snapshot: Record<string, unknown> };
    expect(response.ok).toBe(true);
    expect(response.snapshot).toEqual({
      videoId: "NEWVID67890",
      title: "",
      author: "",
      description: "",
      duration: 0,
      publishDate: "",
      isLiveContent: false,
      isLiveNow: false,
      captionTracks: [],
      chapters: [],
      innertubeContext: null,
      innertubeApiKey: "",
      transcriptParams: "",
      observedTimedtextUrls: []
    });

    perfSpy.mockRestore();
    delete win.ytInitialPlayerResponse;
    delete win.ytInitialData;
  });

  it("videoDetails.lengthSeconds 为空串或 0 时，正确回落到匹配视频的 movie_player.getDuration()", async () => {
    const watchUrl = "https://www.youtube.com/watch?v=NEWVID67890";
    setCrossOriginLocation(watchUrl);

    const playerEl = document.createElement("div");
    playerEl.id = "movie_player";
    Object.assign(playerEl, {
      getPlayerResponse: () => ({
        videoDetails: {
          videoId: "NEWVID67890",
          title: "New Video",
          author: "Creator",
          lengthSeconds: "0"
        }
      }),
      getVideoData: () => ({
        video_id: "NEWVID67890"
      }),
      getDuration: () => 345
    });
    document.body.appendChild(playerEl);

    const perfSpy = vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
    executeScript.mockImplementation(async (injection: { func: () => unknown }) => [
      { result: injection.func() }
    ]);

    const sendResponse = vi.fn();
    onMessageListener({ type: "youtube-page-snapshot" }, { tab: { id: 30, url: watchUrl } }, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));

    const response = sendResponse.mock.calls[0][0] as { ok: boolean; snapshot: { duration: number; videoId: string } };
    expect(response.ok).toBe(true);
    expect(response.snapshot.videoId).toBe("NEWVID67890");
    expect(response.snapshot.duration).toBe(345);

    perfSpy.mockRestore();
  });
});
