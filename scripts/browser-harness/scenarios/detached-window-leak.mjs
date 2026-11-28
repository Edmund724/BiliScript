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
  sleep,
  teardown,
  waitFor,
  watchPage,
  writeEvidence
} from "../harness.mjs";

const NAME = "detached-window-leak";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const BUNDLES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bundles.json"), "utf8"));
const BODIES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bodies.json"), "utf8"));

const VIDEO_BVID = "BV1mAam6tEL8";
const VIDEO_AID = 117370433574328;
const VIDEO_CID_P1 = 42393338874;
const VIDEO_URL_P1 = `https://www.bilibili.com/video/${VIDEO_BVID}/?p=1`;
const SAMPLE_WEBM_URL = "https://www.bilibili.com/__fixture__/sample.webm";
const SAMPLE_WEBM_B64 =
  "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";

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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BiliScript 独立窗口 WeakRef 泄漏门禁</title>
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

function viewResponse() {
  return {
    code: 0,
    message: "0",
    data: {
      aid: VIDEO_AID,
      bvid: VIDEO_BVID,
      cid: VIDEO_CID_P1,
      title: "独立窗口 WeakRef 泄漏门禁视频",
      desc: "离线 fixture 视频",
      duration: 15,
      pubdate: 1767225600,
      owner: { name: "fixture" },
      pages: [{ cid: VIDEO_CID_P1, page: 1, part: "第一分 P", duration: 15 }]
    }
  };
}

function playerResponse() {
  const source = BUNDLES[VIDEO_BVID];
  const zhUrl = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/walkthrough-fixture/${VIDEO_BVID}-zh.json`;
  const subtitles = source.data.subtitle.subtitles.slice(0, 2).map((sub, idx) =>
    idx === 0 ? { ...sub, subtitle_url: zhUrl, subtitle_url_v2: zhUrl } : sub
  );
  return {
    ...source,
    data: {
      ...source.data,
      aid: VIDEO_AID,
      bvid: VIDEO_BVID,
      cid: VIDEO_CID_P1,
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
            await cdp.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [{ name: "content-type", value: "application/json" }],
                body: Buffer.from(JSON.stringify(viewResponse())).toString("base64")
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
                body: Buffer.from(JSON.stringify(playerResponse())).toString("base64")
              },
              sessionId
            );
            return;
          }
          if (url.includes("walkthrough-fixture/")) {
            const body = url.includes(`${VIDEO_BVID}-en.json`)
              ? clipFixtureSubtitleBody(BODIES[`${VIDEO_BVID}-en`])
              : clipFixtureSubtitleBody(BODIES[`${VIDEO_BVID}-zh`]);
            await cdp.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [{ name: "content-type", value: "application/json" }],
                body: Buffer.from(JSON.stringify(body)).toString("base64")
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

async function dispatchPointerClick(cdp, sessionId, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 }, sessionId);
}

async function dispatchPointerDrag(cdp, sessionId, startX, startY, endX, endY) {
  const sx = Math.round(startX);
  const sy = Math.round(startY);
  const ex = Math.round(endX);
  const ey = Math.round(endY);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy, button: "none", clickCount: 0 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ex, y: ey, button: "left", buttons: 1, clickCount: 0 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", buttons: 0, clickCount: 1 }, sessionId);
}

async function clickOpenerSelector(pageCdp, label, locateExpr) {
  const info = await pageCdp.evaluate(
    `(async () => {
      const el = ${locateExpr};
      if (!el) return { ok: false, label: ${JSON.stringify(label)}, reason: "not-found" };
      el.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return {
        ok: r.width > 0 && r.height > 0,
        label: ${JSON.stringify(label)},
        rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        center: { x: +cx.toFixed(1), y: +cy.toFixed(1) }
      };
    })()`
  );
  if (!info?.ok) return { ok: false, ...info };
  await dispatchPointerClick(pageCdp, null, info.center.x, info.center.y);
  return { ok: true, label, rect: info.rect, center: info.center };
}

function quadBounds(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    left,
    top,
    width: +(right - left).toFixed(2),
    height: +(bottom - top).toFixed(2),
    cx: +((left + right) / 2).toFixed(1),
    cy: +((top + bottom) / 2).toFixed(1)
  };
}

async function queryDomNode(cdp, sessionId, selector) {
  const doc = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
  const res = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector }, sessionId);
  return res?.nodeId || 0;
}

async function queryDomNodeCount(cdp, sessionId, selector) {
  const doc = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
  const res = await cdp.send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector }, sessionId);
  return Array.isArray(res?.nodeIds) ? res.nodeIds.length : 0;
}

async function getDomBox(cdp, sessionId, selector) {
  const nodeId = await queryDomNode(cdp, sessionId, selector);
  if (!nodeId) return null;
  await cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId }, sessionId).catch(() => {});
  const box = await cdp.send("DOM.getBoxModel", { nodeId }, sessionId).catch(() => null);
  if (!box?.model?.border) return null;
  const bounds = quadBounds(box.model.border);
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return { nodeId, ...bounds };
}

async function waitForDomVisibleBox(cdp, sessionId, label, selector, timeoutMs = 6000) {
  return waitFor(
    label,
    async () => {
      const box = await getDomBox(cdp, sessionId, selector);
      return box || null;
    },
    { timeoutMs, intervalMs: 100 }
  );
}

async function waitForDomAbsent(cdp, sessionId, label, selector, timeoutMs = 5000) {
  return waitFor(
    label,
    async () => {
      const nodeId = await queryDomNode(cdp, sessionId, selector).catch(() => 0);
      return nodeId === 0;
    },
    { timeoutMs, intervalMs: 100 }
  );
}

async function clickDomSelector(cdp, sessionId, label, selector) {
  let prev = null;
  for (let i = 0; i < 20; i += 1) {
    const box = await getDomBox(cdp, sessionId, selector);
    if (!box) {
      await sleep(50);
      continue;
    }
    if (
      prev &&
      Math.abs(box.left - prev.left) <= 0.5 &&
      Math.abs(box.top - prev.top) <= 0.5 &&
      Math.abs(box.width - prev.width) <= 0.5 &&
      Math.abs(box.height - prev.height) <= 0.5
    ) {
      await dispatchPointerClick(cdp, sessionId, box.cx, box.cy);
      return { ok: true, label, rect: { w: box.width, h: box.height }, center: { x: box.cx, y: box.cy } };
    }
    prev = box;
    await sleep(40);
  }
  if (prev) {
    await dispatchPointerClick(cdp, sessionId, prev.cx, prev.cy);
    return { ok: true, label, rect: { w: prev.width, h: prev.height }, center: { x: prev.cx, y: prev.cy } };
  }
  return { ok: false, label, reason: "not-visible" };
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
      void browserCdp.send("DOM.enable", {}, params.sessionId).catch(() => {});
      void browserCdp.send("Page.enable", {}, params.sessionId).catch(() => {});
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
              targets.set(info.targetId, {
                targetId: info.targetId,
                sessionId: attached.sessionId,
                type: info.type,
                url,
                openerId: info.openerId || "",
                active: true
              });
              await browserCdp.send("DOM.enable", {}, attached.sessionId).catch(() => {});
              await browserCdp.send("Page.enable", {}, attached.sessionId).catch(() => {});
            } catch (e) {
              lastDebug = { attachErr: String(e?.message || e), seen };
            }
          }
        }
        for (const item of targets.values()) {
          if (!item.active || prevIds.has(item.targetId)) continue;
          try {
            const viewNodeId = await queryDomNode(browserCdp, item.sessionId, "#biliscript-reading-view");
            if (viewNodeId > 0) return item;
            lastDebug = { targetId: item.targetId, viewNodeId, seen };
          } catch (e) {
            lastDebug = { targetId: item.targetId, domErr: String(e?.message || e), seen };
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

async function cleanupPageMedia(pageCdp) {
  await pageCdp.evaluate(`(async () => {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); } catch {}
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
    for (const el of document.querySelectorAll("video, audio")) {
      try { el.pause(); } catch {}
      try { el.removeAttribute("src"); } catch {}
      try { el.srcObject = null; } catch {}
      try { el.load(); } catch {}
      try { el.remove(); } catch {}
    }
    return true;
  })()`);
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
      exceptions.push({
        text: params.exceptionDetails?.text,
        desc: params.exceptionDetails?.exception?.description?.slice(0, 300)
      });
    });
    evidence.notes.watcher = watcher;
    evidence.notes.exceptions = exceptions;

    browserCdp = await CDP.connect(browser.version?.webSocketDebuggerUrl);
    cdps.push(browserCdp);

    tracker = createChildTargetTracker(browserCdp, page.target.id || page.target.targetId);
    await tracker.init();

    const worker = createWorkerSession({
      pageCdp: page.cdp,
      browser,
      distDir,
      onReconnect: installWorkerFixtures
    });
    const swReady = await worker.ensureAlive();
    if (!swReady) {
      throw new Error("扩展 SW 启动超时");
    }
    await installWorkerFixtures(worker.handle);

    const fixtureModels = [
      "fixture-model-alpha",
      "fixture-model-beta-width-measurement-long-id"
    ];
    await worker.evaluate(
      `(async () => {
        await chrome.storage.sync.set({
          detachedWindowMode: "pip",
          enableDebugLogs: false,
          aiProviders: [{
            id: "leak-fixture-ai",
            presetId: "custom",
            name: "Fixture AI",
            baseUrl: "https://api.example.com/v1",
            models: ${JSON.stringify(fixtureModels)},
            requiresKey: false,
            enabled: true,
            protocol: "openai"
          }],
          defaultModel: "leak-fixture-ai",
          defaultAiModel: "leak-fixture-ai::${fixtureModels[0]}"
        });
        await chrome.storage.local.set({
          biliscript_ai_provider_models_v1: {
            "leak-fixture-ai": ${JSON.stringify(fixtureModels)}
          }
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
      return true;
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
    const openClick = await clickOpenerSelector(
      page.cdp,
      "script-button",
      "document.getElementById('biliscript-script-button')"
    );
    await waitFor("reader open & subtitles ready", async () =>
      page.cdp.evaluate(`(() => {
        const v = document.getElementById("biliscript-reading-view");
        const detach = document.getElementById("biliscript-reading-detach-btn");
        const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item").length;
        return Boolean(v && v.classList.contains("open") && v.getAttribute("data-biliscript-reader-ready") === "1" && detach && items >= 3);
      })()`)
    );

    const beforeDetach = tracker.snapshotActiveIds();
    await page.cdp.send("Page.bringToFront").catch(() => {});
    const detachClick = await clickOpenerSelector(
      page.cdp,
      "detach-btn-pip",
      "document.getElementById('biliscript-reading-detach-btn')"
    );
    const pipChild = await tracker.waitForNewDetachedTarget(beforeDetach, "Document PiP child target");

    const weakRefInit = await page.cdp.evaluate(`(() => {
      const pipWin = window.documentPictureInPicture && window.documentPictureInPicture.window;
      if (!pipWin || !pipWin.document) {
        return { ok: false, reason: "no-document-pip-window" };
      }
      window.__biliscriptPipWeakRefs = {
        winRef: new WeakRef(pipWin),
        docRef: new WeakRef(pipWin.document)
      };
      return {
        ok: true,
        winAlive: window.__biliscriptPipWeakRefs.winRef.deref() !== undefined,
        docAlive: window.__biliscriptPipWeakRefs.docRef.deref() !== undefined
      };
    })()`);
    check(
      "L1-detach-pip-and-capture-weakrefs",
      openClick.ok && detachClick.ok && Boolean(pipChild?.targetId) && Boolean(weakRefInit?.ok && weakRefInit.winAlive && weakRefInit.docAlive),
      { openClick: openClick.ok, detachClick: detachClick.ok, targetId: pipChild?.targetId, weakRefInit }
    );

    await clickDomSelector(browserCdp, pipChild.sessionId, "settings-open", "#biliscript-reading-settings-btn");
    await waitForDomVisibleBox(browserCdp, pipChild.sessionId, "appearance entry visible", "#openAppearanceBtn", 6000);
    await waitForDomAbsent(browserCdp, pipChild.sessionId, "settings open motion settled", "[data-biliscript-settings-motion]", 4000).catch(() => {});
    await clickDomSelector(browserCdp, pipChild.sessionId, "open-appearance-subpage", "#openAppearanceBtn");
    await waitForDomVisibleBox(
      browserCdp,
      pipChild.sessionId,
      "appearance custom select trigger visible",
      "#biliscriptSettingsSubpageAppearance:not([hidden]) .custom-select-trigger",
      5000
    );
    const customSelectOpen = await clickDomSelector(
      browserCdp,
      pipChild.sessionId,
      "custom-select-trigger",
      "#biliscriptSettingsSubpageAppearance .custom-select-trigger"
    );
    const customSelectOptionBox = await waitForDomVisibleBox(
      browserCdp,
      pipChild.sessionId,
      "custom-select option visible",
      "#biliscriptSettingsSubpageAppearance .custom-select-dropdown:not([hidden]) .custom-select-option",
      4000
    ).catch(() => null);
    await clickDomSelector(
      browserCdp,
      pipChild.sessionId,
      "custom-select-close",
      "#biliscriptSettingsSubpageAppearance .custom-select-trigger"
    ).catch(() => {});
    await clickDomSelector(browserCdp, pipChild.sessionId, "settings-close", "#biliscript-reading-settings-btn");
    await waitForDomAbsent(
      browserCdp,
      pipChild.sessionId,
      "settings panel closed",
      "#biliscript-reading-settings-panel:not([hidden]), [data-biliscript-settings-motion]",
      4000
    );
    check(
      "L2-exercise-custom-select-in-pip",
      Boolean(customSelectOpen.ok && customSelectOptionBox),
      { customSelectOpen, customSelectOptionBox }
    );

    const chatTabClick = await clickDomSelector(browserCdp, pipChild.sessionId, "chat-tab", "#biliscript-reading-tab-chat");
    await waitForDomVisibleBox(
      browserCdp,
      pipChild.sessionId,
      "chat model chip ready",
      "#biliscript-reading-tabbody-chat:not([hidden]) #biliscript-reading-chat-model-chip",
      6000
    );
    const modelChipClick = await clickDomSelector(
      browserCdp,
      pipChild.sessionId,
      "chat-model-chip",
      "#biliscript-reading-chat-model-chip"
    );
    const modelPanelBox = await waitForDomVisibleBox(
      browserCdp,
      pipChild.sessionId,
      "model picker panel opened",
      "#biliscript-reading-chat-model-panel:not([hidden])",
      5000
    ).catch(() => null);
    const modelItemCount = modelPanelBox
      ? await queryDomNodeCount(browserCdp, pipChild.sessionId, "#biliscript-reading-chat-model-list .chat-model-option")
      : 0;
    await clickDomSelector(
      browserCdp,
      pipChild.sessionId,
      "chat-model-chip-close",
      "#biliscript-reading-chat-model-chip"
    ).catch(() => {});
    check(
      "L3-exercise-model-picker-width-in-pip",
      Boolean(chatTabClick.ok && modelChipClick.ok && modelPanelBox && modelItemCount >= 2),
      { chatTabClick: chatTabClick.ok, modelChipClick: modelChipClick.ok, modelPanelBox, modelItemCount }
    );

    const subtitleTabClick = await clickDomSelector(
      browserCdp,
      pipChild.sessionId,
      "subtitle-tab",
      "#biliscript-reading-tab-subtitle"
    );
    const subtitleTextBox = await waitForDomVisibleBox(
      browserCdp,
      pipChild.sessionId,
      "subtitle text visible",
      "#biliscript-reading-subtitle .biliscript-reading-item .biliscript-reading-text",
      5000
    );
    await dispatchPointerDrag(
      browserCdp,
      pipChild.sessionId,
      subtitleTextBox.left + 4,
      subtitleTextBox.cy,
      Math.min(subtitleTextBox.left + subtitleTextBox.width - 4, subtitleTextBox.left + 140),
      subtitleTextBox.cy
    );
    await waitForDomVisibleBox(
      browserCdp,
      pipChild.sessionId,
      "explain pop visible",
      '#biliscript-reading-explain-pop:not([hidden]) [data-selection-action="quote-card"]',
      4000
    );
    const quotePillClick = await clickDomSelector(
      browserCdp,
      pipChild.sessionId,
      "quote-card-pill",
      '#biliscript-reading-explain-pop [data-selection-action="quote-card"]'
    );
    const quoteDialogBox = await waitForDomVisibleBox(
      browserCdp,
      pipChild.sessionId,
      "quote share dialog open",
      ".biliscript-quote-share-dialog",
      5000
    ).catch(() => null);
    await sleep(240);
    const quoteCloseClick = await clickDomSelector(
      browserCdp,
      pipChild.sessionId,
      "quote-close",
      ".biliscript-quote-share-close"
    );
    const quoteClosed = await waitForDomAbsent(
      browserCdp,
      pipChild.sessionId,
      "quote share dialog closed",
      ".biliscript-quote-share-host",
      4000
    ).catch(() => false);
    check(
      "L4-exercise-quote-share-modal-in-pip",
      Boolean(subtitleTabClick.ok && quotePillClick.ok && quoteDialogBox && quoteCloseClick.ok && quoteClosed),
      { quotePillClick: quotePillClick.ok, quoteDialogBox, quoteCloseClick: quoteCloseClick.ok, quoteClosed }
    );

    const childTargetId = pipChild.targetId;
    const childSessionId = pipChild.sessionId;
    await browserCdp.send("Target.detachFromTarget", { sessionId: childSessionId }).catch(() => {});
    await browserCdp.send("Target.closeTarget", { targetId: childTargetId });
    await tracker.waitForClosed(childTargetId, "Document PiP closed and redocked");

    const redocked = await waitFor(
      "reading view returned to opener",
      async () =>
        page.cdp.evaluate(`(() => {
          const v = document.getElementById("biliscript-reading-view");
          const hasPip = Boolean(window.documentPictureInPicture && window.documentPictureInPicture.window);
          return Boolean(v && v.classList.contains("open") && !v.hidden && !hasPip);
        })()`),
      { timeoutMs: 6000, intervalMs: 150 }
    );
    check("L5-redock-after-pip-close", Boolean(redocked), { redocked });

    await cleanupPageMedia(page.cdp);

    await page.cdp.send("HeapProfiler.enable");
    const gcRounds = [];
    for (let round = 1; round <= 2; round += 1) {
      await page.cdp.send("HeapProfiler.collectGarbage");
      await page.cdp.evaluate(
        "new Promise((resolve) => setTimeout(() => queueMicrotask(() => resolve(true)), 120))"
      );
      await sleep(100);
      const snap = await page.cdp.evaluate(`(() => {
        const refs = window.__biliscriptPipWeakRefs;
        return {
          winCollected: refs ? refs.winRef.deref() === undefined : false,
          docCollected: refs ? refs.docRef.deref() === undefined : false
        };
      })()`);
      gcRounds.push({ round, ...snap });
    }
    await page.cdp.send("HeapProfiler.disable").catch(() => {});
    await page.cdp.evaluate("delete window.__biliscriptPipWeakRefs; true;").catch(() => {});

    const finalGc = gcRounds[gcRounds.length - 1] || { winCollected: false, docCollected: false };
    check(
      "L6-pip-window-and-document-weakref-collected",
      Boolean(finalGc.winCollected && finalGc.docCollected),
      { gcRounds }
    );
  } catch (error) {
    check("scenario-unhandled-error", false, {
      message: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 600)
    });
  } finally {
    if (page?.cdp && !page.cdp.closed) {
      await cleanupPageMedia(page.cdp).catch(() => {});
    }
    if (tracker && browserCdp && !browserCdp.closed) {
      for (const item of tracker.activeList()) {
        await browserCdp.send("Target.closeTarget", { targetId: item.targetId }).catch(() => {});
      }
    }
    await teardown({ browser, cdps });
    evidence.profileRemoved = browser.profileRemoved ?? null;
    evidence.failed = checks.filter((c) => !c.ok).map((c) => c.name);
    evidence.ok = evidence.failed.length === 0 && checks.length >= 6;
    await writeEvidence(OUT_DIR, evidence);
    if (!evidence.ok) {
      process.exitCode = 1;
    }
  }
}

await main();
