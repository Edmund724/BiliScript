#!/usr/bin/env node

import path from "node:path";
import { readFileSync } from "node:fs";
import {
  CDP,
  DEFAULT_DIST,
  DEFAULT_VIEWPORT,
  REPO_ROOT,
  artifactDir,
  attachPage,
  createWorkerSession,
  getLog,
  launchBrowser,
  log,
  screenshot,
  sleep,
  teardown,
  waitFor,
  watchPage,
  writeEvidence
} from "../harness.mjs";

const NAME = "connection-allowlist-enforced";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const VIEWPORT = DEFAULT_VIEWPORT;

const YT_FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "youtube");
const BILI_FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");

const YT_VIDEO_ID = "ytDemo01234";
const YT_WATCH_URL = `https://www.youtube.com/watch?v=${YT_VIDEO_ID}`;
const YT_SEED_URL = "https://www.youtube.com/__harness_seed__";
const YT_SAMPLE_WEBM_URL = "https://www.youtube.com/__fixture__/sample.webm";

const BILI_BVID = "BV1mAam6tEL8";
const BILI_AID = 117370433574328;
const BILI_CID = 42393338874;
const BILI_VIDEO_URL = `https://www.bilibili.com/video/${BILI_BVID}/?p=1`;
const BILI_SEED_URL = "https://www.bilibili.com/__harness_seed__";
const BILI_SAMPLE_WEBM_URL = "https://www.bilibili.com/__fixture__/sample.webm";

const SAMPLE_WEBM_B64 =
  "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";

const PAGE_SW_SCRIPT = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
  }
});
`;

const AI_MERMAID_MATH_MARKDOWN = [
  "受控页面下的 Mermaid 与 KaTeX 渲染验证：",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[经典脚本] --> B[零告警]",
  "```",
  "",
  "$$E = mc^2$$"
].join("\n");

function parseCliArgs(argv) {
  let headed = false;
  let distDir = DEFAULT_DIST;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--headed") {
      headed = true;
    } else if (arg.startsWith("--dist=")) {
      distDir = path.resolve(arg.slice("--dist=".length));
    } else if (arg === "--dist" && i + 1 < argv.length) {
      distDir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return { headed, distDir };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const { headed, distDir } = parseCliArgs(process.argv.slice(2));
const YT_PLAYER_RESPONSE = readJson(path.join(YT_FIXTURE_DIR, "player-response.json"));
const YT_INITIAL_DATA = readJson(path.join(YT_FIXTURE_DIR, "initial-data.json"));
const YT_TIMEDTEXT_EN = readJson(path.join(YT_FIXTURE_DIR, "timedtext-json3.json"));
const YT_GET_TRANSCRIPT = readJson(path.join(YT_FIXTURE_DIR, "get-transcript.json"));
const BILI_BUNDLES = readJson(path.join(BILI_FIXTURE_DIR, "bundles.json"));
const BILI_BODIES = readJson(path.join(BILI_FIXTURE_DIR, "bodies.json"));

const YT_ZH_CUES = ["大家好，欢迎回来", "今天测试强制 Allowlist", "经典脚本模式", "感谢观看"];
const YT_TIMEDTEXT_ZH = (() => {
  let idx = 0;
  return {
    ...YT_TIMEDTEXT_EN,
    events: (YT_TIMEDTEXT_EN.events || []).map((ev) => {
      if (!Array.isArray(ev.segs) || ev.segs.length === 0) return ev;
      const joined = ev.segs.map((s) => s.utf8 || "").join("").trim();
      if (!joined) return ev;
      const text = YT_ZH_CUES[idx] || `中文字幕第${idx + 1}段`;
      idx += 1;
      return { tStartMs: ev.tStartMs, dDurationMs: ev.dDurationMs, segs: [{ utf8: text }] };
    })
  };
})();

const checks = [];
const cdps = [];
const allowlistResponses = [];
const handledSwFetchIds = new Set();

function check(name, ok, detail = null) {
  const entry = { name, ok: Boolean(ok), detail };
  checks.push(entry);
  log(`${entry.ok ? "PASS" : "FAIL"}  ${name}${detail === null ? "" : `  ${JSON.stringify(detail).slice(0, 360)}`}`);
  return entry.ok;
}

function buildSeedHtml(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><div id="seed">ready</div></body></html>`;
}

function buildYoutubeWatchHtml() {
  const ytcfgObj = {
    INNERTUBE_API_KEY: "fixture-innertube-key",
    INNERTUBE_CONTEXT: { client: { clientName: "WEB", clientVersion: "2.20261123.00.00" } }
  };
  return `<!doctype html>
<html lang="zh-CN" dark>
<head>
<meta charset="utf-8">
<title>YouTube Connection-Allowlist Fixture - YouTube</title>
<style>
html,body{margin:0;padding:0;width:100%;min-height:100%;background:#0f0f0f;color:#f1f1f1;font-family:Roboto,Arial,sans-serif}
ytd-watch-flexy{display:block;padding-top:24px}
ytd-watch-flexy #columns{display:flex;align-items:flex-start;gap:24px;max-width:1520px;margin:0 auto;padding:0 24px 32px;box-sizing:border-box}
ytd-watch-flexy #primary{flex:0 1 960px;max-width:960px;min-width:0}
ytd-watch-flexy #movie_player{position:relative;width:100%;height:540px;background:#000;border-radius:12px;overflow:hidden}
ytd-watch-flexy #movie_player video.html5-main-video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
ytd-watch-flexy #above-the-fold{margin-top:12px;padding:12px 0}
ytd-watch-flexy #actions{display:flex;align-items:center;justify-content:flex-end}
ytd-watch-flexy #top-level-buttons-computed{display:flex;align-items:center;gap:8px}
.yt-action-pill{height:36px;padding:0 16px;border-radius:18px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.1);color:#f1f1f1;font-size:14px;cursor:pointer}
ytd-watch-flexy #secondary{width:402px;flex:0 0 402px;min-height:700px;background:rgba(255,255,255,0.04);border-radius:12px;padding:12px;box-sizing:border-box}
</style>
</head>
<body>
<ytd-watch-flexy>
  <div id="columns">
    <div id="primary">
      <div id="movie_player">
        <video class="html5-main-video" preload="auto" playsinline crossorigin="anonymous" src="${YT_SAMPLE_WEBM_URL}"></video>
      </div>
      <div id="above-the-fold">
        <div id="title-row">YouTube Connection-Allowlist Fixture</div>
        <div id="actions">
          <div id="actions-inner">
            <ytd-menu-renderer>
              <div id="top-level-buttons-computed">
                <button type="button" class="yt-action-pill">赞</button>
                <button type="button" class="yt-action-pill">分享</button>
              </div>
            </ytd-menu-renderer>
          </div>
        </div>
      </div>
    </div>
    <div id="secondary">相关推荐占位区</div>
  </div>
</ytd-watch-flexy>
<script>
window.ytInitialPlayerResponse = ${JSON.stringify(YT_PLAYER_RESPONSE)};
window.ytInitialData = ${JSON.stringify(YT_INITIAL_DATA)};
window.ytcfg = { data_: ${JSON.stringify(ytcfgObj)}, get(k) { return this.data_[k]; } };
const mp = document.getElementById("movie_player");
mp.getPlayerResponse = () => window.ytInitialPlayerResponse;
mp.getVideoData = () => ({
  video_id: window.ytInitialPlayerResponse.videoDetails.videoId,
  title: window.ytInitialPlayerResponse.videoDetails.title,
  author: window.ytInitialPlayerResponse.videoDetails.author
});
mp.getDuration = () => Number(window.ytInitialPlayerResponse.videoDetails.lengthSeconds || 0);
const flexy = document.querySelector("ytd-watch-flexy");
flexy.playerData = window.ytInitialPlayerResponse;
flexy.data = window.ytInitialData;
</script>
</body>
</html>`;
}

function buildBilibiliHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>B站 Connection-Allowlist Fixture</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#f6f7f8;color:#18191c;font-family:system-ui,sans-serif}
.bili-layout{display:flex;gap:24px;max-width:1440px;margin:16px auto;padding:0 24px;box-sizing:border-box}
.left-container{flex:1 1 auto;min-width:0}
#playerWrap{width:920px;background:#000;border-radius:8px;overflow:hidden}
.bpx-player-container{position:relative;width:100%;height:518px;background:#050505}
.bpx-player-video-wrap{width:100%;height:100%}
.bpx-player-video-wrap video{width:100%;height:100%;display:block;background:#050505}
.bpx-player-control-bottom-right{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;z-index:2}
.bpx-player-ctrl-quality{height:32px;padding:0 10px;border:0;border-radius:4px;background:#222;color:#fff;cursor:pointer}
#arc_toolbar_report{display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:12px 16px;background:#fff;border-radius:8px}
.video-toolbar-left,.video-toolbar-right{display:flex;align-items:center;gap:12px}
.video-complaint{cursor:pointer;color:#61666d}
.right-container{width:350px;flex:0 0 350px}
.right-container-inner{width:350px;min-height:600px;background:#fff;border-radius:8px;padding:12px;box-sizing:border-box}
</style></head><body>
<div id="app" class="bili-layout">
  <div class="left-container">
    <div id="playerWrap"><div id="bilibili-player"><div class="bpx-player-container" data-screen="normal"><div class="bpx-player-video-wrap"><video preload="auto" playsinline crossorigin="anonymous" src="${BILI_SAMPLE_WEBM_URL}"></video></div><div class="bpx-player-control-bottom-right"><button type="button" class="bpx-player-ctrl-quality">1080P</button></div></div></div></div>
    <div id="arc_toolbar_report" class="video-toolbar-container">
      <div class="video-toolbar-left"><span>点赞</span><span>投币</span><span>收藏</span></div>
      <div class="video-toolbar-right"><span class="video-complaint">稿件举报</span></div>
    </div>
  </div>
  <div class="right-container"><div class="right-container-inner">相关推荐占位区</div></div>
</div></body></html>`;
}

function biliViewResponse() {
  return {
    code: 0,
    message: "0",
    data: {
      aid: BILI_AID,
      bvid: BILI_BVID,
      cid: BILI_CID,
      title: "B站 Connection-Allowlist 验证视频",
      desc: "离线 fixture 视频",
      duration: 15,
      pubdate: 1767225600,
      owner: { name: "fixture" },
      pages: [{ cid: BILI_CID, page: 1, part: "第一分 P", duration: 15 }]
    }
  };
}

function biliPlayerResponse() {
  const source = BILI_BUNDLES[BILI_BVID];
  const zhUrl = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/walkthrough-fixture/${BILI_BVID}-zh.json`;
  const subtitles = source.data.subtitle.subtitles.slice(0, 1).map((sub) => ({
    ...sub,
    subtitle_url: zhUrl,
    subtitle_url_v2: zhUrl
  }));
  return {
    ...source,
    data: {
      ...source.data,
      aid: BILI_AID,
      bvid: BILI_BVID,
      cid: BILI_CID,
      subtitle: { ...source.data.subtitle, subtitles }
    }
  };
}

function buildSseCompletion() {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: AI_MERMAID_MATH_MARKDOWN }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
}

function matchDocumentFixture(url) {
  if (url === YT_SEED_URL) return { kind: "seed", html: buildSeedHtml("YouTube Seed"), allowlist: false };
  if (url === BILI_SEED_URL) return { kind: "seed", html: buildSeedHtml("Bilibili Seed"), allowlist: false };
  if (url.startsWith("https://www.youtube.com/watch")) {
    return { kind: "watch", html: buildYoutubeWatchHtml(), allowlist: true };
  }
  if (url.startsWith(`https://www.bilibili.com/video/${BILI_BVID}`)) {
    return { kind: "video", html: buildBilibiliHtml(), allowlist: true };
  }
  return null;
}

async function handleSiteFetchRequest(cdp, sessionId, params, sourceLabel) {
  const url = params.request?.url || "";
  try {
    if (url.endsWith("/__harness_sw__.js")) {
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "content-type", value: "application/javascript; charset=utf-8" },
            { name: "service-worker-allowed", value: "/" },
            { name: "cache-control", value: "no-store" }
          ],
          body: Buffer.from(PAGE_SW_SCRIPT).toString("base64")
        },
        sessionId || undefined
      );
      return;
    }
    if (url === YT_SAMPLE_WEBM_URL || url === BILI_SAMPLE_WEBM_URL) {
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "content-type", value: "video/webm" },
            { name: "accept-ranges", value: "bytes" },
            { name: "cache-control", value: "no-store" }
          ],
          body: SAMPLE_WEBM_B64
        },
        sessionId || undefined
      );
      return;
    }
    if (url.includes("/favicon.ico")) {
      await cdp.send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: [] }, sessionId || undefined);
      return;
    }
    const docFixture = matchDocumentFixture(url);
    if (docFixture && (params.resourceType === "Document" || sourceLabel === "page-sw")) {
      const responseHeaders = [{ name: "content-type", value: "text/html; charset=utf-8" }];
      if (docFixture.allowlist) {
        responseHeaders.push({ name: "connection-allowlist", value: "(response-origin)" });
        allowlistResponses.push({ url, sourceLabel, resourceType: params.resourceType, header: "(response-origin)" });
      }
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders,
          body: Buffer.from(docFixture.html).toString("base64")
        },
        sessionId || undefined
      );
      return;
    }
    if (url.includes("/api/timedtext")) {
      const lang = (new URL(url).searchParams.get("lang") || "").toLowerCase();
      const payload = lang.startsWith("zh") ? YT_TIMEDTEXT_ZH : YT_TIMEDTEXT_EN;
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
          body: Buffer.from(JSON.stringify(payload)).toString("base64")
        },
        sessionId || undefined
      );
      return;
    }
    if (url.includes("/youtubei/v1/get_transcript")) {
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
          body: Buffer.from(JSON.stringify(YT_GET_TRANSCRIPT)).toString("base64")
        },
        sessionId || undefined
      );
      return;
    }
    await cdp.send("Fetch.continueRequest", { requestId: params.requestId }, sessionId || undefined);
  } catch {}
}

async function installSiteFetchHooks(pageCdp, browserCdp) {
  const patterns = [
    { urlPattern: "https://www.youtube.com/*", requestStage: "Request" },
    { urlPattern: "https://www.bilibili.com/*", requestStage: "Request" }
  ];
  await pageCdp.send("Fetch.enable", { patterns });
  pageCdp.on("Fetch.requestPaused", (params, sid) => {
    if (sid) return;
    void handleSiteFetchRequest(pageCdp, null, params, "page");
  });

  await browserCdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "https://www.youtube.com/__harness_sw__.js", requestStage: "Request" },
      { urlPattern: "https://www.bilibili.com/__harness_sw__.js", requestStage: "Request" }
    ]
  });
  browserCdp.on("Fetch.requestPaused", async (params, sid) => {
    if (sid) {
      if (handledSwFetchIds.has(sid)) {
        await handleSiteFetchRequest(browserCdp, sid, params, "page-sw");
      }
      return;
    }
    await handleSiteFetchRequest(browserCdp, null, params, "browser");
  });
}

const handledSwReqIds = new Set();

function installSwFixtures(handle) {
  const { cdp, sessionId } = handle;
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId).then(() => {
    cdp.on("Fetch.requestPaused", async (params, sid) => {
      if ((sessionId || undefined) !== (sid || undefined)) return;
      const url = params.request?.url || "";
      const requestId = params.requestId;
      if (handledSwReqIds.has(requestId)) return;
      handledSwReqIds.add(requestId);
      try {
        if (/x\/web-interface\/view/.test(url)) {
          await cdp.send(
            "Fetch.fulfillRequest",
            {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: "content-type", value: "application/json" }],
              body: Buffer.from(JSON.stringify(biliViewResponse())).toString("base64")
            },
            sessionId
          );
          return;
        }
        if (/x\/player\/(?:wbi\/)?v2/.test(url)) {
          await cdp.send(
            "Fetch.fulfillRequest",
            {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: "content-type", value: "application/json" }],
              body: Buffer.from(JSON.stringify(biliPlayerResponse())).toString("base64")
            },
            sessionId
          );
          return;
        }
        if (url.includes(`walkthrough-fixture/${BILI_BVID}-zh.json`)) {
          const rawZh = BILI_BODIES[`${BILI_BVID}-zh`];
          const slice = (rawZh?.body || []).slice(0, 20);
          const maxTo = Math.max(1, Number(slice.at(-1)?.to || slice.at(-1)?.from || 15));
          const scale = maxTo > 14.5 ? 14.5 / maxTo : 1;
          const clippedZh = {
            ...rawZh,
            body: slice.map((item) => ({
              ...item,
              from: Number((Number(item.from || 0) * scale).toFixed(3)),
              to: Number((Number(item.to || 0) * scale).toFixed(3))
            }))
          };
          await cdp.send(
            "Fetch.fulfillRequest",
            {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: "content-type", value: "application/json" }],
              body: Buffer.from(JSON.stringify(clippedZh)).toString("base64")
            },
            sessionId
          );
          return;
        }
        if (url.includes("/chat/completions")) {
          await cdp.send(
            "Fetch.fulfillRequest",
            {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
              body: Buffer.from(buildSseCompletion()).toString("base64")
            },
            sessionId
          );
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
      } catch {}
    });
  });
}

async function installExecuteScriptSpy(workerSession) {
  await workerSession.evaluate(`(() => {
    if (globalThis.__allowlistExecSpy?.installed) return true;
    const orig = chrome.scripting.executeScript.bind(chrome.scripting);
    const spy = { installed: true, orig, log: [] };
    chrome.scripting.executeScript = async (injection) => {
      spy.log.push({
        files: Array.isArray(injection?.files) ? [...injection.files] : [],
        target: injection?.target ? { tabId: injection.target.tabId, frameIds: injection.target.frameIds || null } : null,
        at: Date.now()
      });
      return orig(injection);
    };
    globalThis.__allowlistExecSpy = spy;
    return true;
  })()`);
}

async function resetExecuteScriptSpy(workerSession) {
  await workerSession.evaluate(`(() => {
    if (globalThis.__allowlistExecSpy) globalThis.__allowlistExecSpy.log = [];
    return true;
  })()`);
}

async function readExecuteScriptSpy(workerSession) {
  return workerSession.evaluate(`globalThis.__allowlistExecSpy?.log || []`);
}

function installOffscreenFixtures(cdp) {
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      try {
        if (url.includes("/chat/completions")) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
            body: Buffer.from(buildSseCompletion()).toString("base64")
          });
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
      } catch {}
    });
  });
}

async function attachOffscreen(browserInstance) {
  const target = await waitFor(
    "offscreen target",
    async () => {
      const response = await fetch(`http://127.0.0.1:${browserInstance.port}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type !== "page" && String(item.url).endsWith("/entry/offscreen.html"));
    },
    { timeoutMs: 30000 }
  );
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdps.push(cdp);
  await cdp.send("Runtime.enable");
  return cdp;
}

function createTargetCoordinator(browserCdp, openerTargetId) {
  const childTargets = new Map();
  const initialTargetIds = new Set();
  const childConsoleLogs = [];

  browserCdp.on("Runtime.consoleAPICalled", (params, sid) => {
    if (!sid) return;
    childConsoleLogs.push({
      sessionId: sid,
      type: params.type,
      text: (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 400)
    });
  });

  browserCdp.on("Log.entryAdded", (params, sid) => {
    if (!sid) return;
    childConsoleLogs.push({
      sessionId: sid,
      type: `log:${params.entry.level}`,
      text: String(params.entry.text || "").slice(0, 400)
    });
  });

  browserCdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
    if (!targetInfo || targetInfo.targetId === openerTargetId) {
      await browserCdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      return;
    }
    const url = String(targetInfo.url || "");
    if (
      targetInfo.type === "service_worker" &&
      (url.startsWith("https://www.youtube.com/") || url.startsWith("https://www.bilibili.com/"))
    ) {
      if (!handledSwFetchIds.has(sessionId)) {
        handledSwFetchIds.add(sessionId);
        await browserCdp
          .send(
            "Fetch.enable",
            {
              patterns: [
                { urlPattern: "https://www.youtube.com/*", requestStage: "Request" },
                { urlPattern: "https://www.bilibili.com/*", requestStage: "Request" }
              ]
            },
            sessionId
          )
          .catch(() => {});
      }
      await browserCdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      return;
    }
    if (targetInfo.type === "service_worker" || url.startsWith("chrome-extension://") || initialTargetIds.has(targetInfo.targetId)) {
      await browserCdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      return;
    }
    childTargets.set(targetInfo.targetId, {
      targetId: targetInfo.targetId,
      sessionId,
      type: targetInfo.type,
      url,
      openerId: targetInfo.openerId || "",
      active: true
    });
    await browserCdp.send("Runtime.enable", {}, sessionId).catch(() => {});
    await browserCdp.send("Page.enable", {}, sessionId).catch(() => {});
    await browserCdp.send("Log.enable", {}, sessionId).catch(() => {});
    await browserCdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
  });

  browserCdp.on("Target.detachedFromTarget", (params) => {
    handledSwFetchIds.delete(params.sessionId);
    for (const item of childTargets.values()) {
      if (item.sessionId === params.sessionId || item.targetId === params.targetId) {
        item.active = false;
      }
    }
  });

  browserCdp.on("Target.targetDestroyed", (params) => {
    const item = childTargets.get(params.targetId);
    if (item) item.active = false;
  });

  async function init() {
    const res = await browserCdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    for (const info of res.targetInfos || []) {
      if (info.targetId && info.targetId !== openerTargetId) {
        initialTargetIds.add(info.targetId);
      }
    }
    await browserCdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
  }

  function snapshotActiveIds() {
    const set = new Set();
    for (const item of childTargets.values()) {
      if (item.active) set.add(item.targetId);
    }
    return set;
  }

  async function waitForNewDetachedTarget(prevIds, label) {
    return waitFor(
      label,
      async () => {
        for (const item of childTargets.values()) {
          if (!item.active || prevIds.has(item.targetId)) continue;
          const ok = await browserCdp
            .evaluate("Boolean(document.getElementById('biliscript-reading-view'))", {
              sessionId: item.sessionId,
              timeoutMs: 1500
            })
            .catch(() => false);
          if (ok) return item;
        }
        return null;
      },
      { timeoutMs: 15000, intervalMs: 150 }
    );
  }

  async function waitForClosed(targetId, label) {
    return waitFor(
      label,
      async () => {
        const item = childTargets.get(targetId);
        return !item || !item.active;
      },
      { timeoutMs: 10000, intervalMs: 120 }
    );
  }

  function activeList() {
    return [...childTargets.values()].filter((t) => t.active);
  }

  return { init, snapshotActiveIds, waitForNewDetachedTarget, waitForClosed, activeList, childConsoleLogs };
}

async function hitAndClick(cdp, sessionId, label, selector) {
  const point = await waitFor(
    `命中目标 ${label}`,
    async () => {
      const value = await cdp.evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "nearest" });
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return { blocked: "zero-size", w: r.width, h: r.height };
          const x = Math.round(r.left + r.width / 2);
          const y = Math.round(r.top + r.height / 2);
          const hit = document.elementFromPoint(x, y);
          if (!(hit === el || el.contains(hit))) {
            return { blocked: "covered", x, y, hit: hit ? hit.tagName + "." + hit.className : null };
          }
          return { x, y, w: Math.round(r.width), h: Math.round(r.height) };
        })()`,
        { sessionId: sessionId || undefined }
      );
      if (value?.blocked) throw new Error(`${label} 不可点击: ${JSON.stringify(value)}`);
      return value;
    },
    { timeoutMs: 15000, intervalMs: 150 }
  );
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 }, sessionId || undefined);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 }, sessionId || undefined);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 }, sessionId || undefined);
  return point;
}

async function fillChatInput(pageCdp, text) {
  await hitAndClick(pageCdp, null, "chat-input", "#biliscript-reading-chat-input");
  await pageCdp.evaluate(`(() => {
    const el = document.getElementById("biliscript-reading-chat-input");
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await pageCdp.send("Input.insertText", { text });
  await sleep(80);
}

async function ensurePageForeground(pageCdp, worker) {
  await worker
    .evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("onboarding.html") });
      const ids = tabs.map((t) => t.id).filter((id) => typeof id === "number");
      if (ids.length) await chrome.tabs.remove(ids);
      return ids.length;
    })()`)
    .catch(() => {});
  await pageCdp.send("Page.bringToFront").catch(() => {});
}

async function pauseAndCleanMedia(pageCdp, remove = false) {
  await pageCdp
    .evaluate(
      `(() => {
        for (const m of document.querySelectorAll("video,audio")) {
          try {
            m.pause();
            if (${Boolean(remove)}) {
              m.removeAttribute("src");
              m.load();
              m.remove();
            }
          } catch {}
        }
      })()`
    )
    .catch(() => {});
}

async function registerPageServiceWorker(pageCdp, seedUrl) {
  await pageCdp.send("Page.navigate", { url: seedUrl });
  await waitFor(`seed 就绪 ${seedUrl}`, () => pageCdp.evaluate(`document.readyState === "complete"`), { timeoutMs: 20000 });
  const swActive = await pageCdp.evaluate(`(async () => {
    if (!("serviceWorker" in navigator)) return { ok: false, reason: "no-serviceWorker-api" };
    const reg = await navigator.serviceWorker.register("/__harness_sw__.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return { ok: Boolean(reg.active), scriptURL: reg.active?.scriptURL || null };
  })()`);
  if (!swActive?.ok) {
    throw new Error(`页面 Service Worker 注册失败 (${seedUrl}): ${JSON.stringify(swActive)}`);
  }
  return swActive;
}

function findUnsafeAttempts(consoleEntries) {
  return consoleEntries.filter((entry) => /unsafe attempt/i.test(entry.text || ""));
}

function findBlockedExtRequests(netEntries) {
  return netEntries.filter(
    (entry) =>
      entry.phase === "loadingFailed" &&
      entry.blockedReason === "other" &&
      String(entry.url || "").startsWith("chrome-extension://")
  );
}

async function verifySiteUnderAllowlist({ site, seedUrl, targetUrl, preinjectMode, page, browserCdp, tracker, worker, watcher, results }) {
  await registerPageServiceWorker(page.cdp, seedUrl);
  await resetExecuteScriptSpy(worker);
  const consoleStartIdx = watcher.consoleLog.length;
  const netStartIdx = watcher.netLog.length;
  const childLogStartIdx = tracker.childConsoleLogs.length;
  const allowlistStartIdx = allowlistResponses.length;

  await ensurePageForeground(page.cdp, worker);
  await page.cdp.send("Page.navigate", { url: targetUrl });
  await waitFor(`${site} 页面就绪`, () => page.cdp.evaluate(`document.readyState === "complete"`), { timeoutMs: 25000 });
  await pauseAndCleanMedia(page.cdp, false);

  const swControl = await page.cdp.evaluate(`({
    href: location.href,
    controller: navigator.serviceWorker?.controller?.scriptURL || null
  })`);
  const injectedAllowlistHeaders = allowlistResponses.slice(allowlistStartIdx);
  const swControlled = Boolean(swControl?.controller && swControl.controller.endsWith("/__harness_sw__.js"));
  const allowlistInjectedViaSw = injectedAllowlistHeaders.some(
    (item) => item.sourceLabel === "page-sw" && item.header === "(response-origin)"
  );

  const preconditionOk = swControlled && allowlistInjectedViaSw;
  check(`${site}.precondition-sw-controlled-and-allowlist`, preconditionOk, {
    swControl,
    injectedAllowlistHeaders
  });
  if (!preconditionOk) {
    throw new Error(
      `前置条件不满足（${site}）：页面必须受 Service Worker 控制且由 SW 路径注入 Connection-Allowlist: (response-origin)。实测=${JSON.stringify({ swControl, injectedAllowlistHeaders })}`
    );
  }

  const buttonGeom = await waitFor(
    `${site} 页内按钮挂载`,
    async () => {
      return page.cdp.evaluate(`(() => {
        const btn = document.getElementById("biliscript-script-button");
        if (!btn || !btn.isConnected) return null;
        const r = btn.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return null;
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          x,
          y,
          hitOk: Boolean(hit && (hit === btn || btn.contains(hit))),
          text: btn.textContent?.trim() || ""
        };
      })()`);
    },
    { timeoutMs: 15000, intervalMs: 150 }
  );
  check(`${site}.script-button-mounted`, Boolean(buttonGeom?.hitOk && buttonGeom.w > 0 && buttonGeom.h > 0), buttonGeom);

  const execBeforePreinject = await readExecuteScriptSpy(worker);
  const hadAppBeforePreinject = execBeforePreinject.some((entry) => entry.files.some((f) => /g-app/i.test(f)));
  const modulePreloadBefore = await page.cdp.evaluate(`document.querySelectorAll('link[rel="modulepreload"]').length`);

  if (preinjectMode === "hover") {
    await page.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: buttonGeom.x,
      y: buttonGeom.y,
      button: "none",
      clickCount: 0
    });
  } else {
    await page.cdp.send("Page.bringToFront");
    await page.cdp.evaluate(`document.getElementById("biliscript-script-button")?.focus()`);
  }

  const preinjectObserved = await waitFor(
    `${site} ${preinjectMode} 预注入 g-shared + g-app`,
    async () => {
      const logEntries = await readExecuteScriptSpy(worker);
      const sharedCall = logEntries.find((entry) => entry.files.some((f) => /g-shared/i.test(f)));
      const appCall = logEntries.find((entry) => entry.files.some((f) => /g-app/i.test(f)));
      return sharedCall && appCall ? { sharedCall, appCall, totalCalls: logEntries.length } : null;
    },
    { timeoutMs: 8000, intervalMs: 100 }
  ).catch(() => null);
  const modulePreloadAfter = await page.cdp.evaluate(`document.querySelectorAll('link[rel="modulepreload"]').length`);
  check(
    `${site}.preinject-${preinjectMode}-effective`,
    Boolean(preinjectObserved && modulePreloadBefore === 0 && modulePreloadAfter === 0),
    { hadAppBeforePreinject, preinjectObserved, modulePreloadBefore, modulePreloadAfter }
  );

  await hitAndClick(page.cdp, null, `${site}-script-button`, "#biliscript-script-button");
  const panelState = await waitFor(
    `${site} 面板打开与样式生效`,
    async () => {
      return page.cdp.evaluate(`(() => {
        const view = document.getElementById("biliscript-reading-view");
        if (!view || !view.classList.contains("open")) return null;
        const htmlGate = document.documentElement.getAttribute("data-biliscript-reader-mode");
        const bodyGate = document.body?.getAttribute("data-biliscript-reader-mode");
        if (htmlGate !== "1" || bodyGate !== "1") return null;
        const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
        if (items === 0) return null;
        const cs = getComputedStyle(view);
        const probe = document.createElement("div");
        probe.style.display = "none";
        probe.style.backgroundColor = "var(--biliscript-reader-surface)";
        view.appendChild(probe);
        const surfaceBg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const r = view.getBoundingClientRect();
        const extLinks = document.querySelectorAll('link[data-biliscript-style], link[rel="stylesheet"][href^="chrome-extension://"]').length;
        return {
          open: true,
          htmlGate,
          bodyGate,
          items,
          display: cs.display,
          position: cs.position,
          surfaceBg,
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          extLinks
        };
      })()`);
    },
    { timeoutMs: 15000, intervalMs: 150 }
  );
  await pauseAndCleanMedia(page.cdp, false);
  await ensurePageForeground(page.cdp, worker);
  const styleOk =
    Boolean(panelState?.open) &&
    panelState.display === "block" &&
    panelState.position === "fixed" &&
    Boolean(panelState.surfaceBg && panelState.surfaceBg !== "rgba(0, 0, 0, 0)") &&
    panelState.rect.w >= 300 &&
    panelState.rect.h >= 300 &&
    panelState.extLinks === 0;
  check(`${site}.panel-open-and-styled`, styleOk, panelState);
  await screenshot(page.cdp, path.join(OUT_DIR, `${site}-01-panel-open.png`));

  await hitAndClick(page.cdp, null, `${site}-chat-tab`, "#biliscript-reading-tab-chat");
  await waitFor(
    `${site} 对话输入框就绪`,
    () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-reading-chat-input"))`),
    { timeoutMs: 15000, intervalMs: 150 }
  );
  await fillChatInput(page.cdp, "请输出 Mermaid 流程图与 KaTeX 公式");
  await waitFor(
    `${site} 发送按钮可点击`,
    () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-send-btn")?.disabled === false`),
    { timeoutMs: 10000, intervalMs: 100 }
  );
  await hitAndClick(page.cdp, null, `${site}-chat-send`, "#biliscript-reading-chat-send-btn");

  const lazyRenderState = await waitFor(
    `${site} Mermaid 与 KaTeX 懒加载渲染`,
    async () => {
      return page.cdp.evaluate(`(() => {
        const container = document.getElementById("biliscript-reading-chat-messages");
        if (!container) return null;
        const mermaidDone = container.querySelector('[data-biliscript-mermaid="done"] .biliscript-md-mermaid-svg svg');
        const mathDone = container.querySelector('[data-biliscript-math-status="done"] .katex math');
        if (!mermaidDone || !mathDone) return null;
        const mr = mermaidDone.getBoundingClientRect();
        if (!(mr.width > 0 && mr.height > 0)) return null;
        return {
          mermaidSvg: { w: Math.round(mr.width), h: Math.round(mr.height) },
          mathTag: mathDone.tagName.toLowerCase(),
          mathText: mathDone.textContent?.trim() || ""
        };
      })()`);
    },
    { timeoutMs: 25000, intervalMs: 200 }
  );
  const execAfterChat = await readExecuteScriptSpy(worker);
  const mermaidInjected = execAfterChat.some((entry) => entry.files.some((f) => /mermaid/i.test(f)));
  const mathInjected = execAfterChat.some((entry) => entry.files.some((f) => /math/i.test(f)));
  check(
    `${site}.mermaid-and-katex-lazy-render`,
    Boolean(lazyRenderState?.mermaidSvg?.w > 0 && lazyRenderState?.mathTag === "math" && mermaidInjected && mathInjected),
    { lazyRenderState, mermaidInjected, mathInjected }
  );
  await screenshot(page.cdp, path.join(OUT_DIR, `${site}-02-mermaid-katex.png`));

  const prevChildIds = tracker.snapshotActiveIds();
  await hitAndClick(page.cdp, null, `${site}-detach-btn`, "#biliscript-reading-detach-btn");
  const detachedChild = await tracker.waitForNewDetachedTarget(prevChildIds, `${site} 独立窗口出现`);
  const childSnap = await browserCdp.evaluate(
    `(() => {
      const view = document.getElementById("biliscript-reading-view");
      const detachBtn = document.getElementById("biliscript-reading-detach-btn");
      const extLinks = document.querySelectorAll('link[data-biliscript-style], link[rel="stylesheet"][href^="chrome-extension://"]').length;
      const styleEls = Array.from(document.head.querySelectorAll('style[data-biliscript-style="1"]')).filter((s) => Boolean(s.sheet)).length;
      const adoptedCount = Array.isArray(document.adoptedStyleSheets) ? document.adoptedStyleSheets.length : 0;
      let surfaceBg = null;
      if (view) {
        const probe = document.createElement("div");
        probe.style.display = "none";
        probe.style.backgroundColor = "var(--biliscript-reader-surface)";
        view.appendChild(probe);
        surfaceBg = getComputedStyle(probe).backgroundColor;
        probe.remove();
      }
      const docEl = document.documentElement;
      return {
        open: Boolean(view && view.classList.contains("open") && !view.hidden),
        detachHidden: Boolean(detachBtn?.hidden),
        extLinks,
        styleEls,
        adoptedCount,
        surfaceBg,
        overflowX: docEl.scrollWidth > docEl.clientWidth + 1,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      };
    })()`,
    { sessionId: detachedChild.sessionId }
  );
  if (!childSnap.detachHidden) {
    await hitAndClick(browserCdp, detachedChild.sessionId, `${site}-redock-btn`, "#biliscript-reading-detach-btn");
  } else {
    await browserCdp.send("Target.closeTarget", { targetId: detachedChild.targetId });
  }
  await tracker.waitForClosed(detachedChild.targetId, `${site} 独立窗口关闭归位`);
  const openerRestored = await waitFor(
    `${site} 主页阅读视图归位`,
    () => page.cdp.evaluate(`(() => {
      const v = document.getElementById("biliscript-reading-view");
      return Boolean(v && v.classList.contains("open") && !v.hidden);
    })()`),
    { timeoutMs: 10000, intervalMs: 150 }
  );
  const detachedOk =
    Boolean(childSnap?.open) &&
    childSnap.extLinks === 0 &&
    (childSnap.adoptedCount >= 3 || childSnap.styleEls >= 3) &&
    Boolean(childSnap.surfaceBg && childSnap.surfaceBg !== "rgba(0, 0, 0, 0)") &&
    !childSnap.overflowX &&
    childSnap.innerWidth >= 320 &&
    childSnap.innerHeight >= 320 &&
    Boolean(openerRestored);
  check(`${site}.detached-window-works`, detachedOk, { childSnap, openerRestored });

  await pauseAndCleanMedia(page.cdp, true);

  const siteConsole = watcher.consoleLog.slice(consoleStartIdx);
  const siteChildConsole = tracker.childConsoleLogs.slice(childLogStartIdx);
  const siteNet = watcher.netLog.slice(netStartIdx);
  const unsafeAttempts = [...findUnsafeAttempts(siteConsole), ...findUnsafeAttempts(siteChildConsole)];
  const blockedExt = findBlockedExtRequests(siteNet);
  check(
    `${site}.zero-unsafe-attempt-warnings`,
    unsafeAttempts.length === 0 && blockedExt.length === 0,
    { unsafeAttempts, blockedExt }
  );

  results[site] = {
    swControl,
    injectedAllowlistHeaders,
    buttonGeom,
    preinjectObserved,
    panelState,
    lazyRenderState,
    childSnap,
    openerRestored,
    unsafeAttemptCount: unsafeAttempts.length,
    blockedExtCount: blockedExt.length
  };
}

async function main() {
  const results = {};
  const browser = await launchBrowser({
    headless: !headed,
    distDir,
    autoplay: false,
    muted: true
  });
  let page = null;
  let watcher = null;
  let browserCdp = null;
  let tracker = null;

  try {
    page = await attachPage(browser, { viewport: VIEWPORT });
    cdps.push(page.cdp);
    watcher = watchPage(page.cdp, { limit: 1000 });

    browserCdp = await CDP.connect(browser.version.webSocketDebuggerUrl);
    cdps.push(browserCdp);

    tracker = createTargetCoordinator(browserCdp, page.target.id || page.target.targetId);
    await tracker.init();
    await installSiteFetchHooks(page.cdp, browserCdp);

    const worker = createWorkerSession({
      pageCdp: page.cdp,
      browser,
      distDir,
      onReconnect: async (handle) => {
        await installSwFixtures(handle);
        await installExecuteScriptSpy(worker);
      }
    });
    if (!(await worker.ensureAlive())) {
      throw new Error("扩展 Service Worker 不可用");
    }
    cdps.push(worker.handle.cdp);

    await worker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set({
        enablePlayerAiQuickAction: true,
        autoOpenReader: false,
        asrAutoFallback: false,
        webSearchEnabled: false,
        aiProviders: [
          {
            id: "allowlist-fixture-ai",
            presetId: "custom",
            name: "Allowlist Fixture AI",
            baseUrl: "https://api.bilibili.com",
            models: ["fixture-allowlist-model"],
            requiresKey: true,
            enabled: true,
            protocol: "openai"
          }
        ],
        defaultModel: "allowlist-fixture-ai"
      });
      await chrome.storage.local.set({
        aiProviderKeys: { "allowlist-fixture-ai": "fixture-allowlist-key" }
      });
      const hasDoc = typeof chrome.offscreen?.hasDocument === "function" ? await chrome.offscreen.hasDocument() : false;
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: chrome.runtime.getURL("entry/offscreen.html"),
          reasons: ["BLOBS"],
          justification: "Connection-Allowlist scenario fixture"
        });
      }
      return true;
    })()`);

    const offscreen = await attachOffscreen(browser);
    await installOffscreenFixtures(offscreen);

    await verifySiteUnderAllowlist({
      site: "youtube",
      seedUrl: YT_SEED_URL,
      targetUrl: YT_WATCH_URL,
      preinjectMode: "hover",
      page,
      browserCdp,
      tracker,
      worker,
      watcher,
      results
    });

    await verifySiteUnderAllowlist({
      site: "bilibili",
      seedUrl: BILI_SEED_URL,
      targetUrl: BILI_VIDEO_URL,
      preinjectMode: "focus",
      page,
      browserCdp,
      tracker,
      worker,
      watcher,
      results
    });
  } catch (error) {
    check("scenario-unhandled-error", false, {
      message: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 1200)
    });
    log(`场景异常：${error?.stack || error?.message}`);
  } finally {
    if (page?.cdp) {
      await pauseAndCleanMedia(page.cdp, true);
    }
    if (tracker && browserCdp && !browserCdp.closed) {
      for (const item of tracker.activeList()) {
        await browserCdp.send("Target.closeTarget", { targetId: item.targetId }).catch(() => {});
      }
    }
    await teardown({ browser, cdps });
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    const allConsole = [...(watcher?.consoleLog || []), ...(tracker?.childConsoleLogs || [])];
    await writeEvidence(OUT_DIR, {
      scenario: NAME,
      generatedAt: new Date().toISOString(),
      distDir,
      failed,
      checks,
      results,
      unsafeAttempts: findUnsafeAttempts(allConsole),
      blockedExt: findBlockedExtRequests(watcher?.netLog || []),
      consoleErrors: allConsole.filter((entry) => /error/i.test(entry.type)),
      logs: getLog(),
      boundary: "离线 fixture：YouTube/B站页面由页面 Service Worker 接管并由 CDP Fetch 注入 Connection-Allowlist: (response-origin)。"
    });
    if (failed.length > 0 || checks.length === 0) {
      process.exitCode = 1;
    }
  }
}

await main();
