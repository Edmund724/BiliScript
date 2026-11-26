import { describe, expect, it, vi } from "vitest";
import { concatByteArrays } from "../../extension/shared/bytes.js";
import {
  STREAM_PROTECTION_REJECTED,
  UMP_PART_FORMAT_INIT_METADATA,
  UMP_PART_MEDIA,
  UMP_PART_MEDIA_END,
  UMP_PART_MEDIA_HEADER,
  UMP_PART_NEXT_REQUEST_POLICY,
  UMP_PART_SABR_CONTEXT_SENDING_POLICY,
  UMP_PART_SABR_CONTEXT_UPDATE,
  UMP_PART_SABR_ERROR,
  UMP_PART_SABR_REDIRECT,
  UMP_PART_STREAM_PROTECTION_STATUS,
  encodeBytesField,
  encodeFormatId,
  encodeStringField,
  encodeVarintField,
  readProtoFields,
  synthesizeSabrTemplateBody,
  writeUmpVarint
} from "../../extension/youtube/sabr-protocol.js";
import {
  probeYoutubeSabrAudioTrack,
  runYoutubeSabrAudioSession,
  runYoutubeSabrVideoWindow,
  type SabrAudioSessionEvent,
  type SabrSessionHost
} from "../../extension/youtube/sabr-session.js";
import type { SniffedSabrTemplate } from "../../extension/youtube/sabr-sniffer.main.js";

function encodeUmpPart(partType: number, payload: Uint8Array): Uint8Array {
  return concatByteArrays([
    writeUmpVarint(partType),
    writeUmpVarint(payload.length),
    payload
  ]);
}

function makeMediaSegmentParts(opts: {
  headerId: number;
  videoId: string;
  itag: number;
  isInitSeg?: boolean;
  sequenceNumber?: number;
  startMs?: number;
  durationMs?: number;
  data: Uint8Array;
}): Uint8Array {
  const headerFields: Uint8Array[] = [
    encodeVarintField(1, opts.headerId),
    encodeStringField(2, opts.videoId),
    encodeVarintField(3, opts.itag)
  ];
  if (opts.isInitSeg) {
    headerFields.push(encodeVarintField(8, 1));
  } else {
    headerFields.push(encodeVarintField(9, opts.sequenceNumber ?? 1));
    headerFields.push(encodeVarintField(11, opts.startMs ?? 0));
    headerFields.push(encodeVarintField(12, opts.durationMs ?? 5000));
  }
  return concatByteArrays([
    encodeUmpPart(UMP_PART_MEDIA_HEADER, concatByteArrays(headerFields)),
    encodeUmpPart(UMP_PART_MEDIA, concatByteArrays([writeUmpVarint(opts.headerId), opts.data])),
    encodeUmpPart(UMP_PART_MEDIA_END, writeUmpVarint(opts.headerId))
  ]);
}

function makeFormatMetaPart(opts: {
  videoId: string;
  itag: number;
  endSegmentNumber?: number;
  endTimeMs?: number;
  mimeType?: string;
}): Uint8Array {
  const fields: Uint8Array[] = [
    encodeStringField(1, opts.videoId),
    encodeBytesField(2, encodeFormatId({ itag: opts.itag, lastModified: 100n, xtags: "" }))
  ];
  if (opts.endTimeMs) fields.push(encodeVarintField(3, opts.endTimeMs));
  if (opts.endSegmentNumber) fields.push(encodeVarintField(4, opts.endSegmentNumber));
  if (opts.mimeType) fields.push(encodeStringField(5, opts.mimeType));
  return encodeUmpPart(UMP_PART_FORMAT_INIT_METADATA, concatByteArrays(fields));
}

function makeContextUpdatePart(opts: {
  type: number;
  value: Uint8Array;
  sendByDefault?: boolean;
  writePolicy?: number;
}): Uint8Array {
  const fields: Uint8Array[] = [
    encodeVarintField(1, opts.type),
    encodeBytesField(3, opts.value)
  ];
  if (opts.sendByDefault) fields.push(encodeVarintField(4, 1));
  if (opts.writePolicy) fields.push(encodeVarintField(5, opts.writePolicy));
  return encodeUmpPart(UMP_PART_SABR_CONTEXT_UPDATE, concatByteArrays(fields));
}

function makeSendingPolicyPart(opts: {
  start?: number[];
  stop?: number[];
  discard?: number[];
}): Uint8Array {
  const fields: Uint8Array[] = [];
  for (const t of opts.start ?? []) fields.push(encodeVarintField(1, t));
  for (const t of opts.stop ?? []) fields.push(encodeVarintField(2, t));
  for (const t of opts.discard ?? []) fields.push(encodeVarintField(3, t));
  return encodeUmpPart(UMP_PART_SABR_CONTEXT_SENDING_POLICY, concatByteArrays(fields));
}

function defaultTemplateBody(): Uint8Array {
  return synthesizeSabrTemplateBody({
    clientName: 1,
    clientVersion: "2.20261125.00.00",
    ustreamerConfig: new Uint8Array([1, 2, 3]),
    poToken: new Uint8Array([4, 5]),
    targetFormat: { itag: 140, lastModified: 100n, xtags: "" }
  });
}

function defaultPlayerResponse(videoId = "dQw4w9WgXcQ", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    videoDetails: { videoId, isLive: false },
    streamingData: {
      serverAbrStreamingUrl: "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=9999999999",
      adaptiveFormats: [
        {
          itag: 140,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 128000,
          lastModified: "100",
          approxDurationMs: "60000",
          audioTrack: { id: "en.4" }
        },
        {
          itag: 136,
          mimeType: 'video/mp4; codecs="avc1.4d401f"',
          width: 1280,
          height: 720,
          fps: 30,
          bitrate: 1500000,
          lastModified: "100",
          approxDurationMs: "60000"
        }
      ]
    },
    playerConfig: {
      mediaCommonConfig: {
        mediaUstreamerRequestConfig: {
          videoPlaybackUstreamerConfig: "AQID"
        }
      }
    },
    ...overrides
  };
}

function makeSniffedTemplate(videoId = "dQw4w9WgXcQ"): SniffedSabrTemplate {
  return {
    url: "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=9999999999",
    body: defaultTemplateBody(),
    videoId,
    observedAudioItag: 140,
    observedAudioXtags: "",
    capturedAt: Date.now(),
    expireSec: 9999999999
  };
}

function createMockHost(overrides: Partial<SabrSessionHost> = {}): SabrSessionHost {
  const playerResponse = defaultPlayerResponse();
  return {
    isAdPlaying: vi.fn(() => false),
    readPlayerResponse: vi.fn(() => playerResponse),
    readVideoId: vi.fn(() => "dQw4w9WgXcQ"),
    readActiveAudioTrackId: vi.fn(() => "en.4"),
    readYtcfg: vi.fn((key: string) =>
      key === "INNERTUBE_CONTEXT_CLIENT_NAME" ? 1 : "2.20261125.00.00"
    ),
    getSniffedTemplate: vi.fn(() => makeSniffedTemplate()),
    isVideoMimeSupported: vi.fn(() => true),
    fetchRound: vi.fn(async () => new Uint8Array()),
    sleep: vi.fn(async () => {}),
    generateCpn: () => "testcpn012345678",
    ...overrides
  };
}

function readStreamerContextFromRequest(reqBody: Uint8Array) {
  const top = readProtoFields(reqBody);
  const ctxField = top.find((f) => f.fieldNumber === 19)?.bytes;
  if (!ctxField) return { cookie: null as Uint8Array | null, sabrContexts: [] as Uint8Array[], unsentTypes: [] as number[] };
  const fields = readProtoFields(ctxField);
  const cookie = fields.find((f) => f.fieldNumber === 3)?.bytes ?? null;
  const sabrContexts = fields.filter((f) => f.fieldNumber === 5 && f.bytes).map((f) => f.bytes!);
  const unsentTypes = fields.filter((f) => f.fieldNumber === 6 && f.varint !== undefined).map((f) => Number(f.varint));
  return { cookie, sabrContexts, unsentTypes };
}

describe("probeYoutubeSabrAudioTrack", () => {
  it("返回当前选中的 itag 140 音轨与嗅探/直播/广告状态", () => {
    const host = createMockHost();
    const res = probeYoutubeSabrAudioTrack("dQw4w9WgXcQ", host);
    expect(res).toEqual({
      videoId: "dQw4w9WgXcQ",
      audioTrackId: "en.4",
      itag: 140,
      hasSniffedTemplate: true,
      isLive: false,
      isAdPlaying: false
    });
  });
});

describe("runYoutubeSabrAudioSession", () => {
  it("多轮拉流按序重排乱序分片、传递 cookie/redirect/backoff，并忽略异视频分片", async () => {
    const reqUrls: string[] = [];
    const reqBodies: Uint8Array[] = [];
    const responses = [
      concatByteArrays([
        makeFormatMetaPart({ videoId: "dQw4w9WgXcQ", itag: 140, endSegmentNumber: 2 }),
        makeMediaSegmentParts({ headerId: 0, videoId: "dQw4w9WgXcQ", itag: 140, isInitSeg: true, data: new Uint8Array([1, 2]) }),
        makeMediaSegmentParts({ headerId: 1, videoId: "otherVideo1", itag: 140, sequenceNumber: 1, durationMs: 5000, data: new Uint8Array([99]) }),
        makeMediaSegmentParts({ headerId: 2, videoId: "dQw4w9WgXcQ", itag: 140, sequenceNumber: 2, durationMs: 4000, data: new Uint8Array([20, 21]) }),
        encodeUmpPart(UMP_PART_SABR_REDIRECT, encodeStringField(1, "https://rr2---sn-xyz.googlevideo.com/videoplayback?expire=9999999999")),
        encodeUmpPart(UMP_PART_NEXT_REQUEST_POLICY, concatByteArrays([
          encodeVarintField(4, 120),
          encodeBytesField(7, new Uint8Array([0xaa, 0xbb]))
        ]))
      ]),
      concatByteArrays([
        makeMediaSegmentParts({ headerId: 3, videoId: "dQw4w9WgXcQ", itag: 140, sequenceNumber: 1, durationMs: 5000, data: new Uint8Array([10, 11]) })
      ])
    ];

    const sleep = vi.fn(async () => {});
    const host = createMockHost({
      sleep,
      fetchRound: vi.fn(async (url, body) => {
        reqUrls.push(url);
        reqBodies.push(body);
        return responses.shift()!;
      })
    });

    const events: SabrAudioSessionEvent[] = [];
    await runYoutubeSabrAudioSession(
      { expectedVideoId: "dQw4w9WgXcQ", signal: new AbortController().signal },
      host,
      (evt) => events.push(evt)
    );

    expect(events.map((e) => e.type)).toEqual(["init", "segment", "segment", "end"]);
    expect(events[1]).toMatchObject({ type: "segment", seq: 1 });
    expect(Array.from((events[1] as { data: Uint8Array }).data)).toEqual([10, 11]);
    expect(events[2]).toMatchObject({ type: "segment", seq: 2 });
    expect(Array.from((events[2] as { data: Uint8Array }).data)).toEqual([20, 21]);
    expect(reqUrls[1]).toContain("rr2---sn-xyz.googlevideo.com");
    expect(reqUrls[1]).toContain("rn=1");
    expect(Array.from(readStreamerContextFromRequest(reqBodies[1]).cookie!)).toEqual([0xaa, 0xbb]);
    expect(sleep).toHaveBeenCalledWith(120, expect.any(AbortSignal));
  });

  it("轮内插播广告、切视频、切音轨或风控拒绝时立即中止", async () => {
    let round = 0;
    const adHost = createMockHost({
      isAdPlaying: vi.fn(() => round > 0),
      fetchRound: vi.fn(async () => {
        round += 1;
        return new Uint8Array();
      })
    });
    await expect(
      runYoutubeSabrAudioSession(
        { expectedVideoId: "dQw4w9WgXcQ", signal: new AbortController().signal },
        adHost,
        () => {}
      )
    ).rejects.toMatchObject({ code: "AD_PLAYING" });

    let trackRound = 0;
    const trackSwitchHost = createMockHost({
      readActiveAudioTrackId: vi.fn(() => (trackRound > 0 ? "es.4" : "en.4")),
      fetchRound: vi.fn(async () => {
        trackRound += 1;
        return new Uint8Array();
      })
    });
    await expect(
      runYoutubeSabrAudioSession(
        { expectedVideoId: "dQw4w9WgXcQ", signal: new AbortController().signal },
        trackSwitchHost,
        () => {}
      )
    ).rejects.toThrow("检测到音轨切换");

    const attestationHost = createMockHost({
      fetchRound: vi.fn(async () =>
        encodeUmpPart(UMP_PART_STREAM_PROTECTION_STATUS, encodeVarintField(1, STREAM_PROTECTION_REJECTED))
      )
    });
    await expect(
      runYoutubeSabrAudioSession(
        { expectedVideoId: "dQw4w9WgXcQ", signal: new AbortController().signal },
        attestationHost,
        () => {}
      )
    ).rejects.toMatchObject({ code: "ATTESTATION_REJECTED" });
  });
});

describe("runYoutubeSabrVideoWindow（统一状态机与 4 处漂移修复）", () => {
  it("多轮拉取覆盖 [t-2, t+2] 视频窗并校验 writePolicy=2 与 stopPolicy/discardPolicy 维护 unsentContextTypes", async () => {
    const reqBodies: Uint8Array[] = [];
    const responses = [
      concatByteArrays([
        makeFormatMetaPart({ videoId: "dQw4w9WgXcQ", itag: 136, endTimeMs: 60_000, endSegmentNumber: 12 }),
        makeMediaSegmentParts({ headerId: 0, videoId: "dQw4w9WgXcQ", itag: 136, isInitSeg: true, data: new Uint8Array([1, 2, 3]) }),
        makeMediaSegmentParts({ headerId: 9, videoId: "adVideo9999", itag: 136, sequenceNumber: 5, startMs: 8000, durationMs: 5000, data: new Uint8Array([9, 9]) }),
        makeMediaSegmentParts({ headerId: 1, videoId: "dQw4w9WgXcQ", itag: 136, sequenceNumber: 2, startMs: 8000, durationMs: 2000, data: new Uint8Array([10, 11]) }),
        makeContextUpdatePart({ type: 5, value: new Uint8Array([50]), sendByDefault: true }),
        makeContextUpdatePart({ type: 6, value: new Uint8Array([60]), sendByDefault: true }),
        makeContextUpdatePart({ type: 5, value: new Uint8Array([99]), sendByDefault: true, writePolicy: 2 }),
        makeSendingPolicyPart({ stop: [6] })
      ]),
      concatByteArrays([
        makeMediaSegmentParts({ headerId: 2, videoId: "dQw4w9WgXcQ", itag: 136, sequenceNumber: 3, startMs: 10000, durationMs: 3000, data: new Uint8Array([12, 13]) }),
        makeSendingPolicyPart({ discard: [6] })
      ])
    ];

    const host = createMockHost({
      fetchRound: vi.fn(async (_url, body) => {
        reqBodies.push(body);
        return responses.shift()!;
      })
    });

    const result = await runYoutubeSabrVideoWindow(
      { expectedVideoId: "dQw4w9WgXcQ", startMs: 8000, endMs: 12000, signal: new AbortController().signal },
      host
    );

    expect(result.mimeType).toBe('video/mp4; codecs="avc1.4d401f"');
    expect(result.durationMs).toBe(60_000);
    expect(Array.from(result.initSegment)).toEqual([1, 2, 3]);
    expect(result.mediaSegments.map((s) => Array.from(s))).toEqual([[10, 11], [12, 13]]);

    const round2Ctx = readStreamerContextFromRequest(reqBodies[1]);
    expect(round2Ctx.sabrContexts).toHaveLength(1);
    const ctx5Fields = readProtoFields(round2Ctx.sabrContexts[0]);
    expect(Number(ctx5Fields.find((f) => f.fieldNumber === 1)?.varint)).toBe(5);
    expect(Array.from(ctx5Fields.find((f) => f.fieldNumber === 3)!.bytes!)).toEqual([50]);
    expect(round2Ctx.unsentTypes).toEqual([6]);
  });

  it("视频窗轮内检测到广告或切视频立即中止（漂移 #3）", async () => {
    let round = 0;
    const adHost = createMockHost({
      isAdPlaying: vi.fn(() => round > 0),
      fetchRound: vi.fn(async () => {
        round += 1;
        return new Uint8Array();
      })
    });
    await expect(
      runYoutubeSabrVideoWindow(
        { expectedVideoId: "dQw4w9WgXcQ", startMs: 8000, endMs: 12000, signal: new AbortController().signal },
        adHost
      )
    ).rejects.toMatchObject({ code: "AD_PLAYING" });

    let switchRound = 0;
    const switchHost = createMockHost({
      readVideoId: vi.fn(() => (switchRound > 0 ? "switchedVid" : "dQw4w9WgXcQ")),
      fetchRound: vi.fn(async () => {
        switchRound += 1;
        return new Uint8Array();
      })
    });
    await expect(
      runYoutubeSabrVideoWindow(
        { expectedVideoId: "dQw4w9WgXcQ", startMs: 8000, endMs: 12000, signal: new AbortController().signal },
        switchHost
      )
    ).rejects.toThrow("视频已切换");
  });

  it("无嗅探模板退回参数合成时遇 HTTP 403 抛出 NO_SIGNED_SABR_URL 友好提示（漂移 #4）", async () => {
    const host = createMockHost({
      getSniffedTemplate: vi.fn(() => null),
      fetchRound: vi.fn(async () => {
        throw Object.assign(new Error("HTTP 403"), { code: "SABR_HTTP_ERROR", status: 403 });
      })
    });
    await expect(
      runYoutubeSabrVideoWindow(
        { expectedVideoId: "dQw4w9WgXcQ", startMs: 8000, endMs: 12000, signal: new AbortController().signal },
        host
      )
    ).rejects.toMatchObject({
      code: "NO_SIGNED_SABR_URL",
      status: 403,
      message: expect.stringContaining("尚未捕获到已签名播放器视频流")
    });
  });

  it("服务端返回 SABR_ERROR 时抛出 SABR_ERROR", async () => {
    const host = createMockHost({
      fetchRound: vi.fn(async () =>
        encodeUmpPart(UMP_PART_SABR_ERROR, concatByteArrays([
          encodeStringField(1, "MISSING_PO_TOKEN"),
          encodeVarintField(2, 403)
        ]))
      )
    });
    await expect(
      runYoutubeSabrVideoWindow(
        { expectedVideoId: "dQw4w9WgXcQ", startMs: 8000, endMs: 12000, signal: new AbortController().signal },
        host
      )
    ).rejects.toMatchObject({ code: "SABR_ERROR" });
  });
});
