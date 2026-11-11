// extension/live/moss-interpret-protocol.ts
// 同声传译（/v1/realtime/interpret）协议定义与下行 JSON 事件解析。
// 与伴看（moss-live-protocol.ts）相互独立：独立端口名、独立 runtime，不复用伴看
// MossAudioPlayer；仅消费文本事件，下行二进制译文语音一律丢弃。
// 连接只带 model 与 target（source 省略自动判断，不开 bidirectional）。

/** 同传 offscreen 端口名（独立于伴看的 MOSS_LIVE_PORT_NAME） */
export const MOSS_INTERPRET_PORT_NAME = "offscreen-moss-interpret";
/** 同传默认模型（与伴看同一 live 模型链路） */
export const DEFAULT_MOSS_INTERPRET_MODEL = "moss-live-1.0";
/** 同传默认目标语言 */
export const DEFAULT_MOSS_INTERPRET_TARGET = "zh";
/** 并发满 / 服务端排空关闭码：如实上报为可识别错误，不自动重试 */
export const MOSS_INTERPRET_CLOSE_CODE_SESSION_LIMIT = 1013;

/** 由 baseUrl、model、target 计算同传 WebSocket 连接地址（不传 source / bidirectional） */
export function resolveMossInterpretWsUrl(
  baseUrl?: string,
  model?: string,
  target?: string
): string {
  const rawUrl = String(baseUrl || "").trim() || "https://api.mosi.cn";
  const selectedModel = String(model || "").trim() || DEFAULT_MOSS_INTERPRET_MODEL;
  const selectedTarget = String(target || "").trim() || DEFAULT_MOSS_INTERPRET_TARGET;
  try {
    const parsed = new URL(rawUrl);
    const wsProtocol = parsed.protocol === "http:" ? "ws:" : "wss:";
    const host = parsed.host;
    let path = parsed.pathname;
    if (!path || path === "/") {
      path = "/v1/realtime/interpret";
    } else if (path.endsWith("/realtime/interpret")) {
      // keep
    } else if (path.endsWith("/realtime")) {
      path = path + "/interpret";
    } else if (path.endsWith("/v1")) {
      path = path + "/realtime/interpret";
    } else {
      path = path.replace(/\/+$/, "") + "/v1/realtime/interpret";
    }
    return `${wsProtocol}//${host}${path}?model=${encodeURIComponent(selectedModel)}&target=${encodeURIComponent(selectedTarget)}`;
  } catch {
    return `wss://api.mosi.cn/v1/realtime/interpret?model=${encodeURIComponent(selectedModel)}&target=${encodeURIComponent(selectedTarget)}`;
  }
}

/** 同传握手第三步：playback=server，上行使用默认 PCM16 16 kHz 单声道 */
export function buildMossInterpretMediaConfigurePayload(): {
  action: "media.configure";
  playback: "server";
} {
  return {
    action: "media.configure",
    playback: "server"
  };
}

/** 同传双端字幕与回合生命周期事件（经 Offscreen 转发至页面侧字幕归并器） */
export type MossInterpretTranscriptEvent =
  | { kind: "input.updated"; text: string; turn: string }
  | { kind: "input.done"; text: string; turn: string }
  | { kind: "output.updated"; text: string; runId: string; sourceTurn: string }
  | { kind: "output.done"; text: string; runId: string; sourceTurn: string }
  | { kind: "response.ended"; status: string; runId: string; sourceTurn: string };

/** 同传 Offscreen 端口上行（Client -> Offscreen）消息 */
export type MossInterpretClientAction =
  | { action: "start"; wsUrl?: string; sessionId?: string | null }
  | { action: "audio"; pcmBase64: string }
  | { action: "stop" };

/** 同传 Offscreen 端口下行（Offscreen -> Client）消息 */
export type MossInterpretServerEvent =
  | { type: "connecting" }
  | { type: "connected"; sessionId?: string }
  | { type: "session_attached"; sessionId: string }
  | {
      type: "reconnecting";
      attempt: number;
      maxAttempts: number;
      code?: number;
      reason?: string;
      error?: string;
    }
  | { type: "transcript"; event: MossInterpretTranscriptEvent }
  | { type: "session_closing"; reason?: string }
  | { type: "error"; error: string; code?: number | string; reason?: string }
  | { type: "closed"; code?: number; reason?: string; error?: string };

/** 同传服务端 JSON 事件结构化解析结果 */
export type MossInterpretParsedServerEvent =
  | { kind: "session_attached"; sessionId: string }
  | { kind: "transcript"; event: MossInterpretTranscriptEvent }
  | { kind: "session_closing"; reason: string }
  | { kind: "error"; message: string; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readStr(
  data: Record<string, unknown> | null,
  obj: Record<string, unknown>,
  key: string
): string {
  const fromData = data?.[key];
  if (typeof fromData === "string") return fromData;
  const fromObj = obj[key];
  if (typeof fromObj === "string") return fromObj;
  return "";
}

/** 解析同传 WebSocket 下行 JSON 消息 */
export function parseMossInterpretServerJsonEvent(raw: unknown): MossInterpretParsedServerEvent | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const action =
    typeof obj.type === "string" ? obj.type : typeof obj.action === "string" ? obj.action : "";
  if (!action) return null;
  const data = asRecord(obj.data);

  switch (action) {
    case "session_attached": {
      const sessionId = readStr(data, obj, "session_id");
      return { kind: "session_attached", sessionId };
    }
    case "input.transcript.updated": {
      const text = readStr(data, obj, "text");
      const turn = readStr(data, obj, "turn");
      return { kind: "transcript", event: { kind: "input.updated", text, turn } };
    }
    case "input.transcript.done": {
      const text = readStr(data, obj, "text");
      const turn = readStr(data, obj, "turn");
      return { kind: "transcript", event: { kind: "input.done", text, turn } };
    }
    case "output.transcript.updated": {
      const text = readStr(data, obj, "text");
      const runId = readStr(data, obj, "run_id");
      const sourceTurn = readStr(data, obj, "source_turn");
      return {
        kind: "transcript",
        event: { kind: "output.updated", text, runId, sourceTurn }
      };
    }
    case "output.transcript.done": {
      const text = readStr(data, obj, "text");
      const runId = readStr(data, obj, "run_id");
      const sourceTurn = readStr(data, obj, "source_turn");
      return {
        kind: "transcript",
        event: { kind: "output.done", text, runId, sourceTurn }
      };
    }
    case "response.ended": {
      const status = readStr(data, obj, "status") || "completed";
      const runId = readStr(data, obj, "run_id");
      const sourceTurn = readStr(data, obj, "source_turn");
      return {
        kind: "transcript",
        event: { kind: "response.ended", status, runId, sourceTurn }
      };
    }
    case "session.closing": {
      const reason = readStr(data, obj, "reason");
      return { kind: "session_closing", reason };
    }
    case "error": {
      const nestedErr = asRecord(data?.error);
      const code =
        typeof nestedErr?.code === "string"
          ? nestedErr.code
          : typeof data?.code === "string"
            ? data.code
            : "";
      const message =
        typeof nestedErr?.message === "string" && nestedErr.message
          ? nestedErr.message
          : typeof data?.message === "string" && data.message
            ? data.message
            : typeof obj.message === "string" && obj.message
              ? obj.message
              : typeof obj.error === "string" && obj.error
                ? obj.error
                : "同声传译会话发生未知错误";
      return { kind: "error", message, code };
    }
    default:
      return null;
  }
}
