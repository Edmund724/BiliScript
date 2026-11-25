import { describe, expect, it } from "vitest";
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
  buildSabrRequestUrl,
  encodeBytesField,
  encodeFormatId,
  encodeStringField,
  encodeVarintField,
  extractVideoIdFromUmpBytes,
  isGooglevideoUrlFresh,
  isValidGooglevideoUrl,
  parseFormatId,
  parseUmpResponse,
  readProtoFields,
  readUmpVarint,
  rewriteSabrAbrRequest,
  sanitizeAudioTrackIdForCacheKey,
  selectTargetYoutubeAudioFormat,
  selectTargetYoutubeVideoFormat,
  synthesizeSabrTemplateBody,
  writeUmpVarint
} from "../../extension/youtube/sabr-protocol.js";

function encodeUmpPart(partType: number, payload: Uint8Array): Uint8Array {
  return concatByteArrays([
    writeUmpVarint(partType),
    writeUmpVarint(payload.length),
    payload
  ]);
}

describe("UMP varint 编解码", () => {
  it("覆盖 1–5 字节前缀宽度的往返一致", () => {
    const cases = [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 0x7fffffff];
    for (const val of cases) {
      const encoded = writeUmpVarint(val);
      const decoded = readUmpVarint(encoded, 0, encoded.length);
      expect(decoded).toEqual({ value: val, next: encoded.length });
    }
  });
});

describe("SABR Protobuf 模板改写与合成", () => {
  it("wire-level 改写保留未知防伪字段、剥离视频字段并写入音频 FormatId/Cookie/BufferedRange", () => {
    const unknownTop = encodeStringField(99, "keep-top-secret");
    const unknownAbr = encodeVarintField(77, 12345);
    const poToken = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const ustreamer = new Uint8Array([0x01, 0x02, 0x03]);
    const originalStreamerCtx = concatByteArrays([
      encodeBytesField(2, poToken),
      encodeBytesField(4, ustreamer)
    ]);

    const template = concatByteArrays([
      encodeBytesField(1, concatByteArrays([encodeVarintField(28, 5000), unknownAbr])),
      encodeBytesField(2, encodeFormatId({ itag: 248, lastModified: 1n, xtags: "" })),
      encodeBytesField(17, encodeFormatId({ itag: 248, lastModified: 1n, xtags: "" })),
      encodeBytesField(18, encodeFormatId({ itag: 300, lastModified: 1n, xtags: "" })),
      encodeBytesField(19, originalStreamerCtx),
      unknownTop
    ]);

    const cookie = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const ctxUpdate = concatByteArrays([encodeVarintField(1, 5), encodeBytesField(3, new Uint8Array([9]))]);
    const targetFormat = { itag: 140, lastModified: 1700000000000000n, xtags: "acont=original" };

    const rewritten = rewriteSabrAbrRequest({
      templateBody: template,
      targetFormat,
      positionMs: 12000,
      playbackCookie: cookie,
      bufferedRange: {
        formatId: targetFormat,
        startTimeMs: 0,
        durationMs: 12000,
        startSegmentIndex: 1,
        endSegmentIndex: 2
      },
      sabrContexts: [ctxUpdate],
      unsentContextTypes: [8]
    });

    const top = readProtoFields(rewritten);
    expect(top.some((f) => f.fieldNumber === 99)).toBe(true);
    expect(top.some((f) => f.fieldNumber === 17)).toBe(false);
    expect(top.some((f) => f.fieldNumber === 18)).toBe(false);

    const abrFields = readProtoFields(top.find((f) => f.fieldNumber === 1)!.bytes!);
    expect(abrFields.find((f) => f.fieldNumber === 77)?.varint).toBe(12345n);
    expect(abrFields.find((f) => f.fieldNumber === 28)?.varint).toBe(12000n);
    expect(abrFields.find((f) => f.fieldNumber === 40)?.varint).toBe(1n);
    expect(abrFields.find((f) => f.fieldNumber === 35)?.wireType).toBe(5);

    const fmt2 = parseFormatId(top.find((f) => f.fieldNumber === 2)!.bytes!);
    const fmt16 = parseFormatId(top.find((f) => f.fieldNumber === 16)!.bytes!);
    expect(fmt2).toEqual(targetFormat);
    expect(fmt16).toEqual(targetFormat);

    const rangeFields = readProtoFields(top.find((f) => f.fieldNumber === 3)!.bytes!);
    expect(rangeFields.find((f) => f.fieldNumber === 4)?.varint).toBe(1n);
    expect(rangeFields.find((f) => f.fieldNumber === 5)?.varint).toBe(2n);

    const ctxFields = readProtoFields(top.find((f) => f.fieldNumber === 19)!.bytes!);
    expect(Array.from(ctxFields.find((f) => f.fieldNumber === 2)!.bytes!)).toEqual(Array.from(poToken));
    expect(Array.from(ctxFields.find((f) => f.fieldNumber === 3)!.bytes!)).toEqual(Array.from(cookie));
    expect(Array.from(ctxFields.find((f) => f.fieldNumber === 4)!.bytes!)).toEqual(Array.from(ustreamer));
    expect(ctxFields.filter((f) => f.fieldNumber === 5)).toHaveLength(1);
    expect(ctxFields.find((f) => f.fieldNumber === 6)?.varint).toBe(8n);
  });

  it("synthesizeSabrTemplateBody 构造包含 clientInfo/poToken/ustreamerConfig 的合法模板", () => {
    const body = synthesizeSabrTemplateBody({
      clientName: 1,
      clientVersion: "2.20261125.00.00",
      ustreamerConfig: new Uint8Array([7, 8, 9]),
      poToken: new Uint8Array([1, 2]),
      targetFormat: { itag: 140, lastModified: 100n, xtags: "" }
    });
    const top = readProtoFields(body);
    expect(top.some((f) => f.fieldNumber === 1)).toBe(true);
    expect(Array.from(top.find((f) => f.fieldNumber === 5)!.bytes!)).toEqual([7, 8, 9]);
    expect(top.some((f) => f.fieldNumber === 16)).toBe(true);
    const ctxFields = readProtoFields(top.find((f) => f.fieldNumber === 19)!.bytes!);
    expect(Array.from(ctxFields.find((f) => f.fieldNumber === 2)!.bytes!)).toEqual([1, 2]);
  });
});

describe("UMP 响应分包解析", () => {
  it("正确解包 init(0) + 多块 MEDIA 分片、Policy、Redirect、ContextUpdate 与 ProtectionStatus", () => {
    const videoId = "dQw4w9WgXcQ";
    const formatMeta = concatByteArrays([
      encodeStringField(1, videoId),
      encodeBytesField(2, encodeFormatId({ itag: 140, lastModified: 55n, xtags: "" })),
      encodeVarintField(4, 12),
      encodeStringField(5, 'audio/mp4; codecs="mp4a.40.2"')
    ]);
    const initHeader = concatByteArrays([
      encodeVarintField(1, 0),
      encodeStringField(2, videoId),
      encodeVarintField(3, 140),
      encodeVarintField(8, 1)
    ]);
    const segHeader = concatByteArrays([
      encodeVarintField(1, 1),
      encodeStringField(2, videoId),
      encodeVarintField(3, 140),
      encodeVarintField(9, 1),
      encodeVarintField(11, 0),
      encodeVarintField(12, 5000)
    ]);
    const policy = concatByteArrays([
      encodeVarintField(4, 250),
      encodeBytesField(7, new Uint8Array([0x10, 0x20]))
    ]);
    const redirect = encodeStringField(1, "https://rr2---sn-abc.googlevideo.com/videoplayback?expire=9999999999");
    const sabrErr = concatByteArrays([encodeStringField(1, "BAD_REQUEST"), encodeVarintField(2, 400)]);
    const ctxUpdate = concatByteArrays([
      encodeVarintField(1, 3),
      encodeVarintField(4, 1),
      encodeBytesField(3, new Uint8Array([42]))
    ]);
    const sendingPolicy = concatByteArrays([
      encodeVarintField(1, 3),
      encodeVarintField(2, 4),
      encodeVarintField(3, 5)
    ]);
    const protection = encodeVarintField(1, STREAM_PROTECTION_REJECTED);

    const ump = concatByteArrays([
      encodeUmpPart(UMP_PART_FORMAT_INIT_METADATA, formatMeta),
      encodeUmpPart(UMP_PART_MEDIA_HEADER, initHeader),
      encodeUmpPart(UMP_PART_MEDIA, concatByteArrays([writeUmpVarint(0), new Uint8Array([1, 2, 3])])),
      encodeUmpPart(UMP_PART_MEDIA_END, writeUmpVarint(0)),
      encodeUmpPart(UMP_PART_MEDIA_HEADER, segHeader),
      encodeUmpPart(UMP_PART_MEDIA, concatByteArrays([writeUmpVarint(1), new Uint8Array([4, 5])])),
      encodeUmpPart(UMP_PART_MEDIA, concatByteArrays([writeUmpVarint(1), new Uint8Array([6, 7])])),
      encodeUmpPart(UMP_PART_MEDIA_END, writeUmpVarint(1)),
      encodeUmpPart(UMP_PART_NEXT_REQUEST_POLICY, policy),
      encodeUmpPart(UMP_PART_SABR_REDIRECT, redirect),
      encodeUmpPart(UMP_PART_SABR_ERROR, sabrErr),
      encodeUmpPart(UMP_PART_SABR_CONTEXT_UPDATE, ctxUpdate),
      encodeUmpPart(UMP_PART_SABR_CONTEXT_SENDING_POLICY, sendingPolicy),
      encodeUmpPart(UMP_PART_STREAM_PROTECTION_STATUS, protection)
    ]);

    const parsed = parseUmpResponse(ump);
    expect(parsed.initMetadatas[0]).toMatchObject({ videoId, endSegmentNumber: 12 });
    expect(parsed.mediaSegments).toHaveLength(2);
    expect(parsed.mediaSegments[0].header.isInitSeg).toBe(true);
    expect(Array.from(parsed.mediaSegments[0].data)).toEqual([1, 2, 3]);
    expect(parsed.mediaSegments[1].header.sequenceNumber).toBe(1);
    expect(parsed.mediaSegments[1].header.durationMs).toBe(5000);
    expect(Array.from(parsed.mediaSegments[1].data)).toEqual([4, 5, 6, 7]);
    expect(parsed.nextRequestPolicy?.backoffTimeMs).toBe(250);
    expect(Array.from(parsed.nextRequestPolicy!.playbackCookie!)).toEqual([0x10, 0x20]);
    expect(parsed.redirectUrl).toContain("rr2---sn-abc.googlevideo.com");
    expect(parsed.sabrError).toEqual({ type: "BAD_REQUEST", code: 400 });
    expect(parsed.contextUpdates).toHaveLength(1);
    expect(parsed.contextSendingPolicies[0]).toEqual({
      startPolicy: [3],
      stopPolicy: [4],
      discardPolicy: [5]
    });
    expect(parsed.streamProtectionStatus).toBe(STREAM_PROTECTION_REJECTED);

    const sniffMeta = extractVideoIdFromUmpBytes(ump);
    expect(sniffMeta.videoId).toBe(videoId);
    expect(sniffMeta.observedAudioItag).toBe(140);
  });
});

describe("YouTube 音轨选择与 URL 校验", () => {
  it("优先选择匹配音轨的 itag 140（AAC-LC），避开 opus 与 HE-AAC 139", () => {
    const formats = [
      { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 130000, audioTrack: { id: "en.4" } },
      { itag: 139, mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 48000, audioTrack: { id: "en.4" } },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, audioTrack: { id: "en.4" }, xtags: "drc=1" },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, audioTrack: { id: "en.4" }, xtags: "" },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, audioTrack: { id: "es.4" }, xtags: "" }
    ];

    const enPick = selectTargetYoutubeAudioFormat(formats, { activeAudioTrackId: "en.4" });
    expect(enPick?.itag).toBe(140);
    expect(enPick?.audioTrackId).toBe("en.4");
    expect(enPick?.xtags).toBe("");

    const esPick = selectTargetYoutubeAudioFormat(formats, { activeAudioTrackId: "es.4" });
    expect(esPick?.audioTrackId).toBe("es.4");

    const drcPick = selectTargetYoutubeAudioFormat(formats, {
      activeAudioTrackId: "en.4",
      preferredXtags: "drc=1"
    });
    expect(drcPick?.xtags).toBe("drc=1");
  });

  it("URL 校验拒绝非 googlevideo / 过期 URL 并正确附加 cpn/alr/rn", () => {
    expect(isValidGooglevideoUrl("https://rr1---sn-xyz.googlevideo.com/videoplayback?expire=9999999999")).toBe(true);
    expect(isValidGooglevideoUrl("https://evil.example.com/videoplayback")).toBe(false);
    expect(isGooglevideoUrlFresh("https://rr1---sn-xyz.googlevideo.com/videoplayback?expire=1000", 2000)).toBe(false);
    expect(isGooglevideoUrlFresh("https://rr1---sn-xyz.googlevideo.com/videoplayback?expire=5000", 2000)).toBe(true);

    const built = buildSabrRequestUrl("https://rr1---sn-xyz.googlevideo.com/videoplayback?id=1", "abc123", 3);
    const parsed = new URL(built);
    expect(parsed.searchParams.get("cpn")).toBe("abc123");
    expect(parsed.searchParams.get("alr")).toBe("no");
    expect(parsed.searchParams.get("rn")).toBe("3");

    expect(sanitizeAudioTrackIdForCacheKey("en.4:dub_1")).toBe("en.4-dub-1");
  });

  it("视频单轨改写写 field 17、清空 field 16 且 mediaType = 2", () => {
    const template = synthesizeSabrTemplateBody({
      clientName: 1,
      clientVersion: "2.20260401.00.00",
      ustreamerConfig: new Uint8Array([9, 8, 7]),
      targetFormat: { itag: 140, lastModified: 100n, xtags: "" }
    });
    const rewritten = rewriteSabrAbrRequest({
      templateBody: template,
      targetFormat: { itag: 136, lastModified: 999n, xtags: "" },
      positionMs: 120_000,
      mediaType: 2
    });
    const top = readProtoFields(rewritten);
    expect(top.find((f) => f.fieldNumber === 16)).toBeUndefined();
    const videoFmtField = top.find((f) => f.fieldNumber === 17);
    expect(videoFmtField?.bytes).toBeDefined();
    expect(parseFormatId(videoFmtField!.bytes!)).toEqual({ itag: 136, lastModified: 999n, xtags: "" });
    const abrFields = readProtoFields(top.find((f) => f.fieldNumber === 1)!.bytes!);
    expect(Number(abrFields.find((f) => f.fieldNumber === 28)?.varint)).toBe(120_000);
    expect(Number(abrFields.find((f) => f.fieldNumber === 40)?.varint)).toBe(2);
  });

  it("视频选轨默认优先 720p 低帧率 avc1，缺失时回退 480p 或 vp9", () => {
    const formats = [
      { itag: 135, mimeType: 'video/mp4; codecs="avc1.4d401f"', width: 854, height: 480, fps: 30, bitrate: 700_000 },
      { itag: 298, mimeType: 'video/mp4; codecs="avc1.4d4020"', width: 1280, height: 720, fps: 60, bitrate: 2_500_000 },
      { itag: 136, mimeType: 'video/mp4; codecs="avc1.4d401f"', width: 1280, height: 720, fps: 30, bitrate: 1_500_000 },
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 },
      { itag: 247, mimeType: 'video/webm; codecs="vp9"', width: 1280, height: 720, fps: 30, bitrate: 1_200_000 }
    ];
    expect(selectTargetYoutubeVideoFormat(formats)?.itag).toBe(136);
    expect(selectTargetYoutubeVideoFormat(formats, { preferredHeight: 480 })?.itag).toBe(135);
    expect(
      selectTargetYoutubeVideoFormat(formats, {
        isTypeSupported: (mime) => mime.includes("vp9")
      })?.itag
    ).toBe(247);
  });
});
