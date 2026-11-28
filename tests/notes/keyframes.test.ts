// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { OFFSCREEN_CHAT_PORT_NAME } from "../../extension/chat/protocol.js";
import type { ChatPortMessage, CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import { linkifyNoteTimestamps } from "../../extension/notes/template.js";
import {
  DEFAULT_NOTE_KEYFRAME_CAPTION,
  MAX_NOTE_KEYFRAMES,
  fitKeyframeDimensions,
  parseNoteKeyframeMarkerLine,
  reencodeKeyframeDataUrl,
  resolveNoteKeyframes,
  sanitizeKeyframeAlt,
  type NoteKeyframeHistoricalSession
} from "../../extension/notes/keyframes.js";
import { clearTurnCapturedFrameCache } from "../../extension/notes/turn-frame-cache.js";

beforeEach(() => {
  resetModuleState();
  clearTurnCapturedFrameCache();
  document.body.innerHTML = "";
});

afterEach(() => {
  clearTurnCapturedFrameCache();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("notes/keyframes 占位解析与 alt 清洗", () => {
  it("解析 MM:SS、HH:MM:SS、缺省图注与非法时钟", () => {
    expect(parseNoteKeyframeMarkerLine("{{frame:03:15 | 缩放点积结构}}")).toEqual({
      clock: "03:15",
      seconds: 195,
      caption: "缩放点积结构",
      rawLine: "{{frame:03:15 | 缩放点积结构}}"
    });

    expect(parseNoteKeyframeMarkerLine("  {{ frame : 1:02:05 | 长视频推导 | 第二部分 }}  ")).toEqual({
      clock: "1:02:05",
      seconds: 3725,
      caption: "长视频推导 | 第二部分",
      rawLine: "  {{ frame : 1:02:05 | 长视频推导 | 第二部分 }}  "
    });

    expect(parseNoteKeyframeMarkerLine("{{frame:00:45}}")).toEqual({
      clock: "00:45",
      seconds: 45,
      caption: DEFAULT_NOTE_KEYFRAME_CAPTION,
      rawLine: "{{frame:00:45}}"
    });

    expect(parseNoteKeyframeMarkerLine("{{frame:03:75 | 非法秒数}}")).toBeNull();
    expect(parseNoteKeyframeMarkerLine("正文中混排 {{frame:03:15 | 说明}} 不应解析")).toBeNull();
  });

  it("sanitizeKeyframeAlt 彻底剔除方括号并规整空白", () => {
    expect(sanitizeKeyframeAlt("[03:15] [核心] 架构[v2]\n图示")).toBe("03:15 核心 架构 v2 图示");
    expect(sanitizeKeyframeAlt("[[nested]]")).toBe("nested");
  });
});

describe("notes/keyframes 尺寸缩放与 WebP/JPEG 重编码", () => {
  it("fitKeyframeDimensions 限宽 800 且不放大低分辨率画面", () => {
    expect(fitKeyframeDimensions(1920, 1080, 800)).toEqual({ width: 800, height: 450 });
    expect(fitKeyframeDimensions(800, 450, 800)).toEqual({ width: 800, height: 450 });
    expect(fitKeyframeDimensions(640, 360, 800)).toEqual({ width: 640, height: 360 });
  });

  it("优先编码 image/webp(0.72)，非 WebP 返回值自动回退 image/jpeg(0.75)", async () => {
    const drawImage = vi.fn();
    const toDataURL = vi.fn().mockReturnValueOnce("data:image/webp;base64,WEBP_OK");
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toDataURL
    } as unknown as HTMLCanvasElement;
    const closeBitmap = vi.fn();
    const fakeSource = { close: closeBitmap } as unknown as CanvasImageSource;

    const webpResult = await reencodeKeyframeDataUrl(
      {
        dataUrl: "data:image/jpeg;base64,RAW",
        maxWidth: 800,
        webpQuality: 0.72,
        jpegQuality: 0.75
      },
      {
        decodeImage: vi.fn(async () => ({
          source: fakeSource,
          width: 1920,
          height: 1080,
          dispose: closeBitmap
        })),
        createCanvas: () => fakeCanvas
      }
    );

    expect(webpResult).toBe("data:image/webp;base64,WEBP_OK");
    expect(fakeCanvas.width).toBe(800);
    expect(fakeCanvas.height).toBe(450);
    expect(drawImage).toHaveBeenCalledWith(fakeSource, 0, 0, 800, 450);
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(toDataURL).toHaveBeenCalledWith("image/webp", 0.72);
    expect(closeBitmap).toHaveBeenCalledTimes(1);

    const fallbackToDataURL = vi
      .fn()
      .mockReturnValueOnce("data:image/png;base64,PNG_FALLBACK")
      .mockReturnValueOnce("data:image/jpeg;base64,JPEG_FALLBACK");
    const fallbackCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toDataURL: fallbackToDataURL
    } as unknown as HTMLCanvasElement;

    const jpegResult = await reencodeKeyframeDataUrl(
      {
        dataUrl: "data:image/jpeg;base64,RAW_SMALL",
        maxWidth: 800,
        webpQuality: 0.72,
        jpegQuality: 0.75
      },
      {
        decodeImage: vi.fn(async () => ({
          source: {} as CanvasImageSource,
          width: 640,
          height: 360
        })),
        createCanvas: () => fallbackCanvas
      }
    );

    expect(jpegResult).toBe("data:image/jpeg;base64,JPEG_FALLBACK");
    expect(fallbackCanvas.width).toBe(640);
    expect(fallbackCanvas.height).toBe(360);
    expect(fallbackToDataURL).toHaveBeenNthCalledWith(1, "image/webp", 0.72);
    expect(fallbackToDataURL).toHaveBeenNthCalledWith(2, "image/jpeg", 0.75);
  });
});

describe("notes/keyframes 核心合成、上限、缓存与双站门控", () => {
  it("includeKeyframes 为 false 时零抽帧直通并保留代码块内占位符", async () => {
    const createHistoricalSession = vi.fn();
    const reencodeDataUrl = vi.fn();
    const source = [
      "---",
      'title: "{{frame:00:05 | 忽略frontmatter}}"',
      "---",
      "段落内容",
      "{{frame:03:15 | 架构图}}",
      "```markdown",
      "{{frame:04:00 | 代码块内保留}}",
      "```",
      "{{frame:05:10}}"
    ].join("\n");

    const output = await resolveNoteKeyframes(
      source,
      {
        site: "bilibili",
        bvid: "BV1kf000001",
        videoId: "BV1kf000001",
        cid: "1001",
        pageUrl: "https://www.bilibili.com/video/BV1kf000001/?p=2",
        includeKeyframes: false
      },
      { createHistoricalSession, reencodeDataUrl }
    );

    expect(createHistoricalSession).not.toHaveBeenCalled();
    expect(reencodeDataUrl).not.toHaveBeenCalled();
    expect(output).toContain('title: "{{frame:00:05 | 忽略frontmatter}}"');
    expect(output).toContain("{{frame:04:00 | 代码块内保留}}");
    expect(output).toContain(
      "*▲ [03:15](https://www.bilibili.com/video/BV1kf000001/?p=2&t=195) 架构图*"
    );
    expect(output).toContain(
      `*▲ [05:10](https://www.bilibili.com/video/BV1kf000001/?p=2&t=310) ${DEFAULT_NOTE_KEYFRAME_CAPTION}*`
    );
  });

  it("优先命中 ±2s 本轮已捕获帧缓存且不触发历史抽帧，并输出 Obsidian 兼容语法", async () => {
    const createHistoricalSession = vi.fn();
    const reencodeDataUrl = vi.fn(async ({ dataUrl }: { dataUrl: string }) =>
      dataUrl.replace("data:image/jpeg", "data:image/webp")
    );
    const source = [
      "正文见 [03:15]。",
      "{{frame:03:15 | [核心] 缩放点积[结构]}}"
    ].join("\n");

    const resolved = await resolveNoteKeyframes(
      source,
      {
        site: "bilibili",
        bvid: "BV1cache001",
        videoId: "BV1cache001",
        cid: "2002",
        pageUrl: "https://www.bilibili.com/video/BV1cache001/",
        includeKeyframes: true,
        capturedFrames: [
          { seconds: 193.2, dataUrl: "data:image/jpeg;base64,FAR_FRAME" },
          { seconds: 196.1, dataUrl: "data:image/jpeg;base64,NEAR_FRAME" }
        ]
      },
      { createHistoricalSession, reencodeDataUrl }
    );

    expect(createHistoricalSession).not.toHaveBeenCalled();
    expect(reencodeDataUrl).toHaveBeenCalledTimes(1);
    expect(resolved).toContain("![03:15 核心 缩放点积 结构](data:image/webp;base64,NEAR_FRAME)");
    expect(resolved).toContain(
      "*▲ [03:15](https://www.bilibili.com/video/BV1cache001/?t=195) [核心] 缩放点积[结构]*"
    );

    const linked = linkifyNoteTimestamps(resolved, {
      site: "bilibili",
      bvid: "BV1cache001",
      videoId: "BV1cache001",
      pageUrl: "https://www.bilibili.com/video/BV1cache001/"
    });
    expect(linked).toContain("正文见 [03:15](https://www.bilibili.com/video/BV1cache001/?t=195)。");
    expect(linked).toContain("![03:15 核心 缩放点积 结构](data:image/webp;base64,NEAR_FRAME)");
    expect(linked).toContain(
      "*▲ [03:15](https://www.bilibili.com/video/BV1cache001/?t=195) [核心] 缩放点积[结构]*"
    );
    expect(linked).not.toContain("[[03:15]");
    expect(linked).not.toContain("](https://www.bilibili.com/video/BV1cache001/?t=195)(");
  });

  it("硬上限 6 帧，第 7 帧起自动降级为跳转链接，并复用单一历史抽帧会话且在 finally 中 close", async () => {
    const capture = vi.fn(async (targetTime: number) => [
      {
        jpegBytes: new Uint8Array([targetTime & 0xff]),
        currentTime: targetTime,
        targetTime
      }
    ]);
    const close = vi.fn();
    const createHistoricalSession = vi.fn(
      (): NoteKeyframeHistoricalSession => ({ capture, close })
    );
    const reencodeDataUrl = vi.fn(async ({ dataUrl }: { dataUrl: string }) =>
      `data:image/webp;base64,ENC_${dataUrl.slice(-4)}`
    );

    const markers = Array.from({ length: 8 }, (_, idx) => {
      const minute = String(idx + 1).padStart(2, "0");
      return `{{frame:${minute}:00 | 画面${idx + 1}}}`;
    }).join("\n\n");

    const output = await resolveNoteKeyframes(
      markers,
      {
        site: "bilibili",
        bvid: "BV1cap00001",
        videoId: "BV1cap00001",
        cid: "3003",
        pageUrl: "https://www.bilibili.com/video/BV1cap00001/",
        includeKeyframes: true
      },
      {
        supportsHistoricalFrameCapture: true,
        createHistoricalSession,
        reencodeDataUrl
      }
    );

    expect(MAX_NOTE_KEYFRAMES).toBe(6);
    expect(createHistoricalSession).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(6);
    expect(close).toHaveBeenCalledTimes(1);
    expect(output.match(/!\[[^\]]+\]\(data:image\/webp;base64,/g)).toHaveLength(6);
    expect(output).toContain("*▲ [07:00](https://www.bilibili.com/video/BV1cap00001/?t=420) 画面7*");
    expect(output).toContain("*▲ [08:00](https://www.bilibili.com/video/BV1cap00001/?t=480) 画面8*");
    expect(output).not.toContain("![07:00");
    expect(output).not.toContain("![08:00");
  });

  it("历史抽帧返回三联帧时复用邻近帧缓存，避免重复抓帧", async () => {
    const capture = vi.fn(async (targetTime: number) => [
      { jpegBytes: new Uint8Array([1]), currentTime: targetTime - 2, targetTime },
      { jpegBytes: new Uint8Array([2]), currentTime: targetTime, targetTime },
      { jpegBytes: new Uint8Array([3]), currentTime: targetTime + 2, targetTime }
    ]);
    const close = vi.fn();
    const createHistoricalSession = vi.fn(
      (): NoteKeyframeHistoricalSession => ({ capture, close })
    );
    const reencodeDataUrl = vi.fn(async ({ dataUrl }: { dataUrl: string }) =>
      dataUrl.replace("data:image/jpeg", "data:image/webp")
    );

    const output = await resolveNoteKeyframes(
      "{{frame:01:00 | 第一帧}}\n{{frame:01:02 | 邻近第二帧}}",
      {
        site: "bilibili",
        bvid: "BV1trip0001",
        videoId: "BV1trip0001",
        cid: "4004",
        pageUrl: "https://www.bilibili.com/video/BV1trip0001/",
        includeKeyframes: true
      },
      {
        supportsHistoricalFrameCapture: true,
        createHistoricalSession,
        reencodeDataUrl
      }
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(output.match(/!\[[^\]]+\]\(data:image\/webp;base64,/g)).toHaveLength(2);
  });

  it("YouTube 历史抽帧受限（supportsHistoricalFrameCapture=false）或抓帧异常时优雅降级为纯跳转图注", async () => {
    const createHistoricalSession = vi.fn();
    const reencodeDataUrl = vi.fn(async () => "data:image/webp;base64,CACHED_YT");

    const ytDegraded = await resolveNoteKeyframes(
      "{{frame:01:35 | 演示界面}}\n{{frame:02:10 | 缓存命中画面}}",
      {
        site: "youtube",
        bvid: "_a-B1234567",
        videoId: "_a-B1234567",
        cid: "yt",
        pageUrl: "https://www.youtube.com/watch?v=_a-B1234567",
        includeKeyframes: true,
        capturedFrames: [{ seconds: 130, dataUrl: "data:image/jpeg;base64,HIT" }]
      },
      {
        supportsHistoricalFrameCapture: false,
        createHistoricalSession,
        reencodeDataUrl
      }
    );

    expect(createHistoricalSession).not.toHaveBeenCalled();
    expect(ytDegraded).not.toContain("![01:35");
    expect(ytDegraded).toContain(
      "*▲ [01:35](https://www.youtube.com/watch?v=_a-B1234567&t=95s) 演示界面*"
    );
    expect(ytDegraded).toContain("![02:10 缓存命中画面](data:image/webp;base64,CACHED_YT)");
    expect(ytDegraded).toContain(
      "*▲ [02:10](https://www.youtube.com/watch?v=_a-B1234567&t=130s) 缓存命中画面*"
    );

    const failingCapture = vi
      .fn()
      .mockRejectedValueOnce(new Error("CORS blocked"))
      .mockResolvedValueOnce([{ jpegBytes: new Uint8Array([9]), currentTime: 120, targetTime: 120 }]);
    const close = vi.fn();
    const partialRes = await resolveNoteKeyframes(
      "{{frame:01:00 | 失败帧}}\n{{frame:02:00 | 正常帧}}",
      {
        site: "bilibili",
        bvid: "BV1err00001",
        videoId: "BV1err00001",
        cid: "5005",
        pageUrl: "https://www.bilibili.com/video/BV1err00001/",
        includeKeyframes: true
      },
      {
        supportsHistoricalFrameCapture: true,
        createHistoricalSession: () => ({ capture: failingCapture, close }),
        reencodeDataUrl: async () => "data:image/webp;base64,OK_FRAME"
      }
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(partialRes).not.toContain("![01:00");
    expect(partialRes).toContain("*▲ [01:00](https://www.bilibili.com/video/BV1err00001/?t=60) 失败帧*");
    expect(partialRes).toContain("![02:00 正常帧](data:image/webp;base64,OK_FRAME)");
    expect(partialRes).toContain("*▲ [02:00](https://www.bilibili.com/video/BV1err00001/?t=120) 正常帧*");
  });
});

describe("chat-runtime 对话轮内存帧索引与生命周期隔离", () => {
  it("记录单帧与历史多帧截帧结果、绑定已提交助手消息、永不写入 chrome.storage.sync 并在会话切换/重置时清理", async () => {
    const { createChatRuntime } = await import("../../extension/chat/chat-runtime.js");
    const {
      applyContextSnapshot,
      applyConversationIdentity,
      chatSessionState,
      detachConversationIdentity,
      resetChatSessionStateForTests
    } = await import("../../extension/chat/chat-state.js");
    const {
      getCapturedFramesForHistoryIndex: getIndexFrames,
      getCapturedFramesForMessage: getMessageFrames,
      getLatestCapturedFrames: getLatestFrames
    } = await import("../../extension/notes/turn-frame-cache.js");
    resetChatSessionStateForTests();

    const syncSet = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        sync: { set: syncSet, get: vi.fn() }
      },
      runtime: { lastError: null }
    });

    const postMessage = vi.fn();
    let currentListeners: Array<(msg: unknown) => void> = [];
    const emit = (msg: ChatPortMessage) => {
      currentListeners.slice().forEach((listener) => listener(msg));
    };

    const onTurnCommitted = vi.fn();
    const messages = document.createElement("div");
    const input = document.createElement("textarea");
    const captureCurrentVideoFrame = vi
      .fn()
      .mockResolvedValueOnce({ image: { mime: "image/jpeg", data: "CURR_A" }, currentTime: 42 })
      .mockResolvedValueOnce([
        { image: { mime: "image/jpeg", data: "HIST_A" }, currentTime: 193 },
        { image: { mime: "image/jpeg", data: "HIST_B" }, currentTime: 195 }
      ])
      .mockResolvedValueOnce({ image: { mime: "image/jpeg", data: "ABORTED_A" }, currentTime: 88 })
      .mockResolvedValueOnce({ image: { mime: "image/jpeg", data: "CLIP_A" }, currentTime: 99 });
    const deps: CreateChatRuntimeDeps = {
      messages,
      input,
      store: {
        persistCurrent: vi.fn(async () => {}),
        isCurrent: vi.fn((id: string) => id === chatSessionState.currentConversationId)
      },
      ui: {
        setStreamingUiState: vi.fn(),
        messagesNotice: { show: vi.fn(), clear: vi.fn() },
        inputNotice: { show: vi.fn(), clear: vi.fn() },
        hideHistoryPopover: vi.fn(),
        removeCenteredState: vi.fn(),
        removeSuggestions: vi.fn(),
        showSetupBlockedState: vi.fn(),
        autosizeInput: vi.fn()
      },
      ensureCurrentContextForSend: vi.fn(async () => ({ pass: true as const })),
      getProviderId: () => "test-provider",
      getSelectedModel: () => "test-model",
      canUseVideoFrameTool: vi.fn(async () => true),
      captureCurrentVideoFrame,
      getTimestampNavDeps: () => ({}),
      connectPort: vi.fn(async () => {
        const listeners: Array<(msg: unknown) => void> = [];
        currentListeners = listeners;
        return {
          name: OFFSCREEN_CHAT_PORT_NAME,
          postMessage,
          disconnect: vi.fn(),
          onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
          onDisconnect: { addListener: vi.fn() }
        };
      }),
      onTurnCommitted
    };

    const runtime = createChatRuntime(deps);
    await runtime.sendTurn("请整理结构化视频笔记");

    emit({ type: "video-frame-request", requestId: "req-1" });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "video-frame-result", requestId: "req-1" })
      );
    });

    emit({ type: "video-frame-request", requestId: "req-2", targetTime: 195 });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "video-frame-result", requestId: "req-2" })
      );
    });

    emit({ type: "token", data: "笔记正文\n{{frame:03:15 | 架构图}}" });
    emit({ type: "done" });

    const assistantIndex = chatSessionState.chatHistory.length - 1;
    const assistantMsg = chatSessionState.chatHistory[assistantIndex];
    const expectedFrames = [
      { seconds: 42, dataUrl: "data:image/jpeg;base64,CURR_A" },
      { seconds: 193, dataUrl: "data:image/jpeg;base64,HIST_A" },
      { seconds: 195, dataUrl: "data:image/jpeg;base64,HIST_B" }
    ];

    expect(getMessageFrames(assistantMsg)).toEqual(expectedFrames);
    expect(getIndexFrames(assistantIndex)).toEqual(expectedFrames);
    expect(getLatestFrames()).toEqual(expectedFrames);
    expect(onTurnCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        historyIndex: assistantIndex,
        message: assistantMsg,
        stopped: false,
        capturedFrames: expectedFrames
      })
    );
    expect(Object.keys(assistantMsg)).toEqual(["role", "content"]);
    expect(syncSet).not.toHaveBeenCalled();

    applyConversationIdentity({ id: "conv-other", meta: null, history: [] });
    expect(getMessageFrames(assistantMsg)).toEqual([]);
    expect(getIndexFrames(assistantIndex)).toEqual([]);
    expect(getLatestFrames()).toEqual([]);

    await runtime.sendTurn("第二轮未提交就中止");
    emit({ type: "video-frame-request", requestId: "req-3" });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "video-frame-result", requestId: "req-3" })
      );
    });
    runtime.resetStreamState();
    expect(getLatestFrames()).toEqual([]);

    applyContextSnapshot({ bvid: "BV1clipA", title: "A" });
    await runtime.sendTurn("换片前提交");
    emit({ type: "video-frame-request", requestId: "req-4" });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "video-frame-result", requestId: "req-4" })
      );
    });
    emit({ type: "token", data: "完成" });
    emit({ type: "done" });
    expect(getLatestFrames()).toHaveLength(1);

    applyContextSnapshot({ bvid: "BV1clipB", title: "B" });
    expect(getLatestFrames()).toEqual([]);

    detachConversationIdentity();
    expect(getLatestFrames()).toEqual([]);
  });

  it("historyIndexFrameMap 有界容量最多保留最近 12 个对话轮次", async () => {
    const {
      MAX_HISTORY_INDEX_FRAME_TURNS,
      bindCapturedFramesToMessage,
      getCapturedFramesForHistoryIndex,
      clearTurnCapturedFrameCache: clearCache
    } = await import("../../extension/notes/turn-frame-cache.js");
    clearCache();

    expect(MAX_HISTORY_INDEX_FRAME_TURNS).toBe(12);
    for (let i = 0; i < 15; i += 1) {
      bindCapturedFramesToMessage(
        { role: "assistant", content: `turn-${i}` },
        [{ seconds: i, dataUrl: `data:image/jpeg;base64,TURN_${i}` }],
        i
      );
    }

    expect(getCapturedFramesForHistoryIndex(0)).toEqual([]);
    expect(getCapturedFramesForHistoryIndex(1)).toEqual([]);
    expect(getCapturedFramesForHistoryIndex(2)).toEqual([]);
    expect(getCapturedFramesForHistoryIndex(3)).toEqual([
      { seconds: 3, dataUrl: "data:image/jpeg;base64,TURN_3" }
    ]);
    expect(getCapturedFramesForHistoryIndex(14)).toEqual([
      { seconds: 14, dataUrl: "data:image/jpeg;base64,TURN_14" }
    ]);
    clearCache();
    expect(getCapturedFramesForHistoryIndex(14)).toEqual([]);
  });
});
