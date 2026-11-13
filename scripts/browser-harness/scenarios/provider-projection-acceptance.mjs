#!/usr/bin/env node
// 票 provider-onboarding-consistency/12：生效投影的真机验收——AI 默认平台与模型、
// 对话另选、Live / ASR 激活、搜索智能回退与单平台摘要，必须与**实际请求**一致。
//
// 全程离线：B 站文档与接口、AI 完成请求、搜索请求、Live WebSocket、ASR 音轨与转写
// 全部由本场景回放，不使用真实账号、真实 Key 或外部付费服务。
import path from "node:path";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
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

const NAME = "provider-projection-acceptance";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const BVID = "BV1mAam6tEL8";
const AID = 117370433574328;
const CID = 42393338874;
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/?p=1`;
const ASR_BVID = "BV1xr4y1c7dE";
const ASR_CID = 42393349999;
const ASR_URL = `https://www.bilibili.com/video/${ASR_BVID}/?p=1`;
// 第二个无字幕视频：切换 ASR 平台后用它重新进入抓取链（同视频的字幕已在手，
// reenter 会按 in-hand 让位）。
const ASR_BVID2 = "BV1yf4y1k7mN";
const ASR_URL2 = `https://www.bilibili.com/video/${ASR_BVID2}/?p=1`;
const ASR_AUDIO_BYTES = readFileSync(path.join(REPO_ROOT, "tests/asr/fixtures/fmp4-audio-sample.bin"));
const ASR_AUDIO_URL = "https://upos-sz-mirrorcos.bilivideo.com/fixture/asr-audio.m4s";
// 两个 AI 平台共用已授权的 api.bilibili.com 源，用路径区分（实际请求的 URL 因此
// 能直接指认平台）；ASR 两个平台同源，用路径区分。
const AI_A_BASE = "https://api.bilibili.com/ai-alpha";
const AI_B_BASE = "https://api.bilibili.com/ai-beta";
const ASR_A_BASE = "https://api.bilibili.com/asr-alpha/v1";
const ASR_B_BASE = "https://api.bilibili.com/asr-beta/v1";
const TAVILY_URL_PATTERN = "api.tavily.com/search";
const ANYSEARCH_URL_PATTERN = "api.anysearch.com/v1/search";
const DEEPSEEK_SEARCH_URL_PATTERN = "api.deepseek.com/v1/tools/search";
const LIVE_OVERLAY_ID = "biliscript-fullscreen-live-overlay";

const fixtureRoot = path.join(REPO_ROOT, "tests/fixtures/bilibili/bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureRoot, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureRoot, "bodies.json"), "utf8"));
const subtitleBody = bodies[`${BVID}-zh`];

const checks = [];
const results = {};
const requestLog = [];
const handledInterceptions = new Set();
const pageWatchers = [];
const cdps = [];

function check(name, ok, detail = null) {
  const entry = { name, ok: Boolean(ok), detail };
  checks.push(entry);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === null ? "" : `  ${JSON.stringify(detail).slice(0, 700)}`}`);
  return entry.ok;
}

function videoHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>生效投影真机验收</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#eee;font-family:Arial,sans-serif;overflow:hidden}
.player{position:relative;width:960px;height:540px;margin:24px;background:#050505;border:1px solid #333}
video{width:100%;height:100%;background:#050505}
.controls{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;z-index:2}
.quality{width:70px;height:36px;color:white;background:#333;border:0}
</style></head><body>
<div id="playerWrap"><div id="bilibili-player"><div class="bpx-player-container player"><div class="bpx-player-video-wrap"><video preload="none"></video></div><div class="bpx-player-control-bottom-right controls"><button class="bpx-player-ctrl-quality quality" aria-label="清晰度 1080P">1080P</button></div></div></div></div>
</body></html>`;
}

function viewResponse(bvid = BVID, aid = AID, cid = CID) {
  return {
    code: 0,
    message: "0",
    data: {
      aid,
      bvid,
      cid,
      title: bvid === ASR_BVID ? "无字幕投影验收视频" : "投影闭环真机验收视频",
      desc: "离线 fixture 视频",
      duration: 461,
      pubdate: 1767225600,
      owner: { name: "fixture" },
      pages: [{ cid, page: 1, part: "第一分 P", duration: 461 }]
    }
  };
}

function playerResponse({ bvid = BVID, cid = CID, aid = AID, withSubtitles = true } = {}) {
  const source = bundles[BVID];
  return {
    ...source,
    data: {
      ...source.data,
      aid,
      bvid,
      cid,
      subtitle: {
        ...source.data.subtitle,
        subtitles: withSubtitles ? [source.data.subtitle.subtitles[0]] : []
      }
    }
  };
}

function playurlResponse() {
  return {
    code: 0,
    message: "0",
    data: {
      dash: {
        audio: [
          { baseUrl: ASR_AUDIO_URL, backupUrl: [], bandwidth: 65553, id: 30216 }
        ]
      }
    }
  };
}

function sseHeaders() {
  return [{ name: "content-type", value: "text/event-stream" }];
}

function jsonHeaders() {
  return [{ name: "content-type", value: "application/json" }];
}

function openAiSse(content) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
}

function openAiToolCallSse(query) {
  return [
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "fixture-search-call",
            type: "function",
            function: { name: "web_search", arguments: JSON.stringify({ query }) }
          }]
        },
        finish_reason: null
      }]
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
}

function completionFixture(body) {
  const messages = body?.messages || [];
  const prompt = JSON.stringify(messages);
  // 选区解释的联网轮：带 tools 的请求先要求模型发起一次搜索（流式 / 非流式
  // 两种回包形状必须分开，否则非流式调用方会拿 SSE 当 JSON 解析）；
  // 之后每轮都回正文——配额用尽后工具定义被摘除，请求自然收束为最终回答。
  if (prompt.includes("被观众选中的内容") && Array.isArray(body?.tools) && body.tools.length > 0) {
    // 每一轮工具调用都用新查询词：搜索缓存按查询词键控，重复查询会命中缓存、
    // 不再出网——那样就数不出「单轮上限」对真实请求的约束。
    const query = `离线验收搜索词-${searchRunId}-${searchRound += 1}`;
    if (body?.stream === false) {
      return {
        headers: jsonHeaders(),
        body: JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "fixture-search-call",
                type: "function",
                function: { name: "web_search", arguments: JSON.stringify({ query }) }
              }]
            },
            finish_reason: "tool_calls"
          }]
        })
      };
    }
    return { headers: sseHeaders(), body: openAiToolCallSse(query) };
  }
  const content = prompt.includes("内容助理")
    ? '{"summary":"受控概览摘要","chapters":[],"keyQuotes":[]}'
    : prompt.includes("被观众选中的内容")
      ? "受控解释回答。"
      : "受控对话回答。";
  if (body?.stream === false) {
    return {
      headers: jsonHeaders(),
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] })
    };
  }
  return { headers: sseHeaders(), body: openAiSse(content) };
}

function classifyCompletion(body) {
  const prompt = JSON.stringify(body?.messages || []);
  if (prompt.includes("内容助理")) return "overview";
  if (prompt.includes("被观众选中的内容")) return "explain";
  return "chat";
}

const searchFailures = { anysearch: false };
let searchRunId = 0;
let searchRound = 0;

function fulfilledJson(payload, status = 200) {
  return {
    responseCode: status,
    responseHeaders: jsonHeaders(),
    body: Buffer.from(JSON.stringify(payload)).toString("base64")
  };
}

// 搜索平台回放：Tavily 恒 500（用于真实回退），AnySearch 成功；DeepSeek 搜索
// 只用于「付费准入」证据（请求被真实发出即算进链，不需要成功解析）。
function searchResponseFor(url) {
  if (url.includes(TAVILY_URL_PATTERN)) {
    return fulfilledJson({ detail: "fixture tavily failure" }, 500);
  }
  if (url.includes(ANYSEARCH_URL_PATTERN)) {
    if (searchFailures.anysearch) {
      return fulfilledJson({ detail: "fixture anysearch failure" }, 500);
    }
    return fulfilledJson({
      data: {
        results: [
          { title: "验收搜索结果", url: "https://example.com/fixture-result", snippet: "离线 fixture 摘要" }
        ]
      }
    });
  }
  if (url.includes(DEEPSEEK_SEARCH_URL_PATTERN)) {
    return fulfilledJson({ detail: "fixture deepseek search failure" }, 500);
  }
  return null;
}

let distDir;
let browser;
let page;
let worker;
let offscreen;
let activePage;
let offscreenTargetId = "";

async function createHarnessDist() {
  // Live 两家的域名不在 manifest 常驻 host_permissions 里：与 live-companion-closure
  // 同法在临时 dist 副本里补齐（不改正式构建产物）。
  const dir = await mkdtemp(path.join(os.tmpdir(), "biliscript-projection-dist-"));
  await cp(DEFAULT_DIST, dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions || []),
    "https://api.mosi.cn/*",
    "wss://api.mosi.cn/*",
    "https://generativelanguage.googleapis.com/*",
    "wss://generativelanguage.googleapis.com/*"
  ])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function installWorkerFixtures(handle) {
  const { cdp, sessionId } = handle;
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      const requestId = params.requestId;
      if (handledInterceptions.has(requestId)) return;
      handledInterceptions.add(requestId);
      try {
        if (/x\/web-interface\/view/.test(url)) {
          const bvid = new URL(url).searchParams.get("bvid") || BVID;
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            ...fulfilledJson(bvid === ASR_BVID || bvid === ASR_BVID2
              ? viewResponse(bvid, 11737043359999, ASR_CID)
              : viewResponse())
          }, sessionId);
          return;
        }
        if (/x\/player\/(?:wbi\/)?v2/.test(url)) {
          const bvid = new URL(url).searchParams.get("bvid") || BVID;
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            ...fulfilledJson(bvid === ASR_BVID || bvid === ASR_BVID2
              ? playerResponse({ bvid, cid: ASR_CID, aid: 11737043359999, withSubtitles: false })
              : playerResponse())
          }, sessionId);
          return;
        }
        if (/x\/player\/playurl/.test(url)) {
          await cdp.send("Fetch.fulfillRequest", { requestId, ...fulfilledJson(playurlResponse()) }, sessionId);
          return;
        }
        if (url.includes(`walkthrough-fixture/${BVID}-zh.json`)) {
          await cdp.send("Fetch.fulfillRequest", { requestId, ...fulfilledJson(subtitleBody) }, sessionId);
          return;
        }
        if (url.includes("/chat/completions")) {
          let body = {};
          try { body = JSON.parse(params.request.postData || "{}"); } catch {}
          requestLog.push({ kind: "completion", url, model: body?.model || "", promptKind: classifyCompletion(body), at: Date.now() });
          const fixture = completionFixture(body);
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: fixture.headers,
            body: Buffer.from(fixture.body).toString("base64")
          }, sessionId);
          return;
        }
        const search = searchResponseFor(url);
        if (search) {
          requestLog.push({ kind: "search", url, at: Date.now() });
          await cdp.send("Fetch.fulfillRequest", { requestId, ...search }, sessionId);
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
      } catch {}
    });
  });
}

// AI 流式完成请求在 offscreen 文档发起；ASR 音轨与转写请求也在 offscreen。
// offscreen 可能在 ASR 终态自关，本场景把 ASR 放在最后（见主流程次序）。
function installOffscreenFixtures(cdp) {
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      const requestId = params.requestId;
      const method = params.request?.method || "GET";
      if (handledInterceptions.has(requestId)) return;
      handledInterceptions.add(requestId);
      try {
        if (url.includes("/chat/completions")) {
          let body = {};
          try { body = JSON.parse(params.request.postData || "{}"); } catch {}
          requestLog.push({ kind: "completion", url, model: body?.model || "", promptKind: classifyCompletion(body), at: Date.now() });
          const fixture = completionFixture(body);
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: fixture.headers,
            body: Buffer.from(fixture.body).toString("base64")
          });
          return;
        }
        if (url.startsWith(ASR_AUDIO_URL)) {
          requestLog.push({ kind: "asr-audio", url, method, at: Date.now() });
          if (method === "HEAD") {
            await cdp.send("Fetch.fulfillRequest", {
              requestId,
              responseCode: 200,
              responseHeaders: [
                { name: "content-type", value: "audio/mp4" },
                { name: "content-length", value: String(ASR_AUDIO_BYTES.length) }
              ],
              body: ""
            });
            return;
          }
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "audio/mp4" }],
            body: ASR_AUDIO_BYTES.toString("base64")
          });
          return;
        }
        if (url.includes("/audio/transcriptions")) {
          requestLog.push({ kind: "transcription", url, at: Date.now() });
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            ...fulfilledJson({
              text: "离线验收语音字幕内容。",
              segments: [{ start: 0, end: 30, text: "离线验收语音字幕内容。" }],
              language: "zh"
            })
          });
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId });
      } catch {}
    });
  });
}

function installDocumentFixture(pageCdp) {
  return pageCdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "https://www.bilibili.com/video/*", requestStage: "Request" }]
  }).then(() => {
    pageCdp.on("Fetch.requestPaused", async (params) => {
      try {
        if (params.resourceType === "Document") {
          await pageCdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
            body: Buffer.from(videoHtml()).toString("base64")
          });
        } else {
          await pageCdp.send("Fetch.continueRequest", { requestId: params.requestId });
        }
      } catch {}
    });
  });
}

// offscreen 文档可能在长流程中被回收/重建（ASR 终态自关、会话收尾）：每个依赖它
// 的阶段前重新确认文档存在并把 fixture 挂到当前 target 上，避免补丁静默失效。
async function ensureOffscreenDocument(workerSession) {
  await workerSession.evaluate(`(async () => {
    const url = chrome.runtime.getURL("entry/offscreen.html");
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] }).catch(() => []);
    if (Array.isArray(contexts) && contexts.length > 0) return true;
    await chrome.offscreen.createDocument({
      url,
      reasons: ["BLOBS"],
      justification: "Offline projection acceptance fixture"
    }).catch(() => null);
    return true;
  })()`);
}

async function refreshOffscreen() {
  const response = await fetch(`http://127.0.0.1:${browser.port}/json/list`);
  const targets = await response.json();
  const target = targets.find((item) => item.type !== "page" && String(item.url).endsWith("/entry/offscreen.html"));
  if (!target?.webSocketDebuggerUrl) return null;
  const targetId = target.targetId || target.id || "";
  if (offscreen && targetId === offscreenTargetId) return offscreen;
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdps.push(cdp);
  offscreen = cdp;
  offscreenTargetId = targetId;
  await cdp.send("Runtime.enable");
  await installOffscreenFixtures(cdp);
  await installLiveSocketStub(cdp);
  return cdp;
}

// ASR 终态会让 offscreen 文档自关：第二次转写前重新确保文档存在并把 fixture 挂上，
// 用 stub 标记（__fixtureLive）自检这次真的挂到了当前文档。
async function prepareOffscreenForAsr(workerSession) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(600);
    await ensureOffscreenDocument(workerSession);
    const cdp = await refreshOffscreen();
    if (!cdp) continue;
    const attached = await cdp.evaluate("Boolean(globalThis.__fixtureLive)").catch(() => false);
    if (attached) return cdp;
    offscreen = null;
    offscreenTargetId = "";
  }
  throw new Error("无法把 fixture 挂到当前 offscreen 文档");
}

async function attachOffscreen(browserInstance) {
  const target = await waitFor("offscreen target", async () => {
    const response = await fetch(`http://127.0.0.1:${browserInstance.port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type !== "page" && String(item.url).endsWith("/entry/offscreen.html"));
  }, { timeoutMs: 30000 });
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdps.push(cdp);
  offscreenTargetId = target.id || target.targetId || "";
  await cdp.send("Runtime.enable");
  return cdp;
}

// 离线 WebSocket 替身（Live 会话）：记录连接 URL 与会话指令，不发任何真实流量。
async function installLiveSocketStub(offscreenCdp) {
  await offscreenCdp.evaluate(`(() => {
    const sockets = [];
    const state = { sockets };
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
        sockets.push(this);
        setTimeout(() => {
          if (this.closed) return;
          this.readyState = 1;
          this.onopen?.({});
        }, 10);
      }
      send(data) {
        if (this.readyState !== 1 || this.closed) return;
        this.sent.push(typeof data === "string" ? data : { binaryBytes: data.byteLength });
        if (typeof data !== "string") return;
        let message;
        try { message = JSON.parse(data); } catch { return; }
        const action = message.type || message.action || "";
        // MOSS 的会话更新 / Gemini 的裸 setup 帧（Gemini 无 type 字段）都要回
        // 各自的握手完成回执，否则客户端按握手超时判连接失败。
        if (message.setup) {
          this.emit({ setupComplete: {} });
          return;
        }
        if (action === "attach_session") this.emit({ type: "session_attached", session_id: "fixture-live-session" });
        if (action === "session.update") {
          this.emit({ type: "session.updated", error: "" });
        }
      }
      emit(message) { setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) }), 0); }
      close(code = 1000, reason = "fixture close") {
        if (this.closed) return;
        this.closed = true;
        this.readyState = 3;
        setTimeout(() => this.onclose?.({ code, reason }), 0);
      }
    }
    globalThis.WebSocket = FixtureWebSocket;
    globalThis.__fixtureLive = state;
    globalThis.__liveSocketSummary = () => sockets.map((socket, index) => ({
      index,
      url: socket.url,
      closed: socket.closed,
      setupModels: socket.sent.filter((item) => typeof item === "string").flatMap((item) => {
        try {
          const value = JSON.parse(item);
          const model = value.setup?.model || value.session?.model || value.session?.setup?.model || "";
          return model ? [String(model)] : [];
        } catch { return []; }
      }),
      sentTypes: socket.sent.filter((item) => typeof item === "string").map((item) => {
        try { const value = JSON.parse(item); return value.type || value.action || "json"; } catch { return "invalid"; }
      })
    }));
  })()`);
}

// ===== 真实输入 / 读取 =====
async function clickCenter(pageCdp, selector) {
  const point = await waitFor(`真实点击目标 ${selector}`, async () => {
    const value = await pageCdp.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { blocked: "missing" };
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return { blocked: "zero-size", rect: [rect.width, rect.height] };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!(hit === element || element.contains(hit))) {
        return { blocked: "covered", rect: [rect.left, rect.top, rect.width, rect.height], hit: hit?.className || hit?.tagName || null };
      }
      return { x, y, width: rect.width, height: rect.height };
    })()`);
    if (value && value.blocked) throw new Error(`不可点击：${JSON.stringify(value)}`);
    return value;
  }, { timeoutMs: 10000, intervalMs: 100 });
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
}

async function fillField(pageCdp, selector, text) {
  await clickCenter(pageCdp, selector);
  await pageCdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await pageCdp.send("Input.insertText", { text });
  await sleep(60);
}

// 范围滑块用真实键盘事件落值：先点中心取得焦点（点击本身可能跳值），Home 回到
// 最小值，再逐档 ArrowRight 到目标值——每一步都是浏览器原生的 input/change。
async function setRangeByKeyboard(pageCdp, selector, targetValue) {
  await clickCenter(pageCdp, selector);
  const press = async (key, code, virtualKeyCode) => {
    await pageCdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
    await pageCdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
    await sleep(80);
  };
  await press("Home", "Home", 36);
  for (let value = 1; value < Number(targetValue); value += 1) {
    await press("ArrowRight", "ArrowRight", 39);
  }
  await sleep(400);
}

async function failShot(pageCdp, name) {
  try {
    await screenshot(pageCdp, path.join(OUT_DIR, `failure-${name}.png`));
  } catch (error) {
    log(`失败截图未生成：${error.message}`);
  }
}

// content script 隔离世界的执行上下文（keepalive 端口只能在扩展语境里开）。
function watchContentScriptContexts(pageCdp) {
  const contexts = new Set();
  pageCdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.isDefault === false) contexts.add(context.id);
  });
  pageCdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(executionContextId));
  pageCdp.on("Runtime.executionContextsCleared", () => contexts.clear());
  return contexts;
}

async function evaluateInContentScript(pageCdp, contexts, expression) {
  return waitFor("内容脚本隔离世界", async () => {
    for (const contextId of contexts) {
      const result = await pageCdp.send("Runtime.evaluate", {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true
      }).catch(() => null);
      if (result?.result?.value?.__biliscript) return result.result.value;
    }
    return null;
  }, { timeoutMs: 20000 });
}

// offscreen 文档会因 ASR 终态自关：从内容脚本持有一个聊天端口，让文档在整个场景
// 内保持同一个 target（fixture 因此不会在第二轮转写时静默失效）。整页导航会断开
// 端口，每次导航后重开。
async function ensureOffscreenKeepAlive(pageCdp, contexts) {
  return evaluateInContentScript(pageCdp, contexts, `(() => {
    if (!globalThis.__harnessOffscreenKeepAlive || !globalThis.__harnessOffscreenKeepAlive.__connected) {
      const port = chrome.runtime.connect({ name: "offscreen-chat" });
      port.__connected = true;
      port.onDisconnect.addListener(() => { port.__connected = false; });
      globalThis.__harnessOffscreenKeepAlive = port;
    }
    return { __biliscript: true, connected: true, runtimeId: chrome.runtime.id };
  })()`);
}

async function hoverPlayer(pageCdp) {
  const point = await pageCdp.evaluate(`(() => {
    const host = document.querySelector(".bpx-player-container");
    const rect = host.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
  await waitFor("AI 快捷动作显形", () => pageCdp.evaluate(`document.getElementById("biliscript-player-ai-quick-action")?.closest(".biliscript-player-ai-wrap")?.classList.contains("is-active") === true`), { timeoutMs: 8000 });
}

async function openReader(pageCdp) {
  await hoverPlayer(pageCdp);
  await clickCenter(pageCdp, "#biliscript-player-ai-quick-action");
  await waitFor("阅读视图打开", () => pageCdp.evaluate(`document.getElementById("biliscript-reading-view")?.classList.contains("open") === true && Boolean(document.getElementById("biliscript-reading-chat-input"))`), { timeoutMs: 45000 });
}

async function activateTab(pageCdp, tabId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clickCenter(pageCdp, `#${tabId}`);
    const active = await waitFor(
      `激活标签 ${tabId}`,
      () => pageCdp.evaluate(`document.getElementById(${JSON.stringify(tabId)})?.classList.contains("is-active") === true`),
      { timeoutMs: 6000 }
    ).catch(() => false);
    if (active) return;
  }
  throw new Error(`标签激活失败：${tabId}`);
}

async function openSettingsSection(pageCdp, section) {
  await clickCenter(pageCdp, "#biliscript-reading-settings-btn");
  await waitFor("设置抽屉打开", () => pageCdp.evaluate(`document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") === true`), { timeoutMs: 15000 });
  await clickCenter(pageCdp, `.biliscript-settings-nav-item[data-section="${section}"]`);
  await sleep(400);
}

async function closeSettings(pageCdp) {
  await clickCenter(pageCdp, "#biliscript-reading-settings-back-btn");
  await waitFor("设置抽屉关闭", () => pageCdp.evaluate(`document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") !== true`), { timeoutMs: 10000 });
}

async function selectExplainText(pageCdp) {
  const selection = await pageCdp.evaluate(`(() => {
    const item = document.querySelector('#biliscript-reading-subtitle .biliscript-reading-item[data-index="0"]');
    const textNode = item && Array.from(item.querySelectorAll(".biliscript-reading-text")[0]?.childNodes || []).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length >= 4);
    if (!textNode) return null;
    const raw = textNode.textContent;
    const trimmed = raw.trim().slice(0, 4);
    const start = raw.indexOf(trimmed);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + trimmed.length);
    const current = window.getSelection();
    current.removeAllRanges();
    current.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return { text: trimmed };
  })()`);
  if (!selection) throw new Error("字幕条目里找不到可选中文本");
  await waitFor("解释浮层显形", () => pageCdp.evaluate(`document.getElementById("biliscript-reading-explain-pop")?.hidden === false`), { timeoutMs: 8000 });
  return selection;
}

async function runExplainWithSearch(pageCdp, workerSession, answerNeedle = "受控解释回答") {
  // 每次解释都换一轮查询词并清引擎健康度（连败 3 次会触发冷却，跨轮会改变链）。
  searchRunId += 1;
  searchRound = 0;
  await workerSession.evaluate(`chrome.storage.local.remove("biliscript_search_health")`).catch(() => {});
  await activateTab(pageCdp, "biliscript-reading-tab-subtitle");
  await waitFor("字幕列表就绪", () => pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length > 0`), { timeoutMs: 45000 });
  await selectExplainText(pageCdp);
  await clickCenter(pageCdp, ".biliscript-reading-explain-btn");
  const card = await waitFor("解释卡完成", () => pageCdp.evaluate(`(() => {
    const answer = document.querySelector("#biliscript-reading-explain-card .biliscript-reading-explain-card-answer");
    const text = answer?.innerText?.trim() || "";
    if (!text.includes(${JSON.stringify(answerNeedle)})) return null;
    return { text, notice: document.querySelector("#biliscript-reading-explain-card .biliscript-reading-explain-card-notice")?.innerText || "" };
  })()`), { timeoutMs: 60000 });
  await clickCenter(pageCdp, '#biliscript-reading-explain-card [data-explain-card-action="close"]');
  return card;
}

function searchRequests() {
  return requestLog.filter((entry) => entry.kind === "search");
}

const completions = () => requestLog.filter((entry) => entry.kind === "completion");
const transcriptions = () => requestLog.filter((entry) => entry.kind === "transcription");

async function seedAiProviders(workerSession) {
  await workerSession.evaluate(`(async () => {
    await chrome.storage.sync.set({
      aiProviders: [
        { id: "ai-alpha", presetId: "custom", name: "AI Alpha", baseUrl: ${JSON.stringify(AI_A_BASE)}, models: ["model-alpha", "model-alpha-2"], requiresKey: true, enabled: true, protocol: "openai" },
        { id: "ai-beta", presetId: "custom", name: "AI Beta", baseUrl: ${JSON.stringify(AI_B_BASE)}, models: ["model-beta"], requiresKey: true, enabled: true, protocol: "openai" }
      ],
      defaultModel: "ai-alpha"
    });
    await chrome.storage.local.set({ aiProviderKeys: { "ai-alpha": "fixture-alpha-key", "ai-beta": "fixture-beta-key" } });
    // 对话面板的存储选中项（另一端的显式选择）：Beta / model-beta，而默认平台是 Alpha
    await chrome.storage.local.set({ biliscript_ai_selected_provider: "ai-beta\\u0001model-beta" });
    return true;
  })()`);
}

async function seedSearchProviders(workerSession) {
  await workerSession.evaluate(`(async () => {
    await chrome.storage.sync.set({
      searchProviders: [
        { id: "search_tavily", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true },
        { id: "search_anysearch", presetId: "anysearch", name: "AnySearch", type: "anysearch", baseUrl: "https://api.anysearch.com", enabled: true },
        { id: "search_deepseek", presetId: "deepseek", name: "DeepSeek Search", type: "deepseek", baseUrl: "https://api.deepseek.com", enabled: true }
      ],
      activeSearchProviderId: "",
      allowPaidSearchProviders: false,
      webSearchMaxToolCalls: 5,
      webSearchEnabled: true,
      searchOptInNoticeAcknowledged: true
    });
    // 付费准入的行为证据需要 AI 族的官方 DeepSeek 记录（凭据引用单向读取）。
    const ai = await chrome.storage.sync.get("aiProviders");
    const providers = Array.isArray(ai.aiProviders) ? ai.aiProviders : [];
    if (!providers.some((provider) => provider.id === "ai-deepseek-official")) {
      providers.push({ id: "ai-deepseek-official", presetId: "deepseek", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"], requiresKey: true, enabled: true, protocol: "openai" });
    }
    await chrome.storage.sync.set({ aiProviders: providers });
    const keys = await chrome.storage.local.get("aiProviderKeys");
    await chrome.storage.local.set({ aiProviderKeys: { ...(keys.aiProviderKeys || {}), "ai-deepseek-official": "fixture-deepseek-key" } });
    return true;
  })()`);
}

async function searchChainControlState(pageCdp) {
  return pageCdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll("#searchProvidersList .search-provider-row")];
    return {
      order: rows.map((row) => row.dataset.providerId),
      names: rows.map((row) => row.querySelector(".provider-row-name")?.textContent?.trim() || ""),
      summary: document.getElementById("searchChainActiveSummary")?.textContent?.trim() || "",
      note: document.querySelector("#searchChainContainer .search-chain-mode-note")?.textContent?.trim() || "",
      footerHidden: document.querySelector("#searchChainContainer .search-chain-footer-bar")?.hidden === true,
      paidRowHidden: document.getElementById("allowPaidSearchProviders")?.closest(".biliscript-toggle-row")?.hidden === true,
      paidChecked: document.getElementById("allowPaidSearchProviders")?.checked === true,
      maxCallsVisible: (() => {
        const node = document.getElementById("webSearchMaxToolCallsContainer");
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.hidden;
      })(),
      maxCallsBadge: document.getElementById("webSearchMaxToolCallsValue")?.textContent?.trim() || "",
      resetDisabled: document.getElementById("resetSearchProviderOrderBtn")?.disabled === true
    };
  })()`);
}

async function expandSearchChain(pageCdp) {
  const expanded = await pageCdp.evaluate(`document.getElementById("toggleSearchChainBtn")?.getAttribute("aria-expanded") === "true"`);
  if (!expanded) {
    await clickCenter(pageCdp, "#toggleSearchChainBtn");
    await waitFor("搜索链展开", () => pageCdp.evaluate(`document.getElementById("toggleSearchChainBtn")?.getAttribute("aria-expanded") === "true" && document.getElementById("searchChainContainer")?.hidden === false`), { timeoutMs: 8000 });
  }
  await sleep(200);
}

async function clickSearchRadio(pageCdp, providerId) {
  await clickCenter(pageCdp, `#searchProvidersList .search-provider-row[data-provider-id="${providerId}"] .search-provider-active-radio`);
  await waitFor(`搜索选中态 ${providerId}`, () => pageCdp.evaluate(`document.querySelector('#searchProvidersList .search-provider-row[data-provider-id="${providerId}"] .search-provider-active-radio')?.checked === true`), { timeoutMs: 8000 });
  await sleep(400);
}

// ===== 主流程 =====
try {
  distDir = await createHarnessDist();
  browser = await launchBrowser({
    distDir,
    autoplay: true,
    muted: true,
    extraArgs: ["--use-fake-device-for-media-stream"]
  });
  page = await attachPage(browser);
  activePage = page;
  cdps.push(page.cdp);
  pageWatchers.push(watchPage(page.cdp));
  const contentScriptContexts = watchContentScriptContexts(page.cdp);
  await installDocumentFixture(page.cdp);

  worker = createWorkerSession({ pageCdp: page.cdp, browser, distDir, onReconnect: installWorkerFixtures });
  if (!(await worker.ensureAlive())) throw new Error("扩展 SW 不可用");
  await worker.evaluate(`(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    await chrome.storage.sync.set({
      enablePlayerAiQuickAction: true,
      autoOpenReader: false,
      asrAutoFallback: false,
      webSearchEnabled: true,
      searchOptInNoticeAcknowledged: true,
      aiProviders: [],
      liveProviders: [],
      asrProviders: [],
      searchProviders: []
    });
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("entry/offscreen.html"),
      reasons: ["BLOBS"],
      justification: "Offline projection acceptance fixture"
    });
    return true;
  })()`);
  offscreen = await attachOffscreen(browser);
  await installOffscreenFixtures(offscreen);
  await installLiveSocketStub(offscreen);
  await page.cdp.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "granted", origin: "https://www.bilibili.com" });
  await refreshOffscreen();

  await page.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("视频页扩展按钮", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");

  // ============================================================
  // B1 AI 默认平台 / 模型 / 对话另选 / 回落与不可用
  // ============================================================
  await seedAiProviders(worker);
  await openReader(page.cdp);
  results.keepAlive = await ensureOffscreenKeepAlive(page.cdp, contentScriptContexts);
  await activateTab(page.cdp, "biliscript-reading-tab-chat");
  await openSettingsSection(page.cdp, "llm");
  const aiProjection = await waitFor("AI 生效投影", () => page.cdp.evaluate(`(() => {
    const summary = document.getElementById("aiActiveDefaultSummary")?.textContent?.trim() || "";
    if (!summary.includes("AI Alpha")) return null;
    const alphaRow = document.querySelector('#aiProvidersList .ai-provider-row[data-provider-id="ai-alpha"]');
    const betaRow = document.querySelector('#aiProvidersList .ai-provider-row[data-provider-id="ai-beta"]');
    const firstOption = document.querySelector("#subtitleTranslateModel option")?.textContent?.trim() || "";
    return {
      summary,
      chatLine: document.getElementById("aiChatSelectionSummary")?.textContent?.trim() || "",
      chatLineHidden: document.getElementById("aiChatSelectionSummary")?.hidden === true,
      alphaBadge: alphaRow?.querySelector(".provider-row-badge")?.textContent?.trim() || "",
      alphaModel: alphaRow?.querySelector(".provider-row-model")?.textContent?.trim() || "",
      betaBadge: betaRow?.querySelector(".provider-row-badge")?.textContent?.trim() || "",
      followHint: document.getElementById("subtitleTranslateFollowHint")?.textContent?.trim() || "",
      followHintHidden: document.getElementById("subtitleTranslateFollowHint")?.hidden === true,
      followHintState: document.getElementById("subtitleTranslateFollowHint")?.dataset?.state || "",
      firstOption
    };
  })()`), { timeoutMs: 20000 });
  results.aiProjection = aiProjection;
  check(
    "B1.1-默认徽标与模型投影指向生效默认平台",
    aiProjection.summary.includes("概览与解释将使用 AI Alpha · model-alpha") &&
      !aiProjection.summary.includes("回落") &&
      aiProjection.alphaBadge === "默认" &&
      aiProjection.alphaModel === "model-alpha" &&
      aiProjection.betaBadge === "",
    aiProjection
  );
  check(
    "B1.2-字幕翻译跟随 AI 默认平台",
    aiProjection.firstOption === "跟随 AI 默认平台" &&
      aiProjection.followHintHidden === false &&
      aiProjection.followHintState === "follow" &&
      aiProjection.followHint === "当前 AI Alpha · model-alpha",
    {
      firstOption: aiProjection.firstOption,
      followHint: aiProjection.followHint,
      hidden: aiProjection.followHintHidden,
      state: aiProjection.followHintState
    }
  );
  check(
    "B1.3-对话另选单独成行且不改变默认",
    !aiProjection.chatLineHidden && aiProjection.chatLine.includes("对话当前使用 AI Beta · model-beta") && aiProjection.summary.includes("AI Alpha"),
    { chatLine: aiProjection.chatLine, hidden: aiProjection.chatLineHidden, summary: aiProjection.summary }
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "01-ai-projection.png"));

  // 默认平台的真实请求：概览（Alpha / model-alpha）
  await closeSettings(page.cdp);
  await activateTab(page.cdp, "biliscript-reading-tab-overview");
  await waitFor("概览生成完成", () => page.cdp.evaluate(`(() => {
    const summary = document.querySelector("#biliscript-reading-overview-body .biliscript-reading-ov-summary")?.textContent?.trim() || "";
    return summary.includes("受控概览摘要");
  })()`), { timeoutMs: 45000 });
  const overviewCompletion = completions().filter((entry) => entry.promptKind === "overview").at(-1);
  results.overviewRequest = overviewCompletion;
  check(
    "B1.4-概览实际请求使用默认平台与模型",
    overviewCompletion?.url === `${AI_A_BASE}/chat/completions` && overviewCompletion?.model === "model-alpha",
    overviewCompletion
  );

  // 对话另选的真实请求：Beta / model-beta
  await activateTab(page.cdp, "biliscript-reading-tab-chat");
  await waitFor("对话输入可用", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-input") && !document.getElementById("biliscript-reading-chat-input").disabled`), { timeoutMs: 30000 });
  await fillField(page.cdp, "#biliscript-reading-chat-input", "投影验收：另选平台问答");
  await waitFor("发送键可用", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-send-btn")?.disabled === false`));
  await clickCenter(page.cdp, "#biliscript-reading-chat-send-btn");
  await waitFor("对话回答上屏", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-messages")?.innerText.includes("受控对话回答")`), { timeoutMs: 45000 });
  const chatCompletion = completions().filter((entry) => entry.promptKind === "chat").at(-1);
  results.chatRequest = chatCompletion;
  check(
    "B1.5-对话实际请求使用另选的平台与模型",
    chatCompletion?.url === `${AI_B_BASE}/chat/completions` && chatCompletion?.model === "model-beta",
    chatCompletion
  );

  // 删除默认平台 → 摘要显示真实回落（不是陈旧成功）
  await openSettingsSection(page.cdp, "llm");
  await clickCenter(page.cdp, '#aiProvidersList .ai-provider-row[data-provider-id="ai-alpha"] .provider-row-remove');
  await clickCenter(page.cdp, ".confirm-dialog-confirm");
  const fallbackProjection = await waitFor("默认平台删除后的回落投影", () => page.cdp.evaluate(`(() => {
    const summary = document.getElementById("aiActiveDefaultSummary")?.textContent?.trim() || "";
    if (!summary.includes("回落")) return null;
    const betaRow = document.querySelector('#aiProvidersList .ai-provider-row[data-provider-id="ai-beta"]');
    return {
      summary,
      betaBadge: betaRow?.querySelector(".provider-row-badge")?.textContent?.trim() || "",
      betaModel: betaRow?.querySelector(".provider-row-model")?.textContent?.trim() || "",
      chatLineHidden: document.getElementById("aiChatSelectionSummary")?.hidden === true
    };
  })()`), { timeoutMs: 20000 });
  results.fallbackProjection = fallbackProjection;
  check(
    "B1.6-默认平台删除后显示真实回落",
    fallbackProjection.summary.includes("已回落至 AI Beta · model-beta") &&
      fallbackProjection.betaBadge === "默认" &&
      fallbackProjection.chatLineHidden === true,
    fallbackProjection
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "02-ai-fallback.png"));

  // 删除全部平台 → 摘要不可用，且概览请求确实失败（不展示陈旧成功态）
  await clickCenter(page.cdp, '#aiProvidersList .ai-provider-row[data-provider-id="ai-beta"] .provider-row-remove');
  await clickCenter(page.cdp, ".confirm-dialog-confirm");
  const unavailableProjection = await waitFor("无平台不可用投影", () => page.cdp.evaluate(`(() => {
    const summary = document.getElementById("aiActiveDefaultSummary")?.textContent?.trim() || "";
    if (!summary.includes("不可用")) return null;
    return { summary, chatLineHidden: document.getElementById("aiChatSelectionSummary")?.hidden === true };
  })()`), { timeoutMs: 20000 });
  results.unavailableProjection = unavailableProjection;
  check("B1.7-无平台时摘要显示不可用", unavailableProjection.chatLineHidden === true, unavailableProjection);
  await closeSettings(page.cdp);
  // 同一身份键的 ready 概览不会自动重跑：刷新页面拿到干净的「无平台 → 概览错误」
  // 起点，证明不可用投影与实际请求失败一致。
  await page.cdp.send("Page.reload", { ignoreCache: false });
  await waitFor("刷新后视频页扩展按钮", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await activateTab(page.cdp, "biliscript-reading-tab-overview");
  const unavailableOverview = await waitFor("概览不可用错误条", () => page.cdp.evaluate(`(() => {
    const strip = document.querySelector("#biliscript-reading-overview-body .biliscript-reading-ov-strip.is-error");
    return strip?.innerText?.includes("还没有配置 AI 平台") ? { text: strip.innerText } : null;
  })()`), { timeoutMs: 45000 });
  results.unavailableOverview = unavailableOverview;
  check("B1.8-不可用投影与实际请求失败一致", Boolean(unavailableOverview), unavailableOverview);

  // ============================================================
  // B2 搜索：模式摘要 / 可见性 / 付费准入 / 次数上限 / 排序恢复 / 实际回退
  // ============================================================
  await seedAiProviders(worker);
  await seedSearchProviders(worker);
  await openSettingsSection(page.cdp, "search");
  await expandSearchChain(page.cdp);
  const smartState = await searchChainControlState(page.cdp);
  results.smartState = smartState;
  check(
    "B2.1-智能模式摘要与控件可见性",
    smartState.summary === "智能搜索 · 失败自动回退" &&
      smartState.note.includes("按下方列表顺序依次尝试，失败自动回退") &&
      smartState.footerHidden === false &&
      smartState.paidRowHidden === false &&
      smartState.maxCallsVisible === true &&
      smartState.order.slice(1).join(",") === "search_tavily,search_anysearch,search_deepseek",
    smartState
  );
  check("B2.2-单轮搜索次数上限两种模式都可见", smartState.maxCallsVisible === true && smartState.maxCallsBadge === "5", { visible: smartState.maxCallsVisible, badge: smartState.maxCallsBadge });
  await screenshot(page.cdp, path.join(OUT_DIR, "03-search-smart.png"));

  // 先把单轮上限收到 2：模型每轮都发起一次搜索，不同轮用不同查询词（不经缓存），
  // 于是「轮数 × 链长」就是实际搜索请求数——上限是否生效可以直接数请求。
  await setRangeByKeyboard(page.cdp, "#webSearchMaxToolCalls", 2);
  const maxCallsState = await waitFor("次数上限落值", () => page.cdp.evaluate(`(() => {
    const badge = document.getElementById("webSearchMaxToolCallsValue")?.textContent?.trim() || "";
    return badge === "2" ? { badge } : null;
  })()`), { timeoutMs: 10000 });
  results.maxCalls = maxCallsState;
  results.maxCalls.stored = await waitFor("次数上限落盘", () => worker.evaluate(`chrome.storage.sync.get("webSearchMaxToolCalls").then((value) => value.webSearchMaxToolCalls)`).then((value) => Number(value) === 2 ? value : null), { timeoutMs: 8000 });
  check("B2.3-次数上限落盘", maxCallsState.badge === "2" && Number(results.maxCalls.stored) === 2, results.maxCalls);
  await closeSettings(page.cdp);

  // 智能模式的实际回退：两轮各 2 家（Tavily 500 → AnySearch 成功）
  const searchBeforeSmart = searchRequests().length;
  const smartExplain = await runExplainWithSearch(page.cdp, worker);
  const smartSearchUrls = searchRequests().slice(searchBeforeSmart).map((entry) => entry.url);
  results.smartSearch = { urls: smartSearchUrls, card: smartExplain };
  check(
    "B2.4-智能搜索按链序真实回退且遵守单轮上限",
    smartSearchUrls.length === 4 &&
      smartSearchUrls[0].includes(TAVILY_URL_PATTERN) &&
      smartSearchUrls[1].includes(ANYSEARCH_URL_PATTERN) &&
      smartSearchUrls[2].includes(TAVILY_URL_PATTERN) &&
      smartSearchUrls[3].includes(ANYSEARCH_URL_PATTERN),
    results.smartSearch
  );

  // 单平台：Tavily 失败不回退（两轮都只打 Tavily）
  await openSettingsSection(page.cdp, "search");
  await expandSearchChain(page.cdp);
  await clickSearchRadio(page.cdp, "search_tavily");
  const singleTavily = await searchChainControlState(page.cdp);
  results.singleTavily = singleTavily;
  check(
    "B2.5-单平台摘要说明失败不回退并隐藏无效控件",
    singleTavily.summary === "仅使用 Tavily · 失败不回退" &&
      singleTavily.note.includes("失败不会切换到其他平台") &&
      singleTavily.footerHidden === true &&
      singleTavily.paidRowHidden === true &&
      singleTavily.maxCallsVisible === true &&
      singleTavily.order.slice(1).join(",") === "search_tavily,search_anysearch,search_deepseek",
    singleTavily
  );
  await closeSettings(page.cdp);
  const searchBeforeSingle = searchRequests().length;
  const singleExplain = await runExplainWithSearch(page.cdp, worker);
  const singleSearchUrls = searchRequests().slice(searchBeforeSingle).map((entry) => entry.url);
  results.singleSearch = { urls: singleSearchUrls, card: singleExplain };
  check(
    "B2.6-单平台失败不切换到其他平台",
    singleSearchUrls.length === 2 && singleSearchUrls.every((url) => url.includes(TAVILY_URL_PATTERN)),
    results.singleSearch
  );

  // 单平台成功的实际请求：只打 AnySearch
  await openSettingsSection(page.cdp, "search");
  await expandSearchChain(page.cdp);
  await clickSearchRadio(page.cdp, "search_anysearch");
  await closeSettings(page.cdp);
  const searchBeforeAny = searchRequests().length;
  await runExplainWithSearch(page.cdp, worker);
  const anySearchUrls = searchRequests().slice(searchBeforeAny).map((entry) => entry.url);
  results.anySearch = { urls: anySearchUrls };
  check(
    "B2.7-单平台只使用所选平台",
    anySearchUrls.length === 2 && anySearchUrls.every((url) => url.includes(ANYSEARCH_URL_PATTERN)),
    results.anySearch
  );

  // 付费准入：智能模式下勾选后摘要加「可能使用付费平台」，链尾出现付费平台
  await openSettingsSection(page.cdp, "search");
  await expandSearchChain(page.cdp);
  await clickSearchRadio(page.cdp, "__smart__");
  const paidOff = await searchChainControlState(page.cdp);
  check("B2.8-智能模式回到默认摘要且控件恢复", paidOff.summary === "智能搜索 · 失败自动回退" && paidOff.footerHidden === false && paidOff.paidRowHidden === false, paidOff);
  await clickCenter(page.cdp, ".biliscript-toggle-row:has(#allowPaidSearchProviders) .biliscript-toggle-track");
  const paidOn = await waitFor("付费准入摘要", () => page.cdp.evaluate(`(() => {
    const summary = document.getElementById("searchChainActiveSummary")?.textContent?.trim() || "";
    const checked = document.getElementById("allowPaidSearchProviders")?.checked === true;
    return checked && summary.includes("可能使用付费平台") ? { summary, checked } : null;
  })()`), { timeoutMs: 15000 });
  await waitFor("付费准入落盘", () => worker.evaluate(`chrome.storage.sync.get("allowPaidSearchProviders").then((value) => value.allowPaidSearchProviders)`).then((value) => value === true), { timeoutMs: 8000 });
  results.paidChain = await offscreen.evaluate(`chrome.runtime.sendMessage({ type: "resolve-search-provider" })`);
  results.deepseekRowNote = await page.cdp.evaluate(`document.querySelector('#searchProvidersList .search-provider-row[data-provider-id="search_deepseek"] .provider-row-model')?.textContent?.trim() || ""`);
  results.paidOn = paidOn;
  check("B2.9-付费准入在智能模式摘要中明示", paidOn.summary === "智能搜索 · 失败自动回退 · 可能使用付费平台", paidOn);
  await closeSettings(page.cdp);
  // 让两家免 Key 平台都失败，逼真实链尾走到付费平台（DeepSeek Search）。
  searchFailures.anysearch = true;
  const searchBeforePaid = searchRequests().length;
  await runExplainWithSearch(page.cdp, worker);
  const paidSearchUrls = searchRequests().slice(searchBeforePaid).map((entry) => entry.url);
  searchFailures.anysearch = false;
  results.paidSearch = { urls: paidSearchUrls };
  check(
    "B2.10-付费准入放开后实际链尾使用付费平台",
    paidSearchUrls.length === 6 &&
      paidSearchUrls[0].includes(TAVILY_URL_PATTERN) &&
      paidSearchUrls[1].includes(ANYSEARCH_URL_PATTERN) &&
      paidSearchUrls[2].includes(DEEPSEEK_SEARCH_URL_PATTERN),
    results.paidSearch
  );

  // 上限回到 5：同样的两全家链，轮数翻倍 → 请求数翻倍（上限确实约束单轮工具调用）
  await openSettingsSection(page.cdp, "search");
  await expandSearchChain(page.cdp);
  await clickCenter(page.cdp, ".biliscript-toggle-row:has(#allowPaidSearchProviders) .biliscript-toggle-track");
  await waitFor("付费准入关闭", () => page.cdp.evaluate(`document.getElementById("allowPaidSearchProviders")?.checked === false`), { timeoutMs: 10000 });
  await setRangeByKeyboard(page.cdp, "#webSearchMaxToolCalls", 5);
  await waitFor("次数上限回到 5 落盘", () => worker.evaluate(`chrome.storage.sync.get("webSearchMaxToolCalls").then((value) => value.webSearchMaxToolCalls)`).then((value) => Number(value) === 5 ? value : null), { timeoutMs: 8000 });
  const maxCallsFive = await waitFor("次数上限回到 5", () => page.cdp.evaluate(`document.getElementById("webSearchMaxToolCallsValue")?.textContent?.trim() === "5"`), { timeoutMs: 10000 });
  results.maxCallsFive = { badge: maxCallsFive };
  check("B2.11-次数上限可回到 5 且两种模式均可见", maxCallsFive === true, results.maxCallsFive);
  await closeSettings(page.cdp);
  const searchBeforeFive = searchRequests().length;
  await runExplainWithSearch(page.cdp, worker);
  const fiveRoundUrls = searchRequests().slice(searchBeforeFive).map((entry) => entry.url);
  results.fiveRoundSearch = { count: fiveRoundUrls.length };
  check(
    "B2.12-次数上限决定单轮实际搜索轮数",
    fiveRoundUrls.length === 10,
    results.fiveRoundSearch
  );

  // 排序恢复：自定义顺序 → 模式切换保留 → 恢复默认顺序
  await worker.evaluate(`chrome.storage.sync.set({ searchProviderOrder: ["search_deepseek", "search_anysearch", "search_tavily"] })`);
  await openSettingsSection(page.cdp, "search");
  await expandSearchChain(page.cdp);
  const customOrder = await searchChainControlState(page.cdp);
  check(
    "B2.13-自定义顺序按链序渲染",
    customOrder.order.slice(1).join(",") === "search_deepseek,search_anysearch,search_tavily" && customOrder.resetDisabled === false,
    customOrder
  );
  await clickSearchRadio(page.cdp, "search_tavily");
  await clickSearchRadio(page.cdp, "__smart__");
  const afterModeSwitch = await searchChainControlState(page.cdp);
  check(
    "B2.14-模式切换保留排序与付费偏好",
    afterModeSwitch.order.slice(1).join(",") === "search_deepseek,search_anysearch,search_tavily" &&
      afterModeSwitch.paidChecked === false &&
      afterModeSwitch.footerHidden === false,
    afterModeSwitch
  );
  await clickCenter(page.cdp, "#resetSearchProviderOrderBtn");
  const restored = await waitFor("恢复默认顺序", () => page.cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll("#searchProvidersList .search-provider-row")];
    const order = rows.map((row) => row.dataset.providerId);
    const resetDisabled = document.getElementById("resetSearchProviderOrderBtn")?.disabled === true;
    return resetDisabled && order[1] === "search_tavily" ? { order, resetDisabled } : null;
  })()`), { timeoutMs: 15000 });
  results.restoredOrder = restored;
  check(
    "B2.15-恢复默认顺序回到内置链序",
    restored.order.slice(1).join(",") === "search_tavily,search_anysearch,search_deepseek",
    restored
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "04-search-controls.png"));
  await closeSettings(page.cdp);

  // ============================================================
  // B3 Live 激活：平台单选 → 实际 WebSocket 会话
  // ============================================================
  await ensureOffscreenDocument(worker);
  await refreshOffscreen();
  await worker.evaluate(`(async () => {
    await chrome.storage.sync.set({
      liveProviders: [
        { id: "moss-fixture", presetId: "moss-live", type: "moss-live", name: "MOSS fixture", baseUrl: "https://api.mosi.cn", model: "moss-live-1.0", enabled: true },
        { id: "gemini-live-fixture", presetId: "gemini-live", type: "gemini-live", name: "Gemini Live fixture", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.8-live", enabled: true }
      ],
      activeLiveProviderId: "moss-fixture"
    });
    await chrome.storage.local.set({ liveProviderKeys: { "moss-fixture": "fixture-moss-key" } });
    const ai = await chrome.storage.sync.get("aiProviders");
    const providers = Array.isArray(ai.aiProviders) ? ai.aiProviders : [];
    if (!providers.some((provider) => provider.id === "gemini-ai-fixture")) {
      providers.push({ id: "gemini-ai-fixture", presetId: "gemini", name: "Gemini AI fixture", baseUrl: "https://generativelanguage.googleapis.com", models: ["gemini-3.8-flash"], requiresKey: true, enabled: true, protocol: "gemini" });
    }
    await chrome.storage.sync.set({ aiProviders: providers });
    const keys = await chrome.storage.local.get("aiProviderKeys");
    await chrome.storage.local.set({ aiProviderKeys: { ...(keys.aiProviderKeys || {}), "gemini-ai-fixture": "fixture-gemini-ai-key" } });
    return true;
  })()`);
  const waitLiveConnected = () => waitFor("伴看已连接", () => page.cdp.evaluate(`(() => {
    const overlay = document.getElementById("${LIVE_OVERLAY_ID}");
    const button = document.getElementById("biliscript-player-live-quick-action");
    return overlay && !overlay.hidden && overlay.innerText.includes("正在伴看") && button?.getAttribute("aria-pressed") === "true";
  })()`), { timeoutMs: 45000 });
  // 播放器控制栏节点会被页面/扩展同步重建：点一次不一定落在当前节点上，
  // 给「点 → 等 connecting/connected」重试（真机点击语义不变）。
  const startLive = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clickCenter(page.cdp, "#biliscript-player-live-quick-action").catch(() => {});
      const connected = await waitLiveConnected().then(() => true).catch(() => false);
      if (connected) return true;
    }
    return false;
  };
  const mossConnected = await startLive();
  const mossSockets = await offscreen.evaluate("globalThis.__liveSocketSummary?.() || []").catch(() => []);
  if (!mossConnected) {
    results.mossLiveFailure = await page.cdp.evaluate(`(() => ({
      overlay: document.getElementById("${LIVE_OVERLAY_ID}")?.innerText || "",
      overlayHidden: document.getElementById("${LIVE_OVERLAY_ID}")?.hidden,
      failureCard: document.querySelector(".live-overlay-failure-card")?.innerText || "",
      pressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed"),
      notice: document.querySelector(".chat-context-notice")?.innerText || ""
    }))()`);
    results.mossLiveSockets = mossSockets;
    throw new Error("MOSS 伴看未连接：" + JSON.stringify(results.mossLiveFailure));
  }
  results.mossSockets = mossSockets;
  check(
    "B3.1-Live 激活平台与真实会话一致（MOSS）",
    mossSockets.length === 1 &&
      mossSockets[0].url.includes("api.mosi.cn") &&
      mossSockets[0].closed === false,
    mossSockets
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "05-live-moss.png"));

  await clickCenter(page.cdp, ".live-overlay-close-btn");
  await openSettingsSection(page.cdp, "live");
  await clickCenter(page.cdp, '#liveProvidersList .live-provider-row[data-provider-id="gemini-live-fixture"] .live-provider-active-radio');
  await waitFor("Live 激活切换落盘", () => worker.evaluate(`chrome.storage.sync.get("activeLiveProviderId").then((value) => value.activeLiveProviderId === "gemini-live-fixture")`), { timeoutMs: 15000 });
  const liveSettingsState = await page.cdp.evaluate(`(() => ({
    mossChecked: document.querySelector('#liveProvidersList .live-provider-row[data-provider-id="moss-fixture"] .live-provider-active-radio')?.checked === true,
    geminiChecked: document.querySelector('#liveProvidersList .live-provider-row[data-provider-id="gemini-live-fixture"] .live-provider-active-radio')?.checked === true
  }))()`);
  results.liveSettingsState = liveSettingsState;
  check("B3.2-Live 单选与设置摘要一致", liveSettingsState.geminiChecked === true && liveSettingsState.mossChecked === false, liveSettingsState);
  await closeSettings(page.cdp);
  const geminiConnected = await startLive();
  const geminiSockets = await offscreen.evaluate("globalThis.__liveSocketSummary?.() || []");
  if (!geminiConnected) {
    results.geminiLiveFailure = await page.cdp.evaluate(`(() => ({
      overlay: document.getElementById("${LIVE_OVERLAY_ID}")?.innerText || "",
      failureCard: document.querySelector(".live-overlay-failure-card")?.innerText || "",
      pressed: document.getElementById("biliscript-player-live-quick-action")?.getAttribute("aria-pressed"),
      notice: document.querySelector(".chat-context-notice")?.innerText || ""
    }))()`);
    results.geminiLiveSockets = geminiSockets;
    throw new Error("切换 Gemini Live 后未连接：" + JSON.stringify(results.geminiLiveFailure));
  }
  results.geminiSockets = geminiSockets;
  check(
    "B3.3-切换 Live 平台后实际会话改用新平台",
    geminiSockets.length === 2 &&
      geminiSockets[0].closed === true &&
      geminiSockets[1].url.includes("generativelanguage.googleapis.com") &&
      geminiSockets[1].setupModels.some((model) => model.includes("gemini-3.8-live")) &&
      geminiSockets[1].closed === false,
    geminiSockets
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "06-live-gemini.png"));
  await clickCenter(page.cdp, ".live-overlay-close-btn");
  await sleep(400);

  // ============================================================
  // B4 ASR 激活：平台单选 → 实际转写请求
  // ============================================================
  await ensureOffscreenDocument(worker);
  await refreshOffscreen();
  await worker.evaluate(`(async () => {
    await chrome.storage.sync.set({
      asrAutoFallback: true,
      activeAsrProviderId: "asr-alpha",
      asrProviders: [
        { id: "asr-alpha", presetId: "siliconflow-sensevoice", name: "ASR Alpha", type: "openai-transcriptions", baseUrl: ${JSON.stringify(ASR_A_BASE)}, model: "fixture-asr-alpha", enabled: true, supportsTimestamps: true },
        { id: "asr-beta", presetId: "siliconflow-sensevoice", name: "ASR Beta", type: "openai-transcriptions", baseUrl: ${JSON.stringify(ASR_B_BASE)}, model: "fixture-asr-beta", enabled: true, supportsTimestamps: true }
      ]
    });
    await chrome.storage.local.set({ asrProviderKeys: { "asr-alpha": "fixture-asr-alpha-key", "asr-beta": "fixture-asr-beta-key" } });
    return true;
  })()`);
  await page.cdp.send("Page.navigate", { url: ASR_URL });
  await waitFor("无字幕视频页", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await ensureOffscreenKeepAlive(page.cdp, contentScriptContexts);
  await activateTab(page.cdp, "biliscript-reading-tab-subtitle");
  await waitFor("主动转写完成（Alpha）", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-subtitle")?.innerText.includes("离线验收语音字幕内容")`), { timeoutMs: 90000 });
  const alphaTranscription = transcriptions().at(-1);
  results.alphaTranscription = alphaTranscription;
  check(
    "B4.1-ASR 激活平台与实际转写请求一致",
    String(alphaTranscription?.url || "").startsWith(`${ASR_A_BASE}/audio/transcriptions`),
    alphaTranscription
  );

  // 切换 ASR 单选：清空字幕缓存（同一视频的转写成果已落缓存，靠缓存命中的话
  // 不会发转写请求），再重进字幕链观察新平台请求。
  await openSettingsSection(page.cdp, "asr");
  await clickCenter(page.cdp, '#asrProvidersList .asr-provider-row[data-provider-id="asr-beta"] .asr-provider-active-radio');
  await waitFor("ASR 激活切换落盘", () => worker.evaluate(`chrome.storage.sync.get("activeAsrProviderId").then((value) => value.activeAsrProviderId === "asr-beta")`), { timeoutMs: 15000 });
  const asrSettingsState = await page.cdp.evaluate(`(() => ({
    alphaChecked: document.querySelector('#asrProvidersList .asr-provider-row[data-provider-id="asr-alpha"] .asr-provider-active-radio')?.checked === true,
    betaChecked: document.querySelector('#asrProvidersList .asr-provider-row[data-provider-id="asr-beta"] .asr-provider-active-radio')?.checked === true
  }))()`);
  results.asrSettingsState = asrSettingsState;
  check("B4.2-ASR 单选与设置一致", asrSettingsState.betaChecked === true && asrSettingsState.alphaChecked === false, asrSettingsState);
  await closeSettings(page.cdp);
  const transcriptionsBeforeBeta = transcriptions().length;
  await worker.evaluate(`(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith("biliscript_subtitle_cache_"));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  })()`);
  // 字幕已在手时 reenter 不会重抓（skipIfInHandOrInFlight）：换到第二个无字幕视频，
  // 重新走既有「无字幕 → ASR → 字幕接受事务」链，观察激活平台是否真的换了。
  await prepareOffscreenForAsr(worker);
  await page.cdp.send("Page.navigate", { url: ASR_URL2 });
  await waitFor("第二个无字幕视频页", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await ensureOffscreenKeepAlive(page.cdp, contentScriptContexts);
  await activateTab(page.cdp, "biliscript-reading-tab-subtitle");
  await waitFor("主动转写完成（Beta）", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-subtitle")?.innerText.includes("离线验收语音字幕内容")`), { timeoutMs: 90000 });
  const betaTranscription = transcriptions().slice(transcriptionsBeforeBeta).at(-1);
  results.betaTranscription = betaTranscription;
  check(
    "B4.3-切换 ASR 激活后实际转写改用新平台",
    String(betaTranscription?.url || "").startsWith(`${ASR_B_BASE}/audio/transcriptions`),
    betaTranscription
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "07-asr-beta.png"));

  // ============================================================
  // 结果
  // ============================================================
} catch (error) {
  if (activePage) {
    results.failureDiagnostics = await activePage.cdp.evaluate(`(() => ({
      href: location.href,
      bodyText: document.body.innerText.slice(-4000),
      settings: document.getElementById("biliscript-reading-settings-host")?.innerText?.slice(0, 2500) || null,
      overview: document.getElementById("biliscript-reading-overview-body")?.innerText || null,
      chat: document.getElementById("biliscript-reading-chat-messages")?.innerText?.slice(0, 1000) || null,
      card: document.getElementById("biliscript-reading-explain-card")?.innerText || null
    }))()`).catch((diagnosticError) => ({ error: diagnosticError.message }));
    await failShot(activePage.cdp, "scenario");
  }
  check("scenario-infrastructure", false, { error: error.message, stack: String(error.stack || "").slice(0, 3000) });
  log(`场景异常：${error.stack || error.message}`);
} finally {
  try {
    if (page) await page.cdp.evaluate(`(() => {
      for (const media of document.querySelectorAll("video,audio")) {
        try { media.pause(); media.removeAttribute("src"); media.load(); media.remove(); } catch {}
      }
    })()`).catch(() => {});
  } catch {}
  if (browser) {
    try { await teardown({ browser, cdps }); } catch (error) { log(`收摊异常：${error.message}`); }
  }
  if (distDir && distDir !== DEFAULT_DIST) await rm(distDir, { recursive: true, force: true }).catch(() => {});
  await writeEvidence(OUT_DIR, {
    scenario: NAME,
    generatedAt: new Date().toISOString(),
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks,
    results,
    requests: requestLog,
    logs: getLog(),
    pages: pageWatchers,
    boundary: "离线 fixture：B 站文档/接口、AI 完成、搜索平台响应、Live WebSocket 与 ASR 音轨/转写全部由本场景回放；两个 AI 平台用同一已授权源的路径区分以便从实际请求 URL 指认平台；不使用真实账号、真实 Key 或外部付费服务。"
  });
  if (checks.some((entry) => !entry.ok) || checks.length === 0) process.exitCode = 1;
}
