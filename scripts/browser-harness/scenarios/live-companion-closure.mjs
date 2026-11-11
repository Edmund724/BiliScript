#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  CDP,
  DEFAULT_DIST,
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

const NAME = "live-companion-closure";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const VIDEO_BVID = "BV1mAam6tEL8";
const VIDEO_AID = 117370433574328;
const VIDEO_CID = 42393338874;
const VIDEO_URL = `https://www.bilibili.com/video/${VIDEO_BVID}/?p=1`;
const VIDEO_URL_P2 = `https://www.bilibili.com/video/${VIDEO_BVID}/?p=2`;
const checks = [];
const results = {};
const pageWatchers = [];
const cdps = [];
const fixtureRoot = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureRoot, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureRoot, "bodies.json"), "utf8"));
const subtitleBody = bodies[`${VIDEO_BVID}-zh`];
const stateChunkFile = (await readdir(path.join(DEFAULT_DIST, "entry", "chunks"))).find((file) => /^state-.*\.mjs$/.test(file));
if (!stateChunkFile) throw new Error("找不到内容脚本 state chunk");

function check(name, ok, detail = null) {
  const entry = { name, ok: Boolean(ok), detail };
  checks.push(entry);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === null ? "" : `  ${JSON.stringify(detail).slice(0, 500)}`}`);
  return entry.ok;
}

function videoHtml(room = false) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${room ? "直播间伴看验收" : "视频页伴看验收"}</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#eee;font-family:Arial,sans-serif;overflow:hidden}
.player{position:relative;width:960px;height:540px;margin:24px;background:#050505;border:1px solid #333}
video{width:100%;height:100%;background:#050505}.controls{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;z-index:2}
.quality{width:70px;height:36px;color:white;background:#333;border:0}.live-controller{position:absolute;inset:0;pointer-events:none}
.live-controller .right-area{position:absolute;right:12px;bottom:12px;pointer-events:auto}.ext-nodes{display:flex;gap:8px}
</style></head><body>${room ? `
<div id="live-player" class="player"><video preload="none"></video><div class="live-web-player-controller live-controller"><div class="right-area"><div class="ext-nodes"></div></div></div></div>` : `
<div id="playerWrap"><div id="bilibili-player"><div class="bpx-player-container player"><div class="bpx-player-video-wrap"><video preload="none"></video></div><div class="bpx-player-control-bottom-right controls"><button class="bpx-player-ctrl-quality quality" aria-label="清晰度 1080P">1080P</button></div></div></div></div>`}
</body></html>`;
}

async function createHarnessDist() {
  const distDir = await mkdtemp(path.join(os.tmpdir(), "biliscript-live-closure-dist-"));
  await cp(DEFAULT_DIST, distDir, { recursive: true });
  const manifestPath = path.join(distDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions || []),
    "https://api.mosi.cn/*",
    "wss://api.mosi.cn/*",
    "https://generativelanguage.googleapis.com/*",
    "wss://generativelanguage.googleapis.com/*"
  ])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return distDir;
}

function viewResponse(pageIndex = 1) {
  const secondCid = String(Number(VIDEO_CID) + 1);
  return {
    code: 0,
    message: "0",
    data: {
      aid: VIDEO_AID,
      bvid: VIDEO_BVID,
      cid: pageIndex === 2 ? secondCid : VIDEO_CID,
      title: "伴看闭环真机验收视频",
      desc: "离线 fixture 视频",
      duration: 461,
      pubdate: 1767225600,
      owner: { name: "fixture" },
      pages: [
        { cid: VIDEO_CID, page: 1, part: "第一分 P", duration: 461 },
        { cid: secondCid, page: 2, part: "第二分 P", duration: 461 }
      ]
    }
  };
}

function playerResponse(pageIndex = 1) {
  const source = bundles[VIDEO_BVID];
  const cid = pageIndex === 2 ? String(Number(VIDEO_CID) + 1) : VIDEO_CID;
  return {
    ...source,
    data: {
      ...source.data,
      aid: VIDEO_AID,
      bvid: VIDEO_BVID,
      cid,
      subtitle: {
        ...source.data.subtitle,
        subtitles: [source.data.subtitle.subtitles[0]]
      }
    }
  };
}

function installWorkerFixtures(handle) {
  const { cdp, sessionId } = handle;
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      const requestId = params.requestId;
      let payload;
      if (/x\/web-interface\/view/.test(url)) {
        payload = viewResponse(new URL(url).searchParams.get("p") === "2" ? 2 : 1);
      } else if (/x\/player\/(?:wbi\/)?v2/.test(url)) {
        const request = new URL(url);
        payload = playerResponse(request.searchParams.get("cid") === String(Number(VIDEO_CID) + 1) ? 2 : 1);
      } else if (url.includes(`walkthrough-fixture/${VIDEO_BVID}-zh.json`)) {
        payload = subtitleBody;
      } else if (url.includes("/chat/completions")) {
        const body = JSON.parse(params.request.postData || "{}");
        const prompt = JSON.stringify(body.messages || []);
        const content = prompt.includes("3 个")
          ? '["视频讲了什么？","有哪些关键结论？","如何应用这些结论？"]'
          : prompt.includes('"chapters"') || prompt.includes("关键原话") || prompt.includes("整理这期视频")
            ? '{"summary":"受控概览摘要","chapters":[],"keyQuotes":[]}'
            : prompt.includes("伴看文本会话保留")
              ? "普通文本会话回答仍在"
              : "# 伴看分析结果\n\n### [0:02] 核心论点\n伴看与文本会话相互独立，刷新后仍可回看本条记录。";
        const stream = [
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n"
        ].join("");
        try {
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
            body: Buffer.from(stream).toString("base64")
          }, sessionId);
        } catch {}
        return;
      }
      try {
        if (payload) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(JSON.stringify(payload)).toString("base64")
          }, sessionId);
        } else {
          await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
        }
      } catch {}
    });
  });
}

function installDocumentFixture(page) {
  const { cdp } = page;
  return cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "https://www.bilibili.com/video/*", requestStage: "Request" },
      { urlPattern: "https://live.bilibili.com/*", requestStage: "Request" }
    ]
  }).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      try {
        if (params.resourceType === "Document") {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
            body: Buffer.from(videoHtml(url.startsWith("https://live.bilibili.com/"))).toString("base64")
          });
        } else {
          await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
        }
      } catch {}
    });
  });
}

async function attachTarget(browser, targetId) {
  const response = await fetch(`http://127.0.0.1:${browser.port}/json/list`);
  const targets = await response.json();
  const target = targets.find((item) => item.targetId === targetId || item.id === targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error(`找不到页面 target ${targetId}`);
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdps.push(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const page = { cdp, target };
  pageWatchers.push(watchPage(cdp));
  await installDocumentFixture(page);
  return page;
}

async function attachOffscreen(browser) {
  const target = await waitFor("offscreen target", async () => {
    const response = await fetch(`http://127.0.0.1:${browser.port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type !== "page" && String(item.url).endsWith("/entry/offscreen.html"));
  });
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdps.push(cdp);
  await cdp.send("Runtime.enable");
  return cdp;
}

async function installLiveSocketStub(offscreen) {
  await offscreen.evaluate(`(() => {
    const sockets = [];
    const state = { failNext: false, sockets };
    class FixtureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.binaryType = "arraybuffer";
        this.readyState = 0;
        this.sent = [];
        this.closed = false;
        this.closeEvent = null;
        sockets.push(this);
        setTimeout(() => {
          if (this.closed) return;
          if (state.failNext) {
            state.failNext = false;
            this.readyState = 3;
            this.onerror?.(new Event("error"));
            this.onclose?.({ code: 1006, reason: "fixture connection failure" });
            return;
          }
          this.readyState = 1;
          this.onopen?.({});
        }, 10);
      }
      send(data) {
        if (this.readyState !== 1 || this.closed) throw new Error("fixture socket is not open");
        this.sent.push(typeof data === "string" ? data : { binaryBytes: data.byteLength });
        if (typeof data !== "string") return;
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message.type === "attach_session") {
          this.emit({ type: "session_attached", session_id: "fixture-live-session" });
        }
      }
      emit(message) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) }), 0);
      }
      close(code = 1000, reason = "fixture close") {
        if (this.closed) return;
        this.closed = true;
        this.readyState = 3;
        this.closeEvent = { code, reason };
        setTimeout(() => this.onclose?.({ code, reason }), 0);
      }
    }
    globalThis.WebSocket = FixtureWebSocket;
    globalThis.__fixtureLive = state;
    globalThis.__liveSocketSummary = () => sockets.map((socket, index) => ({
      index,
      url: socket.url,
      closed: socket.closed,
      closeEvent: socket.closeEvent,
      sentTypes: socket.sent.filter((item) => typeof item === "string").map((item) => {
        try { const value = JSON.parse(item); return value.type || value.action || "json"; } catch { return "invalid"; }
      }),
      sessionInstructions: socket.sent.filter((item) => typeof item === "string").flatMap((item) => {
        try {
          const value = JSON.parse(item);
          return value.action === "session.update" ? [value.session?.instructions || ""] : [];
        } catch { return []; }
      }),
      binaryFrames: socket.sent.filter((item) => typeof item !== "string").length
    }));
  })()`);
}

async function clickCenter(page, selector) {
  const point = await waitFor(`真实点击目标 ${selector}`, async () => {
    const value = await page.cdp.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, width: rect.width, height: rect.height, hit: hit === element || element.contains(hit) };
    })()`);
    return value && value.width > 0 && value.height > 0 && value.hit ? value : null;
  }, { timeoutMs: 8000, intervalMs: 100 });
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120);
}

async function failShot(page, name) {
  try {
    await screenshot(page.cdp, path.join(OUT_DIR, `failure-${name}.png`));
  } catch (error) {
    log(`失败截图未生成：${error.message}`);
  }
}

function watchContentScriptContexts(page) {
  const contexts = new Set();
  page.cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.isDefault === false) contexts.add(context.id);
  });
  page.cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(executionContextId));
  page.cdp.on("Runtime.executionContextsCleared", () => contexts.clear());
  page.contentScriptContexts = contexts;
}

async function evaluateInContentScript(page, expression) {
  return waitFor("内容脚本隔离世界", async () => {
    for (const contextId of page.contentScriptContexts || []) {
      const result = await page.cdp.send("Runtime.evaluate", {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true
      }).catch(() => null);
      if (result?.result?.value?.__biliscriptContentScriptLoaded) return result.result.value;
    }
    return null;
  }, { timeoutMs: 45000 });
}

async function installMediaTracking(page) {
  const expression = `(() => {
    const loaded = Boolean(globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__);
    if (!loaded) return { __biliscriptContentScriptLoaded: false };
    if (!globalThis.__fixtureMedia) {
      const records = [];
      const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
      if (original) {
        navigator.mediaDevices.getUserMedia = async (...args) => {
          const stream = await original(...args);
          for (const track of stream.getTracks()) {
            const record = { kind: track.kind, id: track.id, stopped: false, readyState: track.readyState };
            records.push(record);
            const stop = track.stop.bind(track);
            track.stop = (...stopArgs) => {
              record.stopped = true;
              record.readyState = track.readyState;
              return stop(...stopArgs);
            };
            track.addEventListener("ended", () => {
              record.ended = true;
              record.readyState = track.readyState;
            });
          }
          return stream;
        };
      }
      globalThis.__fixtureMedia = records;
    }
    return {
      __biliscriptContentScriptLoaded: true,
      media: globalThis.__fixtureMedia.map((record) => ({ ...record }))
    };
  })()`;
  return evaluateInContentScript(page, expression);
}

async function readMediaTracking(page) {
  return evaluateInContentScript(page, `(() => ({
    __biliscriptContentScriptLoaded: Boolean(globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__),
    media: (globalThis.__fixtureMedia || []).map((record) => ({ ...record }))
  }))()`);
}

async function fillField(page, selector, text) {
  await clickCenter(page, selector);
  await page.cdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.cdp.send("Input.insertText", { text });
  await sleep(120);
}

async function waitConnected(page) {
  return waitFor("伴看 connected", () => page.cdp.evaluate(`(() => {
    const overlay = document.getElementById("biliscript-fullscreen-live-overlay");
    const button = document.getElementById("biliscript-player-live-quick-action") || document.querySelector(".biliscript-live-room-toggle");
    return overlay && !overlay.hidden && overlay.textContent.includes("正在伴看") && button?.getAttribute("aria-pressed") === "true";
  })()`), { timeoutMs: 30000 });
}

async function socketSummary(offscreen) {
  return offscreen.evaluate("globalThis.__liveSocketSummary?.() || []");
}

async function readClipIdentity(page) {
  return evaluateInContentScript(page, `(async () => {
    const module = await import(chrome.runtime.getURL("entry/chunks/${stateChunkFile}"));
    return {
      __biliscriptContentScriptLoaded: true,
      href: location.href,
      currentUrl: module.state.clip.currentUrl,
      currentClipSignature: module.state.clip.currentClipSignature,
      bvid: module.state.clip.bvid,
      cid: module.state.clip.cid,
      pageIndex: module.state.clip.pageIndex,
      subtitleFetchState: module.state.clip.subtitleFetchState
    };
  })()`);
}

let distDir;
let browser;
let activePage;
let activeOffscreen;
try {
  distDir = await createHarnessDist();
  browser = await launchBrowser({
    distDir,
    autoplay: true,
    muted: true,
    extraArgs: ["--use-fake-device-for-media-stream"]
  });
  const page = await attachPage(browser);
  activePage = page;
  cdps.push(page.cdp);
  watchContentScriptContexts(page);
  pageWatchers.push(watchPage(page.cdp));
  await installDocumentFixture(page);
  const worker = createWorkerSession({
    pageCdp: page.cdp,
    browser,
    distDir,
    onReconnect: installWorkerFixtures
  });
  if (!(await worker.ensureAlive())) throw new Error("扩展 SW 不可用");
  await installWorkerFixtures(worker.handle);
  await worker.evaluate(`(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    await chrome.storage.sync.set({
      activeLiveProviderId: "moss-fixture",
      activeAiProviderId: "ai-fixture",
      enablePlayerAiQuickAction: true,
      autoOpenReader: false,
      asrAutoFallback: false,
      webSearchEnabled: false,
      liveProviders: [
        { id: "moss-fixture", presetId: "moss-live", type: "moss-live", name: "MOSS fixture", baseUrl: "https://api.mosi.cn", model: "moss-live-1.0", enabled: true },
        { id: "gemini-fixture", presetId: "gemini-live", type: "gemini-live", name: "Gemini fixture", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.8-live", enabled: true }
      ],
      aiProviders: [
        { id: "ai-fixture", presetId: "custom", name: "AI fixture", baseUrl: "https://api.bilibili.com", models: ["fixture-model"], requiresKey: false, enabled: true, protocol: "openai" },
        { id: "gemini-ai-fixture", presetId: "gemini", name: "Gemini AI fixture", baseUrl: "https://generativelanguage.googleapis.com", models: ["gemini-3.8-flash"], requiresKey: true, enabled: true, protocol: "gemini" }
      ]
    });
    await chrome.storage.local.set({ liveProviderKeys: { "moss-fixture": "fixture-moss-key" } });
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("entry/offscreen.html"),
      reasons: ["BLOBS"],
      justification: "Offline live companion acceptance fixture"
    });
    return true;
  })()`);
  const offscreen = await attachOffscreen(browser);
  activeOffscreen = offscreen;
  await installLiveSocketStub(offscreen);
  await installWorkerFixtures({ cdp: offscreen, sessionId: null });
  await page.cdp.send("Browser.setPermission", {
    permission: { name: "microphone" },
    setting: "granted",
    origin: "https://www.bilibili.com"
  });

  await page.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("视频页扩展按钮", () => page.cdp.evaluate("Boolean(document.getElementById('biliscript-player-live-quick-action') && document.getElementById('biliscript-player-ai-quick-action'))"), { timeoutMs: 45000 });
  results.initialMediaTracking = await installMediaTracking(page);
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await clickCenter(page, "#biliscript-player-live-quick-action");
  await waitConnected(page);
  results.closedPanelStart = await page.cdp.evaluate(`(() => ({
    readerOpen: document.getElementById("biliscript-reading-view")?.classList.contains("open") === true,
    chatInputExists: Boolean(document.getElementById("biliscript-reading-chat-input")),
    overlayVisible: Boolean(document.getElementById("biliscript-fullscreen-live-overlay") && !document.getElementById("biliscript-fullscreen-live-overlay").hidden),
    livePressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed")
  }))()`);
  check("V1-panel-closed-start-and-first-expand", !results.closedPanelStart.readerOpen && !results.closedPanelStart.chatInputExists && results.closedPanelStart.overlayVisible && results.closedPanelStart.livePressed === "true", results.closedPanelStart);
  await screenshot(page.cdp, path.join(OUT_DIR, "01-panel-closed-connected.png"));

  await clickCenter(page, ".live-overlay-close-btn");
  await waitFor("停止伴看", () => page.cdp.evaluate(`document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed") === "false"`));
  await offscreen.evaluate("globalThis.__fixtureLive.failNext = true");
  await clickCenter(page, "#biliscript-player-live-quick-action");
  await waitFor("网络失败卡", () => page.cdp.evaluate(`document.querySelector(".live-overlay-failure-card")?.dataset.failureKind === "network" && !document.querySelector(".live-overlay-failure-card")?.hidden`));
  await screenshot(page.cdp, path.join(OUT_DIR, "02-network-failure.png"));
  await clickCenter(page, ".live-overlay-retry-btn");
  await waitConnected(page);
  results.networkRetry = { sockets: await socketSummary(offscreen) };
  check("V2a-network-failure-and-retry", results.networkRetry.sockets.length >= 3 && results.networkRetry.sockets.at(-1)?.closed === false, results.networkRetry);

  await clickCenter(page, ".live-overlay-close-btn");
  await worker.evaluate("chrome.storage.local.set({ liveProviderKeys: {} })");
  await clickCenter(page, "#biliscript-player-live-quick-action");
  await waitFor("缺 Key 失败卡", () => page.cdp.evaluate(`document.querySelector(".live-overlay-failure-card")?.dataset.failureKind === "key-missing" && !document.querySelector(".live-overlay-failure-card")?.hidden`));
  await screenshot(page.cdp, path.join(OUT_DIR, "03-key-missing.png"));
  await clickCenter(page, ".live-overlay-settings-btn");
  await waitFor("视频页伴看设置", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-view")?.classList.contains("open") && document.querySelectorAll(".live-provider-row").length === 2`));
  await sleep(500);
  await clickCenter(page, '.live-provider-row[data-provider-id="moss-fixture"] .provider-row-edit');
  await waitFor("MOSS 编辑器", () => page.cdp.evaluate(`Boolean(document.querySelector(".provider-editor-apikey"))`));
  await fillField(page, ".provider-editor-apikey", "fixture-moss-key");
  await clickCenter(page, ".provider-editor-save");
  await waitFor("MOSS Key 保存", () => worker.evaluate(`chrome.storage.local.get("liveProviderKeys").then((value) => value.liveProviderKeys?.["moss-fixture"] === "fixture-moss-key")`));
  await clickCenter(page, "#biliscript-reading-settings-btn");
  await waitFor("退出设置视图", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-tab-chat")?.getBoundingClientRect().width > 0`));
  await clickCenter(page, "#biliscript-reading-tab-chat");
  await waitFor("伴看状态条重试", () => page.cdp.evaluate(`document.querySelector('[data-live-status-action="retry"]')?.hidden === false`));
  await clickCenter(page, '[data-live-status-action="retry"]');
  await waitConnected(page);
  results.settingsReconnect = await page.cdp.evaluate(`(() => ({
    chatOpen: document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active"),
    liveState: document.querySelector(".chat-live-status")?.dataset.state,
    inputExists: Boolean(document.getElementById("biliscript-reading-chat-input"))
  }))()`);
  check("V2b-settings-save-and-reconnect", results.settingsReconnect.chatOpen && results.settingsReconnect.liveState === "connected" && results.settingsReconnect.inputExists, results.settingsReconnect);
  await screenshot(page.cdp, path.join(OUT_DIR, "04-settings-reconnected-chat.png"));

  await waitFor("普通聊天输入可用", () => page.cdp.evaluate(`(() => {
    const input = document.getElementById("biliscript-reading-chat-input");
    return input && !input.disabled;
  })()`), { timeoutMs: 45000 });
  await fillField(page, "#biliscript-reading-chat-input", "伴看文本会话保留");
  await waitFor("普通聊天发送键可用", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-send-btn")?.disabled === false`));
  await clickCenter(page, "#biliscript-reading-chat-send-btn");
  await waitFor("普通文本回答", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-messages")?.innerText.includes("普通文本会话回答仍在")`), { timeoutMs: 45000 });
  await clickCenter(page, ".live-overlay-min-btn");
  await waitFor("浮窗最小化", () => page.cdp.evaluate(`document.getElementById("biliscript-fullscreen-live-overlay")?.hidden === true && !document.querySelector(".biliscript-fullscreen-live-mini-capsule")?.classList.contains("is-hidden")`));
  const socketCountBeforeRestore = (await socketSummary(offscreen)).length;
  await clickCenter(page, '[data-live-status-action="restore"]');
  await waitFor("恢复浮窗", () => page.cdp.evaluate(`document.getElementById("biliscript-fullscreen-live-overlay")?.hidden === false`));
  const socketCountAfterRestore = (await socketSummary(offscreen)).length;
  await clickCenter(page, '[data-live-status-action="stop"]');
  await waitFor("状态条结束伴看", () => page.cdp.evaluate(`document.querySelector(".chat-live-status")?.dataset.state === "idle"`));
  results.chatSurvivesStop = await page.cdp.evaluate(`(() => ({
    text: document.getElementById("biliscript-reading-chat-messages")?.innerText,
    userMessages: document.querySelectorAll("#biliscript-reading-chat-messages .chat-message-user").length,
    assistantMessages: document.querySelectorAll("#biliscript-reading-chat-messages .chat-message-assistant").length,
    state: document.querySelector(".chat-live-status")?.dataset.state
  }))()`);
  results.chatSurvivesStop.socketCountBeforeRestore = socketCountBeforeRestore;
  results.chatSurvivesStop.socketCountAfterRestore = socketCountAfterRestore;
  check("V3-ai-status-restore-stop-preserves-chat", results.chatSurvivesStop.state === "idle" && results.chatSurvivesStop.text?.includes("伴看文本会话保留") && results.chatSurvivesStop.text?.includes("普通文本会话回答仍在") && socketCountBeforeRestore === socketCountAfterRestore, results.chatSurvivesStop);
  await screenshot(page.cdp, path.join(OUT_DIR, "05-chat-survives-live-stop.png"));

  await clickCenter(page, "#biliscript-reading-close-btn");
  await clickCenter(page, "#biliscript-player-live-quick-action");
  await waitConnected(page);
  await page.cdp.send("Page.bringToFront");
  results.fullscreenRequest = await page.cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(".bpx-player-container").requestFullscreen()`,
    userGesture: true,
    awaitPromise: true,
    returnByValue: true
  });
  if (results.fullscreenRequest.exceptionDetails) throw new Error(`全屏请求被拒绝：${JSON.stringify(results.fullscreenRequest.exceptionDetails)}`);
  await waitFor("真实全屏", () => page.cdp.evaluate(`Boolean(document.fullscreenElement)`));
  await clickCenter(page, ".live-overlay-header-settings-btn");
  await waitFor("全屏打开伴看设置", () => page.cdp.evaluate(`!document.fullscreenElement && document.getElementById("biliscript-reading-view")?.classList.contains("open") && document.querySelector(".live-provider-row")`));
  results.fullscreenSettings = await page.cdp.evaluate(`(() => ({
    fullscreen: Boolean(document.fullscreenElement),
    settingsVisible: document.getElementById("biliscript-reading-settings-panel")?.getBoundingClientRect().width > 0,
    liveState: document.querySelector(".chat-live-status")?.dataset.state
  }))()`);
  check("V4a-fullscreen-open-settings", !results.fullscreenSettings.fullscreen && results.fullscreenSettings.settingsVisible, results.fullscreenSettings);
  await screenshot(page.cdp, path.join(OUT_DIR, "06-fullscreen-settings-exited.png"));

  await clickCenter(page, "#biliscript-reading-settings-btn");
  await clickCenter(page, "#biliscript-reading-close-btn");
  await clickCenter(page, ".live-overlay-close-btn");
  await page.cdp.send("Browser.setPermission", {
    permission: { name: "microphone" },
    setting: "denied",
    origin: "https://www.bilibili.com"
  });
  await clickCenter(page, "#biliscript-player-live-quick-action");
  await waitFor("麦克风拒绝失败卡", () => page.cdp.evaluate(`document.querySelector(".live-overlay-failure-card")?.dataset.failureKind === "microphone" && !document.querySelector(".live-overlay-failure-card")?.hidden`));
  await screenshot(page.cdp, path.join(OUT_DIR, "07-microphone-denied.png"));
  await page.cdp.send("Browser.setPermission", {
    permission: { name: "microphone" },
    setting: "granted",
    origin: "https://www.bilibili.com"
  });
  await clickCenter(page, ".live-overlay-retry-btn");
  await waitConnected(page);
  results.microphoneRetry = { media: await readMediaTracking(page), failureKind: await page.cdp.evaluate(`document.querySelector(".live-overlay-failure-card")?.dataset.failureKind || null`) };
  check("V4b-microphone-denied-and-retry", results.microphoneRetry.media.media.some((track) => track.kind === "audio" && !track.stopped), results.microphoneRetry);

  const beforePartSwitch = {
    sockets: await socketSummary(offscreen),
    media: await readMediaTracking(page),
    clip: await readClipIdentity(page)
  };
  results.partSwitchTrigger = await evaluateInContentScript(page, `(() => {
    history.pushState({}, "", ${JSON.stringify(VIDEO_URL_P2)});
    window.dispatchEvent(new PopStateEvent("popstate"));
    return { __biliscriptContentScriptLoaded: true, href: location.href };
  })()`);
  await sleep(1000);
  results.partSwitchAfterOneSecond = await readClipIdentity(page);
  await waitFor("切 P 提示与新 CID 上下文", async () => {
    const notice = await page.cdp.evaluate(`document.getElementById("biliscript-fullscreen-live-overlay")?.innerText.includes("已切换到 P2")`);
    const sockets = await socketSummary(offscreen);
    const latest = sockets.at(-1);
    return notice && latest?.sessionInstructions.some((text) => text.includes("CID：42393338875") && text.includes("当前分P：P2"));
  }, { timeoutMs: 45000 });
  await sleep(400);
  const afterPartSwitch = {
    sockets: await socketSummary(offscreen),
    media: await readMediaTracking(page),
    state: await page.cdp.evaluate(`(() => ({
      pressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed"),
      href: location.href,
      messages: document.querySelector(".live-overlay-messages")?.innerText || ""
    }))()`)
  };
  results.partSwitch = { before: beforePartSwitch, after: afterPartSwitch };
  check("V4c-part-switch-keeps-session-and-refreshes-context", afterPartSwitch.sockets.length === beforePartSwitch.sockets.length && afterPartSwitch.media.media.length === beforePartSwitch.media.media.length && afterPartSwitch.state.pressed === "true" && !afterPartSwitch.state.messages && afterPartSwitch.sockets.at(-1)?.closed === false, {
    socketCount: [beforePartSwitch.sockets.length, afterPartSwitch.sockets.length],
    mediaCount: [beforePartSwitch.media.media.length, afterPartSwitch.media.media.length],
    state: afterPartSwitch.state,
    latestInstructions: afterPartSwitch.sockets.at(-1)?.sessionInstructions.at(-1)
  });
  await screenshot(page.cdp, path.join(OUT_DIR, "08-part-two-connected.png"));

  await clickCenter(page, ".live-overlay-min-btn");
  await clickCenter(page, "#biliscript-player-ai-quick-action");
  await waitFor("打开文本对话", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-view")?.classList.contains("open") && document.getElementById("biliscript-reading-chat-input")`));
  await clickCenter(page, "#biliscript-reading-tab-chat");
  await clickCenter(page, '[data-live-status-action="restore"]');
  await offscreen.evaluate(`globalThis.__fixtureLive.sockets.at(-1).emit({ type: "session.delegation.created", data: { delegation: { id: "closure-open-1" }, objective: "检索全片字幕并回答：核心论点是什么", context: [] } })`);
  await waitFor("面板内文本模型调用完成", () => page.cdp.evaluate(`(() => {
    const record = document.querySelector('[data-live-tool-record="closure-open-1"]');
    return record?.dataset.status === "completed" && record.innerText.includes("检索全片字幕并回答：核心论点是什么") && record.innerText.includes("完整结果") && record.innerText.includes("伴看分析结果");
  })()`), { timeoutMs: 45000 });
  results.openPanelDelegation = await page.cdp.evaluate(`document.querySelector('[data-live-tool-record="closure-open-1"]')?.innerText`);
  check("V5a-text-model-visible-in-open-panel", results.openPanelDelegation?.includes("已完成"), { record: results.openPanelDelegation });
  await screenshot(page.cdp, path.join(OUT_DIR, "09-open-panel-text-tool.png"));

  await clickCenter(page, "#biliscript-reading-close-btn");
  await offscreen.evaluate(`globalThis.__fixtureLive.sockets.at(-1).emit({ type: "session.delegation.created", data: { delegation: { id: "closure-closed-1" }, objective: "检索分 P 字幕并回答：第二条论据是什么", context: [] } })`);
  await waitFor("面板关闭后台调用完成", () => worker.evaluate(`chrome.storage.local.get("biliscript_ai_conversations_v1").then((value) => (value.biliscript_ai_conversations_v1 || []).some((entry) => entry.kind === "live-text-tool" && entry.records?.some((record) => record.callId === "closure-closed-1" && record.status === "completed")))`), { timeoutMs: 45000 });
  results.closedPanelDelegation = await page.cdp.evaluate(`(() => ({
    readerOpen: document.getElementById("biliscript-reading-view")?.classList.contains("open") === true,
    recordsHidden: document.querySelector(".chat-live-tool-records")?.hidden,
    overlayVisible: Boolean(document.getElementById("biliscript-fullscreen-live-overlay") && !document.getElementById("biliscript-fullscreen-live-overlay").hidden)
  }))()`);
  check("V5b-text-model-does-not-open-closed-panel", !results.closedPanelDelegation.readerOpen && results.closedPanelDelegation.recordsHidden && results.closedPanelDelegation.overlayVisible, results.closedPanelDelegation);

  await page.cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(".bpx-player-container").requestFullscreen()`,
    userGesture: true,
    awaitPromise: true,
    returnByValue: true
  });
  await waitFor("文本调用前全屏", () => page.cdp.evaluate(`Boolean(document.fullscreenElement)`));
  await offscreen.evaluate(`globalThis.__fixtureLive.sockets.at(-1).emit({ type: "session.delegation.created", data: { delegation: { id: "closure-fullscreen-1" }, objective: "检索分 P 字幕并回答：第三条论据是什么", context: [] } })`);
  await waitFor("全屏后台调用完成", () => worker.evaluate(`chrome.storage.local.get("biliscript_ai_conversations_v1").then((value) => (value.biliscript_ai_conversations_v1 || []).some((entry) => entry.kind === "live-text-tool" && entry.records?.some((record) => record.callId === "closure-fullscreen-1" && record.status === "completed")))`), { timeoutMs: 45000 });
  results.fullscreenDelegation = await page.cdp.evaluate(`(() => ({
    fullscreen: Boolean(document.fullscreenElement),
    readerOpen: document.getElementById("biliscript-reading-view")?.classList.contains("open") === true
  }))()`);
  check("V5c-text-model-does-not-open-panel-in-fullscreen", results.fullscreenDelegation.fullscreen && !results.fullscreenDelegation.readerOpen, results.fullscreenDelegation);
  await screenshot(page.cdp, path.join(OUT_DIR, "10-fullscreen-text-tool-no-panel.png"));
  await page.cdp.evaluate("document.exitFullscreen()");
  await clickCenter(page, ".live-overlay-header-settings-btn");
  await waitFor("刷新前恢复对话入口", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-view")?.classList.contains("open") && document.querySelector(".live-provider-row")`));
  await clickCenter(page, "#biliscript-reading-settings-btn");
  await clickCenter(page, "#biliscript-reading-tab-chat");

  results.persistedLiveHistory = await worker.evaluate(`chrome.storage.local.get("biliscript_ai_conversations_v1").then((value) => (value.biliscript_ai_conversations_v1 || []).filter((entry) => entry.kind === "live-text-tool"))`);
  const beforeReloadTimeOrigin = await page.cdp.evaluate("performance.timeOrigin");
  await page.cdp.send("Page.reload", { ignoreCache: true });
  await waitFor("刷新后新文档恢复对话", () => page.cdp.evaluate(`performance.timeOrigin !== ${beforeReloadTimeOrigin} && document.getElementById("biliscript-reading-view")?.classList.contains("open") && Boolean(document.getElementById("biliscript-reading-chat-input"))`), { timeoutMs: 45000 });
  results.afterRefreshIdle = await page.cdp.evaluate(`(() => ({
    pressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed"),
    overlayVisible: Boolean(document.getElementById("biliscript-fullscreen-live-overlay") && !document.getElementById("biliscript-fullscreen-live-overlay").hidden),
    readerOpen: document.getElementById("biliscript-reading-view")?.classList.contains("open") === true
  }))()`);
  await clickCenter(page, "#biliscript-reading-tab-chat");
  await clickCenter(page, "#biliscript-reading-chat-more-btn");
  await clickCenter(page, "#biliscript-reading-chat-history-btn");
  await waitFor("伴看历史入口", () => page.cdp.evaluate(`Boolean(document.querySelector(".chat-history-open:has(.chat-history-kind)"))`));
  await clickCenter(page, ".chat-history-open:has(.chat-history-kind)");
  await waitFor("伴看历史完整详情", () => page.cdp.evaluate(`(() => {
    const detail = document.querySelector(".chat-live-history-detail");
    return detail?.innerText.includes("伴看闭环真机验收视频") && detail.innerText.includes("检索全片字幕并回答：核心论点是什么") && detail.innerText.includes("伴看分析结果") && detail.querySelectorAll(".chat-live-tool-record").length === 3;
  })()`));
  results.refreshedLiveHistory = await page.cdp.evaluate(`(() => ({
    text: document.querySelector(".chat-live-history-detail")?.innerText,
    records: document.querySelectorAll(".chat-live-history-detail .chat-live-tool-record").length,
    normalChatContainsTool: document.getElementById("biliscript-reading-chat-messages")?.innerText.includes("伴看分析结果"),
    livePressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed"),
    overlayVisible: Boolean(document.getElementById("biliscript-fullscreen-live-overlay") && !document.getElementById("biliscript-fullscreen-live-overlay").hidden)
  }))()`);
  check("V6-live-history-survives-refresh-separate-from-chat", results.refreshedLiveHistory.records === 3 && !results.refreshedLiveHistory.normalChatContainsTool && results.refreshedLiveHistory.livePressed === "false" && !results.refreshedLiveHistory.overlayVisible, results.refreshedLiveHistory);
  await screenshot(page.cdp, path.join(OUT_DIR, "11-refreshed-live-history.png"));

  await worker.evaluate("chrome.storage.sync.set({ liveProviders: [] })");
  await page.cdp.send("Browser.setPermission", {
    permission: { name: "microphone" },
    setting: "granted",
    origin: "https://live.bilibili.com"
  });
  await page.cdp.send("Page.navigate", { url: "https://live.bilibili.com/1001" });
  await waitFor("直播间伴看按钮", () => page.cdp.evaluate(`Boolean(document.querySelector(".biliscript-live-room-toggle"))`), { timeoutMs: 45000 });
  results.liveRoomIsolation = await page.cdp.evaluate(`(() => ({
    readerExists: Boolean(document.getElementById("biliscript-reading-view")),
    chatInputExists: Boolean(document.getElementById("biliscript-reading-chat-input")),
    subtitleTabExists: Boolean(document.getElementById("biliscript-reading-tab-subtitle")),
    overviewTabExists: Boolean(document.getElementById("biliscript-reading-tab-overview"))
  }))()`);
  await clickCenter(page, ".biliscript-live-room-toggle");
  await waitFor("直播间未配置失败卡", () => page.cdp.evaluate(`document.querySelector(".live-overlay-failure-card")?.dataset.failureKind === "provider-unconfigured" && !document.querySelector(".live-overlay-failure-card")?.hidden`));
  await clickCenter(page, ".live-overlay-settings-btn");
  await waitFor("直播间未配置设置", () => page.cdp.evaluate(`document.getElementById("biliscript-live-room-settings")?.open === true`));
  results.liveRoomUnconfigured = { isolation: results.liveRoomIsolation, settingsOpen: true };
  check("R1-live-room-unconfigured-settings-and-isolation", Object.values(results.liveRoomIsolation).every((value) => value === false), results.liveRoomUnconfigured);
  await screenshot(page.cdp, path.join(OUT_DIR, "12-live-room-unconfigured.png"));

  await worker.evaluate(`chrome.storage.sync.set({
    liveProviders: [
      { id: "moss-fixture", presetId: "moss-live", type: "moss-live", name: "MOSS fixture", baseUrl: "https://api.mosi.cn", model: "moss-live-1.0", enabled: true },
      { id: "gemini-fixture", presetId: "gemini-live", type: "gemini-live", name: "Gemini fixture", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.8-live", enabled: true }
    ],
    activeLiveProviderId: "moss-fixture"
  })`);
  await waitFor("直播间平台列表恢复", () => page.cdp.evaluate(`document.querySelectorAll("#biliscript-live-room-settings .live-provider-row").length === 2`));
  await clickCenter(page, ".biliscript-live-room-settings-close");
  await clickCenter(page, ".biliscript-live-room-toggle");
  await waitConnected(page);
  await clickCenter(page, ".live-overlay-header-settings-btn");
  await waitFor("已连接直播设置", () => page.cdp.evaluate(`document.getElementById("biliscript-live-room-settings")?.open === true && document.querySelectorAll(".live-provider-row").length === 2`));
  const socketsBeforeProviderSwitch = await socketSummary(offscreen);
  await clickCenter(page, '.live-provider-row[data-provider-id="gemini-fixture"] .live-provider-active-radio');
  await waitFor("切换 Gemini 平台", () => worker.evaluate(`chrome.storage.sync.get("activeLiveProviderId").then((value) => value.activeLiveProviderId === "gemini-fixture")`));
  await waitFor("平台切换重连提示", () => page.cdp.evaluate(`document.querySelector(".biliscript-live-room-settings-reconnect")?.hidden === false && document.querySelector(".biliscript-live-room-settings-reconnect-text")?.innerText.includes("重新连接后生效")`));
  const socketsAfterProviderSwitch = await socketSummary(offscreen);
  results.liveRoomProviderSwitch = {
    activeProviderId: "gemini-fixture",
    sameConnection: socketsAfterProviderSwitch.length === socketsBeforeProviderSwitch.length && socketsAfterProviderSwitch.at(-1)?.closed === false
  };
  check("R2-live-room-switch-preserves-current-connection", results.liveRoomProviderSwitch.sameConnection, results.liveRoomProviderSwitch);

  await waitFor("Gemini Key 配置入口", () => page.cdp.evaluate(`document.querySelector(".biliscript-live-room-gemini-credential")?.hidden === false`));
  await clickCenter(page, ".biliscript-live-room-gemini-configure-btn");
  await waitFor("Gemini AI 编辑器", () => page.cdp.evaluate(`document.querySelector(".provider-editor-preset")?.value === "gemini" && Boolean(document.querySelector(".provider-editor-apikey"))`));
  await fillField(page, ".provider-editor-apikey", "fixture-gemini-ai-key");
  await clickCenter(page, ".provider-editor-save");
  await waitFor("Gemini AI Key 保存", () => worker.evaluate(`chrome.storage.local.get("aiProviderKeys").then((value) => value.aiProviderKeys?.["gemini-ai-fixture"] === "fixture-gemini-ai-key")`));
  await waitFor("Gemini Key 重连入口", () => page.cdp.evaluate(`document.querySelector(".biliscript-live-room-settings-reconnect")?.hidden === false && document.querySelector(".biliscript-live-room-settings-reconnect-text")?.innerText.includes("Gemini Key 已保存")`));
  results.geminiKeySaved = await page.cdp.evaluate(`(() => ({
    credentialHidden: document.querySelector(".biliscript-live-room-gemini-credential")?.hidden,
    reconnectText: document.querySelector(".biliscript-live-room-settings-reconnect-text")?.innerText,
    preset: document.querySelector(".provider-editor-preset")?.value || "gemini"
  }))()`);
  check("R3-gemini-key-save-offers-reconnect", results.geminiKeySaved.credentialHidden && results.geminiKeySaved.reconnectText.includes("重新连接后生效"), results.geminiKeySaved);
  await screenshot(page.cdp, path.join(OUT_DIR, "13-live-room-gemini-key-saved.png"));
  await clickCenter(page, '.live-provider-row[data-provider-id="moss-fixture"] .live-provider-active-radio');
  await waitFor("换房前切回 MOSS", () => worker.evaluate(`chrome.storage.sync.get("activeLiveProviderId").then((value) => value.activeLiveProviderId === "moss-fixture")`));

  const socketsBeforeRoomChange = await socketSummary(offscreen);
  await page.cdp.evaluate(`document.title = "直播间伴看验收 1002"; history.pushState({}, "", "/1002"); window.dispatchEvent(new PopStateEvent("popstate"));`);
  await waitFor("换房间关闭设置与旧连接", async () => {
    const settingsClosed = await page.cdp.evaluate(`!document.getElementById("biliscript-live-room-settings") && document.querySelector(".biliscript-live-room-toggle")?.getAttribute("aria-pressed") === "false"`);
    const sockets = await socketSummary(offscreen);
    return settingsClosed && sockets.at(-1)?.closed === true;
  });
  await clickCenter(page, ".biliscript-live-room-toggle");
  await waitConnected(page);
  const socketsAfterRoomChange = await socketSummary(offscreen);
  results.liveRoomChange = {
    before: socketsBeforeRoomChange,
    after: socketsAfterRoomChange,
    roomIsolation: results.liveRoomIsolation
  };
  check("R4-room-change-stops-old-and-uses-new-room-context", socketsAfterRoomChange.length === socketsBeforeRoomChange.length + 1 && socketsAfterRoomChange.at(-2)?.closed === true && socketsAfterRoomChange.at(-1)?.sessionInstructions.some((text) => text.includes("当前直播间：直播间伴看验收 1002") && !text.includes("1001")), {
    socketCount: [socketsBeforeRoomChange.length, socketsAfterRoomChange.length],
    instructions: socketsAfterRoomChange.at(-1)?.sessionInstructions
  });
  await screenshot(page.cdp, path.join(OUT_DIR, "14-live-room-1002-connected.png"));

  await clickCenter(page, ".live-overlay-close-btn");
  await worker.evaluate(`chrome.storage.sync.set({ activeLiveProviderId: "moss-fixture" })`);
  await page.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("接管标签 A 视频页", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-live-quick-action"))`), { timeoutMs: 45000 });
  await installMediaTracking(page);
  await clickCenter(page, "#biliscript-player-live-quick-action");
  await waitConnected(page);
  const socketsBeforeTakeover = await socketSummary(offscreen);
  const oldSocketIndex = socketsBeforeTakeover.length - 1;
  const created = await page.cdp.send("Target.createTarget", { url: "about:blank" });
  const pageB = await attachTarget(browser, created.targetId);
  watchContentScriptContexts(pageB);
  await pageB.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("接管标签 B 视频页", () => pageB.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-live-quick-action"))`), { timeoutMs: 45000 });
  await installMediaTracking(pageB);
  await clickCenter(pageB, "#biliscript-player-live-quick-action");
  await waitConnected(pageB);
  await waitFor("旧标签停止采集", async () => {
    const media = await readMediaTracking(page);
    return media.media.length > 0 && media.media.every((track) => track.stopped);
  });
  await waitFor("旧标签连接关闭", async () => {
    const sockets = await socketSummary(offscreen);
    return sockets.length === socketsBeforeTakeover.length + 1 && sockets[oldSocketIndex]?.closed === true && sockets.at(-1)?.closed === false;
  });
  results.crossTabTakeover = {
    tabA: await page.cdp.evaluate(`(() => ({
      pressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed"),
      overlayVisible: Boolean(document.getElementById("biliscript-fullscreen-live-overlay") && !document.getElementById("biliscript-fullscreen-live-overlay").hidden)
    }))()`),
    tabB: await pageB.cdp.evaluate(`(() => ({
      pressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed"),
      overlayVisible: Boolean(document.getElementById("biliscript-fullscreen-live-overlay") && !document.getElementById("biliscript-fullscreen-live-overlay").hidden)
    }))()`),
    mediaA: await readMediaTracking(page),
    mediaB: await readMediaTracking(pageB),
    sockets: await socketSummary(offscreen)
  };
  check("X1-old-tab-media-and-socket-stop-new-tab-connected", results.crossTabTakeover.tabA.pressed === "false" && !results.crossTabTakeover.tabA.overlayVisible && results.crossTabTakeover.tabB.pressed === "true" && results.crossTabTakeover.tabB.overlayVisible && results.crossTabTakeover.mediaA.media.every((track) => track.stopped) && results.crossTabTakeover.sockets[oldSocketIndex]?.closed && !results.crossTabTakeover.sockets.at(-1)?.closed, {
    tabA: results.crossTabTakeover.tabA,
    tabB: results.crossTabTakeover.tabB,
    mediaA: results.crossTabTakeover.mediaA,
    oldSocketIndex,
    socketCount: results.crossTabTakeover.sockets.length
  });
  activePage = pageB;
  await screenshot(pageB.cdp, path.join(OUT_DIR, "15-takeover-new-tab-connected.png"));
  await screenshot(page.cdp, path.join(OUT_DIR, "16-takeover-old-tab-stopped.png"));
} catch (error) {
  if (activePage) {
    results.failureDiagnostics = await activePage.cdp.evaluate(`(() => ({
      href: location.href,
      bodyText: document.body.innerText.slice(-5000),
      overlay: document.getElementById("biliscript-fullscreen-live-overlay")?.outerHTML || null,
      reader: document.getElementById("biliscript-reading-view")?.outerHTML.slice(0, 1000) || null,
      liveButton: document.getElementById("biliscript-player-live-quick-action")?.outerHTML || null
    }))()`).catch((diagnosticError) => ({ error: diagnosticError.message }));
    await failShot(activePage, "scenario");
  }
  if (activeOffscreen) {
    results.failureSockets = await activeOffscreen.evaluate("globalThis.__liveSocketSummary?.() || []").catch((diagnosticError) => ({ error: diagnosticError.message }));
  }
  check("scenario-infrastructure", false, { error: error.message, stack: error.stack });
  log(`场景异常：${error.stack || error.message}`);
} finally {
  if (browser) {
    try { await teardown({ browser, cdps }); } catch (error) { log(`收摊异常：${error.message}`); }
  }
  if (distDir) await rm(distDir, { recursive: true, force: true }).catch(() => {});
  await writeEvidence(OUT_DIR, {
    scenario: NAME,
    generatedAt: new Date().toISOString(),
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks,
    results,
    logs: getLog(),
    pages: pageWatchers,
    boundary: "离线 B 站文档/API 与模型 SSE fixture；offscreen WebSocket 为 stub；不使用真实账号、真实凭据或外部 Live 服务。"
  });
  if (checks.some((entry) => !entry.ok) || checks.length === 0) process.exitCode = 1;
}
