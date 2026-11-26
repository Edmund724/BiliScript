// @vitest-environment jsdom
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createYoutubeScriptingHandlers,
  type YoutubeScriptingInjectionResult
} from "../../extension/core/youtube-scripting-handlers.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";
import { NORMAL_PAGE_URL } from "../setup.js";

function setCrossOriginLocation(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure: (opts: { url: string }) => void } }).jsdom.reconfigure({
    url
  });
}

type FakeInjection =
  | { target: { tabId: number }; world: "MAIN"; files: string[] }
  | { target: { tabId: number }; world: "MAIN"; func: (...args: never[]) => unknown; args?: unknown[] };

function createFakeExecuteScript() {
  return vi.fn(async (injection: FakeInjection): Promise<YoutubeScriptingInjectionResult[]> => {
    if ("func" in injection) {
      const fn = injection.func as (...args: unknown[]) => unknown;
      return [{ result: await fn(...(injection.args ?? [])) }];
    }
    return [{}];
  });
}

describe("youtube-scripting-handlers MAIN 世界脚本桥接", () => {
  afterAll(() => {
    setCrossOriginLocation(NORMAL_PAGE_URL);
  });

  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
    const win = window as unknown as Record<string, unknown>;
    delete win.ytInitialPlayerResponse;
    delete win.ytInitialData;
    delete win.ytcfg;
  });

  describe("发起方与脚本环境守卫", () => {
    it("缺失 sender.tab.id 时三条处理器均同步拒绝且不调用 executeScript", () => {
      const executeScript = createFakeExecuteScript();
      const handlers = createYoutubeScriptingHandlers({ scripting: { executeScript } });

      const rSnapshot = vi.fn();
      expect(handlers.pageSnapshot({ type: "youtube-page-snapshot" }, {}, rSnapshot)).toBe("answered");
      expect(rSnapshot).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

      const rPot = vi.fn();
      expect(
        handlers.captureTimedtextPot({ type: "youtube-capture-timedtext-pot" }, {}, rPot)
      ).toBe("answered");
      expect(rPot).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

      const rSabr = vi.fn();
      expect(
        handlers.ensureSabrWorker({ type: "youtube-ensure-sabr-worker" }, {}, rSabr)
      ).toBe("answered");
      expect(rSabr).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

      expect(executeScript).not.toHaveBeenCalled();
    });

    it.each([
      "https://www.bilibili.com/video/BV1abc000000/",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/"
    ])("非 YouTube watch 页拒绝三条处理器：%s", (url) => {
      const executeScript = createFakeExecuteScript();
      const handlers = createYoutubeScriptingHandlers({ scripting: { executeScript } });
      const sender: MessageSender = { tab: { id: 9, url } };

      const rSnapshot = vi.fn();
      expect(handlers.pageSnapshot({ type: "youtube-page-snapshot" }, sender, rSnapshot)).toBe("answered");
      expect(rSnapshot).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

      const rPot = vi.fn();
      expect(
        handlers.captureTimedtextPot({ type: "youtube-capture-timedtext-pot" }, sender, rPot)
      ).toBe("answered");
      expect(rPot).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

      const rSabr = vi.fn();
      expect(
        handlers.ensureSabrWorker({ type: "youtube-ensure-sabr-worker" }, sender, rSabr)
      ).toBe("answered");
      expect(rSabr).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

      expect(executeScript).not.toHaveBeenCalled();
    });

    it("scripting API 不可用时三条处理器均同步返回失败", () => {
      const handlers = createYoutubeScriptingHandlers({});
      const sender: MessageSender = {
        tab: { id: 12, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
      };

      const rSnapshot = vi.fn();
      expect(handlers.pageSnapshot({ type: "youtube-page-snapshot" }, sender, rSnapshot)).toBe("answered");
      expect(rSnapshot).toHaveBeenCalledWith({ ok: false, error: "scripting API 不可用" });

      const rPot = vi.fn();
      expect(
        handlers.captureTimedtextPot({ type: "youtube-capture-timedtext-pot" }, sender, rPot)
      ).toBe("answered");
      expect(rPot).toHaveBeenCalledWith({ ok: false, error: "scripting API 不可用" });

      const rSabr = vi.fn();
      expect(
        handlers.ensureSabrWorker({ type: "youtube-ensure-sabr-worker" }, sender, rSabr)
      ).toBe("answered");
      expect(rSabr).toHaveBeenCalledWith({ ok: false, error: "scripting API 不可用" });
    });
  });

  describe("pageSnapshot", () => {
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

      const executeScript = createFakeExecuteScript();
      const handlers = createYoutubeScriptingHandlers({ scripting: { executeScript } });
      const sendResponse = vi.fn();

      expect(
        handlers.pageSnapshot(
          { type: "youtube-page-snapshot" },
          { tab: { id: 19, url: watchUrl } },
          sendResponse
        )
      ).toBe("hold");
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
        commentsContinuation: "",
        commentsDisabled: false,
        observedTimedtextUrls: [
          "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=abc"
        ]
      });
      expect(() => JSON.stringify(response.snapshot)).not.toThrow();

      perfSpy.mockRestore();
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
      const handlers = createYoutubeScriptingHandlers({
        scripting: { executeScript: createFakeExecuteScript() }
      });

      const sendResponse = vi.fn();
      handlers.pageSnapshot(
        { type: "youtube-page-snapshot" },
        { tab: { id: 29, url: newUrl } },
        sendResponse
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));

      expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        snapshot: {
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
          commentsContinuation: "",
          commentsDisabled: false,
          observedTimedtextUrls: []
        }
      });

      perfSpy.mockRestore();
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
      const handlers = createYoutubeScriptingHandlers({
        scripting: { executeScript: createFakeExecuteScript() }
      });

      const sendResponse = vi.fn();
      handlers.pageSnapshot(
        { type: "youtube-page-snapshot" },
        { tab: { id: 30, url: watchUrl } },
        sendResponse
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));

      const response = sendResponse.mock.calls[0][0] as {
        ok: boolean;
        snapshot: { duration: number; videoId: string };
      };
      expect(response.ok).toBe(true);
      expect(response.snapshot.videoId).toBe("NEWVID67890");
      expect(response.snapshot.duration).toBe(345);

      perfSpy.mockRestore();
    });

    it("INNERTUBE_CONTEXT.client 缺少 visitorData 时从 ytcfg VISITOR_DATA 浅拷贝补全，且已有 visitorData 不被覆盖", async () => {
      const watchUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      setCrossOriginLocation(watchUrl);
      const win = window as unknown as { ytcfg?: unknown };
      const missingVisitorClient = { clientName: "WEB", clientVersion: "2.2026" };
      win.ytcfg = {
        get: (key: string) =>
          key === "INNERTUBE_API_KEY"
            ? "AIzaTestKey"
            : key === "VISITOR_DATA"
              ? "  CgtWaXNpdG9yMTIz  "
              : key === "INNERTUBE_CONTEXT"
                ? { client: missingVisitorClient }
                : undefined
      };
      const perfSpy = vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
      const handlers = createYoutubeScriptingHandlers({
        scripting: { executeScript: createFakeExecuteScript() }
      });

      const sendMissing = vi.fn();
      handlers.pageSnapshot(
        { type: "youtube-page-snapshot" },
        { tab: { id: 31, url: watchUrl } },
        sendMissing
      );
      await vi.waitFor(() => expect(sendMissing).toHaveBeenCalledTimes(1));

      const filledResp = sendMissing.mock.calls[0][0] as {
        ok: boolean;
        snapshot: { innertubeContext: { client: { clientName: string; visitorData?: string } } };
      };
      expect(filledResp.ok).toBe(true);
      expect(filledResp.snapshot.innertubeContext.client).toEqual({
        clientName: "WEB",
        clientVersion: "2.2026",
        visitorData: "CgtWaXNpdG9yMTIz"
      });
      expect(missingVisitorClient).toEqual({ clientName: "WEB", clientVersion: "2.2026" });

      win.ytcfg = {
        get: (key: string) =>
          key === "VISITOR_DATA"
            ? "NEW_VISITOR_IGNORED"
            : key === "INNERTUBE_CONTEXT"
              ? { client: { clientName: "WEB", clientVersion: "2.2026", visitorData: "EXISTING_VISITOR" } }
              : undefined
      };
      const sendExisting = vi.fn();
      handlers.pageSnapshot(
        { type: "youtube-page-snapshot" },
        { tab: { id: 32, url: watchUrl } },
        sendExisting
      );
      await vi.waitFor(() => expect(sendExisting).toHaveBeenCalledTimes(1));

      const existingResp = sendExisting.mock.calls[0][0] as {
        ok: boolean;
        snapshot: { innertubeContext: { client: { visitorData?: string } } };
      };
      expect(existingResp.ok).toBe(true);
      expect(existingResp.snapshot.innertubeContext.client.visitorData).toBe("EXISTING_VISITOR");

      perfSpy.mockRestore();
    });

    it("从 engagementPanels 提取 PAmodern_transcript_view 的 modernTranscriptParams", async () => {
      const watchUrl = "https://www.youtube.com/watch?v=aircAruvnKk";
      setCrossOriginLocation(watchUrl);
      const win = window as unknown as { ytInitialData?: unknown; ytcfg?: unknown };
      win.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: "aircAruvnKk" } },
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              panelIdentifier: "engagement-panel-structured-description",
              content: {
                structuredDescriptionContentRenderer: {
                  items: [
                    {
                      videoDescriptionTranscriptSectionRenderer: {
                        primaryButton: {
                          buttonRenderer: {
                            command: {
                              commandExecutorCommand: {
                                commands: [
                                  {
                                    updateEngagementPanelContentCommand: {
                                      contentSourcePanelIdentifier: { tag: "PAmodern_transcript_view" },
                                      globalConfiguration: { params: "qgkPCgthaXJjQXJ1dm5LaxgB" }
                                    }
                                  }
                                ]
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        ]
      };
      win.ytcfg = { get: (k: string) => (k === "INNERTUBE_API_KEY" ? "AIzaKey" : undefined) };
      const perfSpy = vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
      const handlers = createYoutubeScriptingHandlers({
        scripting: { executeScript: createFakeExecuteScript() }
      });

      const sendResponse = vi.fn();
      handlers.pageSnapshot(
        { type: "youtube-page-snapshot" },
        { tab: { id: 35, url: watchUrl } },
        sendResponse
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));

      const resp = sendResponse.mock.calls[0][0] as {
        ok: boolean;
        snapshot: { modernTranscriptParams?: string };
      };
      expect(resp.ok).toBe(true);
      expect(resp.snapshot.modernTranscriptParams).toBe("qgkPCgthaXJjQXJ1dm5LaxgB");

      perfSpy.mockRestore();
    });

    it("executeScript 返回空快照或抛错时返回可读失败结果", async () => {
      const watchUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const sender: MessageSender = { tab: { id: 36, url: watchUrl } };

      const emptyHandlers = createYoutubeScriptingHandlers({
        scripting: { executeScript: vi.fn(async () => [{ result: null }]) }
      });
      const rEmpty = vi.fn();
      expect(emptyHandlers.pageSnapshot({ type: "youtube-page-snapshot" }, sender, rEmpty)).toBe("hold");
      await vi.waitFor(() =>
        expect(rEmpty).toHaveBeenCalledWith({ ok: false, error: "未读取到 YouTube 页面播放器快照" })
      );

      const errHandlers = createYoutubeScriptingHandlers({
        scripting: {
          executeScript: vi.fn(async () => {
            throw new Error("Tab was closed");
          })
        }
      });
      const rErr = vi.fn();
      expect(errHandlers.pageSnapshot({ type: "youtube-page-snapshot" }, sender, rErr)).toBe("hold");
      await vi.waitFor(() =>
        expect(rErr).toHaveBeenCalledWith({ ok: false, error: "Tab was closed" })
      );
    });
  });

  describe("captureTimedtextPot", () => {
    it("未起播态直接跳过零副作用；已起播态静默取 pot 并完整还原 CC 与本地偏好", async () => {
      const watchUrl = "https://www.youtube.com/watch?v=aircAruvnKk";
      setCrossOriginLocation(watchUrl);

      const playerEl = document.createElement("div");
      playerEl.id = "movie_player";
      const ccBtn = document.createElement("button");
      ccBtn.className = "ytp-subtitles-button";
      ccBtn.setAttribute("aria-pressed", "false");
      document.body.append(playerEl, ccBtn);

      let playerState = -1;
      let currentTrack: Record<string, unknown> = {};
      const loadModule = vi.fn();
      const unloadModule = vi.fn();
      const capturedEntries: PerformanceEntry[] = [];
      const setOption = vi.fn((_mod: string, opt: string, val: unknown) => {
        if (opt === "track") {
          currentTrack = (val as Record<string, unknown>) || {};
          if (currentTrack.languageCode) {
            ccBtn.setAttribute("aria-pressed", "true");
            localStorage.setItem(
              "yt-player-caption-sticky-language",
              JSON.stringify({ data: currentTrack.languageCode })
            );
            sessionStorage.setItem(
              "yt-player-caption-language-preferences",
              JSON.stringify({ data: [currentTrack.languageCode] })
            );
            capturedEntries.push({
              name: "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&pot=SILENT_POT_123&potc=1&c=WEB"
            } as PerformanceEntry);
          } else {
            ccBtn.setAttribute("aria-pressed", "false");
          }
        }
      });

      Object.assign(playerEl, {
        getVideoData: () => ({ video_id: "aircAruvnKk" }),
        getPlayerState: () => playerState,
        loadModule,
        unloadModule,
        getOption: (_mod: string, opt: string) =>
          opt === "tracklist"
            ? [
                { languageCode: "ar", kind: "" },
                { languageCode: "en", kind: "" }
              ]
            : currentTrack,
        setOption
      });

      const perfSpy = vi.spyOn(performance, "getEntriesByType").mockImplementation(() => [...capturedEntries]);
      const executeScript = createFakeExecuteScript();
      const handlers = createYoutubeScriptingHandlers({ scripting: { executeScript } });

      const sendUnstarted = vi.fn();
      expect(
        handlers.captureTimedtextPot(
          {
            type: "youtube-capture-timedtext-pot",
            expectedVideoId: " aircAruvnKk ",
            languageCode: " en ",
            kind: " "
          },
          { tab: { id: 40, url: watchUrl } },
          sendUnstarted
        )
      ).toBe("hold");
      expect(executeScript).toHaveBeenCalledWith({
        target: { tabId: 40 },
        world: "MAIN",
        func: expect.any(Function),
        args: ["aircAruvnKk", "en", ""]
      });
      await vi.waitFor(() => expect(sendUnstarted).toHaveBeenCalledTimes(1));
      expect(sendUnstarted.mock.calls[0][0]).toEqual({
        ok: true,
        observedTimedtextUrls: [],
        skippedReason: "player-unstarted"
      });
      expect(loadModule).not.toHaveBeenCalled();
      expect(setOption).not.toHaveBeenCalled();

      playerState = 2;
      localStorage.setItem("yt-player-caption-persistence", JSON.stringify({ data: "false" }));
      const sendActive = vi.fn();
      handlers.captureTimedtextPot(
        { type: "youtube-capture-timedtext-pot", expectedVideoId: "aircAruvnKk", languageCode: "en" },
        { tab: { id: 40, url: watchUrl } },
        sendActive
      );
      await vi.waitFor(() => expect(sendActive).toHaveBeenCalledTimes(1));
      expect(sendActive.mock.calls[0][0]).toEqual({
        ok: true,
        observedTimedtextUrls: [
          "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en&pot=SILENT_POT_123&potc=1&c=WEB"
        ]
      });
      expect(ccBtn.getAttribute("aria-pressed")).toBe("false");
      expect(unloadModule).toHaveBeenCalledWith("captions");
      expect(localStorage.getItem("yt-player-caption-sticky-language")).toBeNull();
      expect(sessionStorage.getItem("yt-player-caption-language-preferences")).toBeNull();
      expect(localStorage.getItem("yt-player-caption-persistence")).toBe(JSON.stringify({ data: "false" }));
      expect(document.getElementById("__biliscript_silent_cc_hide")).toBeNull();

      perfSpy.mockRestore();
    });
  });

  describe("ensureSabrWorker", () => {
    it("合法 YouTube watch 页以 world=MAIN 注入 youtube-sabr-worker.main.js", async () => {
      const executeScript = createFakeExecuteScript();
      const handlers = createYoutubeScriptingHandlers({ scripting: { executeScript } });
      const sendResponse = vi.fn();

      expect(
        handlers.ensureSabrWorker(
          { type: "youtube-ensure-sabr-worker" },
          { tab: { id: 52, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } },
          sendResponse
        )
      ).toBe("hold");

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
      expect(executeScript).toHaveBeenCalledWith({
        target: { tabId: 52 },
        world: "MAIN",
        files: ["entry/youtube-sabr-worker.main.js"]
      });
    });

    it("executeScript 注入失败时返回可读错误", async () => {
      const executeScript = vi.fn(async () => {
        throw new Error("Cannot access contents of url");
      });
      const handlers = createYoutubeScriptingHandlers({ scripting: { executeScript } });
      const sendResponse = vi.fn();

      expect(
        handlers.ensureSabrWorker(
          { type: "youtube-ensure-sabr-worker" },
          { tab: { id: 53, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } },
          sendResponse
        )
      ).toBe("hold");

      await vi.waitFor(() =>
        expect(sendResponse).toHaveBeenCalledWith({
          ok: false,
          error: "Cannot access contents of url"
        })
      );
    });
  });
});
