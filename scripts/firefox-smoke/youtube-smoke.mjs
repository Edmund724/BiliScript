#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  allocateFreePort,
  EXPECTED_EXTENSION_ID,
  EXIT_FAIL,
  EXIT_PASS,
  EXIT_SKIPPED_NO_FIREFOX,
  killFirefoxAndCleanup,
  MarionetteClient,
  MIN_FIREFOX_MAJOR,
  resolveFirefoxBinary,
  waitForChromeExtensionReady
} from "./smoke-firefox.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DIST_FIREFOX = path.join(REPO_ROOT, "dist-firefox");
const STANDALONE_EVIDENCE_FILE = path.join(REPO_ROOT, ".scratch", "firefox-smoke", "youtube-evidence.json");
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const TEST_VIDEO_ID = "dQw4w9WgXcQ";
const TEST_WATCH_URL = `https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`;
const TEST_HOME_URL = "https://www.youtube.com/";
const LIVE_WATCH_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

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
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)?.slice(0, 260)}`);
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
  let buf = typeof value === "number"
    ? Buffer.from(
        value === 0
          ? [0]
          : value.toString(16).padStart(value.toString(16).length + (value.toString(16).length % 2), "0"),
        "hex"
      )
    : Buffer.from(value);
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
  const issuer = derSeq(derSet(derSeq(derOid("2.5.4.3"), derTag(0x0c, Buffer.from("biliscript-fx-yt-smoke", "utf8")))));
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

function buildMockYoutubeHtml(videoId) {
  const playerResponse = {
    videoDetails: {
      videoId,
      title: "Firefox YouTube Smoke Test Video",
      author: "SmokeChannel",
      shortDescription: "00:00 Intro\n00:30 Main Topic",
      lengthSeconds: "120",
      isLiveContent: false,
      isLive: false
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: "2026-11-24"
      }
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=zh-Hans`,
            languageCode: "zh-Hans",
            name: { simpleText: "中文（简体）" },
            vssId: ".zh-Hans",
            isTranslatable: true
          },
          {
            baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
            languageCode: "en",
            name: { simpleText: "English" },
            kind: "asr",
            vssId: "a.en",
            isTranslatable: true
          }
        ]
      }
    }
  };

  const initialData = {
    currentVideoEndpoint: {
      watchEndpoint: { videoId }
    },
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: [
                  {
                    key: "DESCRIPTION_CHAPTERS",
                    value: {
                      chapters: [
                        { chapterRenderer: { title: { simpleText: "Intro" }, timeRangeStartMillis: 0 } },
                        { chapterRenderer: { title: { simpleText: "Main Topic" }, timeRangeStartMillis: 30000 } }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      }
    },
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          panelIdentifier: "engagement-panel-searchable-transcript",
          content: {
            continuationItemRenderer: {
              continuationEndpoint: {
                getTranscriptEndpoint: {
                  params: "smoke-transcript-params"
                }
              }
            }
          }
        }
      }
    ]
  };

  const ytcfgData = {
    INNERTUBE_API_KEY: "yt-smoke-api-key",
    INNERTUBE_CONTEXT: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20261124.00.00",
        hl: "zh-CN"
      }
    }
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Firefox YouTube Smoke Test Video - YouTube</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#fff;color:#0f0f0f;font-family:system-ui,sans-serif}
html[dark],html[dark] body{background:#0f0f0f;color:#f1f1f1}
ytd-watch-flexy{display:block;width:100%}
#columns{display:flex;align-items:flex-start;gap:24px;max-width:1400px;margin:16px auto;padding:0 24px;box-sizing:border-box}
#primary{flex:1 1 auto;min-width:0}
#movie_player{position:relative;width:100%;height:460px;background:#000;border-radius:12px;overflow:hidden}
#movie_player video{width:100%;height:100%;display:block}
#above-the-fold{margin-top:12px}
#actions{display:flex;align-items:center;gap:8px;padding:8px 0}
#top-level-buttons-computed{display:flex;align-items:center;gap:8px}
#top-level-buttons-computed button{height:36px;padding:0 16px;border-radius:18px;border:0;background:rgba(0,0,0,0.05);cursor:pointer}
#secondary{width:402px;flex:0 0 402px;min-height:560px;background:#f8f8f8;border-radius:12px;padding:12px;box-sizing:border-box}
ytd-watch-flexy[theater] #columns{flex-direction:column}
ytd-watch-flexy[theater] #secondary{width:100%;flex:none}
</style></head><body>
<ytd-watch-flexy>
  <div id="columns">
    <div id="primary">
      <div id="player">
        <ytd-player id="ytd-player">
          <div id="movie_player" class="html5-video-player">
            <video class="html5-main-video" preload="none"></video>
          </div>
        </ytd-player>
      </div>
      <div id="above-the-fold">
        <div id="actions">
          <div id="top-level-buttons-computed">
            <button type="button">Like</button>
            <button type="button">Share</button>
          </div>
        </div>
      </div>
    </div>
    <div id="secondary"><div id="related">Related videos</div></div>
  </div>
</ytd-watch-flexy>
<script>
(() => {
  const playerResponse = ${JSON.stringify(playerResponse)};
  const initialData = ${JSON.stringify(initialData)};
  const ytcfgData = ${JSON.stringify(ytcfgData)};
  window.ytcfg = {
    data_: ytcfgData,
    get(key) {
      return Object.prototype.hasOwnProperty.call(this.data_, key) ? this.data_[key] : undefined;
    }
  };
  window.ytInitialData = initialData;
  const moviePlayer = document.getElementById("movie_player");
  moviePlayer.getPlayerResponse = () => playerResponse;
  moviePlayer.getVideoData = () => ({
    video_id: ${JSON.stringify(videoId)},
    title: "Firefox YouTube Smoke Test Video",
    author: "SmokeChannel"
  });
  moviePlayer.getDuration = () => 120;
  const watchFlexy = document.querySelector("ytd-watch-flexy");
  watchFlexy.playerData = playerResponse;
  watchFlexy.data = initialData;
  window.__ytSmokeResourceReady = fetch("/api/timedtext?v=${videoId}&lang=zh-Hans&pot=fx-smoke-pot&probe=1")
    .then((r) => r.text())
    .catch(() => "");
})();
</script>
</body></html>`;
}

async function startMockYoutubeProxy() {
  const { keyPem, certPem } = createSelfSignedCert([
    "www.youtube.com",
    "api.deepseek.com"
  ]);

  let deepseekOverviewCalls = 0;
  let deepseekChatCalls = 0;
  const deepseekTrace = [];
  const timedtextHits = [];

  const tlsHttpServer = http.createServer((req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const parsedUrl = new URL(req.url || "/", `https://${host || "www.youtube.com"}`);

    if (host === "www.youtube.com" && parsedUrl.pathname === "/watch") {
      const vid = parsedUrl.searchParams.get("v") || TEST_VIDEO_ID;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(buildMockYoutubeHtml(vid));
      return;
    }

    if (host === "www.youtube.com" && (parsedUrl.pathname === "/" || parsedUrl.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>YouTube Home</title></head><body>Home</body></html>");
      return;
    }

    if (host === "www.youtube.com" && parsedUrl.pathname === "/api/timedtext") {
      const lang = parsedUrl.searchParams.get("lang") || "";
      const pot = parsedUrl.searchParams.get("pot") || "";
      const fmt = parsedUrl.searchParams.get("fmt") || "";
      const isProbe = parsedUrl.searchParams.get("probe") === "1";
      if (!isProbe) {
        timedtextHits.push({ lang, pot, fmt });
      }
      if (lang === "en") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            events: [
              { tStartMs: 500, dDurationMs: 2500, segs: [{ utf8: "Firefox YouTube switched English track cue one" }] },
              { tStartMs: 3200, dDurationMs: 2800, segs: [{ utf8: "Firefox YouTube switched English track cue two" }] }
            ]
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          events: [
            { tStartMs: 500, dDurationMs: 2500, segs: [{ utf8: "Firefox YouTube 冒烟中文主轨第一句" }] },
            { tStartMs: 3200, dDurationMs: 2800, segs: [{ utf8: "Firefox YouTube 冒烟中文主轨第二句" }] }
          ]
        })
      );
      return;
    }

    if (host === "api.deepseek.com" && /\/chat\/completions$/.test(parsedUrl.pathname)) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        let parsedReq = null;
        try {
          parsedReq = JSON.parse(bodyText);
        } catch {}
        const hasTools = Array.isArray(parsedReq?.tools) && parsedReq.tools.length > 0;
        const isOverview = !hasTools && bodyText.includes("keyQuotes");
        deepseekTrace.push({
          isOverview,
          stream: Boolean(parsedReq?.stream),
          hasTools,
          lastUser: Array.isArray(parsedReq?.messages)
            ? String(parsedReq.messages[parsedReq.messages.length - 1]?.content || "").slice(0, 80)
            : ""
        });
        if (isOverview) {
          deepseekOverviewCalls += 1;
        } else {
          deepseekChatCalls += 1;
        }
        const payload = isOverview
          ? JSON.stringify({
              summary: "Firefox YouTube 流式概览摘要",
              chapters: [{ title: "Intro", summary: "YouTube 冒烟章节摘要", timestampSeconds: 0 }],
              keyQuotes: [{ quote: "Firefox YouTube 冒烟中文主轨第一句", timestampSeconds: 0 }]
            })
          : "Firefox YouTube 对话流式回复成功。";
        if (parsedReq && parsedReq.stream === false) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: payload }, finish_reason: "stop" }]
            })
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
        const mid = Math.floor(payload.length / 2);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(0, mid) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(mid) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
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
        reject(new Error("Failed to start mock YouTube proxy"));
        return;
      }
      resolve(addr.port);
    });
  });

  return {
    port,
    getDeepseekOverviewCalls: () => deepseekOverviewCalls,
    getDeepseekChatCalls: () => deepseekChatCalls,
    getDeepseekTrace: () => [...deepseekTrace],
    getTimedtextHits: () => [...timedtextHits],
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

function writeYoutubeProfilePrefs(profileDir, marionettePort, proxyPort = null) {
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
    'user_pref("dom.popup_maximum", 10);'
  ];
  if (proxyPort) {
    prefs.push(
      'user_pref("network.proxy.type", 1);',
      'user_pref("network.proxy.ssl", "127.0.0.1");',
      `user_pref("network.proxy.ssl_port", ${proxyPort});`,
      'user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1");'
    );
  }
  fs.writeFileSync(path.join(profileDir, "user.js"), prefs.join("\n") + "\n", "utf8");
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
         const cs = getComputedStyle(el);
         const v = el.closest("#biliscript-reading-view");
         const vcs = v ? getComputedStyle(v) : null;
         const vr = v ? v.getBoundingClientRect() : null;
         const vAnimating = v && typeof v.getAnimations === "function"
           ? v.getAnimations().some((anim) => anim.playState === "running")
           : false;
         const viewReady = !v || (
           vcs.display !== "none" &&
           vcs.visibility !== "hidden" &&
           Number(vcs.opacity) >= 0.99 &&
           !vAnimating &&
           (vcs.translate === "none" || vcs.translate === "0px" || vcs.translate === "0px 0px") &&
           vr.left >= -2 &&
           vr.right <= window.innerWidth + 2
         );
         if (el.closest("[hidden]") || cs.visibility === "hidden" || Number(cs.opacity) === 0 || !viewReady) return null;
         el.scrollIntoView({ block: "center", inline: "nearest" });
         const r = el.getBoundingClientRect();
         if (
           r.width <= 0 ||
           r.height <= 0 ||
           r.left < 0 ||
           r.right > window.innerWidth ||
           r.top < 0 ||
           r.bottom > window.innerHeight
         ) {
           return null;
         }
         return { w: r.width, h: r.height };`,
        [selector],
        15_000,
        { newSandbox: false }
      );
      return box;
    },
    { timeoutMs: 12000, intervalMs: 150 }
  );
  let lastClickErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await client.executeSync(
      "document.querySelector(arguments[0])?.scrollIntoView({ block: 'center', inline: 'nearest' });",
      [selector],
      15_000,
      { newSandbox: false }
    );
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
      const retryable =
        errStr.includes("not known in the current browsing context") ||
        errStr.includes("not interactable") ||
        errStr.includes("could not be scrolled into view");
      if (!retryable || attempt === 4) {
        throw new Error(`${err.message} (${label})`);
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
      const hasView = await client.executeSync(
        "return Boolean(document.getElementById('biliscript-reading-view'));",
        [],
        15_000,
        { newSandbox: false }
      );
      if (!hasView) return null;
    }
    return candidate;
  });
}

export async function runYoutubeSmoke({
  firefoxBin,
  distDir = DEFAULT_DIST_FIREFOX,
  headed = false,
  log = (msg) => console.log(`[youtube-fx-smoke] ${msg}`)
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

  const proxy = await startMockYoutubeProxy();
  const marionettePort = await allocateFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "biliscript-fx-youtube-"));
  writeYoutubeProfilePrefs(profileDir, marionettePort, proxy.port);

  const firefoxArgs = [
    "--marionette",
    "--no-remote",
    "--profile",
    profileDir,
    ...(headed ? [] : ["--headless"])
  ];

  log(`Launching Firefox YouTube smoke session: ${firefoxBin} (headless=${!headed}, proxy=${proxy.port}, marionette=${marionettePort})`);
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
  const diag = {};

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
    const onboardingUrl = `moz-extension://${policyInfo.uuid}/onboarding.html`;

    await client.setContext("content");
    await client.send("WebDriver:Navigate", { url: onboardingUrl });
    const seedAndSpeechProbe = await client.executeAsync(
      `
      const done = arguments[arguments.length - 1];
      (async () => {
        const pRes = await browser.runtime.sendMessage({
          type: "ai-providers-save",
          providers: [{
            id: "deepseek",
            presetId: "deepseek",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com",
            models: ["deepseek-chat"],
            requiresKey: true,
            enabled: true,
            protocol: "openai",
            apiKey: "sk-fx-yt-smoke"
          }]
        });
        const sRes = await browser.runtime.sendMessage({
          type: "save-settings",
          settings: {
            defaultModel: "deepseek",
            defaultAiModel: "deepseek-chat",
            detachedWindowMode: "popup"
          }
        });
        const hasChromeTts = typeof chrome?.tts !== "undefined";
        const bgSpeechProbe = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 5000);
          const port = chrome.runtime.connect({ name: "chat-speech" });
          port.onMessage.addListener((msg) => {
            clearTimeout(timer);
            try { port.disconnect(); } catch {}
            resolve({ ok: true, msg });
          });
          port.onDisconnect.addListener(() => {
            clearTimeout(timer);
            resolve({ ok: false, error: "disconnected" });
          });
          port.postMessage({ type: "get-voices", requestId: 1 });
        });
        return { pRes, sRes, hasChromeTts, bgSpeechProbe };
      })().then(done, (err) => done({ error: String(err?.message || err) }));
      `,
      [],
      20_000,
      { newSandbox: false }
    );
    if (!seedAndSpeechProbe?.pRes?.ok || !seedAndSpeechProbe?.sRes?.ok) {
      throw new Error(`Failed to seed settings for YouTube smoke: ${JSON.stringify(seedAndSpeechProbe)}`);
    }

    const extHandle = await client.getWindowHandle();
    const handlesBeforeWatch = new Set(await client.getWindowHandles());
    await client.send("WebDriver:NewWindow", { type: "tab" });
    const watchHandle = await waitFor("YouTube watch tab handle", async () => {
      const now = await client.getWindowHandles();
      return now.find((h) => !handlesBeforeWatch.has(h)) || null;
    });
    await client.send("WebDriver:SwitchToWindow", { handle: watchHandle, focus: true });
    await client.send("WebDriver:SetWindowRect", { width: 1366, height: 900 });
    await client.send("WebDriver:Navigate", { url: TEST_WATCH_URL });

    stepTag = "Y1-script-button-and-main-world";
    const buttonState = await waitFor("YouTube script button mounted", async () =>
      client.executeSync(
        `
        const btn = document.getElementById("biliscript-script-button");
        const actions = document.getElementById("actions");
        if (!btn || !actions || !actions.contains(btn)) return null;
        const cs = getComputedStyle(btn);
        return {
          inActions: true,
          site: btn.dataset.biliscriptSite || "",
          hostTheme: btn.dataset.biliscriptHostTheme || "",
          borderRadius: btn.style.borderRadius || "",
          bg: cs.backgroundColor || ""
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    await client.executeSync(
      'document.documentElement.setAttribute("dark", ""); return true;',
      [],
      15_000,
      { newSandbox: false }
    );
    const darkThemeSync = await waitFor("YouTube button dark attribute sync", async () =>
      client.executeSync(
        `
        const btn = document.getElementById("biliscript-script-button");
        return btn?.dataset.biliscriptHostTheme === "dark" ? true : null;
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    await client.executeSync(
      'document.documentElement.removeAttribute("dark"); return true;',
      [],
      15_000,
      { newSandbox: false }
    );
    await waitFor("YouTube button light attribute restore", async () =>
      client.executeSync(
        `
        const btn = document.getElementById("biliscript-script-button");
        return btn?.dataset.biliscriptHostTheme === "light" ? true : null;
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    await client.executeAsync(
      `
      const done = arguments[arguments.length - 1];
      Promise.resolve(window.__ytSmokeResourceReady).then(() => done(true), () => done(false));
      `,
      [],
      15_000,
      { newSandbox: false }
    );

    await client.send("WebDriver:SwitchToWindow", { handle: extHandle, focus: true });
    const mainWorldProbe = await client.executeAsync(
      `
      const targetUrl = arguments[0];
      const done = arguments[arguments.length - 1];
      (async () => {
        const tabs = await browser.tabs.query({ url: targetUrl });
        const ytTab = tabs[0];
        if (!ytTab?.id) {
          return { ok: false, error: "YouTube tab not found via browser.tabs.query" };
        }
        const execResults = await chrome.scripting.executeScript({
          target: { tabId: ytTab.id },
          world: "MAIN",
          func: () => {
            const mp = document.getElementById("movie_player");
            const flexy = document.querySelector("ytd-watch-flexy");
            const pr = typeof mp?.getPlayerResponse === "function" ? mp.getPlayerResponse() : null;
            const vd = typeof mp?.getVideoData === "function" ? mp.getVideoData() : null;
            const dur = typeof mp?.getDuration === "function" ? mp.getDuration() : 0;
            const ytcfgCtx = typeof window.ytcfg?.get === "function" ? window.ytcfg.get("INNERTUBE_CONTEXT") : null;
            const apiKey = typeof window.ytcfg?.get === "function" ? window.ytcfg.get("INNERTUBE_API_KEY") : "";
            const flexyTitle = flexy?.playerData?.videoDetails?.title || "";
            const timedtextPerf = performance
              .getEntriesByType("resource")
              .map((entry) => entry.name)
              .filter((name) => name.includes("/api/timedtext"));
            return {
              videoId: pr?.videoDetails?.videoId || "",
              title: pr?.videoDetails?.title || "",
              author: pr?.videoDetails?.author || "",
              movieVideoId: vd?.video_id || "",
              duration: Number(dur) || 0,
              flexyTitle,
              captionCount: pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0,
              clientName: String(ytcfgCtx?.client?.clientName || ""),
              apiKey: String(apiKey || ""),
              timedtextPerfCount: timedtextPerf.length
            };
          }
        });
        const payload = execResults?.[0]?.result ?? null;
        const roundTrip = payload ? JSON.parse(JSON.stringify(payload)) : null;
        return {
          ok: Boolean(
            payload &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            roundTrip &&
            roundTrip.videoId === "dQw4w9WgXcQ" &&
            roundTrip.movieVideoId === "dQw4w9WgXcQ" &&
            roundTrip.title === "Firefox YouTube Smoke Test Video" &&
            roundTrip.flexyTitle === "Firefox YouTube Smoke Test Video" &&
            roundTrip.duration === 120 &&
            roundTrip.captionCount === 2 &&
            roundTrip.clientName === "WEB" &&
            roundTrip.apiKey === "yt-smoke-api-key" &&
            roundTrip.timedtextPerfCount >= 1
          ),
          payload: roundTrip
        };
      })().then(done, (err) => done({ ok: false, error: String(err?.message || err) }));
      `,
      [TEST_WATCH_URL],
      20_000,
      { newSandbox: false }
    );
    await client.send("WebDriver:SwitchToWindow", { handle: watchHandle, focus: true });
    diag.buttonState = buttonState;
    diag.mainWorldProbe = mainWorldProbe;
    diag.timedtextHitsBeforeClick = proxy.getTimedtextHits();

    await findAndClick(client, "#biliscript-script-button", "Y1-open-youtube-reader");
    const readerOpenState = await waitFor("Y1 YouTube reader opened with snapshot metadata", async () =>
      client.executeSync(
        `
        const v = document.getElementById("biliscript-reading-view");
        const meta = document.getElementById("biliscript-reading-meta")?.textContent?.trim() || "";
        const list = document.getElementById("biliscript-reading-subtitle");
        const select = document.getElementById("biliscript-reading-subtitle-select");
        if (!v || !v.classList.contains("open") || v.getAttribute("data-biliscript-reader-ready") !== "1") return null;
        if (!list || !(list.textContent || "").includes("Firefox YouTube 冒烟中文主轨第一句")) return null;
        const optionTexts = select ? Array.from(select.options).map((o) => o.textContent || "") : [];
        return {
          meta,
          optionCount: optionTexts.length,
          optionTexts
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    const timedtextHitsAfterOpen = proxy.getTimedtextHits();
    const potObserved = timedtextHitsAfterOpen.some((hit) => hit.lang === "zh-Hans" && hit.pot === "fx-smoke-pot");

    record(
      "fx-youtube-main-world-snapshot-and-xray",
      Boolean(
        buttonState?.inActions &&
        buttonState.site === "youtube" &&
        buttonState.borderRadius === "18px" &&
        !buttonState.bg.includes("251, 114, 153") &&
        darkThemeSync &&
        mainWorldProbe?.ok &&
        readerOpenState?.meta.includes("作者：SmokeChannel") &&
        readerOpenState.optionCount === 2 &&
        potObserved
      ),
      { buttonState, darkThemeSync, mainWorldProbe, readerOpenState, timedtextHitsAfterOpen }
    );

    stepTag = "Y2-stylesheets-light-dom-and-moz-scrollbar";
    const styleAndLayoutState = await waitFor("Y2 stylesheets and docked Light DOM layout", async () =>
      client.executeSync(
        `
        const extPrefix = arguments[0];
        const v = document.getElementById("biliscript-reading-view");
        const sec = document.getElementById("secondary");
        const subList = document.getElementById("biliscript-reading-subtitle");
        const ovBody = document.getElementById("biliscript-reading-overview-body");
        if (!v || !sec || !subList || !ovBody) return null;
        const linkHrefs = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]')).map((l) => l.getAttribute("href") || "");
        const sheetHrefs = Array.from(document.styleSheets).map((s) => s.href || "");
        const allLinksInSheets = linkHrefs.length >= 3 && linkHrefs.every((h) => h.startsWith(extPrefix) && sheetHrefs.includes(h));
        if (!allLinksInSheets) return null;
        const vr = v.getBoundingClientRect();
        const sr = sec.getBoundingClientRect();
        const vcs = getComputedStyle(v);
        const subCs = getComputedStyle(subList);
        const ovCs = getComputedStyle(ovBody);
        const probe = document.createElement("div");
        probe.style.display = "none";
        probe.style.backgroundColor = "var(--biliscript-reader-surface)";
        v.appendChild(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          isLightDom: !v.shadowRoot && document.body.contains(v),
          dockedFloatAttr: v.getAttribute("data-biliscript-script-float"),
          bodyReaderAttr: document.body.getAttribute("data-biliscript-reader-mode"),
          inlineStyle: v.getAttribute("style") || "",
          vr: { left: vr.left, top: vr.top, width: vr.width, height: vr.height, right: vr.right },
          sr: { left: sr.left, top: sr.top, width: sr.width, height: sr.height, right: sr.right },
          clientWidth: document.documentElement.clientWidth,
          computedBox: { left: vcs.left, right: vcs.right, width: vcs.width, translate: vcs.translate, position: vcs.position },
          dockRightDiff: Math.abs(vr.right - document.documentElement.clientWidth),
          viewWidth: vr.width,
          linkCount: linkHrefs.length,
          linkHrefs,
          allLinksInSheets,
          surface,
          supportsMozAppearance: typeof CSS?.supports === "function" ? CSS.supports("-moz-appearance", "none") : false,
          subScrollbarWidth: subCs.scrollbarWidth || "",
          subScrollbarColor: subCs.scrollbarColor || "",
          ovScrollbarWidth: ovCs.scrollbarWidth || ""
        };
        `,
        [extOriginPrefix],
        15_000,
        { newSandbox: false }
      )
    );

    await client.executeSync(
      'document.querySelector("ytd-watch-flexy")?.setAttribute("theater", ""); return true;',
      [],
      15_000,
      { newSandbox: false }
    );
    const theaterFloatOk = await waitFor("Y2 theater degrades to float", async () =>
      client.executeSync(
        `
        const v = document.getElementById("biliscript-reading-view");
        if (!v || v.getAttribute("data-biliscript-script-float") !== "1") return null;
        const animating = typeof v.getAnimations === "function"
          ? v.getAnimations().some((anim) => anim.playState === "running")
          : false;
        if (animating) return null;
        return true;
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    await client.executeSync(
      'document.querySelector("ytd-watch-flexy")?.removeAttribute("theater"); return true;',
      [],
      15_000,
      { newSandbox: false }
    );
    const redockOk = await waitFor("Y2 theater removal redocks to secondary", async () =>
      client.executeSync(
        `
        const v = document.getElementById("biliscript-reading-view");
        if (!v || v.getAttribute("data-biliscript-script-float") === "1") return null;
        if (document.body.getAttribute("data-biliscript-reader-mode") !== "1") return null;
        const vcs = getComputedStyle(v);
        const vr = v.getBoundingClientRect();
        const clientWidth = document.documentElement.clientWidth;
        const animating = typeof v.getAnimations === "function"
          ? v.getAnimations().some((anim) => anim.playState === "running")
          : false;
        const settledTranslate = vcs.translate === "none" || vcs.translate === "0px" || vcs.translate === "0px 0px";
        const redockedBox =
          vr.left >= 700 &&
          vr.width >= 360 &&
          vr.width <= 600 &&
          Math.abs(vr.right - clientWidth) <= 2;
        if (animating || !settledTranslate || !redockedBox || Number(vcs.opacity) < 0.99) return null;
        return true;
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    record(
      "fx-youtube-stylesheets-light-dom-and-moz-scrollbar",
      Boolean(
        styleAndLayoutState?.isLightDom &&
        styleAndLayoutState.bodyReaderAttr === "1" &&
        styleAndLayoutState.dockedFloatAttr !== "1" &&
        styleAndLayoutState.vr?.left >= 700 &&
        styleAndLayoutState.dockRightDiff <= 2 &&
        styleAndLayoutState.viewWidth >= 360 &&
        styleAndLayoutState.viewWidth <= 600 &&
        styleAndLayoutState.allLinksInSheets &&
        styleAndLayoutState.surface &&
        styleAndLayoutState.supportsMozAppearance &&
        styleAndLayoutState.subScrollbarWidth === "thin" &&
        styleAndLayoutState.subScrollbarColor &&
        styleAndLayoutState.subScrollbarColor !== "auto" &&
        styleAndLayoutState.ovScrollbarWidth === "thin" &&
        theaterFloatOk &&
        redockOk
      ),
      { styleAndLayoutState, theaterFloatOk, redockOk }
    );

    stepTag = "Y3-read-switch-track-and-overview";
    const initialSubtitlesOk = await client.executeSync(
      `
      const text = document.getElementById("biliscript-reading-subtitle")?.textContent || "";
      return text.includes("Firefox YouTube 冒烟中文主轨第一句") && text.includes("Firefox YouTube 冒烟中文主轨第二句");
      `,
      [],
      15_000,
      { newSandbox: false }
    );

    await findAndClick(client, ".biliscript-reading-track-picker .custom-select-trigger", "Y3-track-picker-trigger");
    await findAndClick(
      client,
      '.biliscript-reading-track-picker [data-col="main"] .custom-select-option[data-value*="lang=en"]',
      "Y3-track-option-en"
    );
    const switchedTrackState = await waitFor("Y3 switched to English track cues", async () =>
      client.executeSync(
        `
        const listText = document.getElementById("biliscript-reading-subtitle")?.textContent || "";
        const selectVal = document.getElementById("biliscript-reading-subtitle-select")?.value || "";
        if (!listText.includes("Firefox YouTube switched English track cue one")) return null;
        return {
          hasCue1: listText.includes("Firefox YouTube switched English track cue one"),
          hasCue2: listText.includes("Firefox YouTube switched English track cue two"),
          clearedOldCue: !listText.includes("Firefox YouTube 冒烟中文主轨第一句"),
          selectVal
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    await findAndClick(client, "#biliscript-reading-tab-overview", "Y3-overview-tab");
    const overviewState = await waitFor("Y3 YouTube overview stream result", async () =>
      client.executeSync(
        `
        const body = document.getElementById("biliscript-reading-overview-body");
        if (!body) return null;
        const errStrip = body.querySelector(".biliscript-reading-ov-strip.is-error");
        if (errStrip) return { ok: false, errorText: (errStrip.textContent || "").trim() };
        const summary = body.querySelector(".biliscript-reading-ov-summary");
        if (summary && (summary.textContent || "").includes("Firefox YouTube 流式概览摘要")) {
          return { ok: true, summaryText: (summary.textContent || "").trim() };
        }
        return null;
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    await findAndClick(client, "#biliscript-reading-tab-subtitle", "Y3-back-to-subtitle-tab");

    record(
      "fx-youtube-read-switch-track-and-overview",
      Boolean(
        initialSubtitlesOk &&
        switchedTrackState?.hasCue1 &&
        switchedTrackState.hasCue2 &&
        switchedTrackState.clearedOldCue &&
        switchedTrackState.selectVal.includes("lang=en") &&
        overviewState?.ok &&
        proxy.getDeepseekOverviewCalls() >= 1
      ),
      { initialSubtitlesOk, switchedTrackState, overviewState, deepseekOverviewCalls: proxy.getDeepseekOverviewCalls() }
    );

    stepTag = "Y4-detached-popup-open-and-close";
    const handlesBeforeDetach = new Set(await client.getWindowHandles());
    await findAndClick(client, "#biliscript-reading-detach-btn", "Y4-detach-btn");
    const popupHandle = await switchToSettledNewWindow(client, handlesBeforeDetach, "Y4 YouTube popup window", true);
    const detachedState = await waitFor("Y4 YouTube detached popup ready", async () =>
      client.executeSync(
        `
        const extPrefix = arguments[0];
        const v = document.getElementById("biliscript-reading-view");
        const subList = document.getElementById("biliscript-reading-subtitle");
        if (!v || !v.classList.contains("open") || v.hidden || !subList) return null;
        const linkHrefs = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]')).map((l) => l.getAttribute("href") || "");
        const sheetHrefs = Array.from(document.styleSheets).map((s) => s.href || "");
        const subCs = getComputedStyle(subList);
        return {
          docTitle: document.title || "",
          metaText: document.getElementById("biliscript-reading-meta")?.textContent?.trim() || "",
          hasSwitchedCue: (subList.textContent || "").includes("Firefox YouTube switched English track cue one"),
          allLinksInSheets: linkHrefs.length >= 3 && linkHrefs.every((h) => h.startsWith(extPrefix) && sheetHrefs.includes(h)),
          subScrollbarWidth: subCs.scrollbarWidth || "",
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
        };
        `,
        [extOriginPrefix],
        15_000,
        { newSandbox: false }
      )
    );

    await client.send("WebDriver:SwitchToWindow", { handle: watchHandle, focus: true });
    const openerDetachedCleanly = await client.executeSync(
      "return !document.getElementById('biliscript-reading-view');",
      [],
      15_000,
      { newSandbox: false }
    );
    await client.send("WebDriver:SwitchToWindow", { handle: popupHandle, focus: true });
    await client.send("WebDriver:CloseWindow", {});
    await client.send("WebDriver:SwitchToWindow", { handle: watchHandle, focus: true });
    await waitFor("Y4 popup handle removed", async () => !(await client.getWindowHandles()).includes(popupHandle));
    const openerRestoredAfterClose = await waitFor("Y4 opener redocked after popup closed", async () =>
      client.executeSync(
        `
        const v = document.getElementById("biliscript-reading-view");
        const closeBtn = document.getElementById("biliscript-reading-close-btn");
        const detachBtn = document.getElementById("biliscript-reading-detach-btn");
        return Boolean(
          v &&
          !v.hidden &&
          v.classList.contains("open") &&
          document.documentElement.getAttribute("data-biliscript-reader-mode") === "1" &&
          closeBtn && !closeBtn.hidden &&
          detachBtn && !detachBtn.hidden
        );
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    record(
      "fx-youtube-detached-popup-open-and-close",
      Boolean(
        detachedState?.docTitle.includes("Firefox YouTube Smoke Test Video") &&
        detachedState.metaText.includes("作者：SmokeChannel") &&
        detachedState.hasSwitchedCue &&
        detachedState.allLinksInSheets &&
        detachedState.subScrollbarWidth === "thin" &&
        !detachedState.overflowX &&
        openerDetachedCleanly &&
        openerRestoredAfterClose
      ),
      { detachedState, openerDetachedCleanly, openerRestoredAfterClose }
    );

    stepTag = "Y5-tts-live-and-youtube-gating";
    await findAndClick(client, "#biliscript-reading-tab-chat", "Y5-chat-tab");
    const liveChatButtonState = await waitFor("Y5 chat send button live gating", async () =>
      client.executeSync(
        `
        const btn = document.getElementById("biliscript-reading-chat-send-btn");
        if (!btn) return null;
        return {
          isLiveClass: btn.classList.contains("is-live"),
          ariaLabel: btn.getAttribute("aria-label") || "",
          disabled: Boolean(btn.disabled)
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    await findAndClick(client, "#biliscript-reading-chat-more-btn", "Y5-chat-more-btn");
    const chatSpeechMenuState = await waitFor("Y5 chat speech menu volume row", async () =>
      client.executeSync(
        `
        const menu = document.getElementById("biliscript-reading-chat-more-menu");
        const row = document.getElementById("biliscript-reading-chat-speech-volume");
        if (!menu || menu.hidden || !row) return null;
        const hasWebSpeech = typeof window.speechSynthesis?.speak === "function" && typeof window.speechSynthesis?.getVoices === "function";
        return { hasWebSpeech, speechRowHidden: row.hidden };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    await findAndClick(client, "#biliscript-reading-chat-more-btn", "Y5-chat-more-btn-close");

    await client.executeSync(
      `
      const input = document.getElementById("biliscript-reading-chat-input");
      if (!input) return false;
      input.value = "总结核心内容";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
      `,
      [],
      15_000,
      { newSandbox: false }
    );
    await findAndClick(client, "#biliscript-reading-chat-send-btn", "Y5-chat-send-btn");
    const chatReplyTtsState = await waitFor("Y5 chat reply rendered with expected TTS speak action", async () =>
      client.executeSync(
        `
        const msgList = document.getElementById("biliscript-reading-chat-messages");
        const speakBtn = msgList?.querySelector(".chat-msg-speak-btn") || null;
        const regenBtn = msgList?.querySelector(".chat-msg-regenerate-btn") || null;
        if (!regenBtn || !(msgList?.textContent || "").includes("Firefox YouTube 对话流式回复成功")) return null;
        const hasWebSpeech = typeof window.speechSynthesis?.speak === "function" && typeof window.speechSynthesis?.getVoices === "function";
        return {
          hasWebSpeech,
          hasSpeakBtn: Boolean(speakBtn),
          hasRegenBtn: Boolean(regenBtn)
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    await findAndClick(client, "#biliscript-reading-settings-btn", "Y5-open-settings");
    const rootGatingState = await waitFor("Y5 root settings gating", async () =>
      client.executeSync(
        `
        const host = document.getElementById("biliscript-reading-settings-host");
        if (!host || host.dataset.biliscriptSettingsRendered !== "1") return null;
        const isGated = (id) => {
          const el = document.getElementById(id);
          return Boolean(el && el.hidden && el.getAttribute("aria-hidden") === "true");
        };
        return {
          liveGated: isGated("openLiveSettingsBtn") && Boolean(document.getElementById("biliscriptSettingsSubpageLive")?.hidden),
          asrGated: isGated("openAsrSettingsBtn") && Boolean(document.getElementById("biliscriptSettingsSubpageAsr")?.hidden),
          agentGated: isGated("openAgentSettingsBtn") && Boolean(document.getElementById("biliscriptSettingsSubpageAgent")?.hidden),
          subtitleVisible: Boolean(document.getElementById("openSubtitleSettingsBtn") && !document.getElementById("openSubtitleSettingsBtn").hidden),
          aiPromptVisible: Boolean(document.getElementById("openAiPromptBtn") && !document.getElementById("openAiPromptBtn").hidden),
          appearanceVisible: Boolean(document.getElementById("openAppearanceBtn") && !document.getElementById("openAppearanceBtn").hidden)
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    await findAndClick(client, "#openAiPromptBtn", "Y5-open-ai-prompt-settings");
    const aiPromptGatingState = await waitFor("Y5 AI prompt subpage gating", async () =>
      client.executeSync(
        `
        const subpage = document.getElementById("biliscriptSettingsSubpageAiPrompt");
        if (!subpage || subpage.hidden) return null;
        const aiBtnSection = subpage.querySelector('.biliscript-set-group[data-settings-section="ai-button"]');
        const speechRow = document.getElementById("speechVoiceVolume")?.closest(".biliscript-slider-row");
        const heading = document.getElementById("chatPreferencesHeading")?.textContent?.trim() || "";
        const hasWebSpeech = typeof window.speechSynthesis?.speak === "function" && typeof window.speechSynthesis?.getVoices === "function";
        return {
          aiBtnSectionGated: Boolean(aiBtnSection && aiBtnSection.hidden && aiBtnSection.getAttribute("aria-hidden") === "true"),
          hasWebSpeech,
          speechRowHidden: Boolean(speechRow?.hidden),
          heading
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    await findAndClick(client, "#biliscript-reading-settings-back-btn", "Y5-back-from-ai-prompt");
    await waitFor("Y5 back at settings root after ai-prompt", async () =>
      client.executeSync('return Boolean(document.getElementById("biliscriptSettingsRootView") && !document.getElementById("biliscriptSettingsRootView").hidden);', [], 15_000, { newSandbox: false })
    );

    await findAndClick(client, "#openAppearanceBtn", "Y5-open-appearance-settings");
    const appearanceGatingState = await waitFor("Y5 appearance subpage gating", async () =>
      client.executeSync(
        `
        const subpage = document.getElementById("biliscriptSettingsSubpageAppearance");
        if (!subpage || subpage.hidden) return null;
        const extraRatesRow = document.getElementById("enableExtraPlaybackRates")?.closest(".biliscript-toggle-row");
        return {
          extraRatesGated: Boolean(extraRatesRow && extraRatesRow.hidden && extraRatesRow.getAttribute("aria-hidden") === "true")
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    await findAndClick(client, "#biliscript-reading-settings-back-btn", "Y5-back-from-appearance");
    await waitFor("Y5 back at settings root after appearance", async () =>
      client.executeSync('return Boolean(document.getElementById("biliscriptSettingsRootView") && !document.getElementById("biliscriptSettingsRootView").hidden);', [], 15_000, { newSandbox: false })
    );

    await findAndClick(client, "#openSubtitleSettingsBtn", "Y5-open-subtitle-settings");
    const subtitleSettingsState = await waitFor("Y5 subtitle settings visible with Index-Translate", async () =>
      client.executeSync(
        `
        const subpage = document.getElementById("biliscriptSettingsSubpageSubtitle");
        const sourceSelect = document.getElementById("subtitleTranslateSource");
        if (!subpage || subpage.hidden || !sourceSelect) return null;
        const hasIndexTranslate = Array.from(sourceSelect.options).some((o) => o.value === "bilibili-index-translate");
        return { visible: !sourceSelect.hidden, hasIndexTranslate };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );
    await findAndClick(client, "#biliscript-reading-settings-back-btn", "Y5-back-from-subtitle");
    await findAndClick(client, "#biliscript-reading-settings-btn", "Y5-close-settings");

    const pagePlayerGating = await client.executeSync(
      `
      return {
        noPlayerQuickAi: !document.getElementById("biliscript-player-ai-quick-action"),
        noPlayerLiveQuick: !document.getElementById("biliscript-player-live-quick-action"),
        noPlayerInterpretQuick: !document.getElementById("biliscript-player-interpret-quick-action")
      };
      `,
      [],
      15_000,
      { newSandbox: false }
    );

    const expectedTtsBgError = seedAndSpeechProbe.bgSpeechProbe?.ok === true &&
      seedAndSpeechProbe.bgSpeechProbe.msg?.type === "error" &&
      seedAndSpeechProbe.bgSpeechProbe.msg?.message === "TTS_UNSUPPORTED";
    const expectedSpeechRowMatches =
      chatSpeechMenuState?.speechRowHidden === !chatSpeechMenuState?.hasWebSpeech &&
      chatReplyTtsState?.hasSpeakBtn === chatReplyTtsState?.hasWebSpeech &&
      aiPromptGatingState?.speechRowHidden === !aiPromptGatingState?.hasWebSpeech &&
      aiPromptGatingState?.heading === (aiPromptGatingState?.hasWebSpeech ? "阅读与朗读" : "对话阅读");

    record(
      "fx-youtube-tts-live-and-site-gating",
      Boolean(
        seedAndSpeechProbe.hasChromeTts === false &&
        expectedTtsBgError &&
        liveChatButtonState?.isLiveClass === false &&
        liveChatButtonState.ariaLabel === "发送" &&
        liveChatButtonState.disabled === true &&
        expectedSpeechRowMatches &&
        chatReplyTtsState?.hasRegenBtn &&
        rootGatingState?.liveGated &&
        rootGatingState.asrGated &&
        rootGatingState.agentGated &&
        rootGatingState.subtitleVisible &&
        rootGatingState.aiPromptVisible &&
        rootGatingState.appearanceVisible &&
        aiPromptGatingState?.aiBtnSectionGated &&
        appearanceGatingState?.extraRatesGated &&
        subtitleSettingsState?.visible &&
        subtitleSettingsState.hasIndexTranslate &&
        pagePlayerGating?.noPlayerQuickAi &&
        pagePlayerGating.noPlayerLiveQuick &&
        pagePlayerGating.noPlayerInterpretQuick
      ),
      {
        hasChromeTts: seedAndSpeechProbe.hasChromeTts,
        bgSpeechProbe: seedAndSpeechProbe.bgSpeechProbe,
        liveChatButtonState,
        chatSpeechMenuState,
        chatReplyTtsState,
        rootGatingState,
        aiPromptGatingState,
        appearanceGatingState,
        subtitleSettingsState,
        pagePlayerGating
      }
    );

    stepTag = "Y6-close-reader-and-restore-button";
    await findAndClick(client, "#biliscript-reading-close-btn", "Y6-close-reader-btn");
    const closedState = await waitFor("Y6 YouTube reader closed and button restored", async () =>
      client.executeSync(
        `
        const v = document.getElementById("biliscript-reading-view");
        const btn = document.getElementById("biliscript-script-button");
        const actions = document.getElementById("actions");
        if (!v || v.classList.contains("open") || !v.hidden) return null;
        if (document.documentElement.getAttribute("data-biliscript-reader-mode") !== null) return null;
        if (!btn || !actions || !actions.contains(btn)) return null;
        return {
          closed: true,
          hidden: v.hidden,
          readerModeAttr: document.documentElement.getAttribute("data-biliscript-reader-mode"),
          readingActiveAttr: document.body.getAttribute("data-biliscript-reading-active"),
          buttonRestored: true
        };
        `,
        [],
        15_000,
        { newSandbox: false }
      )
    );

    record(
      "fx-youtube-reader-close-and-button-restore",
      Boolean(closedState?.closed && closedState.hidden && closedState.buttonRestored),
      closedState
    );

    const allOk = checks.length === 6 && checks.every((c) => c.ok);
    return {
      ok: allOk,
      status: allOk ? "passed" : "failed",
      browserVersion,
      checks
    };
  } catch (err) {
    const domDiag = await client
      .executeSync(
        `
        const v = document.getElementById("biliscript-reading-view");
        const btn = document.getElementById("biliscript-script-button");
        const list = document.getElementById("biliscript-reading-subtitle");
        const notice = document.getElementById("biliscript-reading-subtitle-notice");
        const meta = document.getElementById("biliscript-reading-meta");
        const select = document.getElementById("biliscript-reading-subtitle-select");
        const chatMsgs = document.getElementById("biliscript-reading-chat-messages");
        const chatInput = document.getElementById("biliscript-reading-chat-input");
        const chatSendBtn = document.getElementById("biliscript-reading-chat-send-btn");
        return {
          href: location.href,
          btnText: btn?.textContent?.trim() || null,
          btnTitle: btn?.title || null,
          hasView: Boolean(v),
          viewClass: v?.className || null,
          viewHidden: v?.hidden ?? null,
          viewReady: v?.getAttribute("data-biliscript-reader-ready") || null,
          metaText: meta?.textContent?.trim() || null,
          noticeText: notice?.textContent?.trim() || null,
          listText: (list?.textContent || "").trim().slice(0, 200),
          chatInputVal: chatInput?.value || "",
          chatSendDisabled: chatSendBtn?.disabled ?? null,
          chatMsgsHtml: (chatMsgs?.innerHTML || "").slice(0, 800),
          selectOptions: select ? Array.from(select.options).map((o) => ({ val: o.value, text: o.textContent })) : []
        };
        `,
        [],
        5000,
        { newSandbox: false }
      )
      .catch((e) => ({ diagErr: String(e?.message || e) }));
    let consoleTail = [];
    try {
      await client.setContext("chrome");
      consoleTail = await client.executeSync(`
        return Services.console
          .getMessageArray()
          .slice(-60)
          .map((m) => ({
            msg: String(m?.errorMessage || m?.message || m),
            source: m?.sourceName || "",
            line: m?.lineNumber ?? null,
            col: m?.columnNumber ?? null,
            cat: m?.category || ""
          }))
          .filter((entry) =>
            entry.msg.includes("Permission denied") ||
            entry.msg.includes("BILISCRIPT") ||
            entry.msg.includes("chat-runtime") ||
            entry.source.includes("moz-extension")
          );
      `);
      await client.setContext("content");
    } catch {}
    record("fx-youtube-runner-error", false, {
      error: String(err?.message || err),
      stepTag,
      diag,
      deepseekOverviewCalls: proxy.getDeepseekOverviewCalls(),
      deepseekChatCalls: proxy.getDeepseekChatCalls(),
      deepseekTrace: proxy.getDeepseekTrace(),
      timedtextHits: proxy.getTimedtextHits(),
      domDiag,
      consoleTail
    });
    return {
      ok: false,
      status: "error",
      browserVersion,
      checks,
      error: String(err?.message || err)
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

export async function runYoutubeLiveProbe({
  firefoxBin,
  distDir = DEFAULT_DIST_FIREFOX,
  headed = false,
  log = (msg) => console.log(`[youtube-fx-live] ${msg}`)
} = {}) {
  if (!firefoxBin) {
    const fx = resolveFirefoxBinary();
    if (!fx.found) {
      return { ok: false, status: "skipped", reason: "firefox-binary-not-found" };
    }
    firefoxBin = fx.bin;
  }

  const distManifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(distManifestPath)) {
    throw new Error(`Missing ${distManifestPath}. Run "pnpm build:firefox" first.`);
  }

  const marionettePort = await allocateFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "biliscript-fx-yt-live-"));
  writeYoutubeProfilePrefs(profileDir, marionettePort, null);

  const child = spawn(
    firefoxBin,
    ["--marionette", "--no-remote", "--profile", profileDir, ...(headed ? [] : ["--headless"])],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1"
      }
    }
  );

  const client = new MarionetteClient();
  let browserVersion = "";
  try {
    await client.connect(marionettePort, 20_000, child);
    const session = await client.send("WebDriver:NewSession", {});
    browserVersion = String(session?.capabilities?.browserVersion || "");

    const installed = await client.send("Addon:Install", { path: distDir, temporary: true });
    if (installed?.value !== EXPECTED_EXTENSION_ID) {
      throw new Error(`Unexpected addon id: ${installed?.value}`);
    }

    const policyInfo = await waitForChromeExtensionReady(client, EXPECTED_EXTENSION_ID);
    await client.setContext("content");
    await client.send("WebDriver:Navigate", { url: `moz-extension://${policyInfo.uuid}/onboarding.html` });
    const extHandle = await client.getWindowHandle();

    const handlesBefore = new Set(await client.getWindowHandles());
    await client.send("WebDriver:NewWindow", { type: "tab" });
    const ytHandle = await waitFor("live YouTube tab handle", async () => {
      const now = await client.getWindowHandles();
      return now.find((h) => !handlesBefore.has(h)) || null;
    });
    await client.send("WebDriver:SwitchToWindow", { handle: ytHandle, focus: true });
    await client.send("WebDriver:SetWindowRect", { width: 1366, height: 900 });

    try {
      await client.send("WebDriver:Navigate", { url: LIVE_WATCH_URL }, 25_000);
    } catch (navErr) {
      return {
        ok: true,
        status: "skipped",
        browserVersion,
        reason: `live-navigation-unreachable: ${String(navErr?.message || navErr)}`
      };
    }

    const gateCheck = await client.executeSync(
      `
      const text = (document.body?.innerText || "").slice(0, 1200);
      const hasConsent = location.hostname.includes("consent.youtube.com");
      const hasBotGate = text.includes("Sign in to confirm") || text.includes("Before you continue");
      return { href: location.href, hasConsent, hasBotGate };
      `,
      [],
      15_000,
      { newSandbox: false }
    );
    if (gateCheck?.hasConsent || gateCheck?.hasBotGate) {
      return {
        ok: true,
        status: "skipped",
        browserVersion,
        reason: "live-youtube-consent-or-bot-gate",
        detail: gateCheck
      };
    }

    await findAndClick(client, "#biliscript-script-button", "live-script-btn");
    const readerLive = await waitFor("live YouTube reader open", async () =>
      client.executeSync(
        `
        const v = document.getElementById("biliscript-reading-view");
        const subList = document.getElementById("biliscript-reading-subtitle");
        if (!v || !v.classList.contains("open") || !subList) return null;
        return {
          title: document.title || "",
          scrollbarWidth: getComputedStyle(subList).scrollbarWidth || "",
          subtitleTextSample: (subList.textContent || "").trim().slice(0, 120)
        };
        `,
        [],
        20_000,
        { newSandbox: false }
      )
    );

    await client.send("WebDriver:SwitchToWindow", { handle: extHandle, focus: true });
    const mainWorldLive = await client.executeAsync(
      `
      const done = arguments[arguments.length - 1];
      (async () => {
        const tabs = await browser.tabs.query({ url: "https://www.youtube.com/watch*" });
        const tab = tabs[0];
        if (!tab?.id) return { ok: false, error: "no-yt-tab" };
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            const mp = document.getElementById("movie_player");
            const pr = typeof mp?.getPlayerResponse === "function" ? mp.getPlayerResponse() : window.ytInitialPlayerResponse;
            return JSON.parse(JSON.stringify({
              videoId: pr?.videoDetails?.videoId || "",
              title: pr?.videoDetails?.title || "",
              captionCount: pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0
            }));
          }
        });
        return { ok: Boolean(res?.[0]?.result?.videoId), snapshot: res?.[0]?.result || null };
      })().then(done, (err) => done({ ok: false, error: String(err?.message || err) }));
      `,
      [],
      20_000,
      { newSandbox: false }
    );

    const passed = Boolean(mainWorldLive?.ok && readerLive?.scrollbarWidth === "thin");
    log(`${passed ? "PASS" : "FAIL"}  live-youtube-probe  ${JSON.stringify({ readerLive, mainWorldLive }).slice(0, 300)}`);
    return {
      ok: passed,
      status: passed ? "passed" : "failed",
      browserVersion,
      readerLive,
      mainWorldLive
    };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      browserVersion,
      error: String(err?.message || err)
    };
  } finally {
    try {
      await client.send("WebDriver:DeleteSession", {}, 4000);
    } catch {}
    client.close();
    await killFirefoxAndCleanup(child, profileDir);
  }
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log(
      [
        "Usage: node scripts/firefox-smoke/youtube-smoke.mjs [--headed] [--live]",
        "",
        "Options:",
        "  --headed     Launch Firefox with a visible window (default: headless)",
        "  --live       Also run opportunistic live https://www.youtube.com/watch probe",
        "  -h, --help   Show this help message",
        "",
        "Environment:",
        "  FIREFOX_BIN             Override Firefox executable path",
        "  BILISCRIPT_FX_YT_LIVE   Set to 1 to also run live probe",
        "",
        "Exit codes:",
        "  0  All YouTube Firefox smoke checks passed",
        "  1  Missing dist-firefox build, invalid FIREFOX_BIN, or assertion/runtime failure",
        "  2  Firefox executable not found on this machine (skipped)"
      ].join("\n")
    );
    process.exit(EXIT_PASS);
  }

  const headed = args.has("--headed");
  const runLive = args.has("--live") || process.env.BILISCRIPT_FX_YT_LIVE === "1";
  const fx = resolveFirefoxBinary();
  if (!fx.found) {
    if (fx.explicitEnv) {
      console.error(`[youtube-fx-smoke] FAIL  FIREFOX_BIN points to non-existent executable: ${fx.explicitEnv}`);
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

  const result = await runYoutubeSmoke({
    firefoxBin: fx.bin,
    distDir: DEFAULT_DIST_FIREFOX,
    headed
  });

  const liveResult = runLive
    ? await runYoutubeLiveProbe({
        firefoxBin: fx.bin,
        distDir: DEFAULT_DIST_FIREFOX,
        headed
      })
    : null;

  const combinedOk = Boolean(result.ok && (!liveResult || liveResult.ok));
  fs.mkdirSync(path.dirname(STANDALONE_EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(
    STANDALONE_EVIDENCE_FILE,
    JSON.stringify(
      {
        status: combinedOk ? result.status : "failed",
        firefoxBin: fx.bin,
        headed,
        browserVersion: result.browserVersion,
        timestamp: new Date().toISOString(),
        checks: result.checks,
        liveProbe: liveResult,
        error: result.error || liveResult?.error || null
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  process.exit(combinedOk ? EXIT_PASS : EXIT_FAIL);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  await runCli();
}
