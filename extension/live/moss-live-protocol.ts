// extension/live/moss-live-protocol.ts
// MOSS-LIVE 全双工实时对话协议定义与二进制编解码工具。
// 官方实时接口规范：wss://api.mosi.cn/v1/realtime?model=moss-live-1.0
//
// 上行二进制帧（tagged-v1 协议）：
// 首字节为通道标签（Tag）：
//   0x00: 单声道 PCM S16LE 音频
//   0x01: 摄像头画面帧（JPEG）
//   0x02: 屏幕/视频共享帧（JPEG）
// 后续字节为原始 payload。

export const enum MossBinaryTag {
  AudioPcm = 0x00,
  CameraJpeg = 0x01,
  ScreenJpeg = 0x02
}

export const DEFAULT_MOSS_LIVE_WS_URL = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";
export const MOSS_LIVE_PORT_NAME = "offscreen-moss-live";

/** 打包 tagged-v1 二进制帧（首字节 Tag + 原始二进制 Payload） */
export function packTaggedBinary(tag: MossBinaryTag, payload: ArrayBufferLike): Uint8Array {
  const src = new Uint8Array(payload);
  const out = new Uint8Array(src.byteLength + 1);
  out[0] = tag;
  out.set(src, 1);
  return out;
}

/** 解包 tagged-v1 二进制帧 */
export function unpackTaggedBinary(data: ArrayBufferLike): { tag: MossBinaryTag; payload: Uint8Array } | null {
  if (data.byteLength < 1) return null;
  const view = new Uint8Array(data);
  return {
    tag: view[0] as MossBinaryTag,
    payload: view.subarray(1)
  };
}

/** 由 baseUrl 与 model 计算 WebSocket 连接地址 */
export function resolveMossLiveWsUrl(baseUrl?: string, model?: string): string {
  const rawUrl = String(baseUrl || "").trim() || "https://api.mosi.cn";
  const selectedModel = String(model || "").trim() || "moss-live-1.0";
  try {
    const parsed = new URL(rawUrl);
    const wsProtocol = parsed.protocol === "http:" ? "ws:" : "wss:";
    const host = parsed.host;
    let path = parsed.pathname;
    if (!path || path === "/") {
      path = "/v1/realtime";
    } else if (path.endsWith("/realtime")) {
      // keep
    } else if (path.endsWith("/v1")) {
      path = path + "/realtime";
    } else {
      path = path.replace(/\/+$/, "") + "/v1/realtime";
    }
    return `${wsProtocol}//${host}${path}?model=${encodeURIComponent(selectedModel)}`;
  } catch {
    return `wss://api.mosi.cn/v1/realtime?model=${encodeURIComponent(selectedModel)}`;
  }
}

/** ticket 01 建立会话所需的最小 session.update 载荷（不提前启用后续工单媒体与工具） */
export interface MinimalSessionUpdatePayload {
  action: "session.update";
  session: {
    persona: {
      name: string;
      aliases: string[];
      prompt: string;
    };
    instructions: string;
    voice: string;
    modalities: string[];
  };
}

export function buildMinimalSessionUpdatePayload(): MinimalSessionUpdatePayload {
  return {
    action: "session.update",
    session: {
      persona: {
        name: "Bili伴看助手",
        aliases: ["伴看助手", "小助手"],
        prompt: "你是BiliScript内置的B站视频伴看AI助手，正在和用户一起观看视频。回答应当自然口语化、简明扼要，像朋友一起看视频聊天。"
      },
      instructions: "当前正在观看B站视频伴看会话。",
      voice: "moss-voice-default",
      modalities: ["audio", "text"]
    }
  };
}

/** Offscreen 端口上行（Client -> Offscreen）消息 */
export type MossLiveClientAction =
  | { action: "start"; wsUrl?: string }
  | { action: "stop" };

/** Offscreen 端口下行（Offscreen -> Client）消息 */
export type MossLiveServerEvent =
  | { type: "connecting" }
  | { type: "connected" }
  | { type: "error"; error: string }
  | { type: "closed"; reason?: string };
