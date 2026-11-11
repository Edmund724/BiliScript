// tests/live/moss-interpret-protocol.test.ts
// 同声传译协议层：连接地址构造、握手载荷与下行 JSON 事件解析测试

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  MOSS_INTERPRET_CLOSE_CODE_SESSION_LIMIT,
  MOSS_INTERPRET_PORT_NAME,
  buildMossInterpretMediaConfigurePayload,
  resolveMossInterpretWsUrl,
  parseMossInterpretServerJsonEvent
} from "../../extension/live/moss-interpret-protocol.js";

beforeEach(() => {
  resetModuleState();
});

describe("resolveMossInterpretWsUrl", () => {
  it("builds the interpret endpoint with model and target only — no source, no bidirectional", () => {
    const url = resolveMossInterpretWsUrl("https://api.mosi.cn", "moss-live-1.0", "zh");
    expect(url).toBe("wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh");
    expect(url).not.toContain("source");
    expect(url).not.toContain("bidirectional");
  });

  it("falls back to the default platform host, model and target", () => {
    expect(resolveMossInterpretWsUrl()).toBe(
      "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh"
    );
  });

  it("derives ws:// from http:// custom baseUrl and keeps custom paths", () => {
    expect(resolveMossInterpretWsUrl("http://127.0.0.1:8787", "moss-live-1.0", "en")).toBe(
      "ws://127.0.0.1:8787/v1/realtime/interpret?model=moss-live-1.0&target=en"
    );
  });
});

describe("buildMossInterpretMediaConfigurePayload", () => {
  it("declares server playback and uses the default 16kHz PCM16 mono uplink", () => {
    expect(buildMossInterpretMediaConfigurePayload()).toEqual({
      action: "media.configure",
      playback: "server"
    });
  });
});

describe("parseMossInterpretServerJsonEvent", () => {
  it("parses session_attached with session id", () => {
    expect(
      parseMossInterpretServerJsonEvent({ type: "session_attached", data: { session_id: "s-1" } })
    ).toEqual({ kind: "session_attached", sessionId: "s-1" });
  });

  it("parses input transcript snapshots with turn identity", () => {
    expect(
      parseMossInterpretServerJsonEvent({
        type: "input.transcript.updated",
        data: { text: "hello", turn: "t-1" }
      })
    ).toEqual({ kind: "transcript", event: { kind: "input.updated", text: "hello", turn: "t-1" } });
    expect(
      parseMossInterpretServerJsonEvent({
        type: "input.transcript.done",
        data: { text: "hello world", turn: "t-1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "input.done", text: "hello world", turn: "t-1" }
    });
  });

  it("parses output transcript snapshots with run_id and source_turn", () => {
    expect(
      parseMossInterpretServerJsonEvent({
        type: "output.transcript.updated",
        data: { text: "你好", run_id: "r-1", source_turn: "t-1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "output.updated", text: "你好", runId: "r-1", sourceTurn: "t-1" }
    });
    expect(
      parseMossInterpretServerJsonEvent({
        type: "output.transcript.done",
        data: { text: "你好，世界", run_id: "r-1", source_turn: "t-1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "output.done", text: "你好，世界", runId: "r-1", sourceTurn: "t-1" }
    });
  });

  it("parses response.ended with status and defaults missing status to completed", () => {
    expect(
      parseMossInterpretServerJsonEvent({
        type: "response.ended",
        data: { status: "cancelled", run_id: "r-1", source_turn: "t-1" }
      })
    ).toEqual({
      kind: "transcript",
      event: { kind: "response.ended", status: "cancelled", runId: "r-1", sourceTurn: "t-1" }
    });
    expect(
      parseMossInterpretServerJsonEvent({ type: "response.ended", data: { run_id: "r-2" } })
    ).toEqual({
      kind: "transcript",
      event: { kind: "response.ended", status: "completed", runId: "r-2", sourceTurn: "" }
    });
  });

  it("parses session.closing and error events", () => {
    expect(
      parseMossInterpretServerJsonEvent({ type: "session.closing", data: { reason: "draining" } })
    ).toEqual({ kind: "session_closing", reason: "draining" });
    expect(
      parseMossInterpretServerJsonEvent({
        type: "error",
        data: { code: "session_limit", message: "并发已满" }
      })
    ).toEqual({ kind: "error", message: "并发已满", code: "session_limit" });
  });

  it("returns null for unknown or malformed messages", () => {
    expect(parseMossInterpretServerJsonEvent(null)).toBeNull();
    expect(parseMossInterpretServerJsonEvent("junk")).toBeNull();
    expect(parseMossInterpretServerJsonEvent({ type: "unknown.event" })).toBeNull();
  });
});

describe("interpret protocol constants", () => {
  it("uses a dedicated port name and the 1013 close code for session limit", () => {
    expect(MOSS_INTERPRET_PORT_NAME).toBe("offscreen-moss-interpret");
    expect(MOSS_INTERPRET_PORT_NAME).not.toBe("offscreen-moss-live");
    expect(MOSS_INTERPRET_CLOSE_CODE_SESSION_LIMIT).toBe(1013);
  });
});
