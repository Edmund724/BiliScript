#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DIST_FIREFOX = path.join(REPO_ROOT, "dist-firefox");
const STANDALONE_EVIDENCE_FILE = path.join(REPO_ROOT, ".scratch", "firefox-smoke", "detached-reader-evidence.json");
const EXPECTED_EXTENSION_ID = "biliscript@edmund724.github.io";
const MIN_FIREFOX_MAJOR = 153;
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const TEST_VIDEO_URL = "https://www.bilibili.com/video/BV1test000000/";
const TEST_HOME_URL = "https://www.bilibili.com/";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_SKIPPED_NO_FIREFOX = 2;

function getCandidateFirefoxPaths() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const userProfile = process.env.USERPROFILE || "";
    return [
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
      "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
      "C:\\Program Files\\Firefox Developer Edition\\firefox.exe",
      "C:\\Program Files\\Firefox Nightly\\firefox.exe",
      "D:\\Apps\\Firefox\\firefox.exe",
      path.join(localAppData, "Mozilla Firefox", "firefox.exe"),
      path.join(userProfile, "scoop", "apps", "firefox", "current", "firefox.exe")
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
      "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
      path.join(os.homedir(), "Applications", "Firefox.app", "Contents", "MacOS", "firefox")
    ];
  }
  return [
    "/usr/bin/firefox",
    "/usr/local/bin/firefox",
    "/snap/bin/firefox",
    "/usr/bin/firefox-esr"
  ];
}

function findFirefoxInPath() {
  const probeCmd = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(probeCmd, ["firefox"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const firstLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine && fs.existsSync(firstLine) ? firstLine : null;
}

function resolveFirefoxBinary() {
  const envBin = (process.env.FIREFOX_BIN || "").trim();
  if (envBin) {
    if (!fs.existsSync(envBin)) {
      return { found: false, explicitEnv: envBin, bin: null };
    }
    return { found: true, explicitEnv: envBin, bin: envBin };
  }
  for (const candidate of getCandidateFirefoxPaths()) {
    if (candidate && fs.existsSync(candidate)) {
      return { found: true, explicitEnv: null, bin: candidate };
    }
  }
  const fromPath = findFirefoxInPath();
  if (fromPath) {
    return { found: true, explicitEnv: null, bin: fromPath };
  }
  return { found: false, explicitEnv: null, bin: null };
}

function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate ephemeral TCP port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitFor(label, fn, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    try {
      lastValue = await fn();
      if (lastValue) return lastValue;
    } catch (err) {
      lastValue = { error: String(err?.message || err) };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)?.slice(0, 200)}`);
}

function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derInt(value) {
  let buf = typeof value === "number" ? Buffer.from(value === 0 ? [0] : value.toString(16).padStart(value.toString(16).length + (value.toString(16).length % 2), "0"), "hex") : Buffer.from(value);
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTag(0x02, buf);
}

function derOid(oid) {
  const parts = oid.split(".").map((x) => Number.parseInt(x, 10));
  const out = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let val = parts[i];
    const encoded = [val & 0x7f];
    val >>= 7;
    while (val > 0) {
      encoded.unshift((val & 0x7f) | 0x80);
      val >>= 7;
    }
    out.push(...encoded);
  }
  return derTag(0x06, Buffer.from(out));
}

function derSeq(...items) {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(...items) {
  return derTag(0x31, Buffer.concat(items));
}

function derBitString(buf) {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derUtcTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const yy = pad(date.getUTCFullYear() % 100);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, "ascii"));
}

function createSelfSignedCert(sanHosts) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f;

  const sha256RsaAlg = derSeq(derOid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
  const issuer = derSeq(derSet(derSeq(derOid("2.5.4.3"), derTag(0x0c, Buffer.from("biliscript-fx-smoke", "utf8")))));
  const subject = derSeq(derSet(derSeq(derOid("2.5.4.3"), derTag(0x0c, Buffer.from(sanHosts[0], "utf8")))));
  const now = Date.now();
  const validity = derSeq(derUtcTime(new Date(now - 3600_000)), derUtcTime(new Date(now + 7 * 86400_000)));
  const basicConstraintsExt = derSeq(
    derOid("2.5.29.19"),
    Buffer.from([0x01, 0x01, 0xff]),
    derTag(0x04, derSeq())
  );
  const sanExt = derSeq(
    derOid("2.5.29.17"),
    derTag(0x04, derSeq(...sanHosts.map((host) => derTag(0x82, Buffer.from(host, "ascii")))))
  );
  const tbs = derSeq(
    derTag(0xa0, derInt(2)),
    derInt(serial),
    sha256RsaAlg,
    issuer,
    validity,
    subject,
    spki,
    derTag(0xa3, derSeq(basicConstraintsExt, sanExt))
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const certDer = derSeq(tbs, sha256RsaAlg, derBitString(signature));
  const b64 = certDer.toString("base64").match(/.{1,64}/g).join("\n");
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
  };
}

function buildMockBilibiliHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BiliScript Firefox 独立窗口冒烟</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#f6f7f8;color:#18191c;font-family:system-ui,sans-serif}
.bili-layout{display:flex;gap:20px;max-width:1240px;margin:12px auto;padding:0 16px;box-sizing:border-box}
.left-container{flex:1 1 auto;min-width:0}
#playerWrap{width:760px;background:#000;border-radius:8px;overflow:hidden}
.bpx-player-container{position:relative;width:100%;height:420px;background:#050505}
.bpx-player-video-wrap{width:100%;height:100%}
.bpx-player-video-wrap video{width:100%;height:100%;display:block;background:#050505}
.bpx-player-control-bottom-right{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;z-index:2}
.bpx-player-ctrl-quality{height:32px;padding:0 10px;border:0;border-radius:4px;background:#222;color:#fff}
#arc_toolbar_report{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding:10px 14px;background:#fff;border-radius:8px}
.video-toolbar-left,.video-toolbar-right{display:flex;align-items:center;gap:12px}
.video-complaint{cursor:pointer;color:#61666d}
.right-container{width:340px;flex:0 0 340px}
.right-container-inner{width:340px;min-height:520px;background:#fff;border-radius:8px;padding:12px;box-sizing:border-box}
</style></head><body>
<div id="app" class="bili-layout">
  <div class="left-container">
    <div id="playerWrap"><div id="bilibili-player"><div class="bpx-player-container"><div class="bpx-player-video-wrap"><video preload="none"></video></div><div class="bpx-player-control-bottom-right"><button type="button" class="bpx-player-ctrl-quality">1080P</button></div></div></div></div>
    <div id="arc_toolbar_report" class="video-toolbar-container">
      <div class="video-toolbar-left"><span>点赞</span><span>投币</span><span>收藏</span></div>
      <div class="video-toolbar-right"><span class="video-complaint">稿件举报</span></div>
    </div>
  </div>
  <div class="right-container"><div class="right-container-inner">相关推荐占位区</div></div>
</div></body></html>`;
}

async function startMockBilibiliProxy() {
  const { keyPem, certPem } = createSelfSignedCert([
    "www.bilibili.com",
    "api.bilibili.com",
    "aisubtitle.hdslb.com"
  ]);

  const tlsHttpServer = http.createServer((req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const parsedUrl = new URL(req.url || "/", `https://${host || "www.bilibili.com"}`);
    if (host === "www.bilibili.com" && parsedUrl.pathname.startsWith("/video/BV1test000000")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(buildMockBilibiliHtml());
      return;
    }
    if (host === "www.bilibili.com" && (parsedUrl.pathname === "/" || parsedUrl.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>Bilibili Home</title></head><body>Home</body></html>");
      return;
    }
    if (host === "api.bilibili.com" && /x\/web-interface\/view/.test(parsedUrl.pathname)) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          code: 0,
          message: "0",
          data: {
            aid: 1000000,
            bvid: "BV1test000000",
            cid: 2000000,
            title: "Firefox 独立窗口冒烟测试",
            desc: "offline",
            duration: 120,
            pubdate: 1767225600,
            owner: { name: "fixture" },
            pages: [{ cid: 2000000, page: 1, part: "P1", duration: 120 }]
          }
        })
      );
      return;
    }
    if (host === "api.bilibili.com" && /x\/player\/(?:wbi\/)?v2/.test(parsedUrl.pathname)) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          code: 0,
          message: "0",
          data: {
            aid: 1000000,
            bvid: "BV1test000000",
            cid: 2000000,
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 1,
                  lan: "ai-zh",
                  lan_doc: "中文",
                  subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/smoke-zh.json",
                  subtitle_url_v2: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/smoke-zh.json",
                  type: 1,
                  id_str: "1",
                  ai_type: 0,
                  ai_status: 2,
                  is_lock: false
                }
              ]
            }
          }
        })
      );
      return;
    }
    if (host === "aisubtitle.hdslb.com") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          body: [
            { from: 0.5, to: 3.0, sid: 1, location: 0, content: "Firefox 独立窗口冒烟字幕第一句", music: 0 },
            { from: 3.2, to: 6.0, sid: 2, location: 0, content: "Firefox 独立窗口冒烟字幕第二句", music: 0 }
          ]
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end("{}");
  });

  const activeSockets = new Set();
  const proxyServer = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });

  proxyServer.on("connect", (_req, clientSocket, head) => {
    activeSockets.add(clientSocket);
    clientSocket.on("close", () => activeSockets.delete(clientSocket));
    clientSocket.on("error", () => {});
    if (head && head.length > 0) {
      clientSocket.unshift(head);
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: keyPem,
      cert: certPem
    });
    activeSockets.add(tlsSocket);
    tlsSocket.on("close", () => activeSockets.delete(tlsSocket));
    tlsSocket.on("error", () => {});
    tlsHttpServer.emit("connection", tlsSocket);
  });

  const port = await new Promise((resolve, reject) => {
    proxyServer.on("error", reject);
    proxyServer.listen(0, "127.0.0.1", () => {
      const addr = proxyServer.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start mock Bilibili proxy"));
        return;
      }
      resolve(addr.port);
    });
  });

  return {
    port,
    async close() {
      for (const s of activeSockets) {
        try {
          s.destroy();
        } catch {}
      }
      await Promise.all([
        new Promise((resolve) => proxyServer.close(() => resolve())),
        new Promise((resolve) => tlsHttpServer.close(() => resolve()))
      ]);
    }
  };
}

function writeTempProfilePrefs(profileDir, marionettePort, proxyPort) {
  const prefs = [
    `user_pref("marionette.port", ${marionettePort});`,
    'user_pref("marionette.enabled", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("startup.homepage_welcome_url", "about:blank");',
    'user_pref("startup.homepage_welcome_url.additional", "");',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("extensions.getAddons.cache.enabled", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("dom.disable_open_during_load", false);',
    'user_pref("browser.link.open_newwindow", 3);',
    'user_pref("dom.popup_maximum", 10);',
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.ssl", "127.0.0.1");',
    `user_pref("network.proxy.ssl_port", ${proxyPort});`,
    'user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1");'
  ].join("\n");
  fs.writeFileSync(path.join(profileDir, "user.js"), prefs + "\n", "utf8");
}

class MarionetteClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextMsgId = 1;
    this.pending = new Map();
    this.greeted = false;
    this.greetingPromise = null;
    this.greetingResolve = null;
    this.greetingReject = null;
  }

  async connect(port, timeoutMs = 20_000, childRef = null) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (childRef && childRef.exitCode !== null) {
        throw new Error(`Firefox exited early with code ${childRef.exitCode}`);
      }
      try {
        await this.connectOnce(port, Math.min(3000, deadline - Date.now()));
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`Timed out connecting to Marionette on 127.0.0.1:${port}: ${lastErr?.message || lastErr}`);
  }

  connectOnce(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("Marionette greeting timeout"));
        }
      }, timeoutMs);

      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      this.greeted = false;
      this.greetingPromise = new Promise((gRes, gRej) => {
        this.greetingResolve = gRes;
        this.greetingReject = gRej;
      });

      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("error", (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.failAll(err);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error("Marionette socket closed before greeting"));
        }
        this.failAll(new Error("Marionette connection closed"));
      });

      this.greetingPromise.then(
        (greeting) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(greeting);
          }
        },
        (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      );
    });
  }

  failAll(err) {
    if (this.greetingReject) {
      this.greetingReject(err);
      this.greetingReject = null;
      this.greetingResolve = null;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const colonIdx = this.buffer.indexOf(0x3a);
      if (colonIdx === -1) return;
      const lenStr = this.buffer.subarray(0, colonIdx).toString("utf8");
      const byteLen = Number.parseInt(lenStr, 10);
      if (!Number.isFinite(byteLen) || byteLen < 0) {
        this.failAll(new Error(`Invalid Marionette frame length: ${lenStr}`));
        return;
      }
      const frameStart = colonIdx + 1;
      const frameEnd = frameStart + byteLen;
      if (this.buffer.length < frameEnd) return;

      const jsonText = this.buffer.subarray(frameStart, frameEnd).toString("utf8");
      this.buffer = this.buffer.subarray(frameEnd);

      let payload;
      try {
        payload = JSON.parse(jsonText);
      } catch (err) {
        this.failAll(new Error(`Invalid Marionette JSON frame: ${err.message}`));
        return;
      }

      if (!this.greeted && payload && typeof payload === "object" && !Array.isArray(payload) && "applicationType" in payload) {
        this.greeted = true;
        this.greetingResolve?.(payload);
        this.greetingResolve = null;
        this.greetingReject = null;
        continue;
      }

      if (Array.isArray(payload) && payload[0] === 1) {
        const [, msgId, error, result] = payload;
        const entry = this.pending.get(msgId);
        if (!entry) continue;
        this.pending.delete(msgId);
        clearTimeout(entry.timer);
        if (error) {
          const errMsg = typeof error === "object" ? `${error.error || "marionette error"}: ${error.message || JSON.stringify(error)}` : String(error);
          entry.reject(new Error(`${entry.command} failed: ${errMsg}`));
        } else {
          entry.resolve(result);
        }
      }
    }
  }

  send(command, params = {}, timeoutMs = 20_000) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error(`Marionette socket not connected for ${command}`));
    }
    const msgId = this.nextMsgId++;
    const packet = JSON.stringify([0, msgId, command, params]);
    const byteLen = Buffer.byteLength(packet, "utf8");
    const wire = `${byteLen}:${packet}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`Marionette command timed out (${timeoutMs}ms): ${command}`));
      }, timeoutMs);

      this.pending.set(msgId, { resolve, reject, timer, command });
      this.socket.write(wire, "utf8");
    });
  }

  async setContext(value) {
    await this.send("Marionette:SetContext", { value });
  }

  async executeSync(script, argsList = [], timeoutMs = 15_000) {
    const res = await this.send(
      "WebDriver:ExecuteScript",
      { script, args: argsList, newSandbox: false },
      timeoutMs
    );
    return res?.value;
  }

  async executeAsync(script, argsList = [], timeoutMs = 20_000) {
    const res = await this.send(
      "WebDriver:ExecuteAsyncScript",
      { script, args: argsList, newSandbox: false, scriptTimeout: timeoutMs },
      timeoutMs + 2000
    );
    return res?.value;
  }

  async getWindowHandle() {
    const res = await this.send("WebDriver:GetWindowHandle", {});
    return res?.value ?? res;
  }

  async getWindowHandles() {
    const res = await this.send("WebDriver:GetWindowHandles", {});
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.value)) return res.value;
    return [];
  }

  close() {
    this.failAll(new Error("Marionette client closed"));
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }
}

function extractElementId(res) {
  return (
    res?.value?.[ELEMENT_KEY] ||
    res?.[ELEMENT_KEY] ||
    res?.value?.ELEMENT ||
    res?.ELEMENT ||
    null
  );
}

async function findAndClick(client, selector, label) {
  await waitFor(
    `element ${label}`,
    async () => {
      const box = await client.executeSync(
        `const el = document.querySelector(arguments[0]);
         if (!el) return null;
         const r = el.getBoundingClientRect();
         const cs = getComputedStyle(el);
         const v = el.closest("#biliscript-reading-view");
         const vcs = v ? getComputedStyle(v) : null;
         const vr = v ? v.getBoundingClientRect() : null;
         const viewReady = !v || (
           vcs.display !== "none" &&
           vcs.visibility !== "hidden" &&
           Number(vcs.opacity) >= 0.99 &&
           vr.left >= -2 &&
           vr.right <= window.innerWidth + 2
         );
         if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || Number(cs.opacity) === 0 || !viewReady) return null;
         return { w: r.width, h: r.height };`,
        [selector]
      );
      return box;
    },
    { timeoutMs: 12000, intervalMs: 150 }
  );
  await client.executeSync("document.querySelector(arguments[0])?.scrollIntoView({ block: 'center', inline: 'nearest' });", [selector]);
  let lastClickErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await client.send("WebDriver:FindElement", {
      using: "css selector",
      value: selector
    });
    const found = extractElementId(res);
    if (!found) {
      lastClickErr = new Error(`FindElement returned null after ready for ${label}`);
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    try {
      await client.send("WebDriver:ElementClick", { id: found });
      return found;
    } catch (err) {
      lastClickErr = err;
      const errStr = String(err?.message || err);
      if (errStr.includes("not known in the current browsing context") && attempt === 3) {
        const clickedFallback = await client.executeSync(
          `if (location.href !== "about:blank") return false;
           const el = document.querySelector(arguments[0]);
           if (!el) return false;
           el.click();
           return true;`,
          [selector]
        );
        if (clickedFallback) return found;
      }
      if (!errStr.includes("not known in the current browsing context") || attempt === 3) {
        const info = await client.executeSync(
          `const el = document.querySelector(arguments[0]);
           if (!el) return null;
           const r = el.getBoundingClientRect();
           const cs = getComputedStyle(el);
           const v = document.getElementById("biliscript-reading-view");
           const vcs = v ? getComputedStyle(v) : null;
           return { btn: { w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom, vis: cs.visibility, op: cs.opacity, pe: cs.pointerEvents }, view: v ? { cls: v.className, ready: v.getAttribute("data-biliscript-reader-ready"), float: v.getAttribute("data-biliscript-script-float"), rect: v.getBoundingClientRect(), disp: vcs.display, op: vcs.opacity, vis: vcs.visibility } : null, vw: window.innerWidth, vh: window.innerHeight };`,
          [selector]
        ).catch(() => null);
        throw new Error(`${err.message} clickDiag(${label})=${JSON.stringify(info)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastClickErr;
}

async function switchToSettledNewWindow(client, handlesBefore, label, requireReaderView = true) {
  return waitFor(label, async () => {
    const now = await client.getWindowHandles();
    const candidate = now.find((h) => !handlesBefore.has(h));
    if (!candidate) return null;
    await client.send("WebDriver:SwitchToWindow", { handle: candidate, focus: true });
    if (requireReaderView) {
      const hasView = await client.executeSync("return Boolean(document.getElementById('biliscript-reading-view'));");
      if (!hasView) return null;
    }
    return candidate;
  });
}

async function waitForChromeExtensionReady(client, extensionId) {
  await client.setContext("chrome");
  const result = await client.executeAsync(
    `
    const extensionId = arguments[0];
    const done = arguments[arguments.length - 1];
    (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const policy = WebExtensionPolicy.getByID(extensionId);
        if (policy && policy.active && policy.mozExtensionHostname) {
          return { ok: true, id: policy.id, uuid: policy.mozExtensionHostname };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: false, error: "Timed out waiting for WebExtensionPolicy: " + extensionId };
    })().then(done, (err) => done({ ok: false, error: String(err?.message || err) }));
    `,
    [extensionId]
  );
  if (!result?.ok) {
    throw new Error(result?.error || "Extension policy did not activate");
  }
  return result;
}

async function killFirefoxAndCleanup(child, profileDir) {
  if (child && child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  if (profileDir && fs.existsSync(profileDir)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

export async function runDetachedReaderSmoke({
  firefoxBin,
  distDir = DEFAULT_DIST_FIREFOX,
  headed = false,
  log = (msg) => console.log(`[detached-fx-smoke] ${msg}`)
} = {}) {
  const checks = [];
  const record = (name, ok, detail = null) => {
    const entry = { name, ok: Boolean(ok), detail };
    checks.push(entry);
    log(`${entry.ok ? "PASS" : "FAIL"}  ${name}${detail === null ? "" : `  ${JSON.stringify(detail).slice(0, 320)}`}`);
    return entry.ok;
  };

  if (!firefoxBin) {
    const fx = resolveFirefoxBinary();
    if (!fx.found) {
      return { ok: false, status: "skipped", browserVersion: null, checks, error: "firefox-binary-not-found" };
    }
    firefoxBin = fx.bin;
  }

  const distManifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(distManifestPath)) {
    throw new Error(`Missing ${distManifestPath}. Run "pnpm build:firefox" first.`);
  }

  const proxy = await startMockBilibiliProxy();
  const marionettePort = await allocateFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "biliscript-fx-detached-"));
  writeTempProfilePrefs(profileDir, marionettePort, proxy.port);

  const firefoxArgs = [
    "--marionette",
    "--no-remote",
    "--profile",
    profileDir,
    ...(headed ? [] : ["--headless"])
  ];

  log(`Launching Firefox detached-reader session: ${firefoxBin} (headless=${!headed}, proxy=${proxy.port}, marionette=${marionettePort})`);
  const child = spawn(firefoxBin, firefoxArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1"
    }
  });

  const client = new MarionetteClient();
  let browserVersion = "";
  let stepTag = "init";
  let handlesBeforeF2List = [];
  let detachedHandleSeen = null;

  try {
    await client.connect(marionettePort, 20_000, child);
    const session = await client.send("WebDriver:NewSession", { acceptInsecureCerts: true });
    browserVersion = String(session?.capabilities?.browserVersion || "");
    const majorVersion = Number.parseInt(browserVersion.split(".")[0] || "0", 10);
    if (Number.isFinite(majorVersion) && majorVersion > 0 && majorVersion < MIN_FIREFOX_MAJOR) {
      throw new Error(`Firefox version ${browserVersion} is below minimum ${MIN_FIREFOX_MAJOR}`);
    }

    const installed = await client.send("Addon:Install", {
      path: distDir,
      temporary: true
    });
    if (installed?.value !== EXPECTED_EXTENSION_ID) {
      throw new Error(`Unexpected installed addon id: ${installed?.value}`);
    }

    const policyInfo = await waitForChromeExtensionReady(client, EXPECTED_EXTENSION_ID);
    const extOriginPrefix = `moz-extension://${policyInfo.uuid}/entry/styles/`;

    await client.setContext("content");
    await client.send("WebDriver:Navigate", { url: TEST_VIDEO_URL });

    await findAndClick(client, "#biliscript-script-button", "F1-script-button");
    const f1State = await waitFor("F1 reader view open", async () =>
      client.executeSync(`
        const v = document.getElementById("biliscript-reading-view");
        const detach = document.getElementById("biliscript-reading-detach-btn");
        const links = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]')).map((l) => l.getAttribute("href") || "");
        if (!v || !v.classList.contains("open") || v.getAttribute("data-biliscript-reader-ready") !== "1" || links.length < 3) return null;
        return { ready: true, linkCount: links.length, hasDetachBtn: Boolean(detach) };
      `)
    );
    const openerHandle = await client.getWindowHandle();
    handlesBeforeF2List = await client.getWindowHandles();
    const handlesBeforeF2 = new Set(handlesBeforeF2List);
    record("fx-content-script-and-reader-open-on-bilibili-scope", Boolean(f1State?.ready), f1State);

    stepTag = "F2-click-detach";
    await findAndClick(client, "#biliscript-reading-detach-btn", "F2-detach-btn");
    stepTag = "F2-switch-to-detached";
    const detachedHandle = await switchToSettledNewWindow(client, handlesBeforeF2, "F2 detached window handle", true);
    detachedHandleSeen = detachedHandle;
    stepTag = "F2-initial";
    const f2Initial = await waitFor("F2 detached view & stylesheets", async () =>
      client.executeSync(`
        const extPrefix = arguments[0];
        const v = document.getElementById("biliscript-reading-view");
        if (!v || !v.classList.contains("open") || v.hidden) return null;
        const linkHrefs = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]')).map((l) => l.getAttribute("href") || "");
        const sheetHrefs = Array.from(document.styleSheets).map((s) => s.href || "");
        const cs = getComputedStyle(v);
        const probe = document.createElement("div");
        probe.style.display = "none";
        probe.style.backgroundColor = "var(--biliscript-reader-surface)";
        v.appendChild(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const docEl = document.documentElement;
        return {
          open: true,
          linkHrefs,
          sheetHrefs,
          allLinksInSheets: linkHrefs.length >= 3 && linkHrefs.every((h) => h.startsWith(extPrefix) && sheetHrefs.includes(h)),
          display: cs.display,
          surface,
          overflowX: docEl.scrollWidth > window.innerWidth + 1
        };
      `, [extOriginPrefix])
    );

    await findAndClick(client, "#biliscript-reading-tab-chat", "F2-chat-tab");
    const lazyChatCss = await waitFor("F2 lazy chat css mirrored", async () =>
      client.executeSync(`
        const sheetHrefs = Array.from(document.styleSheets).map((s) => s.href || "");
        const linkHrefs = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]')).map((l) => l.getAttribute("href") || "");
        return linkHrefs.some((h) => h.includes("reader-chat.css")) && sheetHrefs.some((h) => h.includes("reader-chat.css"));
      `)
    );
    await findAndClick(client, "#biliscript-reading-settings-btn", "F2-settings-btn");
    const lazySettingsCss = await waitFor("F2 lazy settings css mirrored", async () =>
      client.executeSync(`
        const sheetHrefs = Array.from(document.styleSheets).map((s) => s.href || "");
        const linkHrefs = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]')).map((l) => l.getAttribute("href") || "");
        return linkHrefs.some((h) => h.includes("reader-settings-shell.css")) && sheetHrefs.some((h) => h.includes("reader-settings-shell.css"));
      `)
    );

    stepTag = "F2-switch-opener";
    await client.send("WebDriver:SwitchToWindow", { handle: openerHandle, focus: true });
    const openerMoved = await client.executeSync("return !document.getElementById('biliscript-reading-view');");
    stepTag = "F2-switch-back-detached";
    await client.send("WebDriver:SwitchToWindow", { handle: detachedHandle, focus: true });

    record(
      "fx-detach-xray-and-cross-doc-stylesheets",
      Boolean(f2Initial?.allLinksInSheets && f2Initial.display !== "none" && f2Initial.surface && !f2Initial.overflowX && lazyChatCss && lazySettingsCss && openerMoved),
      { f2Initial, lazyChatCss, lazySettingsCss, openerMoved }
    );

    await client.executeSync(`
      const panel = document.getElementById("biliscript-reading-settings-panel");
      if (panel && !panel.hidden) {
        document.getElementById("biliscript-reading-settings-btn")?.click();
      }
    `);
    await findAndClick(client, "#biliscript-reading-detach-btn", "F3-redock-btn");
    await waitFor("F3 detached handle closed", async () => {
      const now = await client.getWindowHandles();
      return !now.includes(detachedHandle);
    });
    await client.send("WebDriver:SwitchToWindow", { handle: openerHandle, focus: true });
    const f3State = await waitFor("F3 opener shell restored", async () =>
      client.executeSync(`
        const nodes = document.querySelectorAll("#biliscript-reading-view");
        const v = nodes[0];
        if (!v || !v.classList.contains("open") || v.hidden) return null;
        return { count: nodes.length, open: true };
      `)
    );
    record("fx-redock-preserves-shell-and-cleans-detached-window", f3State?.count === 1 && f3State?.open, f3State);

    const handlesBeforeTab = new Set(await client.getWindowHandles());
    await client.send("WebDriver:NewWindow", { type: "tab" });
    const tabHandle = await waitFor("F4 helper extension tab", async () => {
      const now = await client.getWindowHandles();
      return now.find((h) => !handlesBeforeTab.has(h)) || null;
    });
    await client.send("WebDriver:SwitchToWindow", { handle: tabHandle });
    await client.send("WebDriver:Navigate", { url: `moz-extension://${policyInfo.uuid}/onboarding.html` });
    await client.executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.storage.sync.set({ detachedWindowMode: "popup" }).then(() => done(true), (err) => done(String(err)));
    `);
    await client.send("WebDriver:CloseWindow", {});
    await client.send("WebDriver:SwitchToWindow", { handle: openerHandle, focus: true });

    const handlesBeforeF4 = new Set(await client.getWindowHandles());
    await findAndClick(client, "#biliscript-reading-detach-btn", "F4-popup-detach-btn");
    const popupHandle = await switchToSettledNewWindow(client, handlesBeforeF4, "F4 popup window handle", true);
    const f4PopupLoaded = await waitFor("F4 popup stylesheets loaded", async () =>
      client.executeSync(`
        const extPrefix = arguments[0];
        const v = document.getElementById("biliscript-reading-view");
        const links = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]')).map((l) => l.getAttribute("href") || "");
        const sheets = Array.from(document.styleSheets).map((s) => s.href || "");
        return Boolean(v && v.classList.contains("open") && links.length >= 3 && links.every((h) => h.startsWith(extPrefix) && sheets.includes(h)));
      `, [extOriginPrefix])
    );

    await client.send("WebDriver:CloseWindow", {});
    await client.send("WebDriver:SwitchToWindow", { handle: openerHandle, focus: true });
    await waitFor("F4 popup handle removed", async () => !(await client.getWindowHandles()).includes(popupHandle));
    const f4OpenerClosed = await waitFor("F4 opener shell exited cleanly", async () =>
      client.executeSync(`
        const v = document.getElementById("biliscript-reading-view");
        const btn = document.getElementById("biliscript-script-button");
        const modeAttr = document.documentElement.getAttribute("data-biliscript-reader-mode") || document.body.getAttribute("data-biliscript-reader-mode");
        return Boolean(v && v.hidden && !v.classList.contains("open") && !modeAttr && btn);
      `)
    );
    record("fx-popup-fallback-and-native-close-lifecycle", Boolean(f4PopupLoaded && f4OpenerClosed), { f4PopupLoaded, f4OpenerClosed });

    await findAndClick(client, "#biliscript-script-button", "F5-reopen-btn");
    await waitFor("F5 reader reopened", async () =>
      client.executeSync("return Boolean(document.getElementById('biliscript-reading-view')?.classList.contains('open'));")
    );
    const handlesBeforeF5 = new Set(await client.getWindowHandles());
    await findAndClick(client, "#biliscript-reading-detach-btn", "F5-detach-btn");
    const orphanHandle = await switchToSettledNewWindow(client, handlesBeforeF5, "F5 detached handle", true);
    await client.send("WebDriver:SwitchToWindow", { handle: openerHandle, focus: true });
    await client.send("WebDriver:Navigate", { url: TEST_HOME_URL });
    const f5OrphanClosed = await waitFor("F5 orphan detached window closed on opener pagehide", async () => {
      const now = await client.getWindowHandles();
      return !now.includes(orphanHandle) && !now.some((h) => !handlesBeforeF5.has(h));
    });
    record("fx-opener-pagehide-closes-detached-window", Boolean(f5OrphanClosed), { orphanHandle, f5OrphanClosed });

    const allOk = checks.length === 5 && checks.every((c) => c.ok);
    return {
      ok: allOk,
      status: allOk ? "passed" : "failed",
      browserVersion,
      checks
    };
  } catch (err) {
    await new Promise((r) => setTimeout(r, 300));
    const msg = String(err?.message || err);
    const handles = await client.getWindowHandles().catch(() => []);
    const handleInfos = [];
    for (const h of handles) {
      try {
        await client.send("WebDriver:SwitchToWindow", { handle: h });
        const info = await client.executeSync("return { url: location.href, hasView: Boolean(document.getElementById('biliscript-reading-view')), text: (document.body?.innerText || '').slice(0, 80) };");
        handleInfos.push({ h, ...info });
      } catch (e) {
        handleInfos.push({ h, err: String(e?.message || e) });
      }
    }
    let chromeWindows = [];
    try {
      await client.setContext("chrome");
      chromeWindows = await client.executeSync(`
        const out = [];
        for (const win of Services.wm.getEnumerator(null)) {
          const tabs = win.gBrowser ? Array.from(win.gBrowser.tabs).map((t) => ({
            url: t.linkedBrowser?.currentURI?.spec || "",
            bcId: t.linkedBrowser?.browsingContext?.id ?? null
          })) : [];
          out.push({ type: win.document?.documentElement?.getAttribute("windowtype") || "", loc: win.location?.href || "", tabCount: tabs.length, tabs });
        }
        return out;
      `);
      await client.setContext("content");
    } catch (ce) {
      chromeWindows = [{ err: String(ce?.message || ce) }];
    }
    record("fx-detached-runner-error", false, {
      error: msg,
      stepTag,
      handlesBeforeF2List,
      detachedHandleSeen,
      handles,
      handleInfos,
      chromeWindows
    });
    return {
      ok: false,
      status: "error",
      browserVersion,
      checks,
      error: msg
    };
  } finally {
    try {
      await client.send("WebDriver:DeleteSession", {}, 4000);
    } catch {}
    client.close();
    await killFirefoxAndCleanup(child, profileDir);
    await proxy.close().catch(() => {});
  }
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log(
      [
        "Usage: node scripts/firefox-smoke/detached-reader-smoke.mjs [--headed]",
        "",
        "Options:",
        "  --headed     Launch Firefox with a visible window (default: headless)",
        "  -h, --help   Show this help message",
        "",
        "Environment:",
        "  FIREFOX_BIN  Override Firefox executable path",
        "",
        "Exit codes:",
        "  0  All 5 detached-reader checks passed",
        "  1  Missing dist-firefox build, invalid FIREFOX_BIN, or assertion/runtime failure",
        "  2  Firefox executable not found on this machine (skipped)"
      ].join("\n")
    );
    process.exit(EXIT_PASS);
  }

  const headed = args.has("--headed");
  const fx = resolveFirefoxBinary();
  if (!fx.found) {
    if (fx.explicitEnv) {
      console.error(`[detached-fx-smoke] FAIL  FIREFOX_BIN points to non-existent executable: ${fx.explicitEnv}`);
      process.exit(EXIT_FAIL);
    }
    fs.mkdirSync(path.dirname(STANDALONE_EVIDENCE_FILE), { recursive: true });
    fs.writeFileSync(
      STANDALONE_EVIDENCE_FILE,
      JSON.stringify({ status: "skipped", reason: "firefox-binary-not-found", timestamp: new Date().toISOString(), checks: [] }, null, 2) + "\n",
      "utf8"
    );
    process.exit(EXIT_SKIPPED_NO_FIREFOX);
  }

  const result = await runDetachedReaderSmoke({
    firefoxBin: fx.bin,
    distDir: DEFAULT_DIST_FIREFOX,
    headed
  });

  fs.mkdirSync(path.dirname(STANDALONE_EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(
    STANDALONE_EVIDENCE_FILE,
    JSON.stringify(
      {
        status: result.status,
        firefoxBin: fx.bin,
        headed,
        browserVersion: result.browserVersion,
        timestamp: new Date().toISOString(),
        checks: result.checks,
        error: result.error || null
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  process.exit(result.ok ? EXIT_PASS : EXIT_FAIL);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  await runCli();
}
