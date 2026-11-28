#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PORT = 18492;
const HOST = "127.0.0.1";
const EXTENSION_PROTOCOL = "biliscript-extension-v1";
const CLI_PROTOCOL_PREFIX = "biliscript-cli-v1.";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const SUBTITLE_INLINE_MAX_BYTES = 12 * 1024;
export const MCP_SUBTITLE_INLINE_MAX_BYTES = 24 * 1024;
export const MCP_SUBTITLE_RANGE_MAX_BYTES = 48 * 1024;
export const MCP_SUBTITLE_PREVIEW_SECONDS = 180;
export const MCP_SUBTITLE_PREVIEW_MAX_BYTES = 3 * 1024;
export const MCP_SUBTITLE_BUCKET_SECONDS = 300;
export const MAX_MCP_FRAMES = 6;
export const MAX_CLI_FRAMES = 12;
export const MAX_FRAME_SPAN_SECONDS = 8;
export const FRAME_DEDUPE_TOLERANCE_SECONDS = 0.25;
export const DEFAULT_FRAME_TIMEOUT_MS = 95000;
const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_EXTENSION_GRACE_MS = 35 * 1000;
const EXTENSION_OFFLINE_ERROR = "扩展未连接，请在扩展的「设置 → 本地 Agent」开启连接或点击「去连接」";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function configuredPort() {
  const port = Number(process.env.BILISCRIPT_BRIDGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BILISCRIPT_BRIDGE_PORT 无效");
  return port;
}

function configuredGraceMs() {
  if (process.env.BILISCRIPT_BRIDGE_GRACE_MS === undefined) return DEFAULT_EXTENSION_GRACE_MS;
  const graceMs = Number(process.env.BILISCRIPT_BRIDGE_GRACE_MS);
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("BILISCRIPT_BRIDGE_GRACE_MS 无效");
  return graceMs;
}

function tokenPath(port) {
  return process.env.BILISCRIPT_BRIDGE_TOKEN_PATH || path.join(tmpdir(), `biliscript-bridge-${port}.token`);
}

function ensureToken(port) {
  const file = tokenPath(port);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, randomBytes(32).toString("hex"), "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const token = readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("本地桥接凭据文件无效，请删除后重试");
  return token;
}

function tokensEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function encodeFrame(opcode, payload = Buffer.alloc(0), masked = false) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const extended = body.length < 126 ? 0 : body.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (masked ? 0x80 : 0) | (body.length < 126 ? body.length : extended === 2 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(body.length, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(body.length), 2);
  if (!masked) return Buffer.concat([header, body]);
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const encoded = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) encoded[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, encoded]);
}

class WebSocketPeer {
  constructor(socket, { masked = false, initialData = Buffer.alloc(0) } = {}) {
    this.socket = socket;
    this.masked = masked;
    this.buffer = initialData;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentBytes = 0;
    this.onMessage = null;
    this.onClose = null;
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("close", () => this.onClose?.());
    socket.on("error", () => socket.destroy());
  }

  sendFrame(opcode, payload) {
    if (!this.socket.destroyed && !this.socket.writableEnded) {
      this.socket.write(encodeFrame(opcode, payload, this.masked));
    }
  }

  sendJSON(value) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(value)));
  }

  ping() {
    this.sendFrame(0x9);
  }

  close() {
    if (this.socket.destroyed || this.socket.writableEnded) return;
    this.socket.end(encodeFrame(0x8, Buffer.alloc(0), this.masked));
  }

  fail() {
    this.socket.destroy();
  }

  consume(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.readFrame()) {}
  }

  readFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return false;
    const first = buffer[0];
    const second = buffer[1];
    if ((first & 0x70) !== 0) {
      this.fail();
      return false;
    }
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const hasMask = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      const wide = buffer.readBigUInt64BE(2);
      if (wide > BigInt(MAX_FRAME_BYTES)) {
        this.fail();
        return false;
      }
      length = Number(wide);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES || (opcode >= 0x8 && (!fin || length > 125))) {
      this.fail();
      return false;
    }
    const maskOffset = offset;
    if (hasMask) offset += 4;
    if (buffer.length < offset + length) return false;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (hasMask) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    this.buffer = buffer.subarray(offset + length);

    if (opcode === 0x8) {
      this.close();
      return false;
    }
    if (opcode === 0x9) {
      this.sendFrame(0xa, payload);
      return true;
    }
    if (opcode === 0xa) return true;
    if (opcode === 0) {
      if (!this.fragmentOpcode) {
        this.fail();
        return false;
      }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_FRAME_BYTES) {
        this.fail();
        return false;
      }
      if (fin) {
        const complete = Buffer.concat(this.fragments);
        const completeOpcode = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.fragmentBytes = 0;
        if (completeOpcode === 0x1) this.emitText(complete);
      }
      return true;
    }
    if (opcode !== 0x1 && opcode !== 0x2) {
      this.fail();
      return false;
    }
    if (this.fragmentOpcode) {
      this.fail();
      return false;
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return true;
    }
    if (opcode === 0x1) this.emitText(payload);
    return true;
  }

  emitText(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    this.onMessage?.(message);
  }
}

export function connectWebSocket({ port = configuredPort(), protocol, origin, timeoutMs = 2000 }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const socket = net.connect(port, HOST);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("连接本地 Bridge 超时"));
    }, timeoutMs);
    const finish = (error, peer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", readHandshake);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(peer);
      }
    };
    const onError = (error) => finish(error);
    const readHandshake = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > 16384) finish(new Error("Bridge 握手响应过大"));
        return;
      }
      const head = buffer.subarray(0, end).toString("latin1");
      const lines = head.split("\r\n");
      if (!lines[0].includes(" 101 ")) {
        finish(new Error("本地 Bridge 拒绝连接，请关闭占用端口的其他程序后重试"));
        return;
      }
      const accept = lines.find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
      const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (accept?.split(":", 2)[1].trim() !== expected) {
        finish(new Error("本地 Bridge 握手校验失败"));
        return;
      }
      const peer = new WebSocketPeer(socket, {
        masked: true,
        initialData: buffer.subarray(end + 4)
      });
      finish(null, peer);
      if (peer.buffer.length) queueMicrotask(() => peer.consume(Buffer.alloc(0)));
    };
    socket.on("error", onError);
    socket.on("data", readHandshake);
    socket.once("connect", () => {
      const headers = [
        `GET / HTTP/1.1`,
        `Host: ${HOST}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Protocol: ${protocol}`
      ];
      if (origin) headers.push(`Origin: ${origin}`);
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
  });
}

function isLoopback(socket) {
  return socket.remoteAddress === HOST || socket.remoteAddress === "::1" || socket.remoteAddress === "::ffff:127.0.0.1";
}

const EXTENSION_ORIGIN_PATTERN =
  /^(?:chrome-extension:\/\/[a-z]{32}|moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function selectRole(request, socket, token) {
  if (!isLoopback(socket) || request.headers.upgrade?.toLowerCase() !== "websocket") return null;
  const protocols = String(request.headers["sec-websocket-protocol"] || "").split(",").map((item) => item.trim());
  if (protocols.includes(EXTENSION_PROTOCOL) && EXTENSION_ORIGIN_PATTERN.test(String(request.headers.origin || ""))) {
    return { role: "extension", protocol: EXTENSION_PROTOCOL };
  }
  const cliProtocol = protocols.find((item) => item.startsWith(CLI_PROTOCOL_PREFIX));
  const suppliedToken = cliProtocol?.slice(CLI_PROTOCOL_PREFIX.length) || "";
  if (cliProtocol && tokensEqual(suppliedToken, token) && !request.headers.origin) {
    return { role: "cli", protocol: cliProtocol };
  }
  return null;
}

export async function requestDaemon(command, { port = configuredPort(), timeoutMs = 8000, options = false ? Object.create(null) : undefined } = {}) {
  const token = ensureToken(port);
  const peer = await connectWebSocket({
    port,
    protocol: `${CLI_PROTOCOL_PREFIX}${token}`,
    timeoutMs: timeoutMs > 0 ? Math.min(timeoutMs, 2000) : 2000
  });
  return new Promise((resolve, reject) => {
    const id = randomBytes(12).toString("hex");
    const timer = timeoutMs > 0 ? setTimeout(() => {
      peer.close();
      reject(new Error("等待本地 Bridge 响应超时"));
    }, timeoutMs) : null;
    peer.onMessage = (message) => {
      if (message?.type !== "response" || message.id !== id) return;
      if (timer) clearTimeout(timer);
      peer.close();
      if (message.ok) {
        resolve(message.result);
      } else {
        const error = new Error(String(message.error || "桥接命令执行失败"));
        error.remote = true;
        if (message.extensionOnline === false) error.extensionOnline = false;
        reject(error);
      }
    };
    peer.onClose = () => {
      if (timer) clearTimeout(timer);
      reject(new Error("本地 Bridge 连接已断开"));
    };
    peer.sendJSON({ type: "request", id, command, ...(options ? { options } : {}) });
  });
}

function daemonStatus(command, extensionOnline) {
  return {
    ok: true,
    command,
    bridgeOnline: true,
    extensionOnline: Boolean(extensionOnline),
    daemonPid: process.pid
  };
}

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractTargetBvid(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^BV[0-9A-Za-z]+$/.test(input)) return input;
  const pathMatch = input.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (pathMatch?.[1]) return pathMatch[1];
  if (YOUTUBE_VIDEO_ID_RE.test(input)) return input;
  try {
    const parsed = new URL(input);
    const queryBvid = String(parsed.searchParams.get("bvid") || "").trim();
    if (/^BV[0-9A-Za-z]+$/.test(queryBvid)) return queryBvid;
    const host = parsed.hostname.toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
      if (YOUTUBE_VIDEO_ID_RE.test(id)) return id;
    } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (parsed.pathname.replace(/\/+$/, "") === "/watch") {
        const ytId = String(parsed.searchParams.get("v") || "").trim();
        if (YOUTUBE_VIDEO_ID_RE.test(ytId)) return ytId;
      }
    }
  } catch {
  }
  return "";
}

function isNoActiveVideoTabError(error) {
  const message = String(error?.message || "");
  return message.includes("当前活动标签页不是 B 站视频页") || message.includes("当前活动标签页不是支持的视频页");
}

export async function startDaemon({
  port = configuredPort(),
  token = ensureToken(port),
  frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
  extensionGraceMs = configuredGraceMs()
} = {}) {
  const idleMs = Number(process.env.BILISCRIPT_BRIDGE_IDLE_MS || DEFAULT_IDLE_MS);
  const graceMs = Number.isFinite(extensionGraceMs) && extensionGraceMs >= 0
    ? extensionGraceMs
    : DEFAULT_EXTENSION_GRACE_MS;
  const graceDeadline = Date.now() + graceMs;
  const extensions = new Set();
  const tabRoutes = new Map();
  const disconnectedTabIds = new Set();
  let nextAliasTabId = 100000;
  let hasSeenExtension = false;
  let graceExpired = graceMs === 0;
  let graceTimer = null;
  let lastActivity = Date.now();
  let sequence = 0;
  let activeRequests = 0;
  const clients = new Set();
  const waitingRequests = [];
  const server = http.createServer((request, response) => {
    response.writeHead(426, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "WebSocket upgrade required" }));
  });

  const respondToCli = (client, id, payload) => {
    if (!clients.has(client)) return;
    client.sendJSON({ type: "response", id, ...payload });
  };

  const removeWaitingFor = (client) => {
    for (let index = waitingRequests.length - 1; index >= 0; index -= 1) {
      if (waitingRequests[index].client === client) waitingRequests.splice(index, 1);
    }
  };

  const requestTimeoutMs = (command) => (command === "tabs" ? 6000 : command === "frame" ? frameTimeoutMs : 0);

  const sendExtensionRequest = (session, command, options) => {
    if (!extensions.has(session)) {
      const error = new Error("扩展连接已断开");
      error.extensionDisconnected = true;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const requestId = `${process.pid}-${++sequence}-${randomBytes(6).toString("hex")}`;
      const timeoutMs = requestTimeoutMs(command);
      const timer = timeoutMs > 0 ? setTimeout(() => {
        session.pending.delete(requestId);
        reject(new Error(
          command === "tabs"
            ? "等待扩展标签页快照超时"
            : command === "frame"
              ? `视频截帧超时（${frameTimeoutMs} 毫秒）`
              : "等待扩展响应超时"
        ));
      }, timeoutMs) : null;
      session.pending.set(requestId, { resolve, reject, timer });
      session.peer.sendJSON({ type: "request", id: requestId, command, ...(options ? { options } : {}) });
    });
  };

  const aggregateTabsWithSessions = async () => {
    const activeSessions = Array.from(extensions);
    if (activeSessions.length === 0) {
      const error = new Error(EXTENSION_OFFLINE_ERROR);
      error.extensionOnline = false;
      throw error;
    }
    const settled = await Promise.allSettled(
      activeSessions.map(async (session) => ({
        session,
        result: await sendExtensionRequest(session, "tabs")
      }))
    );
    const fulfilled = settled
      .filter((entry) => entry.status === "fulfilled" && extensions.has(entry.value.session))
      .map((entry) => entry.value);
    if (fulfilled.length === 0) {
      const rejected = settled.find((entry) => entry.status === "rejected");
      throw rejected ? rejected.reason : new Error(EXTENSION_OFFLINE_ERROR);
    }

    const entries = [];
    for (const { session, result } of fulfilled) {
      const rawTabs = Array.isArray(result?.tabs) ? result.tabs : [];
      const liveRawIds = new Set();
      for (const tab of rawTabs) {
        const rawTabId = Number(tab?.tabId);
        if (Number.isInteger(rawTabId) && rawTabId > 0) liveRawIds.add(rawTabId);
        entries.push({ session, tab, rawTabId });
      }
      for (const [rawId, publicId] of session.rawToPublic) {
        if (!liveRawIds.has(rawId)) {
          session.rawToPublic.delete(rawId);
          if (tabRoutes.get(publicId)?.session === session) tabRoutes.delete(publicId);
        }
      }
    }

    const deferred = [];
    for (const entry of entries) {
      if (!Number.isInteger(entry.rawTabId) || entry.rawTabId <= 0) continue;
      const existingPublicId = entry.session.rawToPublic.get(entry.rawTabId);
      if (!existingPublicId) continue;
      const currentOwner = tabRoutes.get(existingPublicId);
      if (currentOwner && currentOwner.session !== entry.session) {
        entry.session.rawToPublic.delete(entry.rawTabId);
        continue;
      }
      tabRoutes.set(existingPublicId, { session: entry.session, rawTabId: entry.rawTabId });
      disconnectedTabIds.delete(existingPublicId);
    }

    for (const entry of entries) {
      if (!Number.isInteger(entry.rawTabId) || entry.rawTabId <= 0) continue;
      if (entry.session.rawToPublic.has(entry.rawTabId)) continue;
      if (!tabRoutes.has(entry.rawTabId)) {
        entry.session.rawToPublic.set(entry.rawTabId, entry.rawTabId);
        tabRoutes.set(entry.rawTabId, { session: entry.session, rawTabId: entry.rawTabId });
        disconnectedTabIds.delete(entry.rawTabId);
      } else {
        deferred.push(entry);
      }
    }

    for (const entry of deferred) {
      if (entry.session.rawToPublic.has(entry.rawTabId)) continue;
      while (tabRoutes.has(nextAliasTabId) || disconnectedTabIds.has(nextAliasTabId)) {
        nextAliasTabId += 1;
      }
      const publicTabId = nextAliasTabId++;
      entry.session.rawToPublic.set(entry.rawTabId, publicTabId);
      tabRoutes.set(publicTabId, { session: entry.session, rawTabId: entry.rawTabId });
      disconnectedTabIds.delete(publicTabId);
    }

    const tabs = [];
    const bySession = new Map();
    for (const entry of entries) {
      const publicTabId = entry.session.rawToPublic.get(entry.rawTabId);
      const snapshot = publicTabId ? { ...entry.tab, tabId: publicTabId } : { ...entry.tab };
      tabs.push(snapshot);
      let list = bySession.get(entry.session);
      if (!list) {
        list = [];
        bySession.set(entry.session, list);
      }
      list.push(snapshot);
    }
    return { tabs, bySession };
  };

  const executeCommand = async (command, options) => {
    if (command === "tabs") {
      const { tabs } = await aggregateTabsWithSessions();
      return { tabs };
    }

    if (options?.tabId !== undefined) {
      const requestedTabId = Number(options.tabId);
      let route = tabRoutes.get(requestedTabId);
      if (!route) {
        if (disconnectedTabIds.has(requestedTabId)) {
          throw new Error("目标标签页所在扩展实例已断开连接");
        }
        if (extensions.size === 1) {
          const [onlySession] = extensions;
          return sendExtensionRequest(onlySession, command, options);
        }
        await aggregateTabsWithSessions();
        route = tabRoutes.get(requestedTabId);
        if (!route) {
          throw new Error(`未找到标签页 ${requestedTabId}，请先运行 tabs 查看当前在线标签页`);
        }
      }
      if (!extensions.has(route.session)) {
        throw new Error("目标标签页所在扩展实例已断开连接");
      }
      return sendExtensionRequest(route.session, command, { ...options, tabId: route.rawTabId });
    }

    if (extensions.size === 1) {
      const [onlySession] = extensions;
      return sendExtensionRequest(onlySession, command, options);
    }

    const { bySession } = await aggregateTabsWithSessions();
    const onlineSessions = Array.from(extensions);
    const targetBvid = extractTargetBvid(options?.bvid);

    if (targetBvid) {
      const matchingActive = [];
      const matchingOther = [];
      const nonMatching = [];
      for (const session of onlineSessions) {
        const sessionTabs = bySession.get(session) || [];
        const matchingTabs = sessionTabs.filter((tab) => tab?.bvid === targetBvid);
        if (matchingTabs.some((tab) => tab?.active === true)) {
          matchingActive.push(session);
        } else if (matchingTabs.length > 0) {
          matchingOther.push(session);
        } else {
          nonMatching.push(session);
        }
      }
      const candidates = [...matchingActive, ...matchingOther, ...nonMatching];
      let lastError = null;
      for (const session of candidates) {
        if (!extensions.has(session)) continue;
        try {
          return await sendExtensionRequest(session, command, options);
        } catch (error) {
          lastError = error;
          if (!error.extensionDisconnected) throw error;
        }
      }
      throw lastError || new Error(EXTENSION_OFFLINE_ERROR);
    }

    const withActiveTab = [];
    const withAnyTab = [];
    const withoutTabs = [];
    for (const session of onlineSessions) {
      const sessionTabs = bySession.get(session) || [];
      if (sessionTabs.some((tab) => tab?.active === true)) {
        withActiveTab.push(session);
      } else if (sessionTabs.length > 0) {
        withAnyTab.push(session);
      } else {
        withoutTabs.push(session);
      }
    }
    const candidates = [...withActiveTab, ...withAnyTab, ...withoutTabs];
    let lastError = null;
    for (const session of candidates) {
      if (!extensions.has(session)) continue;
      try {
        return await sendExtensionRequest(session, command, options);
      } catch (error) {
        lastError = error;
        if (!error.extensionDisconnected && !isNoActiveVideoTabError(error)) throw error;
      }
    }
    throw lastError || new Error(EXTENSION_OFFLINE_ERROR);
  };

  const dispatchToExtension = (client, clientRequestId, command, options) => {
    if (command === "status") {
      respondToCli(client, clientRequestId, { ok: true, result: daemonStatus(command, extensions.size > 0) });
      return;
    }
    activeRequests += 1;
    void executeCommand(command, options)
      .then((result) => {
        lastActivity = Date.now();
        respondToCli(client, clientRequestId, {
          ok: true,
          result: { ...daemonStatus(command, extensions.size > 0), ...result }
        });
      })
      .catch((error) => {
        lastActivity = Date.now();
        const extensionOnline = error?.extensionOnline !== false && extensions.size > 0;
        respondToCli(client, clientRequestId, {
          ok: false,
          error: String(error?.message || "扩展执行桥接命令失败"),
          ...(extensionOnline ? {} : { extensionOnline: false })
        });
      })
      .finally(() => {
        activeRequests = Math.max(0, activeRequests - 1);
      });
  };

  const flushWaitingRequests = () => {
    if (extensions.size === 0 || waitingRequests.length === 0) return;
    const queued = waitingRequests.splice(0, waitingRequests.length);
    lastActivity = Date.now();
    for (const item of queued) {
      if (!clients.has(item.client)) continue;
      dispatchToExtension(item.client, item.clientRequestId, item.command, item.options);
    }
  };

  const failWaitingRequests = () => {
    graceExpired = true;
    graceTimer = null;
    if (waitingRequests.length === 0) return;
    lastActivity = Date.now();
    const queued = waitingRequests.splice(0, waitingRequests.length);
    for (const item of queued) {
      respondToCli(item.client, item.clientRequestId, {
        ok: false,
        error: EXTENSION_OFFLINE_ERROR,
        extensionOnline: false
      });
    }
  };

  server.on("upgrade", (request, socket, head) => {
    const role = selectRole(request, socket, token);
    if (!role) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      `Sec-WebSocket-Protocol: ${role.protocol}`,
      "\r\n"
    ].join("\r\n"));
    const peer = new WebSocketPeer(socket, { initialData: head });

    if (role.role === "extension") {
      hasSeenExtension = true;
      graceExpired = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      const session = {
        peer,
        rawToPublic: new Map(),
        pending: new Map()
      };
      extensions.add(session);
      peer.onMessage = (message) => {
        if (message?.type !== "response" || typeof message.id !== "string") return;
        const pending = session.pending.get(message.id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        session.pending.delete(message.id);
        lastActivity = Date.now();
        if (message.ok) {
          pending.resolve(message.result || {});
        } else {
          pending.reject(new Error(String(message.error || "扩展执行桥接命令失败")));
        }
      };
      peer.onClose = () => {
        if (!extensions.has(session)) return;
        extensions.delete(session);
        for (const [publicTabId, entry] of tabRoutes) {
          if (entry.session !== session) continue;
          tabRoutes.delete(publicTabId);
          disconnectedTabIds.add(publicTabId);
        }
        for (const [requestId, pending] of session.pending) {
          if (pending.timer) clearTimeout(pending.timer);
          session.pending.delete(requestId);
          const error = new Error("扩展连接已断开");
          error.extensionDisconnected = true;
          pending.reject(error);
        }
        server.emit("extension-disconnected", { remaining: extensions.size });
      };
      flushWaitingRequests();
      if (peer.buffer.length) queueMicrotask(() => peer.consume(Buffer.alloc(0)));
      return;
    }

    clients.add(peer);
    peer.onClose = () => {
      clients.delete(peer);
      removeWaitingFor(peer);
    };
    peer.onMessage = (message) => {
      lastActivity = Date.now();
      if (message?.type !== "request" || typeof message.id !== "string") return;
      const command = String(message.command || "");
      if (command === "status" && !message.options?.wait) {
        respondToCli(peer, message.id, { ok: true, result: daemonStatus(command, extensions.size > 0) });
        return;
      }
      if (!["status", "tabs", "fetch", "subtitles", "comments", "frame"].includes(command)) {
        respondToCli(peer, message.id, { ok: false, error: "未知命令" });
        return;
      }
      if (extensions.size === 0) {
        const remainingGraceMs = hasSeenExtension || graceExpired ? 0 : graceDeadline - Date.now();
        if (remainingGraceMs > 0) {
          waitingRequests.push({
            client: peer,
            clientRequestId: message.id,
            command,
            options: message.options
          });
          if (!graceTimer) {
            graceTimer = setTimeout(failWaitingRequests, remainingGraceMs);
          }
          server.emit("waiting-for-extension", command);
          return;
        }
        graceExpired = true;
        respondToCli(peer, message.id, {
          ok: false,
          error: EXTENSION_OFFLINE_ERROR,
          extensionOnline: false
        });
        return;
      }
      dispatchToExtension(peer, message.id, command, message.options);
    };
    if (peer.buffer.length) queueMicrotask(() => peer.consume(Buffer.alloc(0)));
  });

  const heartbeat = setInterval(() => {
    for (const session of extensions) session.peer.ping();
  }, 20000);
  const idleCheckMs = Number.isFinite(idleMs) && idleMs > 0
    ? Math.max(50, Math.min(1000, Math.floor(idleMs / 2)))
    : 1000;
  const idleTimer = setInterval(() => {
    if (activeRequests > 0 || waitingRequests.length > 0 || Date.now() - lastActivity < idleMs) return;
    clearInterval(heartbeat);
    clearInterval(idleTimer);
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    for (const client of clients) client.close();
    for (const session of extensions) session.peer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }, idleCheckMs);
  heartbeat.unref();
  idleTimer.unref();

  server.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(idleTimer);
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    for (const session of extensions) {
      for (const pending of session.pending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
      }
      session.pending.clear();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  return server;
}

function commandTimeout(command, options, { initialProbe = false } = {}) {
  if (command === "status" && !options?.wait) return initialProbe ? 1000 : 8000;
  return 0;
}

async function waitForDaemon(command, port, options) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await requestDaemon(command, { port, options, timeoutMs: commandTimeout(command, options) });
    } catch (error) {
      if (error.remote) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error("本地 Bridge 启动失败");
}

async function runCommand(command, options, { port = configuredPort() } = {}) {
  ensureToken(port);
  try {
    return await requestDaemon(command, {
      port,
      options,
      timeoutMs: commandTimeout(command, options, { initialProbe: true })
    });
  } catch (error) {
    if (error.remote) throw error;
    const child = spawn(process.execPath, [SCRIPT_PATH, "--daemon"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, BILISCRIPT_BRIDGE_PORT: String(port) }
    });
    child.unref();
    return waitForDaemon(command, port, options);
  }
}

export function writeFrameFiles(
  result,
  out,
  { requestedTimes = false ? Object.create(null) : undefined, spanSeconds = 0, maxFrames = MAX_CLI_FRAMES } = {}
) {
  const selected = normalizeCapturedFrames(result, { requestedTimes, spanSeconds, maxFrames });
  const outputDirectory = out ? path.resolve(out) : mkdtempSync(path.join(tmpdir(), "biliscript-frames-"));
  mkdirSync(outputDirectory, { recursive: true });
  const batchId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const bvid = String(result.bvid || "video").replace(/[^0-9A-Za-z_-]/g, "_");
  const written = selected.map((frame, index) => {
    const bytes = Buffer.from(frame.data, "base64");
    const filePath = path.join(outputDirectory, `${bvid}-${batchId}-${index + 1}.jpg`);
    writeFileSync(filePath, bytes, { flag: "wx" });
    return {
      path: filePath,
      anchorTime: frame.anchorTime,
      targetTime: frame.targetTime,
      currentTime: frame.currentTime
    };
  });
  return { ...result, frames: written };
}

export function formatSubtitleClock(seconds, withHours = false) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const second = total % 60;
  if (!withHours) {
    return `${Math.floor(total / 60)}:${String(second).padStart(2, "0")}`;
  }
  const minute = Math.floor((total % 3600) / 60);
  return `${Math.floor(total / 3600)}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

export function parseTimestampSeconds(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  const mmss = trimmed.match(/^(\d+):([0-5]\d(?:\.\d+)?)$/);
  if (mmss) {
    const seconds = Number(mmss[1]) * 60 + Number(mmss[2]);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  const hhmmss = trimmed.match(/^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/);
  if (hhmmss) {
    const seconds = Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3]);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  return null;
}

export function expandFrameTargets(
  times,
  { spanSeconds = 0, dedupeToleranceSeconds = FRAME_DEDUPE_TOLERANCE_SECONDS } = {}
) {
  if (!Array.isArray(times) || times.length === 0) return [];
  const span = Number(spanSeconds);
  if (!Number.isFinite(span) || span < 0) return [];
  const candidates = [];
  for (const rawTime of times) {
    const anchor = Number(rawTime);
    if (!Number.isFinite(anchor) || anchor < 0) continue;
    if (span === 0) {
      candidates.push({ anchorTime: anchor, targetTime: anchor, isAnchor: true });
    } else {
      const before = Math.max(0, anchor - span);
      const after = anchor + span;
      candidates.push({ anchorTime: anchor, targetTime: before, isAnchor: before === anchor });
      candidates.push({ anchorTime: anchor, targetTime: anchor, isAnchor: true });
      candidates.push({ anchorTime: anchor, targetTime: after, isAnchor: after === anchor });
    }
  }
  candidates.sort((left, right) => {
    if (left.targetTime !== right.targetTime) return left.targetTime - right.targetTime;
    if (left.isAnchor === right.isAnchor) return left.anchorTime - right.anchorTime;
    return left.isAnchor ? -1 : 1;
  });
  const deduped = [];
  for (const item of candidates) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(item.targetTime - previous.targetTime) <= dedupeToleranceSeconds) {
      if (!previous.isAnchor && item.isAnchor) {
        deduped[deduped.length - 1] = item;
      }
      continue;
    }
    deduped.push(item);
  }
  return deduped.map(({ anchorTime, targetTime }) => ({ anchorTime, targetTime }));
}

function sliceUtf8ByBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let result = "";
  let used = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (used + chBytes > maxBytes) break;
    result += ch;
    used += chBytes;
  }
  return result;
}

function summarizeOutlinePreview(items, maxChars = 80) {
  const parts = [];
  let length = 0;
  for (const item of items) {
    const content = item.content;
    if (!content) continue;
    const sep = parts.length ? 1 : 0;
    if (length + sep + content.length > maxChars) {
      const remaining = maxChars - length - sep;
      if (remaining > 1) {
        parts.push(`${Array.from(content).slice(0, remaining - 1).join("")}…`);
      } else if (parts.length === 0) {
        parts.push(`${Array.from(content).slice(0, Math.max(1, maxChars - 1)).join("")}…`);
      }
      break;
    }
    parts.push(content);
    length += sep + content.length;
  }
  return parts.join(" ");
}

function normalizeSubtitleItems(items) {
  const validItems = [];
  let minFrom = Number.POSITIVE_INFINITY;
  let maxTo = 0;
  for (const item of items) {
    const content = String(item?.content ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!content) continue;
    const from = Number(item?.from) || 0;
    const to = Number(item?.to) || from;
    validItems.push({ from, to, content });
    if (from < minFrom) minFrom = from;
    if (to > maxTo) maxTo = to;
    if (from > maxTo) maxTo = from;
  }
  return { validItems, minFrom, maxTo };
}

export function formatMcpSubtitlePayload(
  result,
  requestOptions = {},
  {
    maxInlineBytes = MCP_SUBTITLE_INLINE_MAX_BYTES,
    maxRangeBytes = MCP_SUBTITLE_RANGE_MAX_BYTES,
    previewSeconds = MCP_SUBTITLE_PREVIEW_SECONDS,
    previewMaxBytes = MCP_SUBTITLE_PREVIEW_MAX_BYTES,
    bucketSeconds = MCP_SUBTITLE_BUCKET_SECONDS
  } = {}
) {
  const subtitle = result?.subtitle;
  if (!subtitle || !Array.isArray(subtitle.items)) return result;

  const { validItems, minFrom, maxTo } = normalizeSubtitleItems(subtitle.items);
  const withHours = maxTo >= 3600;
  const lines = validItems.map((item) => `${formatSubtitleClock(item.from, withHours)} ${item.content}`);
  const fullText = lines.join("\n");
  const fullBytes = Buffer.byteLength(fullText, "utf8");
  const hasRange = requestOptions?.from !== undefined || requestOptions?.to !== undefined;
  const { items: _items, ...subtitleMeta } = subtitle;

  if ((!hasRange && fullBytes <= maxInlineBytes) || (hasRange && fullBytes <= maxRangeBytes)) {
    return {
      ...result,
      subtitle: {
        ...subtitleMeta,
        mode: "inline",
        text: fullText,
        count: validItems.length,
        from: validItems.length ? minFrom : null,
        to: validItems.length ? maxTo : null
      }
    };
  }

  if (hasRange) {
    const selectedLines = [];
    const selectedItems = [];
    let usedBytes = 0;
    let nextIndex = validItems.length;
    for (let index = 0; index < validItems.length; index += 1) {
      const line = lines[index];
      const sepBytes = selectedLines.length > 0 ? 1 : 0;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (usedBytes + sepBytes + lineBytes > maxRangeBytes) {
        if (selectedLines.length === 0) {
          selectedLines.push(sliceUtf8ByBytes(line, maxRangeBytes));
          selectedItems.push(validItems[index]);
          nextIndex = index + 1;
        } else {
          nextIndex = index;
        }
        break;
      }
      selectedLines.push(line);
      selectedItems.push(validItems[index]);
      usedBytes += sepBytes + lineBytes;
    }
    const sliceFrom = selectedItems.length ? selectedItems[0].from : null;
    const sliceTo = selectedItems.length
      ? selectedItems.reduce((acc, item) => Math.max(acc, item.from, item.to), 0)
      : null;
    const nextFrom = nextIndex < validItems.length ? validItems[nextIndex].from : null;
    return {
      ...result,
      subtitle: {
        ...subtitleMeta,
        mode: "inline",
        text: selectedLines.join("\n"),
        count: selectedItems.length,
        totalCount: validItems.length,
        from: sliceFrom,
        to: sliceTo,
        truncated: true,
        nextFrom,
        hint: nextFrom !== null
          ? `当前区间字幕超过 48 KiB，已在完整字幕行边界截断。请调用 biliscript_subtitles 并传入 from=${nextFrom} 继续读取剩余内容。`
          : "当前区间字幕超过 48 KiB，已截断输出。"
      }
    };
  }

  const rawChapters = Array.isArray(result?.chapters) ? result.chapters : [];
  let outlineSource = "buckets";
  let outline = [];
  if (rawChapters.length >= 2) {
    outlineSource = "chapters";
    const sortedChapters = rawChapters
      .map((chapter) => ({
        title: String(chapter?.title || "").trim(),
        from: Math.max(0, Number(chapter?.from) || 0),
        to: Number(chapter?.to)
      }))
      .sort((left, right) => left.from - right.from);
    outline = sortedChapters.map((chapter, index) => {
      const fallbackTo = index + 1 < sortedChapters.length ? sortedChapters[index + 1].from : maxTo;
      const chapterTo = Number.isFinite(chapter.to) && chapter.to >= chapter.from ? chapter.to : Math.max(chapter.from, fallbackTo);
      const isLast = index === sortedChapters.length - 1;
      const chapterItems = validItems.filter((item) => (
        isLast
          ? item.from >= chapter.from && item.from <= chapterTo
          : item.from >= chapter.from && item.from < chapterTo
      ));
      return {
        title: chapter.title,
        from: chapter.from,
        to: chapterTo,
        count: chapterItems.length,
        preview: summarizeOutlinePreview(chapterItems)
      };
    });
  } else {
    const buckets = new Map();
    const upperBound = Math.max(maxTo, Number(result?.video?.duration) || 0);
    for (const item of validItems) {
      const bucketIdx = Math.floor(Math.max(0, item.from) / bucketSeconds);
      let entry = buckets.get(bucketIdx);
      if (!entry) {
        entry = { items: [], maxEnd: item.to };
        buckets.set(bucketIdx, entry);
      }
      entry.items.push(item);
      if (item.to > entry.maxEnd) entry.maxEnd = item.to;
      if (item.from > entry.maxEnd) entry.maxEnd = item.from;
    }
    outline = Array.from(buckets.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([bucketIdx, entry]) => {
        const bucketFrom = bucketIdx * bucketSeconds;
        const candidateTo = Math.min(upperBound, (bucketIdx + 1) * bucketSeconds);
        const bucketTo = candidateTo >= bucketFrom ? candidateTo : entry.maxEnd;
        return {
          from: bucketFrom,
          to: bucketTo,
          count: entry.items.length,
          preview: summarizeOutlinePreview(entry.items)
        };
      });
  }

  const previewCutoff = minFrom > previewSeconds ? minFrom + previewSeconds : previewSeconds;
  const previewLines = [];
  let previewBytes = 0;
  for (let index = 0; index < validItems.length; index += 1) {
    if (validItems[index].from > previewCutoff) break;
    const line = lines[index];
    const sepBytes = previewLines.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (previewBytes + sepBytes + lineBytes > previewMaxBytes) {
      if (previewLines.length === 0) {
        previewLines.push(sliceUtf8ByBytes(line, previewMaxBytes));
      }
      break;
    }
    previewLines.push(line);
    previewBytes += sepBytes + lineBytes;
  }

  return {
    ...result,
    subtitle: {
      ...subtitleMeta,
      mode: "windowed",
      count: validItems.length,
      from: validItems.length ? minFrom : null,
      to: validItems.length ? maxTo : null,
      totalBytes: fullBytes,
      outlineSource,
      outline,
      previewText: previewLines.join("\n"),
      hint: "字幕全文超过 24 KiB，已切换纯内存导览模式。请结合 outline 与 previewText 选定目标时间段，调用 biliscript_subtitles(from, to) 分段精读。"
    }
  };
}

function validateFrameData(frame, index) {
  const data = String(frame?.data || "");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error(`第 ${index + 1} 张截图不是有效 JPEG 数据`);
  }
  const targetTime = Number(frame.targetTime);
  const currentTime = Number(frame.currentTime);
  if (!Number.isFinite(targetTime) || !Number.isFinite(currentTime) || currentTime < 0) {
    throw new Error(`第 ${index + 1} 张截图缺少有效时间信息`);
  }
  const rawAnchor = frame.anchorTime;
  const anchorTime = rawAnchor !== undefined && Number.isFinite(Number(rawAnchor))
    ? Number(rawAnchor)
    : targetTime;
  return { data, anchorTime, targetTime, currentTime };
}

function selectClosestFrame(frames, target) {
  let best = frames[0];
  let bestDiff = Math.abs(best.currentTime - target);
  let bestTargetDiff = Math.abs(best.targetTime - target);
  for (let index = 1; index < frames.length; index += 1) {
    const candidate = frames[index];
    const diff = Math.abs(candidate.currentTime - target);
    const targetDiff = Math.abs(candidate.targetTime - target);
    if (diff < bestDiff || (diff === bestDiff && targetDiff < bestTargetDiff)) {
      best = candidate;
      bestDiff = diff;
      bestTargetDiff = targetDiff;
    }
  }
  return { ...best, anchorTime: target };
}

function isLegacyMultiPointResponse(frames, requestedTimes, spanSeconds) {
  if (!Array.isArray(requestedTimes) || requestedTimes.length <= 1) return false;
  if (frames.some((frame) => typeof frame?.anchorTime === "number" && Number.isFinite(frame.anchorTime))) {
    return false;
  }
  const targetTolerance = Math.max(spanSeconds, 0.5);
  const currentTolerance = Math.max(spanSeconds + 0.5, 2.5);
  const hasUncoveredPoint = requestedTimes.slice(1).some((target) => !frames.some((frame) => (
    Math.abs(Number(frame?.targetTime) - target) <= targetTolerance
    || Math.abs(Number(frame?.currentTime) - target) <= currentTolerance
  )));
  if (hasUncoveredPoint) return true;
  if (spanSeconds === 0 && frames.length > requestedTimes.length) {
    const first = requestedTimes[0];
    if (frames.every((frame) => Math.abs(Number(frame?.targetTime) - first) <= 2.5)) {
      return true;
    }
  }
  return false;
}

function normalizeCapturedFrames(
  result,
  { requestedTimes = false ? Object.create(null) : undefined, spanSeconds = 0, maxFrames = MAX_CLI_FRAMES } = {}
) {
  const rawFrames = Array.isArray(result?.frames) ? result.frames : [];
  if (!rawFrames.length) throw new Error("扩展未返回可用视频帧");
  const validated = rawFrames.map((frame, index) => validateFrameData(frame, index));
  let selected = validated;
  if (Array.isArray(requestedTimes) && requestedTimes.length === 1 && spanSeconds === 0 && validated.length > 1) {
    selected = [selectClosestFrame(validated, requestedTimes[0])];
  } else if (Array.isArray(requestedTimes) && requestedTimes.length === 1 && spanSeconds > 0) {
    selected = validated.map((frame) => ({
      ...frame,
      anchorTime: Number.isFinite(Number(frame.anchorTime)) ? frame.anchorTime : requestedTimes[0]
    }));
  }
  return selected.slice(0, maxFrames);
}

async function executeFrameRequest(
  executeDaemon,
  { target = {}, daemonOptions, requestedTimes, spanSeconds = 0, maxFrames }
) {
  let result = await executeDaemon("frame", daemonOptions);
  if (
    requestedTimes
    && requestedTimes.length > 1
    && isLegacyMultiPointResponse(Array.isArray(result?.frames) ? result.frames : [], requestedTimes, spanSeconds)
  ) {
    let firstValidated;
    try {
      firstValidated = (Array.isArray(result?.frames) ? result.frames : []).map((frame, index) => validateFrameData(frame, index));
    } catch (error) {
      error.remote = true;
      throw error;
    }
    const collected = [];
    if (firstValidated.length > 0) {
      if (spanSeconds === 0) {
        collected.push(selectClosestFrame(firstValidated, requestedTimes[0]));
      } else {
        collected.push(...firstValidated.map((frame) => ({ ...frame, anchorTime: requestedTimes[0] })));
      }
    }
    for (const targetTime of requestedTimes.slice(1)) {
      if (collected.length >= maxFrames) break;
      const pointResult = await executeDaemon("frame", {
        ...target,
        times: [targetTime],
        targetTime,
        spanSeconds
      });
      let pointFrames;
      try {
        pointFrames = (Array.isArray(pointResult?.frames) ? pointResult.frames : []).map((frame, index) => validateFrameData(frame, index));
      } catch (error) {
        error.remote = true;
        throw error;
      }
      if (pointFrames.length === 0) continue;
      if (spanSeconds === 0) {
        collected.push(selectClosestFrame(pointFrames, targetTime));
      } else {
        collected.push(...pointFrames.map((frame) => ({ ...frame, anchorTime: targetTime })));
      }
    }
    result = { ...result, frames: collected.slice(0, maxFrames) };
  }
  return result;
}

export function formatMcpFrameContent(
  result,
  { requestedTimes = false ? Object.create(null) : undefined, spanSeconds = 0, maxFrames = MAX_MCP_FRAMES } = {}
) {
  const selected = normalizeCapturedFrames(result, { requestedTimes, spanSeconds, maxFrames });
  const metadata = {
    ...(result?.site ? { site: result.site } : {}),
    bvid: result?.bvid,
    cid: result?.cid,
    frames: selected.map((frame, index) => ({
      index: index + 1,
      anchorTime: frame.anchorTime,
      targetTime: frame.targetTime,
      currentTime: frame.currentTime
    }))
  };
  return [
    { type: "text", text: JSON.stringify(metadata) },
    ...selected.map((frame) => ({
      type: "image",
      data: frame.data,
      mimeType: "image/jpeg"
    }))
  ];
}

class McpParamError extends Error {
  constructor(message) {
    super(message);
    this.code = -32602;
  }
}

const READ_ONLY_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
};

export const MCP_TOOLS = [
  {
    name: "biliscript_status",
    description: "检查本机 BiliScript Bridge Daemon 与浏览器扩展的连接状态。",
    inputSchema: {
      type: "object",
      properties: {
        wait: {
          type: "boolean",
          description: "是否在冷启动宽限期内等待扩展重连（默认 false）。"
        }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY_MCP_ANNOTATIONS
  },
  {
    name: "biliscript_tabs",
    description: "列出当前已连接浏览器中打开的 B 站与 YouTube 视频标签页（含 tabId、bvid、标题、当前播放进度与字幕就绪状态）。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: READ_ONLY_MCP_ANNOTATIONS
  },
  {
    name: "biliscript_fetch",
    description: "单趟获取视频元信息、分 P、章节、字幕与最多 20 条热评。未指定区间且字幕不超过 24 KiB 时直出全文；超长视频自动返回章节或 300 秒时间桶目录与开头 180 秒预览，引导调用 biliscript_subtitles 分段精读。",
    inputSchema: {
      type: "object",
      properties: {
        video: {
          type: "string",
          description: "B 站 BV 号、YouTube 11 位 ID 或视频链接（不可与 tabId 同时传入）。"
        },
        tabId: {
          type: "integer",
          minimum: 1,
          description: "目标视频标签页 ID（不可与 video 同时传入）。"
        },
        from: {
          type: "number",
          minimum: 0,
          description: "字幕起始秒数（非负）。"
        },
        to: {
          type: "number",
          minimum: 0,
          description: "字幕结束秒数（非负且不小于 from）。"
        }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY_MCP_ANNOTATIONS
  },
  {
    name: "biliscript_subtitles",
    description: "拉取指定视频或时间区间的字幕。未指定区间时超过 24 KiB 自动返回目录与预览；显式传入 from/to 时单次最多内联 48 KiB，超出时在完整行边界截断并返回 nextFrom 续读游标。",
    inputSchema: {
      type: "object",
      properties: {
        video: {
          type: "string",
          description: "B 站 BV 号、YouTube 11 位 ID 或视频链接（不可与 tabId 同时传入）。"
        },
        tabId: {
          type: "integer",
          minimum: 1,
          description: "目标视频标签页 ID（不可与 video 同时传入）。"
        },
        from: {
          type: "number",
          minimum: 0,
          description: "字幕起始秒数（非负）。"
        },
        to: {
          type: "number",
          minimum: 0,
          description: "字幕结束秒数（非负且不小于 from）。"
        }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY_MCP_ANNOTATIONS
  },
  {
    name: "biliscript_frame",
    description: "截取视频关键帧并返回原生 JPEG 图片与时间戳元数据。省略 times/time 时截取已打开标签页当前播放帧；传入 times/time 时默认 spanSeconds=0 每点精确截 1 帧，单次最多返回 6 帧。",
    inputSchema: {
      type: "object",
      properties: {
        video: {
          type: "string",
          description: "B 站 BV 号、YouTube 11 位 ID 或视频链接（不可与 tabId 同时传入）。"
        },
        tabId: {
          type: "integer",
          minimum: 1,
          description: "目标视频标签页 ID（不可与 video 同时传入）。"
        },
        times: {
          type: "array",
          minItems: 1,
          maxItems: MAX_MCP_FRAMES,
          items: {
            oneOf: [
              { type: "number", minimum: 0 },
              { type: "string" }
            ]
          },
          description: "1 至 6 个目标时间点（非负秒数或 mm:ss / hh:mm:ss 字符串，不可与 time 同时传入）。"
        },
        time: {
          oneOf: [
            { type: "number", minimum: 0 },
            { type: "string" }
          ],
          description: "单个目标时间点的兼容别名（非负秒数或 mm:ss / hh:mm:ss 字符串，不可与 times 同时传入）。"
        },
        spanSeconds: {
          type: "number",
          minimum: 0,
          maximum: MAX_FRAME_SPAN_SECONDS,
          default: 0,
          description: "可选邻域跨度（0..8 秒，默认 0 每点截 1 帧；大于 0 时展开 [t-span, t, t+span]，去重后总帧数不得超过 6）。"
        }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY_MCP_ANNOTATIONS
  }
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(obj, allowedKeys, context) {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new McpParamError(`${context} 不支持未知参数：${key}`);
    }
  }
}

function parseTargetAndRangeArgs(args, { allowRange = false } = {}) {
  const options = {};
  if (args.video !== undefined) {
    if (typeof args.video !== "string" || !args.video.trim()) {
      throw new McpParamError("video 必须是非空字符串");
    }
    options.bvid = args.video.trim();
  }
  if (args.tabId !== undefined) {
    if (typeof args.tabId !== "number" || !Number.isInteger(args.tabId) || args.tabId <= 0) {
      throw new McpParamError("tabId 必须是正整数");
    }
    options.tabId = args.tabId;
  }
  if (options.bvid !== undefined && options.tabId !== undefined) {
    throw new McpParamError("video 与 tabId 不能同时传入");
  }
  if (allowRange) {
    if (args.from !== undefined) {
      if (typeof args.from !== "number" || !Number.isFinite(args.from) || args.from < 0) {
        throw new McpParamError("from 必须是非负有限数字");
      }
      options.from = args.from;
    }
    if (args.to !== undefined) {
      if (typeof args.to !== "number" || !Number.isFinite(args.to) || args.to < 0) {
        throw new McpParamError("to 必须是非负有限数字");
      }
      options.to = args.to;
    }
    if (options.from !== undefined && options.to !== undefined && options.to < options.from) {
      throw new McpParamError("to 不能小于 from");
    }
  }
  return options;
}

function parseMcpFrameArgs(args) {
  assertAllowedKeys(args, new Set(["video", "tabId", "times", "time", "spanSeconds"]), "biliscript_frame");
  const target = parseTargetAndRangeArgs(args, { allowRange: false });
  if (args.times !== undefined && args.time !== undefined) {
    throw new McpParamError("times 与 time 不能同时传入");
  }
  let spanSeconds = 0;
  if (args.spanSeconds !== undefined) {
    if (
      typeof args.spanSeconds !== "number"
      || !Number.isFinite(args.spanSeconds)
      || args.spanSeconds < 0
      || args.spanSeconds > MAX_FRAME_SPAN_SECONDS
    ) {
      throw new McpParamError(`spanSeconds 必须是 0 到 ${MAX_FRAME_SPAN_SECONDS} 之间的有限数字`);
    }
    spanSeconds = args.spanSeconds;
  }
  let requestedTimes;
  if (args.times !== undefined) {
    if (!Array.isArray(args.times) || args.times.length < 1 || args.times.length > MAX_MCP_FRAMES) {
      throw new McpParamError(`times 必须是包含 1 到 ${MAX_MCP_FRAMES} 个时间点的数组`);
    }
    requestedTimes = args.times.map((item, index) => {
      const parsed = parseTimestampSeconds(item);
      if (parsed === null) {
        throw new McpParamError(`times[${index}] 不是有效时间（支持非负秒数或 mm:ss / hh:mm:ss）`);
      }
      return parsed;
    });
  } else if (args.time !== undefined) {
    const parsed = parseTimestampSeconds(args.time);
    if (parsed === null) {
      throw new McpParamError("time 不是有效时间（支持非负秒数或 mm:ss / hh:mm:ss）");
    }
    requestedTimes = [parsed];
  } else if (spanSeconds > 0) {
    throw new McpParamError("指定 spanSeconds 时必须同时提供 times 或 time");
  }

  if (requestedTimes) {
    const expanded = expandFrameTargets(requestedTimes, { spanSeconds });
    if (expanded.length > MAX_MCP_FRAMES) {
      throw new McpParamError(
        `单次 MCP 截帧上限为 ${MAX_MCP_FRAMES} 帧，当前参数展开去重后为 ${expanded.length} 帧，请减少时间点或减小 spanSeconds`
      );
    }
  }

  const daemonOptions = {
    ...target,
    ...(requestedTimes ? { times: requestedTimes, targetTime: requestedTimes[0], spanSeconds } : {})
  };
  return {
    target,
    requestedTimes,
    spanSeconds,
    daemonOptions: Object.keys(daemonOptions).length > 0 ? daemonOptions : undefined
  };
}

async function executeMcpToolCall(name, rawArgs, executeDaemon) {
  const args = rawArgs === undefined ? {} : rawArgs;
  if (!isPlainObject(args)) {
    throw new McpParamError("tools/call 的 arguments 必须是 JSON 对象");
  }

  if (name === "biliscript_status") {
    assertAllowedKeys(args, new Set(["wait"]), name);
    if (args.wait !== undefined && typeof args.wait !== "boolean") {
      throw new McpParamError("wait 必须是布尔值");
    }
    const options = args.wait ? { wait: true } : undefined;
    try {
      const result = await executeDaemon("status", options);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error?.message || "状态检查失败") }] };
    }
  }

  if (name === "biliscript_tabs") {
    assertAllowedKeys(args, new Set(), name);
    try {
      const result = await executeDaemon("tabs", undefined);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error?.message || "获取标签页失败") }] };
    }
  }

  if (name === "biliscript_fetch" || name === "biliscript_subtitles") {
    assertAllowedKeys(args, new Set(["video", "tabId", "from", "to"]), name);
    const options = parseTargetAndRangeArgs(args, { allowRange: true });
    const daemonCommand = name === "biliscript_fetch" ? "fetch" : "subtitles";
    try {
      const result = await executeDaemon(daemonCommand, Object.keys(options).length > 0 ? options : undefined);
      const formatted = formatMcpSubtitlePayload(result, options);
      return { content: [{ type: "text", text: JSON.stringify(formatted) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error?.message || "获取视频内容失败") }] };
    }
  }

  if (name === "biliscript_frame") {
    const parsed = parseMcpFrameArgs(args);
    try {
      const result = await executeFrameRequest(executeDaemon, {
        target: parsed.target,
        daemonOptions: parsed.daemonOptions,
        requestedTimes: parsed.requestedTimes,
        spanSeconds: parsed.spanSeconds,
        maxFrames: MAX_MCP_FRAMES
      });
      const content = formatMcpFrameContent(result, {
        requestedTimes: parsed.requestedTimes,
        spanSeconds: parsed.spanSeconds
      });
      return { content };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error?.message || "截帧失败") }] };
    }
  }

  throw new McpParamError(`未知工具：${name}`);
}

export function startMcpServer({
  input = process.stdin,
  output = process.stdout,
  port = configuredPort(),
  executeDaemon = (command, options) => runCommand(command, options, { port })
} = {}) {
  const writeMessage = (payload) => {
    if (output.destroyed || output.writableEnded) return;
    output.write(`${JSON.stringify(payload)}\n`);
  };

  const handleRequest = async (message) => {
    const hasId = Object.prototype.hasOwnProperty.call(message, "id") && message.id !== undefined;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !message.method) {
      if (hasId) {
        writeMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Invalid Request" } });
      } else {
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      }
      return;
    }

    if (!hasId) {
      return;
    }

    const { id, method, params } = message;
    try {
      if (method === "initialize") {
        if (params !== undefined && !isPlainObject(params)) {
          throw new McpParamError("initialize 参数必须是对象");
        }
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
        writeMessage({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "biliscript", version: "1.0.0" },
            instructions: "使用 BiliScript 读取本机浏览器已连接扩展中的 B 站与 YouTube 视频元信息、章节、字幕、热评和视频画面。建议顺序：1) 未知目标时先调用 biliscript_tabs；2) 用 biliscript_fetch 一次性获取元信息、章节、热评与字幕（超 24 KiB 自动返回目录与开头 180 秒预览，再按需调用 biliscript_subtitles(from, to) 分段精读，单区间超 48 KiB 按 nextFrom 续读）；3) 需核验画面时调用 biliscript_frame，默认 spanSeconds=0 每点截 1 帧，单次最多 6 帧。"
          }
        });
        return;
      }

      if (method === "ping") {
        writeMessage({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "tools/list") {
        writeMessage({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
        return;
      }

      if (method === "tools/call") {
        if (!isPlainObject(params) || typeof params.name !== "string" || !params.name) {
          throw new McpParamError("tools/call 必须提供字符串类型的 name");
        }
        const result = await executeMcpToolCall(params.name, params.arguments, executeDaemon);
        writeMessage({ jsonrpc: "2.0", id, result });
        return;
      }

      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    } catch (error) {
      const code = error instanceof McpParamError ? error.code : -32603;
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code, message: String(error?.message || "Internal error") }
      });
    }
  };

  return new Promise((resolve) => {
    let buffer = "";
    let inputEnded = false;
    let resolved = false;
    const inFlight = new Set();

    const maybeFinish = () => {
      if (!resolved && inputEnded && inFlight.size === 0) {
        resolved = true;
        resolve();
      }
    };

    const dispatchLine = (rawLine) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (!isPlainObject(parsed)) {
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
        return;
      }
      const task = handleRequest(parsed).finally(() => {
        inFlight.delete(task);
        maybeFinish();
      });
      inFlight.add(task);
    };

    const onData = (chunk) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        dispatchLine(line);
      }
    };

    const onEnd = () => {
      if (buffer.trim()) {
        const remaining = buffer;
        buffer = "";
        dispatchLine(remaining);
      }
      inputEnded = true;
      maybeFinish();
    };

    if (typeof input.setEncoding === "function") input.setEncoding("utf8");
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
  });
}

export function applySubtitleSpillover(result, out, { maxInlineBytes = SUBTITLE_INLINE_MAX_BYTES } = {}) {
  const subtitle = result?.subtitle;
  if (!subtitle || !Array.isArray(subtitle.items)) return result;
  const itemsBytes = Buffer.byteLength(JSON.stringify(subtitle.items), "utf8");
  if (!out && itemsBytes <= maxInlineBytes) return result;

  const validItems = [];
  let minFrom = Number.POSITIVE_INFINITY;
  let maxTo = 0;
  for (const item of subtitle.items) {
    const content = String(item?.content ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!content) continue;
    const from = Number(item?.from) || 0;
    const to = Number(item?.to) || from;
    validItems.push({ from, to, content });
    if (from < minFrom) minFrom = from;
    if (to > maxTo) maxTo = to;
    if (from > maxTo) maxTo = from;
  }

  const withHours = maxTo >= 3600;
  const lines = validItems.map((item) => `${formatSubtitleClock(item.from, withHours)} ${item.content}`);
  const outputDirectory = out ? path.resolve(out) : mkdtempSync(path.join(tmpdir(), "biliscript-subtitles-"));
  mkdirSync(outputDirectory, { recursive: true });
  const batchId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const bvid = String(result?.video?.bvid || result?.bvid || "video").replace(/[^0-9A-Za-z_-]/g, "_");
  const page = Number(result?.video?.page);
  const pagePart = Number.isInteger(page) && page > 0 ? `-p${page}` : "";
  const filePath = path.join(outputDirectory, `${bvid}${pagePart}-${batchId}.txt`);
  writeFileSync(filePath, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", flag: "wx" });

  const { items: _items, ...subtitleMeta } = subtitle;
  return {
    ...result,
    subtitle: {
      ...subtitleMeta,
      path: filePath,
      count: lines.length,
      from: validItems.length ? minFrom : null,
      to: validItems.length ? maxTo : null
    }
  };
}

export function parseCliArgs(args) {
  const command = args[0];
  if (!["status", "tabs", "fetch", "subtitles", "comments", "frame"].includes(command)) return null;
  if (command === "tabs") return args.length === 1 ? { command } : null;
  if (command === "status") {
    if (args.length === 1) return { command };
    if (args.length === 2 && args[1] === "--wait") return { command, options: { wait: true } };
    return null;
  }
  const options = {};
  const target = {};
  const requestedTimes = [];
  let spanSeconds = 0;
  let hasSpan = false;
  let out;
  const hasSubtitles = command === "subtitles" || command === "fetch";
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return null;
    index += 1;
    if (flag === "--tab") {
      options.tabId = Number(value);
      if (!Number.isInteger(options.tabId) || options.tabId <= 0) return null;
      target.tabId = options.tabId;
    } else if (flag === "--bvid" || flag === "--video") {
      options.bvid = value;
      target.bvid = value;
    } else if (hasSubtitles && (flag === "--from" || flag === "--to")) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return null;
      options[flag.slice(2)] = number;
    } else if (command === "frame" && flag === "--time") {
      const parsedTime = parseTimestampSeconds(value);
      if (parsedTime === null) {
        return { command, error: `--time 参数无效：${value}（支持非负秒数或 mm:ss / hh:mm:ss）` };
      }
      requestedTimes.push(parsedTime);
    } else if (command === "frame" && flag === "--times") {
      const parts = value.split(",");
      for (const part of parts) {
        const parsedTime = parseTimestampSeconds(part);
        if (parsedTime === null) {
          return { command, error: `--times 参数无效：${value}（请使用逗号分隔的非负秒数或 mm:ss / hh:mm:ss）` };
        }
        requestedTimes.push(parsedTime);
      }
    } else if (command === "frame" && flag === "--span") {
      const trimmedSpan = value.trim();
      const parsedSpan = trimmedSpan ? Number(trimmedSpan) : Number.NaN;
      if (!Number.isFinite(parsedSpan) || parsedSpan < 0 || parsedSpan > MAX_FRAME_SPAN_SECONDS) {
        return { command, error: `--span 必须是 0 到 ${MAX_FRAME_SPAN_SECONDS} 之间的有限数字` };
      }
      spanSeconds = parsedSpan;
      hasSpan = true;
    } else if ((command === "frame" || hasSubtitles) && flag === "--out") {
      out = value;
    } else {
      return null;
    }
  }
  if (options.from !== undefined && options.to !== undefined && options.to < options.from) return null;
  if (command === "frame") {
    if (hasSpan && requestedTimes.length === 0) {
      return { command, error: "指定 --span 时必须同时提供 --times 或 --time" };
    }
    if (requestedTimes.length > 0) {
      const expanded = expandFrameTargets(requestedTimes, { spanSeconds });
      if (expanded.length > MAX_CLI_FRAMES) {
        return {
          command,
          error: `单次 CLI 截帧上限为 ${MAX_CLI_FRAMES} 帧，当前参数展开去重后为 ${expanded.length} 帧，请减少时间点或减小 --span`
        };
      }
      options.times = requestedTimes;
      options.targetTime = requestedTimes[0];
      options.spanSeconds = spanSeconds;
    }
    return {
      command,
      options,
      frameRequest: {
        target,
        requestedTimes: requestedTimes.length > 0 ? requestedTimes : undefined,
        spanSeconds
      },
      ...(out ? { out } : {})
    };
  }
  return { command, options, ...(out ? { out } : {}) };
}

function parseMcpArgs(args) {
  if (args[0] !== "mcp") return null;
  if (args.length === 1) return { port: configuredPort() };
  if (args.length === 3 && args[1] === "--port") {
    const port = Number(args[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { port };
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--daemon") {
    try {
      await startDaemon();
    } catch (error) {
      if (error.code !== "EADDRINUSE") {
        console.error(JSON.stringify({ ok: false, error: error.message }));
        process.exitCode = 1;
      }
    }
    return;
  }
  if (args[0] === "mcp") {
    let parsedMcp;
    try {
      parsedMcp = parseMcpArgs(args);
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
      return;
    }
    if (!parsedMcp) {
      console.error(JSON.stringify({ ok: false, error: "用法：node biliscript.mjs mcp [--port <n>]" }));
      process.exitCode = 1;
      return;
    }
    await startMcpServer({ port: parsedMcp.port });
    return;
  }
  const parsed = parseCliArgs(args);
  if (!parsed || parsed.error) {
    console.log(JSON.stringify({
      ok: false,
      ...(parsed?.command ? { command: parsed.command } : {}),
      error: parsed?.error || "用法：node biliscript.mjs <status [--wait]|tabs|mcp [--port <n>]>；fetch [--tab <id>|--bvid <ID/URL>|--video <ID/URL>] [--from <sec> --to <sec>] [--out <dir>]；subtitles [--tab <id>|--bvid <ID/URL>|--video <ID/URL>] [--from <sec> --to <sec>] [--out <dir>]；comments [--tab <id>|--bvid <ID/URL>|--video <ID/URL>]；frame [--tab <id>|--bvid <ID/URL>|--video <ID/URL>] [--times <t1,t2,...>] [--time <t>] [--span <sec>] [--out <dir>]"
    }));
    process.exitCode = 1;
    return;
  }
  try {
    let output;
    if (parsed.command === "frame") {
      const result = await executeFrameRequest(
        (command, options) => runCommand(command, options),
        {
          target: parsed.frameRequest.target,
          daemonOptions: parsed.options,
          requestedTimes: parsed.frameRequest.requestedTimes,
          spanSeconds: parsed.frameRequest.spanSeconds,
          maxFrames: MAX_CLI_FRAMES
        }
      );
      try {
        output = writeFrameFiles(result, parsed.out, {
          requestedTimes: parsed.frameRequest.requestedTimes,
          spanSeconds: parsed.frameRequest.spanSeconds,
          maxFrames: MAX_CLI_FRAMES
        });
      } catch (error) {
        error.remote = true;
        throw error;
      }
    } else {
      const result = await runCommand(parsed.command, parsed.options);
      output = result;
      if (parsed.command === "subtitles" || parsed.command === "fetch") {
        try {
          output = applySubtitleSpillover(result, parsed.out);
        } catch (error) {
          error.remote = true;
          throw error;
        }
      }
    }
    console.log(JSON.stringify(output));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      command: parsed.command,
      bridgeOnline: error.remote === true,
      ...(error.remote === true && error.extensionOnline !== false ? {} : { extensionOnline: false }),
      error: error.message
    }));
    process.exitCode = 1;
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) void main();
