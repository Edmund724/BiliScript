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
  teardown,
  waitFor,
  watchPage,
  writeEvidence
} from "../harness.mjs";

const NAME = "detached-reader-window";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const BUNDLES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bundles.json"), "utf8"));
const BODIES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bodies.json"), "utf8"));

const VIDEO_BVID = "BV1mAam6tEL8";
const VIDEO_AID = 117370433574328;
const VIDEO_CID_P1 = 42393338874;
const VIDEO_CID_P2 = 42393338875;
const VIDEO_URL_P1 = `https://www.bilibili.com/video/${VIDEO_BVID}/?p=1`;
const VIDEO_URL_P2 = `https://www.bilibili.com/video/${VIDEO_BVID}/?p=2`;
const SAMPLE_WEBM_URL = "https://www.bilibili.com/__fixture__/sample.webm";
const SAMPLE_WEBM_B64 =
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBlk27i1OrhBZUrmtTrIHLTbuMU6uEElTDZ1OsggEY7AEAAAAAAABdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZrAq17GDD0JATYCMTGF2ZjYzLjEuMTAyV0GMTGF2ZjYzLjEuMTAyRImIQM1MAAAAAAAWVK5ryK4BAAAAAAAAP9eBAXPFiEAGnpy++JISnIEAIrWcg3VuZIiBAIaFVl9WUDiDgQEj44OEHc1lAOCQsIFAuoFAmoECVbCEVbmBARJUw2fWc3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2My4xLjEwMnNzsWPAi2PFiEAGnpy++JISZ8igRaOHRU5DT0RFUkSHk0xhdmM2My4xLjEwMiBsaWJ2cHgfQ7Z19+eBAKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLnggXco5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454ILuKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLnghGUo5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454IXcKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLngh1Mo5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454IjKKOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLngikEo5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAB9DtnX454Iu4KOsgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/ab2JeACjloEB9ADRAQAFEKwAGAAYWC/0AAiOgACjrIED6IDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/2m9iXgAH0O2deLngjS8o5aBAAAA0QEABRCsABgAGFgv9AAIjoAAo6yBAfSA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v9pvYl4AKOWgQPoANEBAAUQrAAYABhYL/QACI6AAA==";

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

const { headed, distDir } = parseCliArgs(process.argv.slice(2));
const checks = [];
const cdps = [];

function check(name, ok, detail = null) {
  const entry = { name, ok: Boolean(ok), detail };
  checks.push(entry);
  log(`${entry.ok ? "PASS" : "FAIL"}  ${name}${detail === null ? "" : `  ${JSON.stringify(detail).slice(0, 320)}`}`);
  return entry.ok;
}

function buildBilibiliHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BiliScript 独立窗口真机验收</title>
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
    <div id="playerWrap"><div id="bilibili-player"><div class="bpx-player-container" data-screen="normal"><div class="bpx-player-video-wrap"><video preload="auto" playsinline crossorigin="anonymous" src="${SAMPLE_WEBM_URL}"></video></div><div class="bpx-player-control-bottom-right"><button type="button" class="bpx-player-ctrl-quality">1080P</button></div></div></div></div>
    <div id="arc_toolbar_report" class="video-toolbar-container">
      <div class="video-toolbar-left"><span>点赞</span><span>投币</span><span>收藏</span></div>
      <div class="video-toolbar-right"><span class="video-complaint">稿件举报</span></div>
    </div>
  </div>
  <div class="right-container"><div class="right-container-inner">相关推荐占位区</div></div>
</div></body></html>`;
}

function viewResponse(pageIndex = 1) {
  return {
    code: 0,
    message: "0",
    data: {
      aid: VIDEO_AID,
      bvid: VIDEO_BVID,
      cid: pageIndex === 2 ? VIDEO_CID_P2 : VIDEO_CID_P1,
      title: "独立窗口真机验收视频",
      desc: "离线 fixture 视频",
      duration: 15,
      pubdate: 1767225600,
      owner: { name: "fixture" },
      pages: [
        { cid: VIDEO_CID_P1, page: 1, part: "第一分 P", duration: 15 },
        { cid: VIDEO_CID_P2, page: 2, part: "第二分 P", duration: 15 }
      ]
    }
  };
}

function playerResponse(pageIndex = 1) {
  const source = BUNDLES[VIDEO_BVID];
  const isP2 = pageIndex === 2;
  const cid = isP2 ? VIDEO_CID_P2 : VIDEO_CID_P1;
  const zhUrl = isP2
    ? `https://aisubtitle.hdslb.com/bfs/ai_subtitle/walkthrough-fixture/${VIDEO_BVID}-p2-zh.json`
    : `https://aisubtitle.hdslb.com/bfs/ai_subtitle/walkthrough-fixture/${VIDEO_BVID}-zh.json`;
  const subtitles = source.data.subtitle.subtitles.slice(0, 2).map((sub, idx) =>
    idx === 0 ? { ...sub, subtitle_url: zhUrl, subtitle_url_v2: zhUrl } : sub
  );
  return {
    ...source,
    data: {
      ...source.data,
      aid: VIDEO_AID,
      bvid: VIDEO_BVID,
      cid,
      subtitle: {
        ...source.data.subtitle,
        subtitles
      }
    }
  };
}

function clipFixtureSubtitleBody(raw) {
  const slice = (raw?.body || []).slice(0, 20);
  const maxTo = Math.max(1, Number(slice.at(-1)?.to || slice.at(-1)?.from || 15));
  const scale = maxTo > 14.5 ? 14.5 / maxTo : 1;
  return {
    ...raw,
    body: slice.map((item) => ({
      ...item,
      from: Number((Number(item.from || 0) * scale).toFixed(3)),
      to: Number((Number(item.to || 0) * scale).toFixed(3))
    }))
  };
}

function subtitleBodyForUrl(url) {
  const baseZh = clipFixtureSubtitleBody(BODIES[`${VIDEO_BVID}-zh`]);
  if (url.includes(`${VIDEO_BVID}-p2-zh.json`)) {
    return {
      ...baseZh,
      body: baseZh.body.map((item, index) =>
        index === 0 ? { ...item, content: "第二分P首段：SPA切P后保留独立窗口" } : item
      )
    };
  }
  if (url.includes(`${VIDEO_BVID}-en.json`)) {
    return clipFixtureSubtitleBody(BODIES[`${VIDEO_BVID}-en`]);
  }
  return baseZh;
}

function installPageFixtures(page) {
  const { cdp } = page;
  return cdp
    .send("Fetch.enable", {
      patterns: [{ urlPattern: "https://www.bilibili.com/*", requestStage: "Request" }]
    })
    .then(() => {
      cdp.on("Fetch.requestPaused", async (params) => {
        const url = params.request?.url || "";
        try {
          if (url.startsWith(SAMPLE_WEBM_URL)) {
            await cdp.send("Fetch.fulfillRequest", {
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
          if (params.resourceType === "Document") {
            await cdp.send("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: 200,
              responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
              body: Buffer.from(buildBilibiliHtml()).toString("base64")
            });
            return;
          }
          await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
        } catch {}
      });
    });
}

function installWorkerFixtures(handle) {
  const { cdp, sessionId } = handle;
  return cdp
    .send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId)
    .then(() => {
      cdp.on("Fetch.requestPaused", async (params) => {
        const url = params.request?.url || "";
        const requestId = params.requestId;
        try {
          if (/x\/web-interface\/view/.test(url)) {
            const p = new URL(url).searchParams.get("p") === "2" ? 2 : 1;
            await cdp.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [{ name: "content-type", value: "application/json" }],
                body: Buffer.from(JSON.stringify(viewResponse(p))).toString("base64")
              },
              sessionId
            );
            return;
          }
          if (/x\/player\/(?:wbi\/)?v2/.test(url)) {
            const cid = Number(new URL(url).searchParams.get("cid") || 0);
            const p = cid === VIDEO_CID_P2 ? 2 : 1;
            await cdp.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [{ name: "content-type", value: "application/json" }],
                body: Buffer.from(JSON.stringify(playerResponse(p))).toString("base64")
              },
              sessionId
            );
            return;
          }
          if (url.includes("walkthrough-fixture/")) {
            await cdp.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [{ name: "content-type", value: "application/json" }],
                body: Buffer.from(JSON.stringify(subtitleBodyForUrl(url))).toString("base64")
              },
              sessionId
            );
            return;
          }
          if (url.includes("/chat/completions")) {
            const body = JSON.parse(params.request?.postData || "{}");
            const prompt = JSON.stringify(body.messages || []);
            const content =
              prompt.includes("chapters") || prompt.includes("关键原话") || prompt.includes("整理这期视频")
                ? JSON.stringify({
                    summary: "离线概览摘要",
                    chapters: [{ from: 0, to: 12, title: "第一章：独立窗口概览", summary: "验证章节时间戳与概览" }],
                    keyQuotes: [{ from: 2, content: "独立窗口中的金句卡片验证。" }]
                  })
                : "离线解释与对话回复：验证独立窗口交互。";
            const stream = [
              `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
              "data: [DONE]\n\n"
            ].join("");
            await cdp.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
                body: Buffer.from(stream).toString("base64")
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

async function hitTestInTarget(cdp, sessionId, label, locateExpr) {
  return cdp.evaluate(
    `(async () => {
      const el = ${locateExpr};
      if (!el) return { ok: false, label: ${JSON.stringify(label)}, reason: "not-found" };
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const nextFrame = () => new Promise((res) => {
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
        setTimeout(finish, 34);
      });
      let r = el.getBoundingClientRect();
      for (let i = 0; i < 30; i += 1) {
        await nextFrame();
        const nr = el.getBoundingClientRect();
        const settled =
          Math.abs(nr.left - r.left) <= 0.25 &&
          Math.abs(nr.top - r.top) <= 0.25 &&
          Math.abs(nr.width - r.width) <= 0.25 &&
          Math.abs(nr.height - r.height) <= 0.25;
        r = nr;
        if (settled && nr.width > 0 && nr.height > 0) break;
      }
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        ok: r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh && !!hit && (hit === el || el.contains(hit)),
        label: ${JSON.stringify(label)},
        rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        center: { x: +cx.toFixed(1), y: +cy.toFixed(1) },
        viewport: { vw, vh },
        hitTag: hit ? hit.tagName + "." + String(hit.className || "").slice(0, 40) : null
      };
    })()`,
    { sessionId: sessionId || undefined }
  );
}

async function dispatchPointerClick(cdp, sessionId, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 }, sessionId);
}

async function clickInTarget(cdp, sessionId, label, locateExpr) {
  const info = await hitTestInTarget(cdp, sessionId, label, locateExpr);
  if (!info?.ok) return { ok: false, ...info };
  await dispatchPointerClick(cdp, sessionId, info.center.x, info.center.y);
  return { ok: true, label, rect: info.rect, center: info.center };
}

async function pressKeyInTarget(cdp, sessionId, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, sessionId);
}

async function captureTargetPng(cdp, sessionId, filename) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, sessionId);
  const outFile = path.join(OUT_DIR, filename);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, Buffer.from(res.data, "base64"));
  log(`截图 ${path.relative(REPO_ROOT, outFile)}`);
  return outFile;
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
    if (params.waitingForDebugger) {
      void browserCdp.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
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
    let lastDebug = null;
    return waitFor(
      label,
      async () => {
        const res = await browserCdp.send("Target.getTargets").catch((e) => ({ targetInfos: [], err: String(e?.message || e) }));
        const seen = [];
        for (const info of res.targetInfos || []) {
          if (info.type === "page") {
            seen.push({ id: info.targetId, url: info.url, openerId: info.openerId || "" });
          }
          if (
            !info.targetId ||
            info.targetId === openerTargetId ||
            prevIds.has(info.targetId) ||
            initialTargetIds.has(info.targetId)
          ) {
            continue;
          }
          if (info.type === "service_worker" || info.type === "background_page" || info.type === "browser") {
            continue;
          }
          const url = String(info.url || "");
          if (url.startsWith("chrome-extension://")) continue;
          const isChildMatch =
            (openerTargetId && info.openerId === openerTargetId) ||
            (info.type === "page" && (url === "about:blank" || url === ""));
          if (!targets.has(info.targetId) && isChildMatch) {
            try {
              const attached = await browserCdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
              const existing = targets.get(info.targetId);
              if (!existing || existing.sessionId !== attached.sessionId) {
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
                await browserCdp.send("Log.enable", {}, attached.sessionId).catch(() => {});
              }
            } catch (e) {
              lastDebug = { attachErr: String(e?.message || e), seen };
            }
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
            lastDebug = { targetId: item.targetId, hasView, seen };
          } catch (e) {
            lastDebug = { targetId: item.targetId, evalErr: String(e?.message || e), seen };
          }
        }
        if (!lastDebug) lastDebug = { seen };
        return null;
      },
      { timeoutMs: 12000, intervalMs: 150 }
    ).catch((err) => {
      throw new Error(`${err.message} debug=${JSON.stringify(lastDebug)}`);
    });
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

async function readThemeTokens(cdp, sessionId) {
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
      const out = {
        surface: readVar("--biliscript-reader-surface", "backgroundColor"),
        text: readVar("--biliscript-reader-text", "color"),
        accent: readVar("--biliscript-reader-accent", "backgroundColor"),
        border: readVar("--biliscript-reader-border", "borderTopColor")
      };
      probe.remove();
      return out;
    })()`,
    { sessionId: sessionId || undefined }
  );
}

async function sendTabMessageFromWorker(worker, message) {
  return worker.evaluate(
    `(async () => {
      const tabs = await chrome.tabs.query({ url: "*://www.bilibili.com/video/*" });
      if (!tabs.length) return { ok: false, error: "no-bilibili-tab" };
      const targetTab = tabs[0];
      return chrome.tabs.sendMessage(targetTab.id, ${JSON.stringify(message)});
    })()`
  );
}

async function main() {
  const browser = await launchBrowser({
    headless: !headed,
    distDir,
    autoplay: true,
    muted: true
  });
  let page = null;
  let browserCdp = null;
  let tracker = null;

  const evidence = {
    name: NAME,
    headed,
    distDir,
    browser: browser.version?.Browser || null,
    timestamp: new Date().toISOString(),
    checks,
    notes: {}
  };

  try {
    page = await attachPage(browser, { viewport: DEFAULT_VIEWPORT });
    cdps.push(page.cdp);
    const watcher = watchPage(page.cdp);
    const exceptions = [];
    page.cdp.on("Runtime.exceptionThrown", (params) => {
      exceptions.push({ text: params.exceptionDetails?.text, desc: params.exceptionDetails?.exception?.description?.slice(0, 300) });
    });
    evidence.notes.watcher = watcher;
    evidence.notes.exceptions = exceptions;

    const versionWs = browser.version?.webSocketDebuggerUrl;
    browserCdp = await CDP.connect(versionWs);
    cdps.push(browserCdp);

    tracker = createChildTargetTracker(browserCdp, page.target.id || page.target.targetId);
    await tracker.init();

    const worker = createWorkerSession({
      pageCdp: page.cdp,
      browser,
      distDir,
      onReconnect: installWorkerFixtures
    });
    await worker.connect();
    await installWorkerFixtures(worker.handle);

    await worker.evaluate(
      `(async () => {
        await chrome.storage.sync.set({
          detachedWindowMode: "pip",
          enableDebugLogs: false
        });
        await chrome.storage.local.remove("biliscript_detached_window_bounds_v1");
        return true;
      })()`
    );

    await installPageFixtures(page);
    await page.cdp.send("Page.bringToFront").catch(() => {});
    await page.cdp.send("Page.navigate", { url: VIDEO_URL_P1 });

    await waitFor("opener video ready", async () => {
      const state = await page.cdp.evaluate(`(() => {
        const v = document.querySelector("video");
        return {
          visible: document.visibilityState === "visible",
          ready: Boolean(v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 5)
        };
      })()`);
      if (state && !state.visible) {
        await page.cdp.send("Page.bringToFront").catch(() => {});
        return false;
      }
      return Boolean(state?.ready);
    });
    await page.cdp.evaluate(`(() => {
      const v = document.querySelector("video");
      if (v) { v.pause(); v.currentTime = 0; }
    })()`);

    await waitFor("script button mounted", async () =>
      page.cdp.evaluate("Boolean(document.getElementById('biliscript-script-button'))")
    );
    await worker.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("onboarding.html") });
      const ids = tabs.map((t) => t.id).filter((id) => typeof id === "number");
      if (ids.length) await chrome.tabs.remove(ids);
      return ids.length;
    })()`).catch(() => {});
    await page.cdp.send("Page.bringToFront").catch(() => {});
    const openClick = await clickInTarget(
      page.cdp,
      null,
      "script-button",
      "document.getElementById('biliscript-script-button')"
    );
    check("boot-open-reader", openClick.ok, openClick);

    await waitFor("reader open & subtitles ready", async () =>
      page.cdp.evaluate(`(() => {
        const v = document.getElementById("biliscript-reading-view");
        const detach = document.getElementById("biliscript-reading-detach-btn");
        const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
        return Boolean(v && v.classList.contains("open") && v.getAttribute("data-biliscript-reader-ready") === "1" && detach && items >= 3);
      })()`)
    );

    await page.cdp.evaluate("window.__biliscriptShellRef = document.getElementById('biliscript-reading-view');");
    const openerTokens = await readThemeTokens(page.cdp, null);

    const beforeD1 = tracker.snapshotActiveIds();
    await page.cdp.send("Page.bringToFront").catch(() => {});
    const detachClick = await clickInTarget(
      page.cdp,
      null,
      "detach-btn-pip",
      "document.getElementById('biliscript-reading-detach-btn')"
    );
    if (!detachClick?.ok) {
      throw new Error(`D1 detachClick failed: ${JSON.stringify(detachClick)}`);
    }
    const postClickSnap = await page.cdp.evaluate(`(() => ({
      notice: document.getElementById("biliscript-reading-detached-notice")?.textContent || "",
      hasFocus: document.hasFocus(),
      visible: document.visibilityState,
      active: Boolean(navigator.userActivation?.isActive),
      hasBeenActive: Boolean(navigator.userActivation?.hasBeenActive)
    }))()`).catch(() => null);
    const pipChild = await tracker.waitForNewDetachedTarget(beforeD1, "D1 pip detached target").catch(async (err) => {
      const diag = await page.cdp.evaluate(`(() => ({
        visible: document.visibilityState,
        hasFocus: document.hasFocus(),
        hasPipWin: Boolean(window.documentPictureInPicture?.window),
        notice: document.getElementById("biliscript-reading-detached-notice")?.textContent || "",
        settingsHidden: document.getElementById("biliscript-reading-settings-panel")?.hidden,
        viewOpen: Boolean(document.getElementById("biliscript-reading-view")?.classList.contains("open"))
      }))()`).catch(() => null);
      throw new Error(`${err.message} detachClick=${JSON.stringify(detachClick)} postClickSnap=${JSON.stringify(postClickSnap)} openerDiag=${JSON.stringify(diag)}`);
    });

    const openerAfterD1 = await page.cdp.evaluate(`(() => ({
      hasPipWindow: Boolean(window.documentPictureInPicture && window.documentPictureInPicture.window),
      viewStillInOpener: Boolean(document.getElementById("biliscript-reading-view")),
      readerModeAttr: document.documentElement.getAttribute("data-biliscript-reader-mode")
    }))()`);

    const childD1 = await browserCdp.evaluate(
      `(() => {
        const view = document.getElementById("biliscript-reading-view");
        const actions = Array.from(document.querySelectorAll(".biliscript-reading-actions > button")).map((b) => b.id);
        const detachBtn = document.getElementById("biliscript-reading-detach-btn");
        const closeBtn = document.getElementById("biliscript-reading-close-btn");
        const themeBtn = document.getElementById("biliscript-reading-theme-select");
        const settingsBtn = document.getElementById("biliscript-reading-settings-btn");
        const detachHidden = Boolean(detachBtn?.hidden) && getComputedStyle(detachBtn).display === "none";
        const closeHidden = Boolean(closeBtn?.hidden) && getComputedStyle(closeBtn).display === "none";
        const themeHidden = Boolean(themeBtn?.hidden) || getComputedStyle(themeBtn).display === "none";
        const settingsHidden = Boolean(settingsBtn?.hidden) || getComputedStyle(settingsBtn).display === "none";
        const extLinks = Array.from(document.querySelectorAll('link[data-biliscript-style="1"], link[rel="stylesheet"][href^="chrome-extension://"]'));
        const styleEls = Array.from(document.head.querySelectorAll('style[data-biliscript-style="1"]')).map((s) => ({
          path: s.getAttribute("data-biliscript-style-path"),
          loaded: Boolean(s.sheet)
        }));
        const adoptedCount = Array.isArray(document.adoptedStyleSheets) ? document.adoptedStyleSheets.length : 0;
        const docEl = document.documentElement;
        return {
          open: Boolean(view && view.classList.contains("open") && !view.hidden),
          actions,
          detachHidden,
          closeHidden,
          themeHidden,
          settingsHidden,
          extLinkCount: extLinks.length,
          adoptedCount,
          styleEls,
          allLinksLoaded:
            extLinks.length === 0 &&
            (adoptedCount >= 3 || (styleEls.length >= 3 && styleEls.every((s) => s.loaded))),
          scrollWidth: docEl.scrollWidth,
          clientWidth: docEl.clientWidth,
          overflowX: docEl.scrollWidth > docEl.clientWidth + 1,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight
        };
      })()`,
      { sessionId: pipChild.sessionId }
    );
    const childD1Tokens = await readThemeTokens(browserCdp, pipChild.sessionId);
    const tokensMatch =
      Boolean(openerTokens && childD1Tokens) &&
      openerTokens.surface === childD1Tokens.surface &&
      openerTokens.text === childD1Tokens.text &&
      openerTokens.accent === childD1Tokens.accent;

    check(
      "D1-pip-popout-cssom-bounds-header",
      detachClick.ok &&
        openerAfterD1.hasPipWindow &&
        !openerAfterD1.viewStillInOpener &&
        openerAfterD1.readerModeAttr === "1" &&
        childD1.open &&
        childD1.actions.length === 4 &&
        childD1.detachHidden &&
        childD1.closeHidden &&
        !childD1.themeHidden &&
        !childD1.settingsHidden &&
        childD1.allLinksLoaded &&
        tokensMatch &&
        !childD1.overflowX &&
        childD1.innerWidth >= 360 &&
        childD1.innerHeight >= 420,
      { openerAfterD1, childD1, tokensMatch }
    );
    await captureTargetPng(browserCdp, pipChild.sessionId, "01-d1-pip-detached.png").catch(() => {});

    await browserCdp.evaluate("window.focus()", { sessionId: pipChild.sessionId });
    const focusClick = await clickInTarget(
      browserCdp,
      pipChild.sessionId,
      "focus-detached-header",
      "document.querySelector('.biliscript-reading-header')"
    );
    await waitFor(
      "child window hasFocus",
      async () => browserCdp.evaluate("document.hasFocus()", { sessionId: pipChild.sessionId }),
      { timeoutMs: 5000, intervalMs: 100 }
    ).catch(() => false);

    const openPaletteTry = await (async () => {
      await pressKeyInTarget(browserCdp, pipChild.sessionId, {
        key: "k",
        code: "KeyK",
        windowsVirtualKeyCode: 75,
        modifiers: 2
      });
      const opened = await waitFor(
        "command palette open",
        async () =>
          browserCdp.evaluate(
            `(() => {
              const dlg = document.getElementById("biliscript-command-palette");
              return Boolean(dlg && (dlg.open || dlg.hasAttribute("open")));
            })()`,
            { sessionId: pipChild.sessionId }
          ),
        { timeoutMs: 4000, intervalMs: 100 }
      ).catch(() => false);
      await pressKeyInTarget(browserCdp, pipChild.sessionId, {
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27
      });
      return Boolean(opened);
    })();

    const openSettingsTry = await (async () => {
      const btn = await clickInTarget(
        browserCdp,
        pipChild.sessionId,
        "settings-btn",
        "document.getElementById('biliscript-reading-settings-btn')"
      );
      if (!btn.ok) return false;
      const expanded = await waitFor(
        "settings panel open in detached",
        async () =>
          browserCdp.evaluate(
            `(() => {
              const p = document.getElementById("biliscript-reading-settings-panel");
              return Boolean(p && !p.hidden);
            })()`,
            { sessionId: pipChild.sessionId }
          ),
        { timeoutMs: 4000, intervalMs: 100 }
      ).catch(() => false);
      await clickInTarget(
        browserCdp,
        pipChild.sessionId,
        "settings-close",
        "document.getElementById('biliscript-reading-settings-btn')"
      );
      await waitFor(
        "settings panel hidden in D2",
        async () =>
          browserCdp.evaluate(
            "Boolean(document.getElementById('biliscript-reading-settings-panel')?.hidden && !document.querySelector('[data-biliscript-settings-motion]'))",
            { sessionId: pipChild.sessionId }
          ),
        { timeoutMs: 4000, intervalMs: 100 }
      ).catch(() => false);
      return Boolean(expanded);
    })();

    const quoteModalTry = await (async () => {
      const selected = await browserCdp.evaluate(
        `(() => {
          const txt = document.querySelector("#biliscript-reading-subtitle .biliscript-reading-item .biliscript-reading-text");
          if (!txt || !txt.firstChild) return false;
          const r = document.createRange();
          r.selectNodeContents(txt);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          document.dispatchEvent(new Event("selectionchange"));
          txt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return true;
        })()`,
        { sessionId: pipChild.sessionId }
      );
      if (!selected) return false;
      const popShown = await waitFor(
        "explain pop visible",
        async () =>
          browserCdp.evaluate(
            `(() => {
              const p = document.getElementById("biliscript-reading-explain-pop");
              return Boolean(p && !p.hidden);
            })()`,
            { sessionId: pipChild.sessionId }
          ),
        { timeoutMs: 4000, intervalMs: 100 }
      ).catch(() => false);
      if (!popShown) return false;
      const quoteClick = await clickInTarget(
        browserCdp,
        pipChild.sessionId,
        "quote-card-pill",
        "document.querySelector('#biliscript-reading-explain-pop [data-selection-action=\"quote-card\"]')"
      );
      if (!quoteClick.ok) return false;
      const dialogOpen = await waitFor(
        "quote share dialog open",
        async () =>
          browserCdp.evaluate(
            `(() => {
              const d = document.querySelector(".biliscript-quote-share-dialog");
              return Boolean(d && !d.getAnimations().some((a) => a.playState === "running"));
            })()`,
            { sessionId: pipChild.sessionId }
          ),
        { timeoutMs: 4000, intervalMs: 100 }
      ).catch(() => false);
    const closeClick = await clickInTarget(
        browserCdp,
        pipChild.sessionId,
        "quote-close",
        "document.querySelector('.biliscript-quote-share-close')"
      );
      const quoteClosed = await waitFor(
        "quote share dialog closed",
        async () =>
          browserCdp.evaluate(
            "!document.querySelector('.biliscript-quote-share-host')",
            { sessionId: pipChild.sessionId }
          ),
        { timeoutMs: 4000, intervalMs: 100 }
      ).catch(() => false);
      if (!quoteClosed) {
        const qDiag = await browserCdp.evaluate(`(() => {
          const h = document.querySelector(".biliscript-quote-share-host");
          return {
            closeClick: ${JSON.stringify(closeClick)},
            hasHost: Boolean(h),
            closingAttr: h?.getAttribute("data-biliscript-closing") ?? null,
            anims: h ? h.getAnimations({ subtree: true }).map((a) => ({ playState: a.playState, pending: a.pending })) : []
          };
        })()`, { sessionId: pipChild.sessionId }).catch(() => null);
        throw new Error(`D2 quote share dialog did not close: ${JSON.stringify(qDiag)}`);
      }
      await browserCdp.evaluate(
        "window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));",
        { sessionId: pipChild.sessionId }
      );
      return Boolean(dialogOpen);
    })();

    await browserCdp.evaluate("window.focus()", { sessionId: pipChild.sessionId });
    await page.cdp.evaluate("document.querySelector('video').pause(); document.querySelector('video').currentTime = 0;");
    const seekClick = await clickInTarget(
      browserCdp,
      pipChild.sessionId,
      "subtitle-seek-item",
      "document.querySelector('#biliscript-reading-subtitle .biliscript-reading-item[data-index=\"3\"] .biliscript-reading-time') || document.querySelector('#biliscript-reading-subtitle .biliscript-reading-item[data-index=\"3\"]')"
    );
    const seekResult = await waitFor(
      "opener video seeked without focus theft",
      async () => {
        const videoState = await page.cdp.evaluate(`(() => {
          const v = document.querySelector("video");
          return {
            currentTime: v ? v.currentTime : 0,
            paused: v ? v.paused : true,
            openerFocused: document.hasFocus()
          };
        })()`);
        if (videoState.currentTime >= 4) return videoState;
        return null;
      },
      { timeoutMs: 5000, intervalMs: 100 }
    ).catch(async (err) => {
      const openerSt = await page.cdp.evaluate(`(() => {
        const v = document.querySelector("video");
        return { currentTime: v?.currentTime, readyState: v?.readyState, paused: v?.paused };
      })()`).catch(() => null);
      const childSt = await browserCdp.evaluate(`(() => {
        const item = document.querySelector('#biliscript-reading-subtitle .biliscript-reading-item[data-index="3"]');
        return {
          seconds: item?.dataset?.seconds,
          sel: window.getSelection()?.toString() || "",
          hasFocus: document.hasFocus(),
          explainHidden: document.getElementById("biliscript-reading-explain-pop")?.hidden,
          settingsHidden: document.getElementById("biliscript-reading-settings-panel")?.hidden
        };
      })()`, { sessionId: pipChild.sessionId }).catch(() => null);
      throw new Error(`${err.message} seekClick=${JSON.stringify(seekClick)} openerSt=${JSON.stringify(openerSt)} childSt=${JSON.stringify(childSt)}`);
    });
    const childFocusedAfterSeek = await browserCdp.evaluate("document.hasFocus()", {
      sessionId: pipChild.sessionId
    });
    await page.cdp.evaluate("document.querySelector('video')?.pause();");

    check(
      "D2-overlays-and-seek-without-focus-theft",
      focusClick.ok &&
        openPaletteTry &&
        openSettingsTry &&
        quoteModalTry &&
        seekClick.ok &&
        seekResult.currentTime >= 4 &&
        !seekResult.openerFocused &&
        (headed ? childFocusedAfterSeek === true : true),
      { openPaletteTry, openSettingsTry, quoteModalTry, seekResult, childFocusedAfterSeek, headed }
    );

    let activeDetached = pipChild;
    const beforeD3 = tracker.snapshotActiveIds();
    await clickInTarget(
      browserCdp,
      activeDetached.sessionId,
      "settings-open-for-d3",
      "document.getElementById('biliscript-reading-settings-btn')"
    );
    await waitFor(
      "appearance entry visible",
      async () =>
        browserCdp.evaluate(
          `(() => {
            if (document.querySelector("[data-biliscript-settings-motion]")) return false;
            const p = document.getElementById("biliscript-reading-settings-panel");
            const b = document.getElementById("openAppearanceBtn");
            if (!p || p.hidden || !b) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })()`,
          { sessionId: activeDetached.sessionId }
        ),
      { timeoutMs: 4000, intervalMs: 100 }
    );
    const appearanceClick = await clickInTarget(
      browserCdp,
      activeDetached.sessionId,
      "open-appearance-subpage",
      "document.getElementById('openAppearanceBtn')"
    );
    if (!appearanceClick?.ok) {
      throw new Error(`D3 open-appearance-subpage click failed: ${JSON.stringify(appearanceClick)}`);
    }
    await waitFor(
      "appearance subpage visible",
      async () =>
        browserCdp.evaluate(
          `(() => {
            const p = document.getElementById("biliscriptSettingsSubpageAppearance");
            return Boolean(p && !p.hidden);
          })()`,
          { sessionId: activeDetached.sessionId }
        ),
      { timeoutMs: 4000, intervalMs: 100 }
    );

    const modeUi = await browserCdp.evaluate(
      `(() => {
        const sub = document.getElementById("biliscriptSettingsSubpageAppearance");
        if (!sub) return null;
        const sel =
          sub.querySelector("#detachedWindowMode") ||
          sub.querySelector("select[id*='detached' i]") ||
          Array.from(sub.querySelectorAll(".biliscript-set-row")).find((r) => /独立窗口/.test(r.textContent || ""))?.querySelector("select");
        if (!sel) return null;
        const wrap = sel.closest(".custom-select-wrapper");
        return { id: sel.id, hasCustomSelect: Boolean(wrap) };
      })()`,
      { sessionId: activeDetached.sessionId }
    );

    let modeSwitchedOrNoticed = false;
    let d3Outcome = { modeUi };
    if (modeUi?.hasCustomSelect) {
      await clickInTarget(
        browserCdp,
        activeDetached.sessionId,
        "detached-mode-trigger",
        `document.getElementById(${JSON.stringify(modeUi.id)}).closest('.custom-select-wrapper').querySelector('.custom-select-trigger')`
      );
      await waitFor(
        "detached mode option visible",
        async () =>
          browserCdp.evaluate(
            `Boolean(document.getElementById(${JSON.stringify(modeUi.id)}).closest('.custom-select-wrapper').querySelector('.custom-select-option[data-value="popup"]'))`,
            { sessionId: activeDetached.sessionId }
          ),
        { timeoutMs: 3000, intervalMs: 100 }
      );
      await clickInTarget(
        browserCdp,
        activeDetached.sessionId,
        "detached-mode-popup-option",
        `document.getElementById(${JSON.stringify(modeUi.id)}).closest('.custom-select-wrapper').querySelector('.custom-select-option[data-value="popup"]')`
      );
    } else if (modeUi?.id) {
      await browserCdp.evaluate(
        `(() => {
          const sel = document.getElementById(${JSON.stringify(modeUi.id)});
          if (sel) { sel.value = "popup"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
        })()`,
        { sessionId: activeDetached.sessionId }
      );
    }

    const syncedModeD3 = await waitFor(
      "detachedWindowMode synced to popup",
      async () => {
        const stored = await worker.evaluate("chrome.storage.sync.get('detachedWindowMode')");
        return stored?.detachedWindowMode === "popup" ? stored : null;
      },
      { timeoutMs: 6000, intervalMs: 150 }
    ).catch(() => null);

    const switchedTarget = await tracker.waitForNewDetachedTarget(beforeD3, "D3 popup target").catch(() => null);
    if (switchedTarget) {
      activeDetached = switchedTarget;
      modeSwitchedOrNoticed = true;
      d3Outcome = { ...d3Outcome, switchedInPlace: true, newTargetId: switchedTarget.targetId, syncedModeD3 };
    } else {
      const noticeText = await browserCdp.evaluate(
        `(() => {
          const notice = document.getElementById("biliscript-reading-detached-notice");
          if (notice && !notice.hidden && notice.textContent.trim().length > 0) {
            return notice.textContent.trim();
          }
          const status = document.getElementById("biliscriptSettingsStatus");
          return status ? status.textContent.trim() : "";
        })()`,
        { sessionId: activeDetached.sessionId }
      );
      modeSwitchedOrNoticed = Boolean(syncedModeD3 && noticeText.length > 0 && noticeText !== "已保存");
      d3Outcome = { ...d3Outcome, switchedInPlace: false, noticeText, syncedModeD3 };
    }
    check("D3-cross-window-mode-switch-pip-to-popup", modeSwitchedOrNoticed && Boolean(syncedModeD3), d3Outcome);
    await captureTargetPng(browserCdp, activeDetached.sessionId, "02-d3-mode-switch.png").catch(() => {});

    await browserCdp.evaluate(
      `(() => {
        const panel = document.getElementById("biliscript-reading-settings-panel");
        if (panel && !panel.hidden) {
          document.getElementById("biliscript-reading-settings-btn")?.click();
        }
      })()`,
      { sessionId: activeDetached.sessionId }
    );
    await waitFor(
      "settings panel closed before redock",
      async () =>
        browserCdp.evaluate(
          "Boolean(document.getElementById('biliscript-reading-settings-panel')?.hidden)",
          { sessionId: activeDetached.sessionId }
        ),
      { timeoutMs: 4000, intervalMs: 100 }
    ).catch(() => {});

    const redockTargetId = activeDetached.targetId;
    let redockTriggered = false;
    let redockClick = { ok: false, mode: d3Outcome.switchedInPlace ? "popup-header-btn" : "pip-external-close" };
    if (d3Outcome.switchedInPlace) {
      redockClick = await clickInTarget(
        browserCdp,
        activeDetached.sessionId,
        "redock-btn",
        "document.getElementById('biliscript-reading-detach-btn')"
      );
      redockTriggered = Boolean(redockClick?.ok);
    } else {
      await browserCdp.send("Target.closeTarget", { targetId: redockTargetId });
      redockTriggered = true;
    }
    await tracker.waitForClosed(redockTargetId, "detached window closed on redock");
    const openerAfterRedock = await waitFor(
      "reading view returned to opener",
      async () =>
        page.cdp.evaluate(`(() => {
          const v = document.getElementById("biliscript-reading-view");
          return v && v.classList.contains("open") && !v.hidden
            ? { open: true, sameRoot: v === window.__biliscriptShellRef }
            : null;
        })()`),
      { timeoutMs: 6000, intervalMs: 150 }
    );

    const beforePopupRepop = tracker.snapshotActiveIds();
    const repopClick = await clickInTarget(
      page.cdp,
      null,
      "repop-popup-btn",
      "document.getElementById('biliscript-reading-detach-btn')"
    );
    const popupChild = await tracker.waitForNewDetachedTarget(beforePopupRepop, "D4 popup repop target");
    activeDetached = popupChild;

    const popupWinInfo = await browserCdp
      .send("Browser.getWindowForTarget", { targetId: popupChild.targetId })
      .catch(() => null);
    if (popupWinInfo?.windowId) {
      await browserCdp.send("Browser.setWindowBounds", {
        windowId: popupWinInfo.windowId,
        bounds: { width: 490, height: 560 }
      }).catch(() => {});
      await browserCdp.evaluate("window.dispatchEvent(new Event('resize'))", { sessionId: popupChild.sessionId });
    }
    const savedNormalBounds = await waitFor(
      "local bounds saved for 490x560",
      async () => {
        const res = await worker.evaluate("chrome.storage.local.get('biliscript_detached_window_bounds_v1')");
        const b = res?.biliscript_detached_window_bounds_v1;
        return b && typeof b.width === "number" && typeof b.height === "number" ? b : null;
      },
      { timeoutMs: 6000, intervalMs: 200 }
    );

    await worker.evaluate("chrome.storage.local.remove('biliscript_detached_window_bounds_v1')");
    if (popupWinInfo?.windowId) {
      await browserCdp.send("Browser.setWindowBounds", {
        windowId: popupWinInfo.windowId,
        bounds: { width: 250, height: 280 }
      }).catch(() => {});
      await browserCdp.evaluate(
        "try { window.resizeTo(250, 280); } catch {} window.dispatchEvent(new Event('resize'));",
        { sessionId: popupChild.sessionId }
      );
    }
    const clampedBounds = await waitFor(
      "local bounds clamped >= 360x420",
      async () => {
        const res = await worker.evaluate("chrome.storage.local.get('biliscript_detached_window_bounds_v1')");
        const b = res?.biliscript_detached_window_bounds_v1;
        return b &&
          typeof b.width === "number" &&
          typeof b.height === "number" &&
          b.width < 490 &&
          b.height < 560 &&
          b.width >= 360 &&
          b.height >= 420
          ? b
          : null;
      },
      { timeoutMs: 6000, intervalMs: 200 }
    );

    check(
      "D4-redock-shell-preservation-and-popup-resize-clamping",
      redockTriggered &&
        openerAfterRedock?.open &&
        openerAfterRedock?.sameRoot &&
        repopClick.ok &&
        clampedBounds.width < 490 &&
        clampedBounds.height < 560 &&
        clampedBounds.width >= 360 &&
        clampedBounds.height >= 420,
      { openerAfterRedock, redockClick, savedNormalBounds, clampedBounds }
    );
    await captureTargetPng(browserCdp, popupChild.sessionId, "03-d4-popup-resized.png").catch(() => {});

    await page.cdp.send("Page.bringToFront");
    await page.cdp.send("Runtime.evaluate", {
      expression: "document.querySelector('.bpx-player-container').requestFullscreen()",
      userGesture: true,
      awaitPromise: true
    }).catch(() => {});
    const fsActive = await waitFor(
      "fullscreenElement active",
      async () => page.cdp.evaluate("Boolean(document.fullscreenElement)"),
      { timeoutMs: 4000, intervalMs: 100 }
    ).catch(() => false);
    const detachedInFs = await browserCdp.evaluate(
      "Boolean(document.getElementById('biliscript-reading-view')?.classList.contains('open'))",
      { sessionId: popupChild.sessionId }
    );
    await page.cdp.evaluate("document.fullscreenElement ? document.exitFullscreen() : null").catch(() => {});

    await page.cdp.evaluate(
      `(() => {
        history.pushState({}, "", ${JSON.stringify(VIDEO_URL_P2)});
        window.dispatchEvent(new PopStateEvent("popstate"));
      })()`
    );
    const p2Refreshed = await waitFor(
      "P2 subtitle refreshed in detached window",
      async () =>
        browserCdp.evaluate(
          `(() => {
            const list = document.getElementById("biliscript-reading-subtitle");
            return list && list.textContent.includes("第二分P首段：SPA切P后保留独立窗口");
          })()`,
          { sessionId: popupChild.sessionId }
        ),
      { timeoutMs: 10000, intervalMs: 200 }
    );

    check(
      "D5-fullscreen-and-spa-p2-retention",
      fsActive && detachedInFs && p2Refreshed,
      { fsActive, detachedInFs, p2Refreshed }
    );

    await page.cdp.send("Page.bringToFront");
    const enterResp = await sendTabMessageFromWorker(worker, {
      type: "reader-enter",
      readerUrl: VIDEO_URL_P2
    });
    const stillOpenOnEnter = await browserCdp.evaluate(
      "Boolean(document.getElementById('biliscript-reading-view')?.classList.contains('open'))",
      { sessionId: popupChild.sessionId }
    );
    const externalMsgFocused = await browserCdp.evaluate("document.hasFocus()", { sessionId: popupChild.sessionId });
    const inPageEnterClick = await clickInTarget(
      page.cdp,
      null,
      "inpage-reader-enter-for-focus",
      "document.getElementById('biliscript-script-button')"
    );
    const focusedOnEnter = await waitFor(
      "detached focused after reader-enter",
      async () => browserCdp.evaluate("document.hasFocus()", { sessionId: popupChild.sessionId }),
      { timeoutMs: 4000, intervalMs: 100 }
    ).catch(() => false);

    const toggleResp = await sendTabMessageFromWorker(worker, {
      type: "reader-toggle",
      readerUrl: VIDEO_URL_P2
    });
    await tracker.waitForClosed(popupChild.targetId, "D6 reader-toggle closed detached window");
    const openerClosedOnToggle = await waitFor(
      "opener shell exited on reader-toggle",
      async () =>
        page.cdp.evaluate(`(() => {
          const v = document.getElementById("biliscript-reading-view");
          return Boolean(v && v.hidden && !v.classList.contains("open") && !document.documentElement.hasAttribute("data-biliscript-reader-mode"));
        })()`),
      { timeoutMs: 6000, intervalMs: 150 }
    );

    check(
      "D6-external-reader-enter-and-toggle",
      Boolean(enterResp?.ok) &&
        stillOpenOnEnter &&
        Boolean(inPageEnterClick?.ok) &&
        (headed ? Boolean(focusedOnEnter) : true) &&
        Boolean(toggleResp?.ok) &&
        openerClosedOnToggle,
      { enterResp, stillOpenOnEnter, externalMsgFocused, inPageEnterClick, focusedOnEnter, toggleResp, openerClosedOnToggle }
    );

    await clickInTarget(
      page.cdp,
      null,
      "reopen-for-d7",
      "document.getElementById('biliscript-script-button')"
    );
    await waitFor("reader reopened for D7", async () =>
      page.cdp.evaluate("Boolean(document.getElementById('biliscript-reading-view')?.classList.contains('open'))")
    );
    const beforeD7Popup = tracker.snapshotActiveIds();
    await clickInTarget(
      page.cdp,
      null,
      "detach-popup-for-d7",
      "document.getElementById('biliscript-reading-detach-btn')"
    );
    const d7Popup = await tracker.waitForNewDetachedTarget(beforeD7Popup, "D7 popup target");

    const nativePipResult = await page.cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const v = document.querySelector("video");
        if (!v) return { ok: false, reason: "no-video" };
        await v.requestPictureInPicture();
        return { ok: Boolean(document.pictureInPictureElement), pipActive: Boolean(document.pictureInPictureElement) };
      })()`,
      userGesture: true,
      awaitPromise: true,
      returnByValue: true
    });
    const popupCoexistsWithVideoPip = await browserCdp.evaluate(
      "Boolean(document.getElementById('biliscript-reading-view')?.classList.contains('open'))",
      { sessionId: d7Popup.sessionId }
    );
    await page.cdp.evaluate("document.pictureInPictureElement ? document.exitPictureInPicture().catch(() => {}) : null");
    await clickInTarget(
      browserCdp,
      d7Popup.sessionId,
      "redock-d7",
      "document.getElementById('biliscript-reading-detach-btn')"
    );
    await tracker.waitForClosed(d7Popup.targetId, "D7 popup redocked");

    await worker.evaluate("chrome.storage.sync.set({ detachedWindowMode: 'pip' })");
    await waitFor(
      "mode reset to pip for D7",
      async () => {
        const s = await worker.evaluate("chrome.storage.sync.get('detachedWindowMode')");
        return s?.detachedWindowMode === "pip";
      },
      { timeoutMs: 4000, intervalMs: 100 }
    );
    const beforeD7Pip = tracker.snapshotActiveIds();
    await clickInTarget(
      page.cdp,
      null,
      "detach-pip-for-d7",
      "document.getElementById('biliscript-reading-detach-btn')"
    );
    const d7Pip = await tracker.waitForNewDetachedTarget(beforeD7Pip, "D7 pip target");

    const videoPipAfterDocPip = await page.cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const v = document.querySelector("video");
        try {
          await v.requestPictureInPicture();
          return { requested: true, videoPip: Boolean(document.pictureInPictureElement) };
        } catch (err) {
          return { requested: false, error: String(err?.message || err) };
        }
      })()`,
      userGesture: true,
      awaitPromise: true,
      returnByValue: true
    });
    await page.cdp.evaluate("document.pictureInPictureElement ? document.exitPictureInPicture().catch(() => {}) : null");
    await page.cdp.evaluate("document.querySelector('video')?.pause();");
    const d7TargetsAfter = await browserCdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    const d7PipStillOpenAfterVideoPip = (d7TargetsAfter.targetInfos || []).some((t) => t.targetId === d7Pip.targetId);

    check(
      "D7-native-video-pip-coexistence",
      Boolean(nativePipResult?.result?.value?.pipActive) &&
        popupCoexistsWithVideoPip &&
        Boolean(d7Pip?.targetId),
      {
        nativePip: nativePipResult?.result?.value,
        popupCoexistsWithVideoPip,
        videoPipAfterDocPip: videoPipAfterDocPip?.result?.value,
        d7PipStillOpenAfterVideoPip
      }
    );

    const liveTargetsNow = await browserCdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    const liveIdsNow = new Set((liveTargetsNow.targetInfos || []).map((t) => t.targetId));
    let activeBeforeClose = tracker.activeList().find((t) => liveIdsNow.has(t.targetId)) || (liveIdsNow.has(d7Pip.targetId) ? d7Pip : null);
    if (!activeBeforeClose) {
      await waitFor("opener redocked after D7 auto-close", async () =>
        page.cdp.evaluate(`(() => {
          const v = document.getElementById("biliscript-reading-view");
          const detachBtn = document.getElementById("biliscript-reading-detach-btn");
          return Boolean(v && v.classList.contains("open") && !v.hidden && detachBtn && !detachBtn.hidden);
        })()`)
      );
      await page.cdp.send("Page.bringToFront").catch(() => {});
      const beforeD8 = tracker.snapshotActiveIds();
      await clickInTarget(page.cdp, null, "detach-for-d8-close", "document.getElementById('biliscript-reading-detach-btn')");
      activeBeforeClose = await tracker.waitForNewDetachedTarget(beforeD8, "D8 child target");
    }
    await browserCdp.send("Target.closeTarget", { targetId: activeBeforeClose.targetId });
    await tracker.waitForClosed(activeBeforeClose.targetId, "D8 child target closed");
    const openerRedockedOnChildClose = await waitFor(
      "opener shell redocked on child pagehide",
      async () =>
        page.cdp.evaluate(`(() => {
          const v = document.getElementById("biliscript-reading-view");
          const detachBtn = document.getElementById("biliscript-reading-detach-btn");
          const closeBtn = document.getElementById("biliscript-reading-close-btn");
          return Boolean(
            v &&
              !v.hidden &&
              v.classList.contains("open") &&
              document.documentElement.hasAttribute("data-biliscript-reader-mode") &&
              detachBtn &&
              !detachBtn.hidden &&
              closeBtn &&
              !closeBtn.hidden
          );
        })()`),
      { timeoutMs: 6000, intervalMs: 150 }
    );

    await worker.evaluate("chrome.storage.sync.set({ detachedWindowMode: 'popup' })");
    await page.cdp.send("Page.bringToFront").catch(() => {});
    await waitFor("reader open for D8 reset", async () =>
      page.cdp.evaluate(`(() => {
        const v = document.getElementById("biliscript-reading-view");
        return Boolean(v && v.classList.contains("open") && !v.hidden && v.getAttribute("data-biliscript-reader-ready") === "1");
      })()`)
    );
    const motionBeforeResetSettings = await page.cdp.evaluate(
      "document.querySelector('[data-biliscript-settings-motion]')?.getAttribute('data-biliscript-settings-motion') ?? null"
    );
    const openSettingsResetClick = await clickInTarget(
      page.cdp,
      null,
      "open-settings-for-reset",
      "document.getElementById('biliscript-reading-settings-btn')"
    );
    if (!openSettingsResetClick?.ok) {
      throw new Error(`D8 openSettingsResetClick failed: ${JSON.stringify(openSettingsResetClick)}`);
    }
    await waitFor("reset btn visible", async () =>
      page.cdp.evaluate(`(() => {
        if (document.querySelector("[data-biliscript-settings-motion]")) return false;
        const p = document.getElementById("biliscript-reading-settings-panel");
        const b = document.getElementById("biliscriptSettingsResetBtn");
        if (!p || p.hidden || !b) return false;
        if (b.hidden) {
          document.getElementById("biliscriptSettingsBackBtn")?.click();
          return false;
        }
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })()`),
      { timeoutMs: 4000, intervalMs: 100 }
    ).catch(async (err) => {
      const diag = await page.cdp.evaluate(`(async () => {
        const sp = document.querySelector("[data-biliscript-settings-motion]");
        const timerOk = await new Promise((res) => setTimeout(() => res(true), 50));
        return {
          motionBeforeResetSettings: ${JSON.stringify(motionBeforeResetSettings)},
          timerOk,
          panelHidden: document.getElementById("biliscript-reading-settings-panel")?.hidden,
          resetHidden: document.getElementById("biliscriptSettingsResetBtn")?.hidden,
          title: document.getElementById("biliscriptSettingsTitle")?.textContent,
          motion: sp?.getAttribute("data-biliscript-settings-motion") ?? null,
          spId: sp?.id || sp?.className || null,
          spConnected: sp?.isConnected ?? null,
          animStates: sp ? sp.getAnimations({ subtree: true }).map((a) => ({ id: a.id, playState: a.playState, pending: a.pending })) : []
        };
      })()`).catch(() => null);
      throw new Error(`${err.message} resetDiag=${JSON.stringify(diag)}`);
    });
    const resetClick = await clickInTarget(
      page.cdp,
      null,
      "reset-preferences-btn",
      "document.getElementById('biliscriptSettingsResetBtn')"
    );
    await waitFor("reset confirm dialog visible", async () =>
      page.cdp.evaluate("Boolean(document.querySelector('.confirm-dialog-confirm'))")
    );
    const confirmResetClick = await clickInTarget(
      page.cdp,
      null,
      "reset-preferences-confirm",
      "document.querySelector('.confirm-dialog-confirm')"
    );

    const resetStorage = await waitFor(
      "sync detachedWindowMode and local bounds reset",
      async () => {
        const syncVal = await worker.evaluate("chrome.storage.sync.get('detachedWindowMode')");
        const localVal = await worker.evaluate("chrome.storage.local.get('biliscript_detached_window_bounds_v1')");
        if (
          syncVal?.detachedWindowMode === "pip" &&
          localVal?.biliscript_detached_window_bounds_v1 === undefined
        ) {
          return { syncVal, localVal };
        }
        return null;
      },
      { timeoutMs: 6000, intervalMs: 150 }
    );

    check(
      "D8-child-close-alignment-and-reset-preferences",
      openerRedockedOnChildClose && resetClick.ok && confirmResetClick.ok && Boolean(resetStorage),
      { openerRedockedOnChildClose, resetStorage }
    );
  } catch (error) {
    check("scenario-unhandled-error", false, { message: String(error?.message || error), stack: String(error?.stack || "").slice(0, 600) });
  } finally {
    if (page?.cdp && !page.cdp.closed) {
      await page.cdp
        .evaluate(`(async () => {
          try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); } catch {}
          try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
          for (const el of document.querySelectorAll("video, audio")) {
            try { el.pause(); } catch {}
            try { el.removeAttribute("src"); } catch {}
            try { el.srcObject = null; } catch {}
            try { el.load(); } catch {}
            try { el.remove(); } catch {}
          }
        })()`)
        .catch(() => {});
    }
    if (tracker && browserCdp && !browserCdp.closed) {
      for (const item of tracker.activeList()) {
        await browserCdp.send("Target.closeTarget", { targetId: item.targetId }).catch(() => {});
      }
    }
    await teardown({ browser, cdps });
    evidence.profileRemoved = browser.profileRemoved ?? null;
    evidence.failed = checks.filter((c) => !c.ok).map((c) => c.name);
    evidence.ok = evidence.failed.length === 0 && checks.length >= 8;
    await writeEvidence(OUT_DIR, evidence);
    if (!evidence.ok) {
      process.exitCode = 1;
    }
  }
}

await main();
