// tests/live/moss-live-protocol.test.ts
// MOSS-LIVE 协议封包与辅助函数单元测试

import { describe, expect, it } from "vitest";
import {
  MossBinaryTag,
  packTaggedBinary,
  unpackTaggedBinary,
  resolveMossLiveWsUrl,
  buildMinimalSessionUpdatePayload
} from "../../extension/live/moss-live-protocol.js";

describe("moss-live-protocol binary framing", () => {
  it("packs tag and payload with 1-byte header and unpacks faithfully", () => {
    const rawData = new Uint8Array([10, 20, 30, 40, 50]);
    const packed = packTaggedBinary(MossBinaryTag.AudioPcm, rawData.buffer);

    expect(packed.byteLength).toBe(1 + 5);
    expect(packed[0]).toBe(MossBinaryTag.AudioPcm);

    const unpacked = unpackTaggedBinary(packed.buffer);
    expect(unpacked).not.toBeNull();
    expect(unpacked!.tag).toBe(MossBinaryTag.AudioPcm);
    expect(Array.from(new Uint8Array(unpacked!.payload))).toEqual([10, 20, 30, 40, 50]);
  });

  it("handles different binary tags (AudioPcm, CameraJpeg, ScreenJpeg)", () => {
    const payload = new Uint8Array([1, 2, 3]).buffer;

    const t1 = unpackTaggedBinary(packTaggedBinary(MossBinaryTag.AudioPcm, payload).buffer);
    expect(t1?.tag).toBe(MossBinaryTag.AudioPcm);

    const t2 = unpackTaggedBinary(packTaggedBinary(MossBinaryTag.CameraJpeg, payload).buffer);
    expect(t2?.tag).toBe(MossBinaryTag.CameraJpeg);

    const t3 = unpackTaggedBinary(packTaggedBinary(MossBinaryTag.ScreenJpeg, payload).buffer);
    expect(t3?.tag).toBe(MossBinaryTag.ScreenJpeg);
  });

  it("returns null for frames smaller than 1 byte", () => {
    const emptyBuffer = new Uint8Array([]).buffer;
    expect(unpackTaggedBinary(emptyBuffer)).toBeNull();
  });
});

describe("resolveMossLiveWsUrl", () => {
  it("converts https://api.mosi.cn to wss:// endpoint with default model", () => {
    const url = resolveMossLiveWsUrl("https://api.mosi.cn");
    expect(url).toBe("wss://api.mosi.cn/v1/realtime?model=moss-live-1.0");
  });

  it("converts http to ws and respects custom model", () => {
    const url = resolveMossLiveWsUrl("http://localhost:8000", "moss-beta");
    expect(url).toBe("ws://localhost:8000/v1/realtime?model=moss-beta");
  });

  it("handles existing /v1 path without duplicating", () => {
    const url = resolveMossLiveWsUrl("https://api.mosi.cn/v1", "moss-live-1.0");
    expect(url).toBe("wss://api.mosi.cn/v1/realtime?model=moss-live-1.0");
  });

  it("handles existing /v1/realtime endpoint directly", () => {
    const url = resolveMossLiveWsUrl("wss://api.mosi.cn/v1/realtime", "moss-live-1.0");
    expect(url).toBe("wss://api.mosi.cn/v1/realtime?model=moss-live-1.0");
  });
});

describe("buildMinimalSessionUpdatePayload", () => {
  it("builds minimal session update without premature tools or media", () => {
    const payload = buildMinimalSessionUpdatePayload();
    expect(payload.action).toBe("session.update");
    expect(payload.session).toBeDefined();
    expect(payload.session.modalities).toEqual(["audio", "text"]);
    expect(payload.session.persona.name).toBe("Bili伴看助手");
  });
});
