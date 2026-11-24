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

function extractTargetBvid(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^BV[0-9A-Za-z]+$/.test(input)) return input;
  const pathMatch = input.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (pathMatch?.[1]) return pathMatch[1];
  try {
    const queryBvid = String(new URL(input).searchParams.get("bvid") || "").trim();
    if (/^BV[0-9A-Za-z]+$/.test(queryBvid)) return queryBvid;
  } catch {
  }
  return "";
}

function isNoActiveVideoTabError(error) {
  return String(error?.message || "").includes("当前活动标签页不是 B 站视频页");
}

export async function startDaemon({
  port = configuredPort(),
  token = ensureToken(port),
  frameTimeoutMs = 50000,
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

async function runCommand(command, options) {
  const port = configuredPort();
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
      env: process.env
    });
    child.unref();
    return waitForDaemon(command, port, options);
  }
}

function writeFrameFiles(result, out) {
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  if (!frames.length) throw new Error("扩展未返回可用视频帧");
  const outputDirectory = out ? path.resolve(out) : mkdtempSync(path.join(tmpdir(), "biliscript-frames-"));
  mkdirSync(outputDirectory, { recursive: true });
  const batchId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const bvid = String(result.bvid || "video").replace(/[^0-9A-Za-z_-]/g, "_");
  const written = frames.map((frame, index) => {
    const bytes = Buffer.from(String(frame?.data || ""), "base64");
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`第 ${index + 1} 张截图不是有效 JPEG 数据`);
    }
    const targetTime = Number(frame.targetTime);
    const currentTime = Number(frame.currentTime);
    if (!Number.isFinite(targetTime) || !Number.isFinite(currentTime) || currentTime < 0) {
      throw new Error(`第 ${index + 1} 张截图缺少有效时间信息`);
    }
    const filePath = path.join(outputDirectory, `${bvid}-${batchId}-${index + 1}.jpg`);
    writeFileSync(filePath, bytes, { flag: "wx" });
    return { path: filePath, targetTime, currentTime };
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

function parseCliArgs(args) {
  const command = args[0];
  if (!["status", "tabs", "fetch", "subtitles", "comments", "frame"].includes(command)) return null;
  if (command === "tabs") return args.length === 1 ? { command } : null;
  if (command === "status") {
    if (args.length === 1) return { command };
    if (args.length === 2 && args[1] === "--wait") return { command, options: { wait: true } };
    return null;
  }
  const options = {};
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
    } else if (flag === "--bvid") {
      options.bvid = value;
    } else if (hasSubtitles && (flag === "--from" || flag === "--to")) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return null;
      options[flag.slice(2)] = number;
    } else if (command === "frame" && flag === "--time") {
      options.targetTime = Number(value);
      if (!Number.isFinite(options.targetTime) || options.targetTime < 0) return null;
    } else if ((command === "frame" || hasSubtitles) && flag === "--out") {
      out = value;
    } else {
      return null;
    }
  }
  if (options.from !== undefined && options.to !== undefined && options.to < options.from) return null;
  return { command, options, ...(out ? { out } : {}) };
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
  const parsed = parseCliArgs(args);
  if (!parsed) {
    console.log(JSON.stringify({ ok: false, error: "用法：node biliscript.mjs <status [--wait]|tabs>；fetch [--tab <id>|--bvid <BV/URL>] [--from <sec> --to <sec>] [--out <dir>]；subtitles [--tab <id>|--bvid <BV/URL>] [--from <sec> --to <sec>] [--out <dir>]；comments [--tab <id>|--bvid <BV/URL>]；frame [--tab <id>|--bvid <BV/URL>] [--time <sec>] [--out <dir>]" }));
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runCommand(parsed.command, parsed.options);
    let output = result;
    if (parsed.command === "frame") {
      try {
        output = writeFrameFiles(result, parsed.out);
      } catch (error) {
        error.remote = true;
        throw error;
      }
    } else if (parsed.command === "subtitles" || parsed.command === "fetch") {
      try {
        output = applySubtitleSpillover(result, parsed.out);
      } catch (error) {
        error.remote = true;
        throw error;
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
