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
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function configuredPort() {
  const port = Number(process.env.BILISCRIPT_BRIDGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BILISCRIPT_BRIDGE_PORT 无效");
  return port;
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
      finish(null, new WebSocketPeer(socket, {
        masked: true,
        initialData: buffer.subarray(end + 4)
      }));
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

function selectRole(request, socket, token) {
  if (!isLoopback(socket) || request.headers.upgrade?.toLowerCase() !== "websocket") return null;
  const protocols = String(request.headers["sec-websocket-protocol"] || "").split(",").map((item) => item.trim());
  if (protocols.includes(EXTENSION_PROTOCOL) && /^chrome-extension:\/\/[a-z]{32}$/i.test(String(request.headers.origin || ""))) {
    return { role: "extension", protocol: EXTENSION_PROTOCOL };
  }
  const cliProtocol = protocols.find((item) => item.startsWith(CLI_PROTOCOL_PREFIX));
  const suppliedToken = cliProtocol?.slice(CLI_PROTOCOL_PREFIX.length) || "";
  if (cliProtocol && tokensEqual(suppliedToken, token) && !request.headers.origin) {
    return { role: "cli", protocol: cliProtocol };
  }
  return null;
}

export async function requestDaemon(command, { port = configuredPort(), timeoutMs = 8000, options } = {}) {
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

function daemonStatus(command, extension) {
  return {
    ok: true,
    command,
    bridgeOnline: true,
    extensionOnline: Boolean(extension),
    daemonPid: process.pid
  };
}

export async function startDaemon({ port = configuredPort(), token = ensureToken(port) } = {}) {
  const idleMs = Number(process.env.BILISCRIPT_BRIDGE_IDLE_MS || DEFAULT_IDLE_MS);
  let extension = null;
  let lastActivity = Date.now();
  let sequence = 0;
  const clients = new Set();
  const pendingTabs = new Map();
  const server = http.createServer((request, response) => {
    response.writeHead(426, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "WebSocket upgrade required" }));
  });

  const respondToCli = (client, id, payload) => {
    if (!clients.has(client)) return;
    client.sendJSON({ type: "response", id, ...payload });
  };

  const failPendingFor = (client, error) => {
    for (const [requestId, pending] of pendingTabs) {
      if (pending.client !== client) continue;
      clearTimeout(pending.timer);
      pendingTabs.delete(requestId);
      respondToCli(client, pending.clientRequestId, { ok: false, error });
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
      if (extension) extension.close();
      extension = peer;
      peer.onMessage = (message) => {
        if (message?.type !== "response" || typeof message.id !== "string") return;
        const pending = pendingTabs.get(message.id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        pendingTabs.delete(message.id);
        lastActivity = Date.now();
        respondToCli(pending.client, pending.clientRequestId, message.ok
          ? { ok: true, result: { ...daemonStatus(pending.command, extension), ...message.result } }
          : { ok: false, error: String(message.error || "扩展执行桥接命令失败") });
      };
      peer.onClose = () => {
        if (extension !== peer) return;
        extension = null;
        for (const [requestId, pending] of pendingTabs) {
          if (pending.timer) clearTimeout(pending.timer);
          pendingTabs.delete(requestId);
          respondToCli(pending.client, pending.clientRequestId, { ok: false, error: "扩展连接已断开" });
        }
      };
      return;
    }

    clients.add(peer);
    peer.onClose = () => {
      clients.delete(peer);
      failPendingFor(peer, "CLI 连接已断开");
    };
    peer.onMessage = (message) => {
      lastActivity = Date.now();
      if (message?.type !== "request" || typeof message.id !== "string") return;
      const command = String(message.command || "");
      if (command === "status") {
        respondToCli(peer, message.id, { ok: true, result: daemonStatus(command, extension) });
        return;
      }
      if (!["tabs", "subtitles", "comments", "frame"].includes(command)) {
        respondToCli(peer, message.id, { ok: false, error: "未知命令" });
        return;
      }
      if (!extension) {
        if (command === "tabs") {
          respondToCli(peer, message.id, { ok: true, result: { ...daemonStatus(command, extension), tabs: [] } });
        } else {
          respondToCli(peer, message.id, { ok: false, error: "扩展未连接，请在扩展的「设置 → 本地 Agent」点击「去连接」" });
        }
        return;
      }
      const requestId = `${process.pid}-${++sequence}-${randomBytes(6).toString("hex")}`;
      const timer = command === "tabs" ? setTimeout(() => {
        pendingTabs.delete(requestId);
        respondToCli(peer, message.id, { ok: false, error: "等待扩展标签页快照超时" });
      }, 6000) : null;
      pendingTabs.set(requestId, { client: peer, clientRequestId: message.id, command, timer });
      extension.sendJSON({ type: "request", id: requestId, command, ...(message.options ? { options: message.options } : {}) });
    };
  });

  const heartbeat = setInterval(() => extension?.ping(), 20000);
  const idleTimer = setInterval(() => {
    if (pendingTabs.size > 0 || Date.now() - lastActivity < idleMs) return;
    clearInterval(heartbeat);
    clearInterval(idleTimer);
    for (const client of clients) client.close();
    extension?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }, 1000);
  heartbeat.unref();
  idleTimer.unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  return server;
}

function commandTimeout(command) {
  return ["subtitles", "comments", "frame"].includes(command) ? 0 : 8000;
}

async function waitForDaemon(command, port, options) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await requestDaemon(command, { port, options, timeoutMs: commandTimeout(command) });
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
    return await requestDaemon(command, { port, options, timeoutMs: command === "status" || command === "tabs" ? 1000 : 0 });
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

function parseCliArgs(args) {
  const command = args[0];
  if (!["status", "tabs", "subtitles", "comments", "frame"].includes(command)) return null;
  if (command === "status" || command === "tabs") return args.length === 1 ? { command } : null;
  const options = {};
  let out;
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
    } else if (command === "subtitles" && (flag === "--from" || flag === "--to")) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return null;
      options[flag.slice(2)] = number;
    } else if (command === "frame" && flag === "--time") {
      options.targetTime = Number(value);
      if (!Number.isFinite(options.targetTime) || options.targetTime < 0) return null;
    } else if (command === "frame" && flag === "--out") {
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
    console.log(JSON.stringify({ ok: false, error: "用法：node biliscript.mjs <status|tabs>；subtitles [--tab <id>|--bvid <BV/URL>] [--from <sec> --to <sec>]；comments [--tab <id>|--bvid <BV/URL>]；frame [--tab <id>|--bvid <BV/URL>] [--time <sec>] [--out <dir>]" }));
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
    }
    console.log(JSON.stringify(output));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      command: parsed.command,
      bridgeOnline: error.remote === true,
      ...(error.remote ? {} : { extensionOnline: false }),
      error: error.message
    }));
    process.exitCode = 1;
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) void main();
