// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YOUTUBE_SABR_CHANNEL } from "../../extension/youtube/sabr-channel.js";

const sendRuntimeMessageMock = vi.fn();

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: (...args: unknown[]) => sendRuntimeMessageMock(...args)
}));

async function loadClient() {
  return import("../../extension/youtube/audio-source.js");
}

function dispatchWindowMessage(data: Record<string, unknown>, source: MessageEventSource | null = window) {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

describe("YouTube SABR 统一跨世界客户端（audio-source.ts）", () => {
  beforeEach(() => {
    vi.resetModules();
    sendRuntimeMessageMock.mockReset();
    sendRuntimeMessageMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ensureYoutubeSabrWorker 成功结果复用单次注入，失败后重置以允许重试", async () => {
    const { ensureYoutubeSabrWorker } = await loadClient();
    sendRuntimeMessageMock.mockResolvedValueOnce({ ok: false, error: "注入失败" });
    await expect(ensureYoutubeSabrWorker()).rejects.toThrow("注入失败");

    sendRuntimeMessageMock.mockResolvedValueOnce({ ok: true });
    await Promise.all([ensureYoutubeSabrWorker(), ensureYoutubeSabrWorker()]);
    expect(sendRuntimeMessageMock).toHaveBeenCalledTimes(2);
    expect(sendRuntimeMessageMock).toHaveBeenLastCalledWith({ type: "youtube-ensure-sabr-worker" });
  });

  it("probeYoutubeAudioTrack 规范化音轨 ID 并忽略无关频道/会话消息", async () => {
    const { probeYoutubeAudioTrack } = await loadClient();
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
      const data = msg as Record<string, unknown>;
      posted.push(data);
      if (data.type === "probe-audio-track") {
        queueMicrotask(() => {
          dispatchWindowMessage({ channel: "other-channel", sessionId: data.sessionId, type: "probe-result", ok: true, itag: 999 });
          dispatchWindowMessage({
            channel: YOUTUBE_SABR_CHANNEL,
            sessionId: data.sessionId,
            type: "probe-result",
            ok: true,
            audioTrackId: "en.4:dub_1",
            itag: 140,
            hasSniffedTemplate: true,
            isLive: false,
            isAdPlaying: false
          });
        });
      }
    });

    const result = await probeYoutubeAudioTrack("dQw4w9WgXcQ");
    expect(posted).toHaveLength(1);
    expect(result).toEqual({
      audioTrackId: "en.4-dub-1",
      itag: 140,
      hasSniffedTemplate: true,
      isLive: false,
      isAdPlaying: false
    });
  });

  it("createYoutubeAudioStreamSource 按序吐出 init/chunk、回调首片进度并在结束或中止时通知 worker", async () => {
    const { createYoutubeAudioStreamSource } = await loadClient();
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
      const data = msg as Record<string, unknown>;
      posted.push(data);
      if (data.type === "start-stream") {
        queueMicrotask(() => {
          dispatchWindowMessage({
            channel: YOUTUBE_SABR_CHANNEL,
            sessionId: data.sessionId,
            type: "init",
            buffer: new Uint8Array([1, 2]).buffer
          });
          dispatchWindowMessage({
            channel: YOUTUBE_SABR_CHANNEL,
            sessionId: data.sessionId,
            type: "segment",
            seq: 1,
            buffer: new Uint8Array([3, 4, 5]).buffer
          });
          dispatchWindowMessage({
            channel: YOUTUBE_SABR_CHANNEL,
            sessionId: data.sessionId,
            type: "end"
          });
        });
      }
    });

    const onProgress = vi.fn();
    const source = createYoutubeAudioStreamSource({ videoId: "dQw4w9WgXcQ", onProgress });
    const received: Array<{ kind: string; bytes: number[] }> = [];
    for await (const seg of source({ signal: new AbortController().signal })) {
      received.push({ kind: seg.kind, bytes: Array.from(seg.bytes) });
    }

    expect(received).toEqual([
      { kind: "init", bytes: [1, 2] },
      { kind: "chunk", bytes: [3, 4, 5] }
    ]);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(posted.map((p) => p.type)).toEqual(["start-stream", "abort-stream"]);
  });

  it("createYoutubeAudioStreamSource 透传 worker error 及 code", async () => {
    const { createYoutubeAudioStreamSource } = await loadClient();
    vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
      const data = msg as Record<string, unknown>;
      if (data.type === "start-stream") {
        queueMicrotask(() => {
          dispatchWindowMessage({
            channel: YOUTUBE_SABR_CHANNEL,
            sessionId: data.sessionId,
            type: "error",
            error: "风控拒绝",
            code: "ATTESTATION_REJECTED"
          });
        });
      }
    });

    const source = createYoutubeAudioStreamSource({ videoId: "dQw4w9WgXcQ" });
    await expect(async () => {
      for await (const _seg of source({ signal: new AbortController().signal })) {
        void _seg;
      }
    }).rejects.toMatchObject({
      message: "风控拒绝",
      code: "ATTESTATION_REJECTED",
      kind: "asr-media"
    });
  });

  it("fetchYoutubeVideoWindow 正常返回视频窗载荷，并在超时或中止时向 worker 发送 abort-video-window", async () => {
    const { fetchYoutubeVideoWindow } = await loadClient();
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
      const data = msg as Record<string, unknown>;
      posted.push(data);
      if (data.type === "capture-video-window" && data.expectedVideoId === "okVid123456") {
        queueMicrotask(() => {
          dispatchWindowMessage({
            channel: YOUTUBE_SABR_CHANNEL,
            sessionId: data.sessionId,
            type: "video-window-result",
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            durationMs: 120_000,
            initSegment: new Uint8Array([1, 2]).buffer,
            mediaSegments: [new Uint8Array([3, 4]).buffer]
          });
        });
      }
    });

    const okPayload = await fetchYoutubeVideoWindow({
      videoId: "okVid123456",
      startMs: 7999.8,
      endMs: 12000.2
    });
    expect(okPayload.mimeType).toBe('video/mp4; codecs="avc1.4d401f"');
    expect(okPayload.durationMs).toBe(120_000);
    expect(Array.from(new Uint8Array(okPayload.initSegment))).toEqual([1, 2]);
    expect(posted[0]).toMatchObject({ type: "capture-video-window", startMs: 7999, endMs: 12001 });

    const controller = new AbortController();
    const abortedPromise = fetchYoutubeVideoWindow({
      videoId: "hangVid1234",
      startMs: 0,
      endMs: 4000,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(posted.some((p) => p.expectedVideoId === "hangVid1234")).toBe(true));
    controller.abort();
    await expect(abortedPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(posted.some((p) => p.type === "abort-video-window")).toBe(true);

    vi.useFakeTimers();
    const timeoutPromise = fetchYoutubeVideoWindow({
      videoId: "slowVid1234",
      startMs: 0,
      endMs: 4000,
      timeoutMs: 500
    });
    const handled = timeoutPromise.catch((err) => err);
    await vi.advanceTimersByTimeAsync(600);
    expect(await handled).toMatchObject({ message: expect.stringContaining("获取 YouTube 视频分片超时") });
  });
});
