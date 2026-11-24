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
  launchBrowser,
  log,
  screenshot,
  sleep,
  teardown,
  waitFor,
  watchPage,
  writeEvidence
} from "../harness.mjs";

const NAME = "youtube-core";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "youtube");
const VIEWPORT = DEFAULT_VIEWPORT;
const headed = process.argv.includes("--headed");
const fixtureOnly = process.argv.includes("--fixture-only");

const OFFLINE_VIDEO_ID = "ytDemo01234";
const OFFLINE_WATCH_URL = `https://www.youtube.com/watch?v=${OFFLINE_VIDEO_ID}`;
const SAMPLE_WEBM_URL = "https://www.youtube.com/__fixture__/sample.webm";
const SAMPLE_WEBM_B64 =
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBlk27i1OrhBZUrmtTrIHLTbuMU6uEElTDZ1OsggEY7AEAAAAAAABdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZrAq17GDD0JATYCMTGF2ZjYzLjEuMTAyV0GMTGF2ZjYzLjEuMTAyRImIQM1MAAAAAAAWVK5ryK4BAAAAAAAAP9eBAXPFiEAGnpy++JISnIEAIrWcg3VuZIiBAIaFVl9WUDiDgQEj44OEHc1lAOCQsIFAuoFAmoECVbCEVbmBARJUw2fWc3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2My4xLjEwMnNzsWPAi2PFiEAGnpy++JISZ8igRaOHRU5DT0RFUkSHk0xhdmM2My4xLjEwMiBsaWJ2cHgfQ7Z19+eBAKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLnggXco5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454ILuKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLnghGUo5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454IXcKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLngh1Mo5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454IjKKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLngikEo5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454Iu4KOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLngjS8o5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAA==";

const LIVE_VIDEO_A = {
  videoId: "aircAruvnKk",
  url: "https://www.youtube.com/watch?v=aircAruvnKk"
};
const LIVE_VIDEO_B = {
  videoId: "IHZwWFHWa-w",
  url: "https://www.youtube.com/watch?v=IHZwWFHWa-w"
};

function readJsonFixture(file) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
}

const PLAYER_RESPONSE = readJsonFixture("player-response.json");
const INITIAL_DATA = readJsonFixture("initial-data.json");
const TIMEDTEXT_EN = readJsonFixture("timedtext-json3.json");
const GET_TRANSCRIPT = readJsonFixture("get-transcript.json");
const LIVE_PLAYER_RESPONSE = readJsonFixture("live-stream-player-response.json");

const ZH_CUE_TEXTS = [
  "大家好，欢迎回来",
  "今天我们测试 YouTube 字幕",
  "[音乐]",
  "感谢观看"
];

function buildZhTimedtext(enPayload) {
  let cueIdx = 0;
  return {
    ...enPayload,
    events: (enPayload.events || []).map((ev) => {
      if (!Array.isArray(ev.segs) || ev.segs.length === 0) return ev;
      const joined = ev.segs.map((s) => s.utf8 || "").join("").trim();
      if (!joined) return ev;
      const text = ZH_CUE_TEXTS[cueIdx] || `中文测试第${cueIdx + 1}段`;
      cueIdx += 1;
      return {
        tStartMs: ev.tStartMs,
        dDurationMs: ev.dDurationMs,
        segs: [{ utf8: text }]
      };
    })
  };
}

const TIMEDTEXT_ZH = buildZhTimedtext(TIMEDTEXT_EN);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 320)}`}`);
  return Boolean(ok);
}

function checkEquals(name, actual, expected) {
  return check(name, actual === expected, { actual, expected });
}

function selfCheckFixtures() {
  const tracks = PLAYER_RESPONSE?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  checkEquals("fixture.video-id", PLAYER_RESPONSE?.videoDetails?.videoId, OFFLINE_VIDEO_ID);
  checkEquals("fixture.caption-tracks-count", tracks.length, 3);
  const chapters =
    INITIAL_DATA?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar
      ?.multiMarkersPlayerBarRenderer?.markersMap?.[0]?.value?.chapters ?? [];
  checkEquals("fixture.chapters-count", chapters.length, 3);
  const enCues = (TIMEDTEXT_EN?.events ?? []).filter(
    (e) => Array.isArray(e.segs) && e.segs.map((s) => s.utf8 || "").join("").trim().length > 0
  );
  checkEquals("fixture.timedtext-en-cues", enCues.length, 4);
  const zhCues = (TIMEDTEXT_ZH?.events ?? []).filter(
    (e) => Array.isArray(e.segs) && e.segs.map((s) => s.utf8 || "").join("").trim().length > 0
  );
  checkEquals("fixture.timedtext-zh-cues", zhCues.length, 4);
  check("fixture.transcript-params-present", Boolean(
    INITIAL_DATA?.engagementPanels?.[0]?.engagementPanelSectionListRenderer?.content?.continuationItemRenderer
      ?.continuationEndpoint?.getTranscriptEndpoint?.params
  ));
  check("fixture.get-transcript-cues", (GET_TRANSCRIPT?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptBodyRenderer?.cueGroups ?? []).length >= 3);
  checkEquals("fixture.live-flag", LIVE_PLAYER_RESPONSE?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow, true);
  return checks.every((c) => c.ok);
}

function buildOfflineYoutubeWatchHtml() {
  const ytcfgObj = {
    INNERTUBE_API_KEY: "fixture-innertube-key",
    INNERTUBE_CONTEXT: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20261123.00.00"
      }
    }
  };
  return `<!doctype html>
<html lang="zh-CN" dark>
<head>
<meta charset="utf-8">
<title>YouTube Multisite Subtitle Demo - YouTube</title>
<style>
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  min-height: 100%;
  background: #ffffff;
  color: #0f0f0f;
  font-family: Roboto, Arial, sans-serif;
}
html[dark], html[dark] body {
  background: #0f0f0f;
  color: #f1f1f1;
}
#masthead-stub {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 24px;
  background: rgba(15, 15, 15, 0.92);
  color: #f1f1f1;
  z-index: 100;
}
html:not([dark]) #masthead-stub {
  background: rgba(255, 255, 255, 0.95);
  color: #0f0f0f;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
ytd-watch-flexy {
  display: block;
  padding-top: 72px;
}
ytd-watch-flexy #columns {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  max-width: 1520px;
  margin: 0 auto;
  padding: 0 24px 32px;
  box-sizing: border-box;
}
ytd-watch-flexy #primary {
  flex: 0 1 960px;
  max-width: 960px;
  min-width: 0;
}
ytd-watch-flexy #movie_player {
  position: relative;
  width: 100%;
  height: 540px;
  background: #000000;
  border-radius: 12px;
  overflow: hidden;
}
ytd-watch-flexy #movie_player video.html5-main-video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  background: #000000;
}
ytd-watch-flexy #above-the-fold {
  margin-top: 12px;
  padding: 12px 0;
}
ytd-watch-flexy #title-row {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 12px;
}
ytd-watch-flexy #actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
ytd-watch-flexy #top-level-buttons-computed {
  display: flex;
  align-items: center;
  gap: 8px;
}
.yt-action-pill {
  height: 36px;
  padding: 0 16px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.1);
  color: #f1f1f1;
  font-size: 14px;
  cursor: pointer;
}
html:not([dark]) .yt-action-pill {
  border-color: rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.05);
  color: #0f0f0f;
}
ytd-watch-flexy #secondary {
  width: 402px;
  flex: 0 0 402px;
  min-height: 700px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  padding: 12px;
  box-sizing: border-box;
}
html:not([dark]) ytd-watch-flexy #secondary {
  background: rgba(0, 0, 0, 0.04);
}
ytd-watch-flexy[theater] #columns,
ytd-watch-flexy[full-bleed-player] #columns {
  flex-direction: column;
}
ytd-watch-flexy[theater] #primary,
ytd-watch-flexy[full-bleed-player] #primary {
  width: 100%;
}
ytd-watch-flexy[theater] #movie_player,
ytd-watch-flexy[full-bleed-player] #movie_player {
  height: 620px;
}
ytd-watch-flexy[theater] #secondary,
ytd-watch-flexy[full-bleed-player] #secondary {
  width: 100%;
  flex: 0 0 auto;
}
</style>
</head>
<body>
<header id="masthead-stub">YouTube Fixture Shell</header>
<ytd-watch-flexy>
  <div id="columns">
    <div id="primary">
      <div id="movie_player">
        <video class="html5-main-video" preload="auto" playsinline crossorigin="anonymous" src="${SAMPLE_WEBM_URL}"></video>
      </div>
      <div id="above-the-fold">
        <div id="title-row">YouTube Multisite Subtitle Demo</div>
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
window.ytInitialPlayerResponse = ${JSON.stringify(PLAYER_RESPONSE)};
window.ytInitialData = ${JSON.stringify(INITIAL_DATA)};
window.ytcfg = {
  data_: ${JSON.stringify(ytcfgObj)},
  get(key) { return this.data_[key]; }
};
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

async function installOfflineYoutubeFixtures(pageCdp) {
  await pageCdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "https://www.youtube.com/*", requestStage: "Request" }]
  });
  pageCdp.on("Fetch.requestPaused", async (params) => {
    const url = params.request?.url || "";
    try {
      if (url.startsWith(SAMPLE_WEBM_URL)) {
        await pageCdp.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "content-type", value: "video/webm" },
            { name: "accept-ranges", value: "bytes" },
            { name: "cache-control", value: "no-store" }
          ],
          body: SAMPLE_WEBM_B64
        });
        return;
      }
      if (url.includes("/favicon.ico")) {
        await pageCdp.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 204,
          responseHeaders: []
        });
        return;
      }
      if (params.resourceType === "Document" && url.includes("/watch")) {
        await pageCdp.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
          body: Buffer.from(buildOfflineYoutubeWatchHtml()).toString("base64")
        });
        return;
      }
      if (url.includes("/api/timedtext")) {
        const parsed = new URL(url);
        const lang = (parsed.searchParams.get("lang") || "").toLowerCase();
        const payload = lang.startsWith("zh") ? TIMEDTEXT_ZH : TIMEDTEXT_EN;
        await pageCdp.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
          body: Buffer.from(JSON.stringify(payload)).toString("base64")
        });
        return;
      }
      if (url.includes("/youtubei/v1/get_transcript")) {
        await pageCdp.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
          body: Buffer.from(JSON.stringify(GET_TRANSCRIPT)).toString("base64")
        });
        return;
      }
      await pageCdp.send("Fetch.continueRequest", { requestId: params.requestId });
    } catch {}
  });
}

async function disablePageFetchInterception(pageCdp) {
  await pageCdp.send("Fetch.disable").catch(() => {});
}

async function hitTestInTarget(cdp, sessionId, label, locateExpr, { clipExpr = null } = {}) {
  return cdp.evaluate(
    `(async () => {
      const el = ${locateExpr};
      if (!el) return { ok: false, label: ${JSON.stringify(label)}, reason: "not-found" };
      const clip = ${clipExpr ?? "null"};
      const r0 = el.getBoundingClientRect();
      if (clip) {
        const cr = clip.getBoundingClientRect();
        if (r0.top < cr.top + 1 || r0.bottom > cr.bottom - 1) {
          clip.scrollTop += r0.top - cr.top - (cr.height - r0.height) / 2;
        }
      } else {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      }
      const nextFrame = () => new Promise((res) => {
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
        setTimeout(finish, 34);
      });
      let r = el.getBoundingClientRect();
      for (let i = 0; i < 20; i += 1) {
        await nextFrame();
        const nr = el.getBoundingClientRect();
        if (
          nr.width > 0 &&
          nr.height > 0 &&
          Math.abs(nr.left - r.left) <= 0.25 &&
          Math.abs(nr.top - r.top) <= 0.25 &&
          Math.abs(nr.width - r.width) <= 0.25 &&
          Math.abs(nr.height - r.height) <= 0.25
        ) {
          r = nr;
          break;
        }
        r = nr;
      }
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const ok = r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh && !!hit && (hit === el || el.contains(hit));
      let diag = null;
      if (!ok) {
        const anc = [];
        for (let cur = el; cur && anc.length < 10; cur = cur.parentElement) {
          const cs = getComputedStyle(cur);
          const cr = cur.getBoundingClientRect();
          if (cs.pointerEvents === "none" || cs.visibility !== "visible" || cs.opacity === "0" || cs.overflow !== "visible" || cs.display === "none" || cr.width === 0 || cr.height === 0) {
            anc.push({
              tag: cur.tagName + (cur.id ? "#" + cur.id : ""),
              pe: cs.pointerEvents,
              vis: cs.visibility,
              op: cs.opacity,
              ov: cs.overflow,
              disp: cs.display,
              w: +cr.width.toFixed(1),
              h: +cr.height.toFixed(1)
            });
          }
        }
        diag = { scrollY: window.scrollY, anc };
      }
      return {
        ok,
        label: ${JSON.stringify(label)},
        rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2), left: +r.left.toFixed(2), top: +r.top.toFixed(2) },
        center: { x: +cx.toFixed(1), y: +cy.toFixed(1) },
        hitTag: hit ? hit.tagName + "." + String(hit.className || "").slice(0, 40) : null,
        ...(diag ? { diag } : {})
      };
    })()`,
    { sessionId: sessionId || undefined }
  );
}

async function dispatchClick(cdp, sessionId, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 }, sessionId || undefined);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 }, sessionId || undefined);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 }, sessionId || undefined);
}

async function clickInTarget(cdp, sessionId, label, locateExpr, opts = {}) {
  const info = await hitTestInTarget(cdp, sessionId, label, locateExpr, opts);
  if (!info?.ok) return { ok: false, ...info };
  await dispatchClick(cdp, sessionId, info.center.x, info.center.y);
  return { ok: true, label, rect: info.rect, center: info.center };
}

function createChildTargetTracker(browserCdp, openerTargetId) {
  const targets = new Map();
  const initialTargetIds = new Set();

  browserCdp.on("Target.attachedToTarget", (params) => {
    const info = params.targetInfo;
    if (!info || info.targetId === openerTargetId || info.type === "service_worker") return;
    if (initialTargetIds.has(info.targetId)) return;
    const url = String(info.url || "");
    if (url.startsWith("chrome-extension://")) return;
    const existing = targets.get(info.targetId);
    targets.set(info.targetId, {
      targetId: info.targetId,
      sessionId: params.sessionId,
      type: info.type,
      url,
      openerId: info.openerId || "",
      active: true
    });
    if (!existing || existing.sessionId !== params.sessionId) {
      void browserCdp.send("Runtime.enable", {}, params.sessionId).catch(() => {});
      void browserCdp.send("Page.enable", {}, params.sessionId).catch(() => {});
      void browserCdp.send("Log.enable", {}, params.sessionId).catch(() => {});
    }
  });

  browserCdp.on("Target.detachedFromTarget", (params) => {
    for (const item of targets.values()) {
      if (item.sessionId === params.sessionId || item.targetId === params.targetId) {
        item.active = false;
      }
    }
  });

  browserCdp.on("Target.targetDestroyed", (params) => {
    const item = targets.get(params.targetId);
    if (item) item.active = false;
  });

  async function init() {
    const res = await browserCdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    for (const info of res.targetInfos || []) {
      if (info.targetId && info.targetId !== openerTargetId) {
        initialTargetIds.add(info.targetId);
      }
    }
  }

  function snapshotActiveIds() {
    const set = new Set();
    for (const item of targets.values()) {
      if (item.active) set.add(item.targetId);
    }
    return set;
  }

  async function waitForNewDetachedTarget(prevIds, label = "detached target") {
    return waitFor(
      label,
      async () => {
        const res = await browserCdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
        for (const info of res.targetInfos || []) {
          if (!info.targetId || info.targetId === openerTargetId || prevIds.has(info.targetId) || initialTargetIds.has(info.targetId)) {
            continue;
          }
          if (info.type === "service_worker" || info.type === "background_page" || info.type === "browser") continue;
          const url = String(info.url || "");
          if (url.startsWith("chrome-extension://")) continue;
          const isChildMatch =
            (openerTargetId && info.openerId === openerTargetId) ||
            (info.type === "page" && (url === "about:blank" || url === ""));
          if (!targets.has(info.targetId) && isChildMatch) {
            try {
              const attached = await browserCdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
              targets.set(info.targetId, {
                targetId: info.targetId,
                sessionId: attached.sessionId,
                type: info.type,
                url,
                openerId: info.openerId || "",
                active: true
              });
              await browserCdp.send("Runtime.enable", {}, attached.sessionId).catch(() => {});
              await browserCdp.send("Page.enable", {}, attached.sessionId).catch(() => {});
            } catch {}
          }
        }
        for (const item of targets.values()) {
          if (!item.active || prevIds.has(item.targetId)) continue;
          try {
            const hasView = await browserCdp.evaluate(
              "Boolean(document.getElementById('biliscript-reading-view'))",
              { sessionId: item.sessionId, timeoutMs: 2500 }
            );
            if (hasView) return item;
          } catch {}
        }
        return null;
      },
      { timeoutMs: 12000, intervalMs: 150 }
    );
  }

  async function waitForClosed(targetId, label = "detached target closed") {
    return waitFor(
      label,
      async () => {
        const item = targets.get(targetId);
        if (item && !item.active) return true;
        const res = await browserCdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
        const stillExists = (res.targetInfos || []).some((info) => info.targetId === targetId);
        if (!stillExists) {
          if (item) item.active = false;
          return true;
        }
        return false;
      },
      { timeoutMs: 10000, intervalMs: 150 }
    );
  }

  function activeList() {
    return [...targets.values()].filter((t) => t.active);
  }

  return { init, snapshotActiveIds, waitForNewDetachedTarget, waitForClosed, activeList };
}

async function pauseAndCleanMedia(pageCdp, removeSrc = false) {
  if (!pageCdp || pageCdp.closed) return null;
  return pageCdp
    .evaluate(
      `(() => {
        const nodes = [...document.querySelectorAll("video, audio")];
        const summary = nodes.map((n) => {
          try { n.pause(); } catch {}
          if (${removeSrc ? "true" : "false"}) {
            try { n.removeAttribute("src"); } catch {}
            try { n.srcObject = null; } catch {}
            try { n.load(); } catch {}
            try { n.remove(); } catch {}
          }
          return { tag: n.tagName, paused: n.paused };
        });
        return summary;
      })()`
    )
    .catch(() => null);
}

async function readThemeSurfaceSnapshot(cdp, sessionId = null) {
  return cdp.evaluate(
    `(() => {
      const view = document.getElementById("biliscript-reading-view");
      if (!view) return null;
      const probe = document.createElement("div");
      probe.style.display = "none";
      view.appendChild(probe);
      const readVar = (cssVar, prop) => {
        probe.style[prop] = "var(" + cssVar + ")";
        return getComputedStyle(probe)[prop];
      };
      const cs = getComputedStyle(view);
      const out = {
        htmlDark: document.documentElement.hasAttribute("dark"),
        htmlReaderTheme: document.documentElement.getAttribute("data-biliscript-reader-theme"),
        viewTheme: view.getAttribute("data-theme"),
        surface: readVar("--biliscript-reader-surface", "backgroundColor"),
        text: readVar("--biliscript-reader-text", "color"),
        viewBg: cs.backgroundColor
      };
      probe.remove();
      return out;
    })()`,
    { sessionId: sessionId || undefined }
  );
}

async function ensureWatchForeground(pageCdp, worker) {
  await worker.evaluate(`(async () => {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("onboarding.html") });
    const ids = tabs.map((t) => t.id).filter((id) => typeof id === "number");
    if (ids.length) await chrome.tabs.remove(ids);
    return ids.length;
  })()`).catch(() => {});
  await pageCdp.send("Page.bringToFront").catch(() => {});
}

async function runOfflineSuite({ page, browserCdp, tracker, worker, evidence }) {
  log("PHASE 1（离线 fixture）：YouTube 桌面 /watch 真实 DOM 几何与交互验收");
  await worker.evaluate(`(async () => {
    await chrome.storage.sync.set({
      readerTheme: "bilibili",
      readerThemeUserSet: false,
      readerPalette: "flyme",
      bilingualSubtitles: false,
      detachedWindowMode: "popup",
      autoOpenReader: false,
      enableDebugLogs: false
    });
    await chrome.storage.local.remove("biliscript_detached_window_bounds_v1");
    return true;
  })()`);

  await ensureWatchForeground(page.cdp, worker);

  await installOfflineYoutubeFixtures(page.cdp);
  await page.cdp.send("Page.bringToFront").catch(() => {});
  await page.cdp.send("Page.navigate", { url: OFFLINE_WATCH_URL });

  await waitFor("offline video ready", async () => {
    const st = await page.cdp.evaluate(`(() => {
      const v = document.querySelector("#movie_player video");
      return {
        visible: document.visibilityState === "visible",
        ready: Boolean(v && v.readyState >= 2)
      };
    })()`);
    if (st && !st.visible) {
      await ensureWatchForeground(page.cdp, worker);
      return false;
    }
    return Boolean(st?.ready);
  }, { timeoutMs: 15000, intervalMs: 200 });
  await pauseAndCleanMedia(page.cdp, false);

  await waitFor("offline #actions script button mounted", async () => {
    return page.cdp.evaluate(`Boolean(document.getElementById("biliscript-script-button"))`);
  }, { timeoutMs: 15000, intervalMs: 200 });
  await ensureWatchForeground(page.cdp, worker);

  const btnInfo = await page.cdp.evaluate(`(() => {
    const btn = document.getElementById("biliscript-script-button");
    const host = document.querySelector("#actions #top-level-buttons-computed") || document.querySelector("#actions");
    if (!btn || !host) return null;
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return {
      insideActions: host.contains(btn),
      siteAttr: btn.dataset.biliscriptSite || null,
      hostThemeAttr: btn.dataset.biliscriptHostTheme || null,
      text: (btn.textContent || "").trim(),
      bg: cs.backgroundColor,
      color: cs.color,
      borderRadius: cs.borderRadius,
      rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) }
    };
  })()`);
  check(
    "offline.1-actions-capsule-mount-and-style",
    Boolean(
      btnInfo &&
        btnInfo.insideActions &&
        btnInfo.siteAttr === "youtube" &&
        btnInfo.hostThemeAttr === "dark" &&
        btnInfo.text === "文摘" &&
        btnInfo.bg !== "rgb(251, 114, 153)" &&
        btnInfo.borderRadius === "18px" &&
        btnInfo.rect.h === 36 &&
        btnInfo.rect.w > 0
    ),
    btnInfo
  );

  await page.cdp.evaluate(`document.getElementById("biliscript-script-button")?.remove();`);
  const healed = await waitFor("script button self-heal after removal", async () => {
    return page.cdp.evaluate(`(() => {
      const btn = document.getElementById("biliscript-script-button");
      const host = document.querySelector("#actions #top-level-buttons-computed") || document.querySelector("#actions");
      if (!btn || !host || !host.contains(btn)) return null;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { w: +r.width.toFixed(2), h: +r.height.toFixed(2) } : null;
    })()`);
  }, { timeoutMs: 8000, intervalMs: 200 });
  check("offline.1-actions-button-self-heal", Boolean(healed), healed);

  const playerAiInfo = await waitFor("youtube player-ai quick button mounted in #movie_player", async () => {
    return page.cdp.evaluate(`(() => {
      const player = document.querySelector("ytd-watch-flexy #movie_player");
      const btn = document.getElementById("biliscript-player-ai-quick-action");
      const wrap = btn?.closest(".biliscript-player-ai-wrap");
      if (!player || !btn || !wrap || wrap.parentElement !== player) return null;
      player.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      const pr = player.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const cs = getComputedStyle(wrap);
      return {
        active: wrap.classList.contains("is-active"),
        zIndex: cs.zIndex,
        noLive: !document.getElementById("biliscript-player-live-quick-action"),
        noInterpret: !document.getElementById("biliscript-player-interpret-quick-action"),
        rightGap: +(pr.right - wr.right).toFixed(2),
        cyDelta: +(((wr.top + wr.bottom) / 2) - ((pr.top + pr.bottom) / 2)).toFixed(2),
        w: +wr.width.toFixed(2),
        h: +wr.height.toFixed(2)
      };
    })()`);
  }, { timeoutMs: 8000, intervalMs: 150 });
  check(
    "offline.1-player-ai-button-mount-and-position",
    Boolean(
      playerAiInfo &&
        playerAiInfo.active &&
        playerAiInfo.zIndex === "40" &&
        playerAiInfo.noLive &&
        playerAiInfo.noInterpret &&
        Math.abs(playerAiInfo.rightGap - 14) <= 10 &&
        Math.abs(playerAiInfo.cyDelta) <= 2 &&
        playerAiInfo.w === 36 &&
        playerAiInfo.h === 36
    ),
    playerAiInfo
  );

  const openClick = await clickInTarget(page.cdp, null, "yt-script-button", "document.getElementById('biliscript-script-button')");
  check("offline.open-reader-click", openClick.ok, openClick);

  await waitFor("offline reader open & subtitles ready", async () => {
    return page.cdp.evaluate(`(() => {
      const v = document.getElementById("biliscript-reading-view");
      const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
      const anims = v ? v.getAnimations().filter((a) => a.playState === "running").length : 0;
      return Boolean(v && v.classList.contains("open") && v.getAttribute("data-biliscript-reader-ready") === "1" && items === 4 && anims === 0);
    })()`);
  }, { timeoutMs: 15000, intervalMs: 200 });
  await pauseAndCleanMedia(page.cdp, false);

  const readLayout = async () => {
    return page.cdp.evaluate(`(() => {
      const view = document.getElementById("biliscript-reading-view");
      const sec = document.querySelector("ytd-watch-flexy #secondary");
      const player = document.querySelector("ytd-watch-flexy #movie_player");
      if (!view || !sec || !player) return null;
      const vr = view.getBoundingClientRect();
      const sr = sec.getBoundingClientRect();
      const pr = player.getBoundingClientRect();
      const anims = view.getAnimations();
      const runningAnims = anims.filter((a) => a.playState === "running").length;
      const flexy = document.querySelector("ytd-watch-flexy");
      return {
        vis: document.visibilityState,
        theater: flexy?.hasAttribute("theater") || false,
        fullBleed: flexy?.hasAttribute("full-bleed-player") || false,
        htmlReaderMode: document.documentElement.getAttribute("data-biliscript-reader-mode"),
        bodyReaderMode: document.body.getAttribute("data-biliscript-reader-mode"),
        floating: view.getAttribute("data-biliscript-script-float"),
        runningAnims,
        animNames: anims.map((a) => a.playState + ":" + (a.transitionProperty || a.animationName || "")),
        vw: window.innerWidth,
        vh: window.innerHeight,
        clientWidth: document.documentElement.clientWidth,
        viewRect: { left: +vr.left.toFixed(2), top: +vr.top.toFixed(2), right: +vr.right.toFixed(2), bottom: +vr.bottom.toFixed(2), w: +vr.width.toFixed(2), h: +vr.height.toFixed(2) },
        secRect: { left: +sr.left.toFixed(2), top: +sr.top.toFixed(2), right: +sr.right.toFixed(2), w: +sr.width.toFixed(2) },
        playerRect: { right: +pr.right.toFixed(2), bottom: +pr.bottom.toFixed(2) }
      };
    })()`);
  };

  const docked = await waitFor("docked layout settled", async () => {
    const l = await readLayout();
    if (!l || l.floating === "1" || l.runningAnims > 0) return false;
    return l.bodyReaderMode === "1" && Math.abs(l.viewRect.right - l.clientWidth) <= 2 && l.viewRect.w >= 500 ? l : false;
  }, { timeoutMs: 8000, intervalMs: 150 });
  check(
    "offline.2-secondary-docked-alignment",
    Boolean(
      docked &&
        docked.htmlReaderMode === "1" &&
        docked.bodyReaderMode === "1" &&
        docked.floating === null &&
        Math.abs(docked.viewRect.w - 540) <= 2 &&
        Math.abs(docked.viewRect.top - docked.secRect.top) <= 2 &&
        Math.abs(docked.viewRect.right - docked.clientWidth) <= 2 &&
        docked.viewRect.left > docked.playerRect.right
    ),
    docked
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "01-offline-docked-dark.png"));

  await page.cdp.evaluate(`document.querySelector("ytd-watch-flexy").setAttribute("theater", "");`);
  let lastTheaterSnap = null;
  let theaterFloat = null;
  try {
    theaterFloat = await waitFor("theater float layout", async () => {
      const l = await readLayout();
      lastTheaterSnap = l;
      if (!l) return false;
      if (l.vis !== "visible") {
        await ensureWatchForeground(page.cdp, worker);
        return false;
      }
      if (l.floating !== "1" || l.runningAnims > 0) return false;
      const cx = (l.viewRect.left + l.viewRect.right) / 2;
      const cy = (l.viewRect.top + l.viewRect.bottom) / 2;
      return Math.abs(cx - l.clientWidth / 2) <= 6 && Math.abs(cy - l.vh / 2) <= 6 && l.viewRect.w >= 700 ? l : false;
    }, { timeoutMs: 8000, intervalMs: 150 });
  } catch (err) {
    throw new Error(`${err.message} | last=${JSON.stringify(lastTheaterSnap)}`);
  }
  check("offline.2-theater-fallback-centered-float", Boolean(theaterFloat), theaterFloat);
  await screenshot(page.cdp, path.join(OUT_DIR, "02-offline-theater-float.png"));

  await page.cdp.evaluate(`document.querySelector("ytd-watch-flexy").removeAttribute("theater");`);
  const redockedAfterTheater = await waitFor("redocked after theater removed", async () => {
    const l = await readLayout();
    return l && l.floating === null && l.runningAnims === 0 && Math.abs(l.viewRect.top - l.secRect.top) <= 2 ? l : false;
  }, { timeoutMs: 8000, intervalMs: 150 });

  await page.cdp.evaluate(`document.querySelector("ytd-watch-flexy").setAttribute("full-bleed-player", "");`);
  let lastFullBleedSnap = null;
  let fullBleedFloat = null;
  try {
    fullBleedFloat = await waitFor("full-bleed-player float layout", async () => {
      const l = await readLayout();
      lastFullBleedSnap = l;
      if (!l) return false;
      if (l.vis !== "visible") {
        await ensureWatchForeground(page.cdp, worker);
        return false;
      }
      if (l.floating !== "1" || l.runningAnims > 0) return false;
      const cx = (l.viewRect.left + l.viewRect.right) / 2;
      return Math.abs(cx - l.clientWidth / 2) <= 6 && l.viewRect.w >= 700 ? l : false;
    }, { timeoutMs: 8000, intervalMs: 150 });
  } catch (err) {
    throw new Error(`${err.message} | last=${JSON.stringify(lastFullBleedSnap)}`);
  }
  await page.cdp.evaluate(`document.querySelector("ytd-watch-flexy").removeAttribute("full-bleed-player");`);
  const redockedAfterFullBleed = await waitFor("redocked after full-bleed removed", async () => {
    const l = await readLayout();
    return l && l.floating === null && l.runningAnims === 0 && Math.abs(l.viewRect.top - l.secRect.top) <= 2 ? l : false;
  }, { timeoutMs: 8000, intervalMs: 150 });
  check(
    "offline.2-full-bleed-fallback-and-restore",
    Boolean(redockedAfterTheater && fullBleedFloat && redockedAfterFullBleed),
    { fullBleedFloat, redockedAfterFullBleed }
  );

  const darkThemeSnap = await readThemeSurfaceSnapshot(page.cdp);
  await page.cdp.evaluate(`document.documentElement.removeAttribute("dark");`);
  const lightThemeSnap = await waitFor("panel theme follows light", async () => {
    const s = await readThemeSurfaceSnapshot(page.cdp);
    return s && s.viewTheme === "light" && s.htmlReaderTheme === "light" && s.surface !== darkThemeSnap?.surface ? s : false;
  }, { timeoutMs: 6000, intervalMs: 100 });
  await screenshot(page.cdp, path.join(OUT_DIR, "03-offline-light-theme.png"));
  await page.cdp.evaluate(`document.documentElement.setAttribute("dark", "");`);
  const restoredDarkSnap = await waitFor("panel theme follows dark again", async () => {
    const s = await readThemeSurfaceSnapshot(page.cdp);
    return s && s.viewTheme === "dark" && s.htmlReaderTheme === "dark" && s.surface === darkThemeSnap?.surface ? s : false;
  }, { timeoutMs: 6000, intervalMs: 100 });
  check(
    "offline.3-html-dark-live-theme-sync",
    Boolean(
      darkThemeSnap?.viewTheme === "dark" &&
        lightThemeSnap?.viewTheme === "light" &&
        lightThemeSnap?.surface !== darkThemeSnap?.surface &&
        lightThemeSnap?.text !== darkThemeSnap?.text &&
        restoredDarkSnap?.surface === darkThemeSnap?.surface
    ),
    { darkThemeSnap, lightThemeSnap, restoredDarkSnap }
  );

  const beforeDetachIds = tracker.snapshotActiveIds();
  const detachClick = await clickInTarget(page.cdp, null, "detach-btn", "document.getElementById('biliscript-reading-detach-btn')");
  const detachedChild = await tracker.waitForNewDetachedTarget(beforeDetachIds, "detached YouTube window");
  const childSnap = await browserCdp.evaluate(
    `(() => {
      const view = document.getElementById("biliscript-reading-view");
      const detachBtn = document.getElementById("biliscript-reading-detach-btn");
      const links = Array.from(document.head.querySelectorAll('link[data-biliscript-style="1"]'));
      return {
        open: Boolean(view && view.classList.contains("open") && !view.hidden),
        theme: view?.getAttribute("data-theme") || null,
        detachHidden: Boolean(detachBtn?.hidden),
        linksLoaded: links.length >= 3 && links.every((l) => Boolean(l.sheet)),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      };
    })()`,
    { sessionId: detachedChild.sessionId }
  );
  const openerHasViewWhileDetached = await page.cdp.evaluate(`Boolean(document.getElementById("biliscript-reading-view"))`);
  const redockClick = await clickInTarget(
    browserCdp,
    detachedChild.sessionId,
    "redock-btn-in-child",
    "document.getElementById('biliscript-reading-detach-btn')"
  );
  await tracker.waitForClosed(detachedChild.targetId, "detached child closed after redock");
  const openerAfterRedock = await waitFor("opener view restored", async () => {
    return page.cdp.evaluate(`(() => {
      const v = document.getElementById("biliscript-reading-view");
      return v && v.classList.contains("open") && !v.hidden ? { open: true, detached: v.hasAttribute("data-biliscript-detached") } : false;
    })()`);
  }, { timeoutMs: 8000, intervalMs: 150 });
  check(
    "offline.4-detached-window-popout-and-redock",
    Boolean(
      detachClick.ok &&
        !openerHasViewWhileDetached &&
        childSnap?.open &&
        childSnap?.theme === "dark" &&
        !childSnap?.detachHidden &&
        childSnap?.linksLoaded &&
        childSnap?.innerWidth >= 360 &&
        childSnap?.innerHeight >= 420 &&
        redockClick.ok &&
        openerAfterRedock?.open &&
        openerAfterRedock?.detached === false
    ),
    { detachClick, openerHasViewWhileDetached, childSnap, redockClick, openerAfterRedock }
  );

  const waitForSettingsSettled = (label, viewConditionExpr) =>
    waitFor(
      label,
      async () =>
        page.cdp.evaluate(`(() => {
          const host = document.querySelector(".biliscript-reading-settings-host");
          const runningAnims = host
            ? host.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length
            : 0;
          const inMotion = Boolean(
            document.querySelector("[data-biliscript-settings-motion]") ||
              document.querySelector("[data-settings-view-leaving]") ||
              runningAnims > 0
          );
          return !inMotion && Boolean(${viewConditionExpr});
        })()`),
      { timeoutMs: 8000, intervalMs: 100 }
    );

  const openSettingsClick = await clickInTarget(page.cdp, null, "settings-open", "document.getElementById('biliscript-reading-settings-btn')");
  await waitForSettingsSettled(
    "settings panel open",
    '!document.getElementById("biliscript-reading-settings-panel")?.hidden && !document.getElementById("biliscriptSettingsRootView")?.hidden'
  );

  const rootGating = await page.cdp.evaluate(`(() => {
    const probe = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { hidden: el.hidden, ariaHidden: el.getAttribute("aria-hidden"), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
    };
    return {
      liveBtn: probe("openLiveSettingsBtn"),
      asrBtn: probe("openAsrSettingsBtn"),
      agentBtn: probe("openAgentSettingsBtn"),
      subtitleBtn: probe("openSubtitleSettingsBtn")
    };
  })()`);

  await clickInTarget(page.cdp, null, "open-ai-prompt-settings", "document.getElementById('openAiPromptBtn')");
  await waitForSettingsSettled(
    "ai prompt subpage visible",
    '!document.getElementById("biliscriptSettingsSubpageAiPrompt")?.hidden'
  );
  const playerAiSection = await page.cdp.evaluate(`(() => {
    const el = document.querySelector('#biliscriptSettingsSubpageAiPrompt .biliscript-set-group[data-settings-section="ai-button"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, ariaHidden: el.getAttribute("aria-hidden"), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  })()`);
  await clickInTarget(page.cdp, null, "settings-back-from-ai-prompt", "document.getElementById('biliscript-reading-settings-back-btn')");
  await waitForSettingsSettled(
    "settings root restored after ai prompt",
    '!document.getElementById("biliscriptSettingsRootView")?.hidden'
  );

  await clickInTarget(page.cdp, null, "open-appearance-settings", "document.getElementById('openAppearanceBtn')");
  await waitForSettingsSettled(
    "appearance subpage visible",
    '!document.getElementById("biliscriptSettingsSubpageAppearance")?.hidden'
  );
  const extraRatesRow = await page.cdp.evaluate(`(() => {
    const el = document.querySelector('#biliscriptSettingsSubpageAppearance [data-settings-item="extra-playback-rates"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, ariaHidden: el.getAttribute("aria-hidden"), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  })()`);
  await clickInTarget(page.cdp, null, "settings-back-from-appearance", "document.getElementById('biliscript-reading-settings-back-btn')");
  await waitForSettingsSettled(
    "settings root restored after appearance",
    '!document.getElementById("biliscriptSettingsRootView")?.hidden'
  );

  await clickInTarget(page.cdp, null, "open-subtitle-settings", "document.getElementById('openSubtitleSettingsBtn')");
  await waitForSettingsSettled(
    "subtitle settings subpage visible",
    '!document.getElementById("biliscriptSettingsSubpageSubtitle")?.hidden'
  );
  const indexTranslateState = await page.cdp.evaluate(`(() => {
    const sub = document.getElementById("biliscriptSettingsSubpageSubtitle");
    const srcSel = document.getElementById("subtitleTranslateSource");
    const modelSel = document.getElementById("subtitleTranslateModel");
    const srcWrap = srcSel?.closest(".custom-select-wrapper")?.querySelector(".custom-select-trigger") || srcSel;
    const modelWrap = modelSel?.closest(".custom-select-wrapper")?.querySelector(".custom-select-trigger") || modelSel;
    const sr = srcWrap ? srcWrap.getBoundingClientRect() : null;
    const mr = modelWrap ? modelWrap.getBoundingClientRect() : null;
    const idxOpt = srcSel ? [...srcSel.options].find((o) => o.value === "bilibili-index-translate") : null;
    return {
      subVisible: Boolean(sub && !sub.hidden),
      hasIndexOption: Boolean(idxOpt),
      indexOptionText: idxOpt?.textContent || "",
      sourceValue: srcSel?.value || "",
      modelValue: modelSel?.value || "",
      srcRect: sr ? { w: +sr.width.toFixed(2), h: +sr.height.toFixed(2) } : null,
      modelRect: mr ? { w: +mr.width.toFixed(2), h: +mr.height.toFixed(2) } : null
    };
  })()`);
  await screenshot(page.cdp, path.join(OUT_DIR, "04-offline-settings-subtitle.png"));

  const isGated = (entry) => Boolean(entry && entry.hidden === true && entry.ariaHidden === "true" && entry.w === 0 && entry.h === 0);
  check(
    "offline.5-settings-hides-4-bili-only-and-keeps-player-ai-and-index-translate",
    Boolean(
      openSettingsClick.ok &&
        isGated(rootGating.asrBtn) &&
        isGated(rootGating.liveBtn) &&
        isGated(rootGating.agentBtn) &&
        Boolean(playerAiSection && !playerAiSection.hidden && playerAiSection.w > 0 && playerAiSection.h > 0) &&
        isGated(extraRatesRow) &&
        indexTranslateState.subVisible &&
        indexTranslateState.hasIndexOption &&
        indexTranslateState.sourceValue === "bilibili-index-translate" &&
        (indexTranslateState.srcRect?.w ?? 0) > 0 &&
        (indexTranslateState.srcRect?.h ?? 0) > 0 &&
        (indexTranslateState.modelRect?.w ?? 0) > 0 &&
        (indexTranslateState.modelRect?.h ?? 0) > 0
    ),
    { rootGating, playerAiSection, extraRatesRow, indexTranslateState }
  );

  await clickInTarget(page.cdp, null, "settings-close", "document.getElementById('biliscript-reading-settings-btn')");
  await waitForSettingsSettled(
    "settings panel hidden",
    'document.getElementById("biliscript-reading-settings-panel")?.hidden'
  );

  const singleRowMetrics = await page.cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item")];
    return {
      count: items.length,
      subtextCount: document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-subtext").length,
      firstItemH: items[0] ? +items[0].getBoundingClientRect().height.toFixed(2) : 0
    };
  })()`);

  const pickerOpenClick = await clickInTarget(
    page.cdp,
    null,
    "track-picker-trigger",
    "document.querySelector('.biliscript-reading-track-picker .custom-select-trigger')"
  );
  await waitFor("track picker dropdown visible", async () => {
    return page.cdp.evaluate(`(() => {
      const d = document.querySelector(".biliscript-reading-track-picker .custom-select-dropdown");
      return Boolean(d && !d.hidden);
    })()`);
  }, { timeoutMs: 5000, intervalMs: 100 });

  const bilingualClick = await clickInTarget(
    page.cdp,
    null,
    "bilingual-switch",
    "document.querySelector('.biliscript-bilingual-switch')"
  );
  await sleep(300);

  const subReadyAfterSwitch = await waitFor("bilingual subtext ready", async () => {
    return page.cdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="ready"]').length === 4`);
  }, { timeoutMs: 10000, intervalMs: 150 }).catch(() => false);

  if (!subReadyAfterSwitch) {
    const subCol = await page.cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.biliscript-bilingual-col[data-col="sub"] .custom-select-option')];
      return rows.map((r) => ({ text: r.textContent, val: r.dataset.value || "" }));
    })()`);
    if (subCol.length > 0) {
      await clickInTarget(
        page.cdp,
        null,
        "pick-secondary-track",
        "document.querySelector('.biliscript-bilingual-col[data-col=\"sub\"] .custom-select-option:not(.is-selected)')"
      );
      await waitFor("bilingual subtext ready after pick", async () => {
        return page.cdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="ready"]').length === 4`);
      }, { timeoutMs: 10000, intervalMs: 150 });
    }
  }

  await clickInTarget(
    page.cdp,
    null,
    "track-picker-close",
    "document.querySelector('.biliscript-reading-track-picker .custom-select-trigger')"
  );
  await sleep(200);

  const dualRowMetrics = await page.cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item")];
    return items.map((it) => {
      const textWrap = it.querySelector(".biliscript-reading-text");
      const sub = it.querySelector(".biliscript-reading-subtext");
      const clone = textWrap ? textWrap.cloneNode(true) : null;
      if (clone) clone.querySelectorAll(".biliscript-reading-subtext").forEach((n) => n.remove());
      const mainText = (clone?.textContent || "").trim();
      const subText = (sub?.textContent || "").trim();
      return {
        itemH: +it.getBoundingClientRect().height.toFixed(2),
        textH: textWrap ? +textWrap.getBoundingClientRect().height.toFixed(2) : 0,
        subH: sub ? +sub.getBoundingClientRect().height.toFixed(2) : 0,
        subState: sub?.dataset.state || null,
        mainText,
        subText
      };
    });
  })()`);
  await screenshot(page.cdp, path.join(OUT_DIR, "05-offline-bilingual-subtitles.png"));

  check(
    "offline.6-bilingual-dual-line-and-nonzero-height",
    Boolean(
      pickerOpenClick.ok &&
        bilingualClick.ok &&
        singleRowMetrics.count === 4 &&
        singleRowMetrics.subtextCount === 0 &&
        dualRowMetrics.length === 4 &&
        dualRowMetrics.every(
          (row) =>
            row.subState === "ready" &&
            row.mainText.length > 0 &&
            row.subText.length > 0 &&
            row.mainText !== row.subText &&
            row.subH > 0 &&
            row.textH > row.subH &&
            row.itemH > singleRowMetrics.firstItemH
        )
    ),
    { singleRowMetrics, dualRowMetrics }
  );

  const offlineFrame = await page.cdp.evaluate(`(async () => {
    const v = document.querySelector("#movie_player video");
    if (!v) return { error: "no-video" };
    v.pause();
    if (v.readyState < 2 || v.videoWidth <= 0 || v.videoHeight <= 0) {
      return { error: "video-not-ready", readyState: v.readyState, vw: v.videoWidth, vh: v.videoHeight };
    }
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const c = document.createElement("canvas");
    c.width = vw;
    c.height = vh;
    const ctx = c.getContext("2d");
    if (!ctx) return { error: "no-2d-context" };
    ctx.drawImage(v, 0, 0, c.width, c.height);
    let px = null;
    let jpegDataUrlLen = 0;
    let jpegBlobSize = 0;
    let jpegMagic = "";
    try {
      px = [...ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data];
      const dataUrl = c.toDataURL("image/jpeg", 0.72);
      jpegDataUrlLen = dataUrl.length;
      const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.72));
      if (blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        jpegBlobSize = bytes.byteLength;
        jpegMagic = Array.from(bytes.slice(0, 3)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    return {
      ok: true,
      vw,
      vh,
      px,
      jpegDataUrlLen,
      jpegBlobSize,
      jpegMagic,
      pausedAfter: v.paused,
      srcCleared: !v.getAttribute("src")
    };
  })()`);
  check(
    "offline.7-video-canvas-drawimage-jpeg",
    Boolean(
      offlineFrame?.ok &&
        offlineFrame.px?.length === 4 &&
        offlineFrame.jpegDataUrlLen > 100 &&
        offlineFrame.jpegBlobSize > 0 &&
        offlineFrame.jpegMagic === "ffd8ff" &&
        offlineFrame.pausedAfter === true &&
        offlineFrame.srcCleared === true
    ),
    offlineFrame
  );

  await clickInTarget(page.cdp, null, "close-reader-before-player-ai", "document.getElementById('biliscript-reading-close-btn')");
  await waitFor("reader closed before player-ai click", async () => {
    return page.cdp.evaluate(`(() => {
      const v = document.getElementById("biliscript-reading-view");
      return !v || !v.classList.contains("open");
    })()`);
  }, { timeoutMs: 8000, intervalMs: 150 });

  await waitFor("player-ai button ready after close", async () => {
    return page.cdp.evaluate(`(() => {
      window.__BILISCRIPT_FORCE_SYNC_PLAYER_AI__?.();
      const player = document.querySelector("ytd-watch-flexy #movie_player");
      const btn = document.getElementById("biliscript-player-ai-quick-action");
      const wrap = btn?.closest(".biliscript-player-ai-wrap");
      if (!player || !btn || !wrap) return false;
      player.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      const cs = getComputedStyle(wrap);
      return wrap.classList.contains("is-active") && cs.pointerEvents !== "none";
    })()`);
  }, { timeoutMs: 8000, intervalMs: 200 });

  const playerAiClick = await clickInTarget(
    page.cdp,
    null,
    "yt-player-ai-quick-action",
    "document.getElementById('biliscript-player-ai-quick-action')"
  );
  const playerAiOpenedChat = await waitFor("player-ai click opens reader chat tab", async () => {
    return page.cdp.evaluate(`(() => {
      const v = document.getElementById("biliscript-reading-view");
      const chatTab = document.getElementById("biliscript-reading-tab-chat");
      if (!v || !v.classList.contains("open") || !chatTab) return false;
      const selected = chatTab.getAttribute("aria-selected") === "true" || chatTab.classList.contains("active");
      return selected ? { open: true, chatSelected: true } : false;
    })()`);
  }, { timeoutMs: 10000, intervalMs: 150 });
  check(
    "offline.8-player-ai-click-opens-chat-summary",
    Boolean(playerAiClick.ok && playerAiOpenedChat?.open && playerAiOpenedChat?.chatSelected),
    { playerAiClick, playerAiOpenedChat }
  );

  evidence.offline = {
    btnInfo,
    playerAiInfo,
    playerAiOpenedChat,
    docked,
    theaterFloat,
    fullBleedFloat,
    darkThemeSnap,
    lightThemeSnap,
    childSnap,
    rootGating,
    playerAiSection,
    extraRatesRow,
    indexTranslateState,
    singleRowMetrics,
    dualRowMetrics,
    offlineFrame
  };
}

async function runLiveSuite({ page, worker, evidence }) {
  log("PHASE 2（真网）：https://www.youtube.com/watch 主世界桥接、SPA 切换、字幕分级与视频帧探针");
  await disablePageFetchInterception(page.cdp);

  const liveNet = [];
  page.cdp.on("Network.requestWillBeSent", (params) => {
    const url = params.request?.url || "";
    if (!/\/api\/timedtext|\/youtubei\/v1\/get_transcript/.test(url)) return;
    if (liveNet.length < 200) {
      const headers = params.request?.headers || {};
      liveNet.push({
        phase: "request",
        t: Date.now(),
        method: params.request?.method || "",
        kind: url.includes("get_transcript") ? "get_transcript" : "timedtext",
        url: url.slice(0, 220),
        videoId: (() => {
          try {
            return new URL(url).searchParams.get("v") || "";
          } catch {
            return "";
          }
        })(),
        hasPot: url.includes("pot="),
        hasFmtJson3: url.includes("fmt=json3"),
        webHeaders: {
          clientName: headers["X-Youtube-Client-Name"] || headers["x-youtube-client-name"] || null,
          clientVersion: headers["X-Youtube-Client-Version"] || headers["x-youtube-client-version"] || null,
          origin: headers["X-Origin"] || headers["x-origin"] || null,
          visitorId: headers["X-Goog-Visitor-Id"] || headers["x-goog-visitor-id"] ? "present" : null
        }
      });
    }
  });
  page.cdp.on("Network.responseReceived", (params) => {
    const url = params.response?.url || "";
    if (!/\/api\/timedtext|\/youtubei\/v1\/get_transcript/.test(url)) return;
    if (liveNet.length < 200) {
      liveNet.push({
        phase: "response",
        t: Date.now(),
        status: params.response?.status,
        kind: url.includes("get_transcript") ? "get_transcript" : "timedtext",
        url: url.slice(0, 220)
      });
    }
  });

  await worker.evaluate(`(async () => {
    await chrome.storage.sync.set({
      bilingualSubtitles: false,
      autoOpenReader: false
    });
    return true;
  })()`);

  let navA = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (attempt > 1) {
      await page.cdp.send("Page.navigate", { url: "about:blank" }).catch(() => {});
      await sleep(300);
    }
    liveNet.length = 0;
    await page.cdp.send("Page.bringToFront").catch(() => {});
    await page.cdp.send("Page.navigate", { url: LIVE_VIDEO_A.url });
    navA = await waitFor(`live YouTube video A hydrated (attempt ${attempt})`, async () => {
      return page.cdp.evaluate(`(() => {
        if (location.href.startsWith("chrome-error://")) {
          return { errorPage: true };
        }
        const btn = document.getElementById("biliscript-script-button");
        const mp = document.getElementById("movie_player");
        const v = document.querySelector("#movie_player video");
        if (btn && mp && typeof mp.getPlayerResponse === "function" && v) {
          return { ok: true, href: location.href };
        }
        return false;
      })()`);
    }, { timeoutMs: 120000, intervalMs: 500 }).catch((error) => ({ timeout: error.message }));
    if (navA?.ok) break;
    log(`真网导航重试(${attempt}/4)：${JSON.stringify(navA)}`);
  }

  if (!navA?.ok) {
    throw new Error(`真网访问 YouTube 失败：${JSON.stringify(navA)}`);
  }

  await pauseAndCleanMedia(page.cdp, false);

  const snapshotA = await worker.evaluate(`(async () => {
    const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
    if (!tabs.length) return { error: "no-youtube-tab" };
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: "MAIN",
      func: () => {
        const mp = document.getElementById("movie_player");
        const pr = mp?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
        const wf = document.querySelector("ytd-watch-flexy");
        const idata = wf?.data || window.ytInitialData;
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const markers =
          idata?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer
            ?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap || [];
        const chapterCount = markers.reduce((acc, m) => acc + (m?.value?.chapters?.length || 0), 0);
        const ytcfg = window.ytcfg;
        const ctx = ytcfg?.get?.("INNERTUBE_CONTEXT") || ytcfg?.data_?.INNERTUBE_CONTEXT || null;
        const apiKey = ytcfg?.get?.("INNERTUBE_API_KEY") || ytcfg?.data_?.INNERTUBE_API_KEY || "";
        return {
          videoId: pr?.videoDetails?.videoId || "",
          title: pr?.videoDetails?.title || "",
          author: pr?.videoDetails?.author || "",
          trackCount: tracks.length,
          chapterCount,
          clientName: ctx?.client?.clientName || "",
          hasApiKey: Boolean(apiKey),
          hasVisitorData: Boolean(ctx?.client?.visitorData)
        };
      }
    });
    return res?.[0]?.result || null;
  })()`);
  check(
    "live.1-main-world-bridge-meta-chapters-tracks",
    Boolean(
      snapshotA &&
        snapshotA.videoId === LIVE_VIDEO_A.videoId &&
        snapshotA.title.length > 0 &&
        snapshotA.author.length > 0 &&
        snapshotA.trackCount > 0 &&
        snapshotA.chapterCount > 0 &&
        snapshotA.clientName === "WEB" &&
        snapshotA.hasApiKey
    ),
    snapshotA
  );

  let firstLiveHitFail = null;
  const openLiveHit = await waitFor("live script button hit-testable", async () => {
    const info = await hitTestInTarget(page.cdp, null, "live-script-button", "document.getElementById('biliscript-script-button')");
    if (info?.ok) return info;
    if (!firstLiveHitFail) firstLiveHitFail = info;
    return false;
  }, { timeoutMs: 12000, intervalMs: 250 }).catch(() => null);
  let beforeOpenNetIdx = liveNet.length;
  let openLiveClick = { ok: false, firstLiveHitFail };
  if (openLiveHit?.ok) {
    beforeOpenNetIdx = liveNet.length;
    await dispatchClick(page.cdp, null, openLiveHit.center.x, openLiveHit.center.y);
    openLiveClick = { ok: true, label: "live-script-button", rect: openLiveHit.rect, center: openLiveHit.center, firstLiveHitFail };
  }
  check("live.open-reader-click", openLiveClick.ok, openLiveClick);

  const subtitleSettledA = await waitFor("live subtitle fetch settled", async () => {
    return page.cdp.evaluate(`(() => {
      const view = document.getElementById("biliscript-reading-view");
      if (!view?.classList.contains("open")) return false;
      const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
      const empty = document.querySelector("#biliscript-reading-subtitle .biliscript-reading-empty")?.textContent || "";
      const notice = document.getElementById("biliscript-reading-subtitle-notice")?.textContent || "";
      const meta = document.getElementById("biliscript-reading-meta")?.textContent || "";
      const opts = (document.getElementById("biliscript-reading-subtitle-select")?.options || []).length;
      if (items > 0) {
        return {
          settled: true,
          items,
          meta,
          opts,
          firstLine: document.querySelector("#biliscript-reading-subtitle .biliscript-reading-text")?.textContent || ""
        };
      }
      if ((empty && !/正在加载字幕/.test(empty)) || notice) {
        return { settled: true, items: 0, meta, opts, empty, notice };
      }
      return false;
    })()`);
  }, { timeoutMs: 50000, intervalMs: 500 });

  const preCcNet = liveNet.slice(beforeOpenNetIdx);
  const gtReqsA = preCcNet.filter((e) => e.phase === "request" && e.kind === "get_transcript");
  const gtRespsA = preCcNet.filter((e) => e.phase === "response" && e.kind === "get_transcript");
  const ttReqsA = preCcNet.filter((e) => e.phase === "request" && e.kind === "timedtext");
  const extTtReqsA = ttReqsA.filter((e) => e.hasFmtJson3 && !e.webHeaders?.visitorId);
  const hasWebHeadersOnGt = gtReqsA.every(
    (r) => r.webHeaders?.clientName && r.webHeaders?.clientVersion && r.webHeaders?.origin
  );

  let ccRetry = null;
  if (subtitleSettledA?.items === 0) {
    const ccBtn = await page.cdp.evaluate(`(() => {
      const b = document.querySelector("#movie_player .ytp-subtitles-button");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { pressed: b.getAttribute("aria-pressed"), disabled: b.disabled, w: r.width, h: r.height };
    })()`);
    if (ccBtn && !ccBtn.disabled && ccBtn.w > 0 && ccBtn.h > 0) {
      const clicks = ccBtn.pressed === "true" ? 2 : 1;
      for (let i = 0; i < clicks; i += 1) {
        await clickInTarget(page.cdp, null, `native-cc-toggle-${i + 1}`, "document.querySelector('#movie_player .ytp-subtitles-button')");
        await sleep(1200);
      }
    }
    const observedPotAfterCc = await page.cdp.evaluate(
      `performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/timedtext") && e.name.includes("pot=")).map((e) => e.name.slice(0, 180))`
    );
    const beforeRetryNetIdx = liveNet.length;
    const retryClick = await clickInTarget(
      page.cdp,
      null,
      "subtitle-retry-fetch",
      "document.querySelector('#biliscript-reading-subtitle [data-subtitle-action=\"retry-fetch\"]')"
    );
    let afterRetry = null;
    if (retryClick.ok) {
      let sawRetryStart = false;
      afterRetry = await waitFor("retry subtitle settled", async () => {
        const snap = await page.cdp.evaluate(`(() => {
          const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
          const empty = document.querySelector("#biliscript-reading-subtitle .biliscript-reading-empty")?.textContent || "";
          const notice = document.getElementById("biliscript-reading-subtitle-notice")?.textContent || "";
          const hasRetryBtn = Boolean(document.querySelector('#biliscript-reading-subtitle [data-subtitle-action="retry-fetch"]'));
          if (items > 0) {
            return {
              items,
              firstLine: document.querySelector("#biliscript-reading-subtitle .biliscript-reading-text")?.textContent || ""
            };
          }
          return {
            items: 0,
            empty,
            notice,
            hasRetryBtn,
            loading: /正在加载|正在抓取/.test(empty) || !hasRetryBtn
          };
        })()`);
        if (snap.items > 0) return snap;
        const delta = liveNet.slice(beforeRetryNetIdx).filter((e) => e.phase === "request");
        if (snap.loading || delta.length > 0) sawRetryStart = true;
        if (sawRetryStart && !snap.loading && snap.empty) {
          return {
            items: 0,
            empty: snap.empty,
            notice: snap.notice,
            retryReqs: delta.map((r) => ({ kind: r.kind, hasPot: r.hasPot }))
          };
        }
        return false;
      }, { timeoutMs: 40000, intervalMs: 250 }).catch((err) => ({ timeout: err.message }));
    }
    ccRetry = { ccBtn, observedPotAfterCc, retryClick, afterRetry };
  }

  const circuitBreakerOk =
    subtitleSettledA?.items > 0 ||
    (gtReqsA.length <= 2 &&
      extTtReqsA.length <= 2 &&
      (gtReqsA.length === 0 || hasWebHeadersOnGt) &&
      /原生.*字幕开关/.test(`${subtitleSettledA?.notice || ""} ${subtitleSettledA?.empty || ""}`));

  check(
    "live.3-subtitle-tiers-and-fast-circuit-breaker",
    Boolean(circuitBreakerOk),
    {
      items: subtitleSettledA?.items ?? 0,
      ttCount: extTtReqsA.length,
      totalTtCount: ttReqsA.length,
      gtCount: gtReqsA.length,
      gtStatuses: gtRespsA.map((r) => r.status),
      hasWebHeadersOnGt,
      notice: subtitleSettledA?.notice || "",
      ccRetry
    }
  );

  const liveFrameProbe = await page.cdp.evaluate(`(() => {
    const v = document.querySelector("#movie_player video");
    if (!v) return { status: "no-video" };
    v.pause();
    if (v.readyState < 2 || v.videoWidth <= 0 || v.videoHeight <= 0) {
      return { status: "unbuffered", readyState: v.readyState, networkState: v.networkState, vw: v.videoWidth, vh: v.videoHeight, pausedAfter: v.paused };
    }
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const c = document.createElement("canvas");
    c.width = Math.min(320, vw);
    c.height = Math.round((c.width * vh) / vw);
    const ctx = c.getContext("2d");
    try {
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const px = [...ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data];
      const jpeg = c.toDataURL("image/jpeg", 0.72);
      return { status: "captured", ok: true, vw, vh, px, jpegLen: jpeg.length, pausedAfter: v.paused };
    } catch (error) {
      return { status: "tainted", ok: false, error: String(error?.message || error), pausedAfter: v.paused };
    } finally {
      v.pause();
    }
  })()`);
  await pauseAndCleanMedia(page.cdp, false);
  check(
    "live.4-video-canvas-drawimage-probe",
    liveFrameProbe?.status === "unbuffered" || Boolean(liveFrameProbe?.ok && liveFrameProbe.jpegLen > 100 && liveFrameProbe.pausedAfter === true),
    liveFrameProbe
  );

  const preSpaUi = await page.cdp.evaluate(`(() => ({
    items: document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length,
    empty: document.querySelector("#biliscript-reading-subtitle .biliscript-reading-empty")?.textContent || ""
  }))()`);
  const netIdxBeforeSpa = liveNet.length;
  const spaTrigger = await page.cdp.evaluate(`(() => {
    const nextBtn = document.querySelector("#movie_player a.ytp-next-button[href*='/watch?v=']");
    const relatedLink = [...document.querySelectorAll("#related a[href*='/watch?v='], ytd-watch-next-secondary-results-renderer a[href*='/watch?v=']")].find((a) => {
      const href = a.getAttribute("href") || "";
      return /\\/watch\\?v=([A-Za-z0-9_-]{11})/.test(href) && !href.includes(${JSON.stringify(LIVE_VIDEO_A.videoId)});
    });
    const target = nextBtn || relatedLink;
    if (target) {
      const href = target.getAttribute("href") || "";
      target.click();
      return { via: nextBtn ? "ytp-next-button" : "related-link", href };
    }
    history.pushState({}, "", ${JSON.stringify(LIVE_VIDEO_B.url)});
    window.dispatchEvent(new PopStateEvent("popstate"));
    return { via: "history-pushState", href: ${JSON.stringify(LIVE_VIDEO_B.url)} };
  })()`);

  const spaStateReset = await waitFor("SPA URL and clip reset", async () => {
    return page.cdp.evaluate(`(() => {
      if (location.href.includes(${JSON.stringify(LIVE_VIDEO_A.videoId)})) return false;
      const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
      const meta = document.getElementById("biliscript-reading-meta")?.textContent || "";
      const empty = document.querySelector("#biliscript-reading-subtitle .biliscript-reading-empty")?.textContent || "";
      if (items > 0 && empty === "") return false;
      return { href: location.href, items, meta, empty };
    })()`).catch(() => false);
  }, { timeoutMs: 25000, intervalMs: 200 }).catch(() => null);

  let sawSpaLoading = false;
  let sawSpaCleared = false;
  let spaRetried = false;
  let lastSpaDebug = null;
  const spaFetchSettled = await waitFor("SPA new video fetch triggered and settled", async () => {
    const reqsAfter = liveNet.slice(netIdxBeforeSpa).filter((e) => e.phase === "request");
    const ui = await page.cdp.evaluate(`(() => {
      const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
      const empty = document.querySelector("#biliscript-reading-subtitle .biliscript-reading-empty")?.textContent || "";
      const notice = document.getElementById("biliscript-reading-subtitle-notice")?.textContent || "";
      const meta = document.getElementById("biliscript-reading-meta")?.textContent || "";
      const opts = (document.getElementById("biliscript-reading-subtitle-select")?.options || []).length;
      const mpId = document.getElementById("movie_player")?.getPlayerResponse?.()?.videoDetails?.videoId || "";
      const hasRetry = Boolean(document.querySelector('#biliscript-reading-subtitle [data-subtitle-action="retry-fetch"]'));
      const loading = /正在加载|正在抓取/.test(empty);
      const settled = items > 0 || (empty && !loading);
      return { settled, loading, items, empty, notice, meta, opts, mpId, hasRetry };
    })()`);
    lastSpaDebug = { ...ui, reqsAfterCount: reqsAfter.length, sawSpaLoading, sawSpaCleared, spaRetried };
    if (ui?.items === 0 && (preSpaUi.items > 0 || ui.loading || ui.empty !== preSpaUi.empty || reqsAfter.length > 0)) {
      sawSpaCleared = true;
    }
    if (ui?.loading || reqsAfter.length > 0) sawSpaLoading = true;
    if (!spaRetried && ui?.empty?.includes("字幕加载失败") && ui?.mpId && ui.mpId !== LIVE_VIDEO_A.videoId && ui?.hasRetry) {
      spaRetried = true;
      await clickInTarget(page.cdp, null, "spa-retry-after-proxy-hydrate", "document.querySelector('#biliscript-reading-subtitle [data-subtitle-action=\"retry-fetch\"]')").catch(() => {});
      return false;
    }
    const switchedOutOfOldEmpty = !ui?.empty?.includes("字幕加载失败") && (reqsAfter.length > 0 || (sawSpaLoading && ui?.mpId !== LIVE_VIDEO_A.videoId));
    if (sawSpaCleared && ui?.settled && (switchedOutOfOldEmpty || (spaRetried && reqsAfter.length > 0))) {
      return { reqsAfterCount: reqsAfter.length, reqKinds: reqsAfter.map((r) => r.kind), sawSpaLoading, sawSpaCleared, spaRetried, ui };
    }
    return false;
  }, { timeoutMs: 75000, intervalMs: 150 }).catch(() => null);

  await pauseAndCleanMedia(page.cdp, false);
  check(
    "live.2-spa-navigation-resets-and-fetches",
    Boolean(spaTrigger?.href && spaStateReset?.href && spaFetchSettled),
    { spaTrigger, spaStateReset, spaFetchSettled, lastSpaDebug }
  );

  evidence.live = {
    snapshotA,
    subtitleSettledA,
    ccRetry,
    liveFrameProbe,
    spaTrigger,
    spaStateReset,
    spaFetchSettled,
    netLogSample: liveNet.slice(0, 80)
  };
}

async function main() {
  const fixtureOk = selfCheckFixtures();
  const browser = await launchBrowser({
    headless: !headed,
    distDir: DEFAULT_DIST,
    autoplay: false,
    muted: true
  });
  const cdps = [];
  let page = null;
  let browserCdp = null;
  let tracker = null;

  const evidence = {
    meta: {
      startedAt: new Date().toISOString(),
      scenario: NAME,
      distDir: DEFAULT_DIST,
      viewport: VIEWPORT,
      headed,
      fixtureOnly,
      browser: browser.version?.Browser || null
    },
    fixtureSelfCheck: fixtureOk,
    checks
  };

  try {
    page = await attachPage(browser, { viewport: VIEWPORT });
    cdps.push(page.cdp);
    const watcher = watchPage(page.cdp);
    evidence.consoleErrors = watcher.consoleLog.filter((entry) => /error/i.test(entry.type));

    browserCdp = await CDP.connect(browser.version?.webSocketDebuggerUrl);
    cdps.push(browserCdp);

    tracker = createChildTargetTracker(browserCdp, page.target.id || page.target.targetId);
    await tracker.init();

    const worker = createWorkerSession({
      pageCdp: page.cdp,
      browser,
      distDir: DEFAULT_DIST
    });
    const workerUp = await worker.ensureAlive();
    if (!workerUp) throw new Error("扩展 SW 连接失败");
    cdps.push(worker.handle.cdp);

    await runOfflineSuite({ page, browserCdp, tracker, worker, evidence });

    if (!fixtureOnly) {
      await runLiveSuite({ page, worker, evidence });
    }
  } catch (error) {
    check("scenario-unhandled-error", false, {
      message: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 600)
    });
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
    evidence.profileRemoved = browser.profileRemoved ?? null;
    evidence.failed = checks.filter((c) => !c.ok).map((c) => c.name);
    evidence.ok = evidence.failed.length === 0 && checks.length > 0;
    await writeEvidence(OUT_DIR, evidence);
    if (!evidence.ok) {
      process.exitCode = 1;
    }
  }
}

await main();
