// tests/live/moss-live-protocol.test.ts
// MOSS-LIVE 协议封包、音频重采样/分帧与服务端事件解析单元测试

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMINI_LIVE_WS_URL,
  MOSS_DOWNSTREAM_SAMPLE_RATE,
  MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS,
  MOSS_UPSTREAM_FRAME_BYTES,
  MOSS_UPSTREAM_FRAME_SAMPLES,
  MOSS_UPSTREAM_SAMPLE_RATE,
  MossBinaryTag,
  buildChangeVoicePayload,
  buildMinimalSessionUpdatePayload,
  createPcm16kFrameChunker,
  decodeBase64Bytes,
  decodePcmS16LEToFloat32,
  formatLiveCloseDiagnostics,
  encodeBase64Bytes,
  encodeFloat32ToPcmS16LE,
  packTaggedBinary,
  parseMossServerJsonEvent,
  resampleMonoFloat32,
  resolveGeminiLiveWsUrl,
  resolveLivePermissionOrigins,
  resolveMossLivePermissionOrigins,
  resolveMossLiveWsUrl,
  unpackTaggedBinary
} from "../../extension/live/moss-live-protocol.js";

describe("moss-live-protocol binary framing & base64 transport", () => {
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

  it("encodes and decodes base64 bytes losslessly across full 0..255 range", () => {
    const src = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      src[i] = i;
    }
    const b64 = encodeBase64Bytes(src);
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);

    const decoded = decodeBase64Bytes(b64);
    expect(Array.from(decoded)).toEqual(Array.from(src));
  });

  it("returns empty Uint8Array for empty or invalid base64 input", () => {
    expect(decodeBase64Bytes("").byteLength).toBe(0);
    expect(decodeBase64Bytes("@@@invalid@@@").byteLength).toBe(0);
  });
});

describe("PCM S16LE codec & resampling", () => {
  it("encodes Float32 [-1, 1] to S16LE and clamps out-of-range samples", () => {
    const input = new Float32Array([0, 1, -1, 1.5, -1.8, 0.5, -0.5]);
    const pcmBytes = encodeFloat32ToPcmS16LE(input);

    expect(pcmBytes.byteLength).toBe(input.length * 2);
    const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(8, true)).toBe(-32768);
    expect(view.getInt16(10, true)).toBe(16383);
    expect(view.getInt16(12, true)).toBe(-16384);

    const decoded = decodePcmS16LEToFloat32(pcmBytes.buffer);
    expect(decoded.length).toBe(input.length);
    expect(decoded[0]).toBeCloseTo(0, 4);
    expect(decoded[1]).toBeCloseTo(32767 / 32768, 4);
    expect(decoded[2]).toBeCloseTo(-1, 4);
    expect(decoded[5]).toBeCloseTo(0.5, 3);
    expect(decoded[6]).toBeCloseTo(-0.5, 3);
  });

  it("handles odd byte lengths and empty buffers safely in decodePcmS16LEToFloat32", () => {
    expect(decodePcmS16LEToFloat32(new ArrayBuffer(0)).length).toBe(0);
    expect(decodePcmS16LEToFloat32(new ArrayBuffer(1)).length).toBe(0);

    // 5 bytes -> 2 complete Int16LE samples (last trailing byte ignored)
    const raw = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff]);
    const float32 = decodePcmS16LEToFloat32(raw.buffer);
    expect(float32.length).toBe(2);
    expect(float32[0]).toBeCloseTo(0.5, 4);
    expect(float32[1]).toBeCloseTo(-0.5, 4);
  });

  it("resamples 48kHz mono Float32 down to 16kHz (3:1 ratio)", () => {
    const src48k = new Float32Array(960);
    src48k.fill(0.25);
    const out16k = resampleMonoFloat32(src48k, MOSS_DOWNSTREAM_SAMPLE_RATE, MOSS_UPSTREAM_SAMPLE_RATE);

    expect(out16k.length).toBe(MOSS_UPSTREAM_FRAME_SAMPLES);
    for (let i = 0; i < out16k.length; i++) {
      expect(out16k[i]).toBeCloseTo(0.25, 4);
    }
  });

  it("returns original samples when srcSampleRate equals targetSampleRate", () => {
    const src16k = new Float32Array([0.1, -0.2, 0.3]);
    const out = resampleMonoFloat32(src16k, 16000, 16000);
    expect(Array.from(out)).toEqual(Array.from(src16k));
  });
});

describe("createPcm16kFrameChunker (20ms / 640-byte framing)", () => {
  it("accumulates 128-sample WebAudio blocks at 16kHz into exact 320-sample (640-byte) frames", () => {
    const frames: Uint8Array[] = [];
    const chunker = createPcm16kFrameChunker((frame) => {
      frames.push(frame);
    });

    const block128 = new Float32Array(128).fill(0.5);

    // 128 samples -> 0 frames (128 buffered)
    chunker.push(block128, 16000);
    expect(frames).toHaveLength(0);

    // +128 = 256 samples -> 0 frames (256 buffered)
    chunker.push(block128, 16000);
    expect(frames).toHaveLength(0);

    // +128 = 384 samples -> 1 frame (320 emitted, 64 buffered)
    chunker.push(block128, 16000);
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(MOSS_UPSTREAM_FRAME_BYTES);

    // Pack with tagged-v1 0x00 -> 641 bytes as required by MOSS-LIVE spec
    const tagged = packTaggedBinary(MossBinaryTag.AudioPcm, frames[0].buffer);
    expect(tagged.byteLength).toBe(641);
    expect(tagged[0]).toBe(MossBinaryTag.AudioPcm);
  });

  it("resamples 48kHz blocks and emits multiple 640-byte frames when input is large", () => {
    const frames: Uint8Array[] = [];
    const chunker = createPcm16kFrameChunker((frame) => {
      frames.push(frame);
    });

    // 1920 samples @ 48kHz = 40ms = 640 samples @ 16kHz = exactly 2 frames
    const block48k = new Float32Array(1920).fill(-0.25);
    chunker.push(block48k, 48000);

    expect(frames).toHaveLength(2);
    expect(frames[0].byteLength).toBe(640);
    expect(frames[1].byteLength).toBe(640);
  });

  it("reset() discards buffered remainder so muted/stopped state leaves no stale samples", () => {
    const frames: Uint8Array[] = [];
    const chunker = createPcm16kFrameChunker((frame) => {
      frames.push(frame);
    });

    chunker.push(new Float32Array(300).fill(0.8), 16000);
    expect(frames).toHaveLength(0);

    chunker.reset();

    // After reset, pushing 100 samples is only 100 (not 300+100=400)
    chunker.push(new Float32Array(100).fill(0.8), 16000);
    expect(frames).toHaveLength(0);
  });
});

describe("parseMossServerJsonEvent", () => {
  it("reads run_id/turn_id from the envelope top level when data omits them", () => {
    expect(
      parseMossServerJsonEvent({
        action: "output.transcript.updated",
        data: { text: "你好" },
        run_id: "run_1",
        turn_id: "turn_1"
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "output.updated", text: "你好", runId: "run_1", turnId: "turn_1" }
    });
    expect(parseMossServerJsonEvent({ action: "response.audio.done", run_id: "r", turn_id: "t" })).toEqual({
      kind: "audio.done",
      runId: "r",
      turnId: "t"
    });
  });

  it("parses input and output transcript updated/done events", () => {
    expect(
      parseMossServerJsonEvent({
        action: "input.transcript.updated",
        data: { text: "这个架构图" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "input.updated", text: "这个架构图" }
    });

    expect(
      parseMossServerJsonEvent({
        action: "input.transcript.done",
        data: { text: "这个架构图中间那层是什么？" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "input.done", text: "这个架构图中间那层是什么？" }
    });

    expect(
      parseMossServerJsonEvent({
        action: "output.transcript.updated",
        data: { text: "中间那层是", run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "output.updated", text: "中间那层是", runId: "r1", turnId: "t1" }
    });

    expect(
      parseMossServerJsonEvent({
        action: "output.transcript.done",
        data: { text: "中间那层是消息队列层。", run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "output.done", text: "中间那层是消息队列层。", runId: "r1", turnId: "t1" }
    });

    expect(
      parseMossServerJsonEvent({
        action: "response.ended",
        data: { status: "completed", run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "response.ended", status: "completed", runId: "r1", turnId: "t1" }
    });
  });

  it("parses response.interrupted with turn identity", () => {
    expect(
      parseMossServerJsonEvent({
        action: "response.interrupted",
        data: { run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "response.interrupted", runId: "r1", turnId: "t1" }
    });
  });

  it("parses audio context, audio done, and audio stop events", () => {
    expect(
      parseMossServerJsonEvent({
        action: "response.audio.context",
        data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "audio.context",
      chunkId: "c1",
      runId: "r1",
      turnId: "t1"
    });

    expect(
      parseMossServerJsonEvent({
        action: "response.audio.done",
        data: { run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "audio.done",
      runId: "r1",
      turnId: "t1"
    });

    expect(
      parseMossServerJsonEvent({
        action: "response.audio.stop",
        data: { run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "audio.stop",
      runId: "r1",
      turnId: "t1"
    });
  });

  it("parses server-side output volume and speed confirmation", () => {
    expect(parseMossServerJsonEvent({
      action: "media.output.configured",
      data: { volume_db: 8, speed: 1.25 }
    })).toEqual({
      kind: "output.configured",
      volumeDb: 8,
      speed: 1.25
    });
  });

  it("parses completed web search calls and interruption markers", () => {
    expect(
      parseMossServerJsonEvent({
        action: "response.function_call_arguments.done",
        data: {
          call_id: "call-1",
          name: "web_search",
          arguments: JSON.stringify({ query: "B 站 2026 财报" }),
          run_id: "r1",
          turn_id: "t1"
        }
      })
    ).toEqual({
      kind: "function_call.done",
      callId: "call-1",
      name: "web_search",
      argumentsText: JSON.stringify({ query: "B 站 2026 财报" }),
      runId: "r1",
      turnId: "t1"
    });

    expect(
      parseMossServerJsonEvent({
        action: "response.interrupted",
        data: { run_id: "r1", turn_id: "t1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "response.interrupted", runId: "r1", turnId: "t1" }
    });
  });

  it("parses nested error.data.error.message as well as top-level message", () => {
    expect(
      parseMossServerJsonEvent({
        action: "error",
        data: {
          type: "error",
          error: { code: "invalid_memory_scope", message: "参数值不合法" }
        }
      })
    ).toEqual({
      kind: "error",
      message: "参数值不合法",
      code: "invalid_memory_scope"
    });

    expect(
      parseMossServerJsonEvent({
        action: "error",
        message: "鉴权失败：密钥无效"
      })
    ).toEqual({
      kind: "error",
      message: "鉴权失败：密钥无效",
      code: ""
    });
  });

  it("parses native client delegation creation and cancellation events", () => {
    expect(parseMossServerJsonEvent({
      type: "session.delegation.created",
      data: {
        delegation: { id: "del_001", type: "client", status: "in_progress" },
        objective: "总结视频核心内容",
        context: ["用户想先了解全片脉络"],
        purpose: "task",
        timeout_ms: null
      }
    })).toEqual({
      kind: "delegation.created",
      delegation: {
        delegationId: "del_001",
        objective: "总结视频核心内容",
        context: ["用户想先了解全片脉络"]
      }
    });

    expect(parseMossServerJsonEvent({
      type: "session.delegation.cancelled",
      data: {
        delegation_id: "del_001",
        cancelled_by: "server",
        reason: "User cancelled the task"
      }
    })).toEqual({ kind: "delegation.cancelled", delegationId: "del_001" });
  });

  it("parses delegation context given as role/content lines", () => {
    expect(parseMossServerJsonEvent({
      action: "session.delegation.created",
      data: {
        delegation: { id: "del_002", target: "client" },
        objective: "总结视频核心内容",
        context: [{ role: "user", content: "先讲全片脉络" }, { role: "", content: "无角色" }, { role: "user", content: "" }],
        purpose: "task"
      }
    })).toEqual({
      kind: "delegation.created",
      delegation: {
        delegationId: "del_002",
        objective: "总结视频核心内容",
        context: ["user：先讲全片脉络", "无角色"]
      }
    });
  });

  it("returns null for malformed or unrecognized events", () => {
    expect(parseMossServerJsonEvent(null)).toBeNull();
    expect(parseMossServerJsonEvent("not-an-object")).toBeNull();
    expect(parseMossServerJsonEvent({ action: "" })).toBeNull();
    expect(parseMossServerJsonEvent({ action: "unknown.event" })).toBeNull();
  });
});

describe("resolveMossLiveWsUrl & buildMinimalSessionUpdatePayload", () => {
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

  it("resolves Gemini Live BidiGenerateContent WS URL from official baseUrl", () => {
    expect(resolveGeminiLiveWsUrl()).toBe(DEFAULT_GEMINI_LIVE_WS_URL);
    expect(resolveGeminiLiveWsUrl("https://generativelanguage.googleapis.com/v1beta")).toBe(
      DEFAULT_GEMINI_LIVE_WS_URL
    );
  });

  it("derives paired HTTP(S) and WS(S) permission origins via resolveMossLivePermissionOrigins / resolveLivePermissionOrigins", () => {
    expect(resolveMossLivePermissionOrigins("https://api.mosi.cn")).toEqual([
      "https://api.mosi.cn",
      "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"
    ]);
    expect(resolveMossLivePermissionOrigins("http://localhost:8000", "moss-beta")).toEqual([
      "http://localhost:8000",
      "ws://localhost:8000/v1/realtime?model=moss-beta"
    ]);
    expect(
      resolveLivePermissionOrigins(
        "https://generativelanguage.googleapis.com",
        "gemini-3.1-flash-live-preview",
        "gemini-live"
      )
    ).toEqual([
      "https://generativelanguage.googleapis.com",
      "wss://generativelanguage.googleapis.com"
    ]);
    expect(resolveMossLivePermissionOrigins("https://generativelanguage.googleapis.com")).toEqual([
      "https://generativelanguage.googleapis.com",
      "wss://generativelanguage.googleapis.com"
    ]);
  });

  it("builds session.update with lightweight tools and explicit delegation routing", () => {
    const payload = buildMinimalSessionUpdatePayload();
    expect(payload.action).toBe("session.update");
    expect(Object.keys(payload.session).sort()).toEqual(["instructions", "persona", "tools"]);
    expect(payload.session.persona.name).toBe("Bili伴看助手");
    expect(payload.session.instructions).toContain("screen通道");
    expect(payload.session.instructions).toContain("切勿提示用户打开摄像头");
    expect(payload.session.instructions).toContain("不得编造外部事实");
    expect(payload.session.instructions).toContain("请通过后台委派（delegation）交由后台文本模型处理");
    expect(payload.session.instructions).toContain("普通日常闲聊或常识问题请直接回答");
    expect(payload.session.instructions).toContain("跳到刚才总结或分析中的某一点");
    expect(payload.session.instructions).toContain("把时间戳换算成秒数后调用 control_bilibili_player 的 seek");
    expect(payload.session.tools).toEqual(MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS);
  });
});

describe("subtitle-aware session and tool calls", () => {
  it("injects video, part and chapter context into session.update instructions", () => {
    const payload = buildMinimalSessionUpdatePayload({
      url: "https://www.bilibili.com/video/BV1test000000/?p=2",
      bvid: "BV1test000000",
      cid: "123",
      title: "实时语音原理",
      pageIndex: 2,
      pageCount: 3,
      pageTitle: "工具调用",
      chapters: [{ title: "开场", from: 0, to: 10 }]
    });
    expect(Object.keys(payload.session).sort()).toEqual(["instructions", "persona", "tools"]);
    expect(payload.session.instructions).toContain("实时语音原理");
    expect(payload.session.instructions).toContain("P2 工具调用 / 共3P");
    expect(payload.session.instructions).toContain("0s 开场");
    expect(payload.session.instructions).toContain("time 时刻文本");
    expect(payload.session.instructions).toContain("控制播放器（跳转进度、暂停/播放/倍速）");
    expect(payload.session.instructions).toContain("总结全片或片段内容");
    expect(payload.session.instructions).toContain("不得声称操作已成功");
  });

  it("renders the full-video overview and forbids search/subtitle substitution", () => {
    const payload = buildMinimalSessionUpdatePayload({
      url: "https://www.bilibili.com/video/BV1test000000/",
      bvid: "BV1test000000",
      cid: "123",
      title: "实时语音原理",
      pageIndex: 1,
      pageCount: 1,
      pageTitle: "",
      chapters: [],
      overview: {
        phase: "ready",
        coverage: "complete",
        summary: "全片介绍实时语音链路。",
        chapters: [{ from: 0, to: 120, time: "0:00", title: "开场", summary: "为什么需要实时" }],
        quotes: [{ from: 125, time: "2:05", content: "延迟就是体验。" }],
        statusText: ""
      }
    });
    const instructions = payload.session.instructions;
    expect(instructions).toContain("不得用前台字幕工具或 web_search 代替后台委派");
    expect(instructions).toContain("已有覆盖完整的全片概览，可直接读取并回答");
    expect(instructions).toContain("全片概览状态：ready（覆盖：complete）");
    expect(instructions).toContain("全片简介：全片介绍实时语音链路。");
    expect(instructions).toContain("0:00 开场：为什么需要实时");
    expect(instructions).toContain("2:05 延迟就是体验。");
  });

  it("marks partial coverage as incomplete and lists uncovered ranges", () => {
    const payload = buildMinimalSessionUpdatePayload({
      url: "https://www.bilibili.com/video/BV1test000000/",
      bvid: "BV1test000000",
      cid: "123",
      title: "实时语音原理",
      pageIndex: 1,
      pageCount: 1,
      pageTitle: "",
      chapters: [],
      overview: {
        phase: "partial",
        coverage: "partial",
        summary: "",
        chapters: [{ from: 0, to: 120, time: "0:00", title: "开场", summary: "" }],
        quotes: [],
        failedRanges: [{ from: 120, to: 300 }],
        statusText: "覆盖不完整：1 段字幕生成失败；不得当作完整全片总结。"
      }
    });
    const instructions = payload.session.instructions;
    expect(instructions).toContain("全片概览状态：partial（覆盖：partial）");
    expect(instructions).toContain("不得当作完整全片总结");
    expect(instructions).toContain("未覆盖区间：2:00");
  });

  it("states the not-ready status instead of inventing a full-video summary", () => {
    const payload = buildMinimalSessionUpdatePayload({
      url: "https://www.bilibili.com/video/BV1test000000/",
      bvid: "BV1test000000",
      cid: "123",
      title: "实时语音原理",
      pageIndex: 1,
      pageCount: 1,
      pageTitle: "",
      chapters: [],
      overview: {
        phase: "generating",
        coverage: "none",
        summary: "",
        chapters: [],
        quotes: [],
        statusText: "全片概览正在生成，尚未完成；完成后会自动更新，未完成前不得编造全片内容。"
      }
    });
    const instructions = payload.session.instructions;
    expect(instructions).toContain("全片概览状态：generating（覆盖：none）");
    expect(instructions).toContain("正在生成");
    expect(instructions).not.toContain("全片简介：");
  });

  it("uses backend delegation when no local overview is available", () => {
    const payload = buildMinimalSessionUpdatePayload({
      url: "https://www.bilibili.com/video/BV1test000000/",
      bvid: "BV1test000000",
      cid: "123",
      title: "实时语音原理",
      pageIndex: 1,
      pageCount: 1,
      pageTitle: "",
      chapters: []
    });
    expect(payload.session.instructions).toContain("没有可用的本地概览");
    expect(payload.session.instructions).toContain("发起后台委派");
    expect(payload.session.instructions).toContain("不得编造全片内容");
  });

  it("parses tool.call arguments in object or JSON string form", () => {
    expect(parseMossServerJsonEvent({
      action: "tool.call",
      data: { call_id: "call-1", name: "search_video_subtitles", arguments: "{\"query\":\"字幕\"}" }
    })).toEqual({
      kind: "tool.call",
      call: { callId: "call-1", name: "search_video_subtitles", arguments: "{\"query\":\"字幕\"}" }
    });
    expect(parseMossServerJsonEvent({
      action: "tool.call",
      call_id: "call-2",
      name: "get_subtitles_around_time",
      arguments: { current_time: 12 }
    })).toEqual({
      kind: "tool.call",
      call: { callId: "call-2", name: "get_subtitles_around_time", arguments: { current_time: 12 } }
    });
  });

  it("declares only lightweight player and nearby-subtitle tools for MOSS-LIVE", () => {
    const names = MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS.map((tool) => tool.name);
    expect(names).toEqual([
      "control_bilibili_player",
      "get_subtitles_around_time"
    ]);
    expect(MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS.every((tool) => tool.type === "function")).toBe(true);
    expect(
      MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS.filter((tool) => "read_only" in tool).map((tool) => tool.name)
    ).toEqual(["get_subtitles_around_time"]);
  });

  describe("formatLiveCloseDiagnostics", () => {
    it("formats simple error message when code and reason are absent", () => {
      expect(formatLiveCloseDiagnostics({ error: "网络中断" })).toBe("网络中断");
      expect(formatLiveCloseDiagnostics({})).toBe("伴看连接已断开。");
    });

    it("formats WebSocket close code and reason cleanly", () => {
      const text = formatLiveCloseDiagnostics({
        code: 1006,
        reason: "Connection refused"
      });
      expect(text).toContain("关闭码: 1006");
      expect(text).toContain("原因: Connection refused");
      expect(text).toMatch(/^伴看连接已断开/);
    });

    it("formats Relay / Live connection error details", () => {
      const text = formatLiveCloseDiagnostics({
        code: 502,
        reason: "Bad Gateway",
        error: "Relay 连接失败：上游网关超时"
      });
      expect(text).toContain("关闭码: 502");
      expect(text).toContain("原因: Bad Gateway");
      expect(text).toContain("错误详情: Relay 连接失败：上游网关超时");
    });

    it("formats reconnecting notices with attempt count and code/reason", () => {
      const text = formatLiveCloseDiagnostics({
        isReconnect: true,
        attempt: 1,
        maxAttempts: 3,
        code: 1006,
        reason: "Abnormal Closure",
        error: "WebSocket 连接失败"
      });
      expect(text).toContain("正在尝试自动重连 (第 1/3 次)...");
      expect(text).toContain("关闭码: 1006");
      expect(text).toContain("原因: Abnormal Closure");
      expect(text).toContain("错误详情: WebSocket 连接失败");
    });

    it("formats exhausted retry failure with attempt count and diagnostic details", () => {
      const text = formatLiveCloseDiagnostics({
        attempt: 3,
        maxAttempts: 3,
        code: 1006,
        error: "已达最大重连次数 (3 次)"
      });
      expect(text).toContain("自动重连 3 次均失败");
      expect(text).toContain("关闭码: 1006");
    });

  });
});

describe("MOSS-LIVE 音色事件", () => {
  it("builds change_voice with the documented voice_name field", () => {
    expect(buildChangeVoicePayload("voice-1")).toEqual({
      action: "change_voice",
      voice_name: "voice-1"
    });
  });

  it("parses voice_changed from data.name and keeps the voice id", () => {
    expect(
      parseMossServerJsonEvent({ action: "voice_changed", data: { name: "voice-1" } })
    ).toEqual({ kind: "voice_changed", voiceId: "voice-1" });
    expect(
      parseMossServerJsonEvent({ action: "voice_changed", data: { name: "voice-2" } })
    ).toEqual({ kind: "voice_changed", voiceId: "voice-2" });
  });
});
