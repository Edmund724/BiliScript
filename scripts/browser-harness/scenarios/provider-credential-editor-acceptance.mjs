#!/usr/bin/env node
// 票 provider-onboarding-consistency/13：凭据、编辑器与授权真机验收。
//
// 真机判据（Chromium/Edge + dist 里的未打包扩展）：
//   C1 两类凭据引用（Gemini Live / DeepSeek Search → AI 族 Key）四态与同层往返；
//   C2 Key 只进 AI 族，AI 编辑/删除后两族状态同步，证据不泄露 Key；
//   C3 模型子视图跨过滤选择、逐层 Esc、dirty 确认、Tab 焦点约束与归还；
//   C4 权限：浏览器权限库（mic）首次拒绝/授权/重新授权/多 origin +
//      Live 保存的 http(s)+ws(s) 多 origin 域名权限（chrome.permissions 链路）；
//   C5 搜索首次授权：同意 / 拒绝后开关同步 / 下一条不重复 / 付费提示 / 主任务继续；
//   C6 400px 窄面板 + 矮视口下的表单错误、确认框与动作可达；
//   C7 全程可控 fixture，无真实账号 / 真实 Key / 外部付费服务的真实出网；
//   C8 证据工件（断言、权限结果、焦点记录、失败截图、日志）与退出码。
//
// 边界（README「场景层的已知限制」）：headless 没有浏览器 UI，交互式
// chrome.permissions.request 的原生弹窗无法结算（实测 request 数秒后仍 pending、
// 永不 resolve）。
// 因此本场景对**未常驻 manifest 的 origin** 用 SW 单点替身按「拒绝」结算（其余
// 链路与真实 API 不变），对**已常驻 origin** 仍走真实 chrome.permissions.request
// （已授权时 Chrome 直接放行、不弹窗）；「重新授权」用同一临时 dist 第二次装机
// 把 fixture 域名写进 host_permissions 建立真实授权态，再由 contains() 复核。
// 浏览器权限库（mic）的首次拒绝/授权/重新授权/多 origin 全部走 CDP
// Browser.resetPermissions / grantPermissions，是真实浏览器权限 API。

import path from "node:path";
import os from "node:os";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const NAME = "provider-credential-editor-acceptance";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const BVID = "BV1mAam6tEL8";
const AID = 117370433574328;
const CID = 42393338874;
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/?p=1`;
const LIVE_URL = "https://live.bilibili.com/21452505";

// fixture 宿主：不在 manifest 常驻 host_permissions 里，门禁由「装期授权 + 拒绝替身」
// 覆盖（见文件头边界）。
const AI_FIXTURE_BASE = "https://api.fixture-ai.test/v1";
const AI_FIXTURE_ORIGIN = "https://api.fixture-ai.test/*";
const LIVE_FIXTURE_BASE = "https://api.fixture-live.test";
const LIVE_FIXTURE_ORIGINS = ["https://api.fixture-live.test/*", "wss://api.fixture-live.test/*"];
// 伴看 Gemini Live 与 MOSS 的域名与 ws:// 对应项：投影票同法在临时 dist 里常驻
// （不改正式构建产物），使真实 chrome.permissions.request 无需弹窗即可放行。
const LIVE_HOST_PERMANENT = [
  "https://api.mosi.cn/*",
  "wss://api.mosi.cn/*",
  "https://generativelanguage.googleapis.com/*",
  "wss://generativelanguage.googleapis.com/*"
];
// 非同族中转地址（用于两族的「非官方地址」态）
const DEEPSEEK_RELAY_BASE = "https://api.relay-fixture.test/v1";
const GEMINI_RELAY_BASE = "https://gemini-relay-fixture.test";

const CASE_PATH = path.join(REPO_ROOT, "tests/fixtures/provider-acceptance/case.json");
const CASE = JSON.parse(readFileSync(CASE_PATH, "utf8"));
// fixture 形状自检：缺字段或空数组直接红，而不是让后面的断言各自失配。
if (!Array.isArray(CASE.aiModels) || CASE.aiModels.length < 3) throw new Error("case.json: aiModels 形状不符");
if (!CASE.searchAnySearch?.data?.results?.length) throw new Error("case.json: searchAnySearch 形状不符");
if (!CASE.fakeKeys?.chat || !CASE.fakeKeys?.searchRoundTrip || !CASE.fakeKeys?.liveRoundTrip) {
  throw new Error("case.json: fakeKeys 形状不符");
}
const FAKE_KEYS = CASE.fakeKeys;

const fixtureRoot = path.join(REPO_ROOT, "tests/fixtures/bilibili/bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureRoot, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureRoot, "bodies.json"), "utf8"));
const subtitleBody = bodies[`${BVID}-zh`];

const checks = [];
const results = {};
const requestLog = [];
const externalRequests = [];
const focusTrace = [];
const screenshots = [];
const handledInterceptions = new Set();
const pageWatchers = [];
const cdps = [];

let distDir = null;
let browser = null;
let page = null;
let worker = null;
let offscreen = null;
let browserCdp = null;
let activePage = null;

function check(name, ok, detail = null) {
  const entry = { name, ok: Boolean(ok), detail };
  checks.push(entry);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === null ? "" : `  ${JSON.stringify(detail).slice(0, 700)}`}`);
  return entry.ok;
}

// 只记事实，不把假 Key 写进证据：允许清单之外的出网请求单独记下来。
const EXTERNAL_ALLOWLIST = [
  "https://www.bilibili.com",
  "https://live.bilibili.com",
  "https://api.bilibili.com",
  "https://api.tavily.com",
  "https://api.anysearch.com",
  "https://api.deepseek.com",
  "https://api.mosi.cn",
  "https://generativelanguage.googleapis.com",
  "https://api.fixture-ai.test",
  "https://api.fixture-live.test",
  "https://api.relay-fixture.test",
  "https://gemini-relay-fixture.test"
];
function noteExternal(url, where) {
  if (String(url).startsWith("chrome-extension:") || String(url).startsWith("data:") || String(url).startsWith("blob:")) return;
  let host = "";
  try {
    host = new URL(url).origin;
  } catch {
    return;
  }
  if (EXTERNAL_ALLOWLIST.includes(host)) return;
  externalRequests.push({ where, url, host, at: Date.now() });
}

// ===== 页面与接口 fixture =====

function videoHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>凭据与授权真机验收</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#eee;font-family:Arial,sans-serif;overflow:hidden}
#bilibili-player{position:relative;width:960px;height:540px;margin:24px;background:#050505;border:1px solid #333}
video{width:100%;height:100%;background:#050505}
.controls{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;z-index:2}
</style></head><body>
<div class="bpx-player-container player"><div class="bpx-player-video-wrap"><video preload="none"></video></div>
<div class="bpx-player-control-bottom-right controls"><button class="bpx-player-ctrl-quality" aria-label="清晰度 1080P">1080P</button></div></div>
</body></html>`;
}

function liveDocHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>直播页 fixture</title></head>
<body><div id="live-player"></div></body></html>`;
}

function viewResponse() {
  return {
    code: 0,
    message: "0",
    data: {
      aid: AID,
      bvid: BVID,
      cid: CID,
      title: "凭据与授权真机验收视频",
      desc: "离线 fixture 视频",
      duration: 461,
      pubdate: 1767225600,
      owner: { name: "fixture" },
      pages: [{ cid: CID, page: 1, part: "第一分 P", duration: 461 }]
    }
  };
}

function playerResponse() {
  const source = bundles[BVID];
  return {
    ...source,
    data: {
      ...source.data,
      aid: AID,
      bvid: BVID,
      cid: CID,
      subtitle: {
        ...source.data.subtitle,
        subtitles: [source.data.subtitle.subtitles[0]]
      }
    }
  };
}

function playurlResponse() {
  return { code: 0, message: "0", data: { dash: { audio: [] } } };
}

function jsonHeaders() {
  return [{ name: "content-type", value: "application/json" }];
}

function sseHeaders() {
  return [{ name: "content-type", value: "text/event-stream" }];
}

function fulfilled(payload, headers = jsonHeaders(), status = 200) {
  return {
    responseCode: status,
    responseHeaders: headers,
    body: Buffer.from(JSON.stringify(payload)).toString("base64")
  };
}

// 搜索轮次：每轮用新查询词，避免搜索缓存按词命中后不出网、让「真实发出请求」
// 这条读数失效。toolCallBudget 由调用方在每次发送/解释前重置为 1。
let searchRunId = 0;
let searchRound = 0;
let toolCallBudget = 0;

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

function toolCallJson(query) {
  return {
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
  };
}

function classifyCompletion(body) {
  const prompt = JSON.stringify(body?.messages || []);
  if (prompt.includes("被观众选中的内容")) return "explain";
  return "chat";
}

function completionFixture(body) {
  const kind = classifyCompletion(body);
  const toolNames = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => String(tool?.function?.name || tool?.name || ""));
  const hasSearchTool = toolNames.includes("web_search");
  const wantsSearch = hasSearchTool && toolCallBudget > 0;
  if (wantsSearch) {
    toolCallBudget -= 1;
    const query = `票13验收搜索词-${searchRunId}-${(searchRound += 1)}`;
    if (body?.stream === false) {
      return { headers: jsonHeaders(), body: JSON.stringify(toolCallJson(query)), kind };
    }
    return { headers: sseHeaders(), body: openAiToolCallSse(query), kind };
  }
  const content = kind === "explain" ? "受控解释回答。" : "受控对话回答。";
  if (body?.stream === false) {
    return {
      headers: jsonHeaders(),
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }),
      kind
    };
  }
  return { headers: sseHeaders(), body: openAiSse(content), kind };
}

function searchResponseFor(url) {
  if (url.includes("api.anysearch.com")) {
    return fulfilled(CASE.searchAnySearch);
  }
  if (url.includes("api.tavily.com")) {
    return fulfilled(CASE.searchTavilyFailure, jsonHeaders(), 500);
  }
  if (url.includes("api.deepseek.com") && url.includes("search")) {
    return fulfilled({ detail: "fixture deepseek search failure" }, jsonHeaders(), 500);
  }
  return null;
}

// ===== 真机管道 =====

async function createHarnessDist({ grantedFixtureHosts }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biliscript-credential-dist-"));
  await cp(DEFAULT_DIST, dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const extra = [...LIVE_HOST_PERMANENT];
  if (grantedFixtureHosts) {
    extra.push(AI_FIXTURE_ORIGIN, ...LIVE_FIXTURE_ORIGINS);
  }
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...extra])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

function installDocumentFixture(pageCdp) {
  return pageCdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "https://www.bilibili.com/video/*", requestStage: "Request" },
      { urlPattern: "https://live.bilibili.com/*", requestStage: "Request" }
    ]
  }).then(() => {
    pageCdp.on("Fetch.requestPaused", async (params) => {
      try {
        if (params.resourceType === "Document") {
          const url = params.request?.url || "";
          const html = url.startsWith("https://live.bilibili.com") ? liveDocHtml() : videoHtml();
          await pageCdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
            body: Buffer.from(html).toString("base64")
          });
        } else {
          noteExternal(params.request?.url || "", "page");
          await pageCdp.send("Fetch.continueRequest", { requestId: params.requestId });
        }
      } catch {}
    });
  });
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
          await cdp.send("Fetch.fulfillRequest", { requestId, ...fulfilled(viewResponse()) }, sessionId);
          return;
        }
        if (/x\/player\/(?:wbi\/)?v2/.test(url)) {
          await cdp.send("Fetch.fulfillRequest", { requestId, ...fulfilled(playerResponse()) }, sessionId);
          return;
        }
        if (/x\/player\/playurl/.test(url)) {
          await cdp.send("Fetch.fulfillRequest", { requestId, ...fulfilled(playurlResponse()) }, sessionId);
          return;
        }
        if (url.includes(`walkthrough-fixture/${BVID}-zh.json`)) {
          await cdp.send("Fetch.fulfillRequest", { requestId, ...fulfilled(subtitleBody) }, sessionId);
          return;
        }
        if (/\/models(?:\?|$)/.test(url)) {
          requestLog.push({ kind: "models", url, at: Date.now() });
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            ...fulfilled({ object: "list", data: CASE.aiModels.map((id) => ({ id, object: "model" })) })
          }, sessionId);
          return;
        }
        if (url.includes("/chat/completions")) {
          let body = {};
          try { body = JSON.parse(params.request.postData || "{}"); } catch {}
          const fixture = completionFixture(body);
          requestLog.push({ kind: "completion", url, model: body?.model || "", promptKind: fixture.kind, stream: body?.stream !== false, hasTools: Array.isArray(body?.tools) && body.tools.length > 0, at: Date.now() });
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
        noteExternal(url, "sw");
        await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
      } catch {}
    });
  });
}

// 对话的流式完成请求在 offscreen 发起；设置/探针等非流式请求走 SW。
function installOffscreenFixtures(cdp) {
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      const requestId = params.requestId;
      if (handledInterceptions.has(requestId)) return;
      handledInterceptions.add(requestId);
      try {
        if (url.includes("/chat/completions")) {
          let body = {};
          try { body = JSON.parse(params.request.postData || "{}"); } catch {}
          const fixture = completionFixture(body);
          requestLog.push({ kind: "completion", url, model: body?.model || "", promptKind: fixture.kind, stream: body?.stream !== false, hasTools: Array.isArray(body?.tools) && body.tools.length > 0, at: Date.now() });
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: fixture.headers,
            body: Buffer.from(fixture.body).toString("base64")
          });
          return;
        }
        noteExternal(url, "offscreen");
        await cdp.send("Fetch.continueRequest", { requestId });
      } catch {}
    });
  });
}

async function attachOffscreen(browserInstance) {
  const target = await waitFor("offscreen target", async () => {
    const response = await fetch(`http://127.0.0.1:${browserInstance.port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type !== "page" && String(item.url).endsWith("/entry/offscreen.html"));
  }, { timeoutMs: 30000 });
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdps.push(cdp);
  await cdp.send("Runtime.enable");
  return cdp;
}

async function boot({ grantedFixtureHosts }) {
  const made = await createHarnessDist({ grantedFixtureHosts });
  distDir = made.dir;
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
  await installDocumentFixture(page.cdp);

  worker = createWorkerSession({ pageCdp: page.cdp, browser, distDir, onReconnect: installWorkerFixtures });
  if (!(await worker.ensureAlive())) throw new Error("扩展 SW 不可用");
  await installWorkerFixtures(worker.handle);
  await worker.evaluate(`(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    await chrome.storage.sync.set({
      enablePlayerAiQuickAction: true,
      autoOpenReader: false,
      asrAutoFallback: false,
      webSearchEnabled: false,
      searchOptInNoticeAcknowledged: false,
      aiProviders: [],
      liveProviders: [],
      asrProviders: [],
      searchProviders: [],
      defaultModel: ""
    });
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("entry/offscreen.html"),
      reasons: ["BLOBS"],
      justification: "Offline credential and permission acceptance fixture"
    });
    return true;
  })()`);
  offscreen = await attachOffscreen(browser);
  await installOffscreenFixtures(offscreen);

  // 浏览器级 CDP 会话：Browser.grantPermissions / resetPermissions 只在这里可靠。
  const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
  browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
  cdps.push(browserCdp);
  results[`browser-${grantedFixtureHosts ? "granted" : "base"}`] = { engine: browser.version?.Browser || "", dist: distDir };
}

async function shutdown() {
  if (page) {
    await page.cdp.evaluate(`(() => {
      for (const media of document.querySelectorAll("video,audio")) {
        try { media.pause(); media.removeAttribute("src"); media.load(); media.remove(); } catch {}
      }
    })()`).catch(() => {});
  }
  if (browser) {
    try { await teardown({ browser, cdps }); } catch (error) { log(`收摊异常：${error.message}`); }
  }
  if (distDir) await rm(distDir, { recursive: true, force: true }).catch(() => {});
  page = null; worker = null; offscreen = null; browser = null; distDir = null; browserCdp = null; activePage = null;
  cdps.length = 0; pageWatchers.length = 0;
}

// ===== 权限探针 =====

async function installPermissionProbe(permanentOrigins) {
  await worker.evaluate(`(async () => {
    if (globalThis.__permProbeInstalled) return true;
    const permanent = ${JSON.stringify(permanentOrigins)};
    globalThis.__permProbeInstalled = true;
    globalThis.__permCalls = [];
    globalThis.__permDenied = [];
    const original = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = async (perms) => {
      const origins = Array.isArray(perms?.origins) ? perms.origins.map(String) : [];
      globalThis.__permCalls.push({ origins, at: Date.now() });
      const uncovered = origins.filter((origin) => !permanent.includes(origin));
      if (uncovered.length > 0) {
        globalThis.__permDenied.push(...uncovered);
        return false;
      }
      return original(perms);
    };
    return true;
  })()`);
}

async function permissionCalls() {
  return worker.evaluate(`globalThis.__permCalls || []`).catch(() => []);
}

async function permissionDenied() {
  return worker.evaluate(`globalThis.__permDenied || []`).catch(() => []);
}

async function permissionContains(origins) {
  return worker.evaluate(`chrome.permissions.contains(${JSON.stringify({ origins })})`).catch(() => null);
}

// ===== 真实输入 =====

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
  }, { timeoutMs: 12000, intervalMs: 100 });
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
}

async function fillField(pageCdp, selector, text) {
  await pageCdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (field) field.scrollIntoView({ block: "center" });
    return true;
  })()`).catch(() => {});
  await sleep(120);
  await clickCenter(pageCdp, selector);
  await pageCdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await pageCdp.send("Input.insertText", { text });
  await sleep(60);
}

async function pressKey(pageCdp, key, code, vk, modifiers = 0) {
  await pageCdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await pageCdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(120);
}

const pressTab = (pageCdp, shift = false) => pressKey(pageCdp, "Tab", "Tab", 9, shift ? 8 : 0);
const pressEscape = (pageCdp) => pressKey(pageCdp, "Escape", "Escape", 27, 0);

async function focusInfo(pageCdp) {
  return pageCdp.evaluate(`(() => {
    const active = document.activeElement;
    if (!active) return null;
    return {
      id: active.id || "",
      tag: active.tagName,
      className: typeof active.className === "string" ? active.className : "",
      insideDialog: Boolean(active.closest(".provider-editor-dialog")),
      insideConfirm: Boolean(active.closest(".confirm-dialog"))
    };
  })()`);
}

async function waitEditor(pageCdp, { title = null, submit = null, timeoutMs = 20000 } = {}) {
  return waitFor("平台编辑器打开", () => pageCdp.evaluate(`(() => {
    const dialog = document.querySelector(".provider-editor-dialog");
    if (!dialog) return null;
    const value = {
      title: dialog.querySelector(".provider-editor-title")?.textContent?.trim() || "",
      submit: dialog.querySelector(".provider-editor-save")?.textContent?.trim() || "",
      cancel: dialog.querySelector(".provider-editor-cancel")?.textContent?.trim() || ""
    };
    return value;
  })()`).then((value) => {
    if (!value) return null;
    if (title !== null && value.title !== title) return null;
    if (submit !== null && value.submit !== submit) return null;
    return value;
  }), { timeoutMs });
}

async function readEditor(pageCdp) {
  return pageCdp.evaluate(`(() => {
    const dialog = document.querySelector(".provider-editor-dialog");
    if (!dialog) return null;
    const linked = dialog.querySelector(".provider-editor-linked-credential");
    const keyField = dialog.querySelector(".provider-editor-apikey")?.closest(".provider-editor-field");
    const status = dialog.querySelector(".provider-editor-status");
    return {
      title: dialog.querySelector(".provider-editor-title")?.textContent?.trim() || "",
      submit: dialog.querySelector(".provider-editor-save")?.textContent?.trim() || "",
      cancel: dialog.querySelector(".provider-editor-cancel")?.textContent?.trim() || "",
      name: dialog.querySelector(".provider-editor-name")?.value ?? "",
      baseUrl: dialog.querySelector(".provider-editor-baseurl")?.value ?? "",
      preset: dialog.querySelector(".provider-editor-preset")?.value ?? "",
      linked: linked
        ? {
            text: linked.querySelector(".provider-editor-linked-credential-text")?.textContent?.trim() || "",
            action: linked.querySelector(".provider-editor-linked-credential-btn")?.textContent?.trim() || ""
          }
        : null,
      keyHidden: keyField ? keyField.hasAttribute("hidden") : null,
      status: status ? status.innerText.trim() : "",
      statusError: status?.dataset.error === "true",
      fieldErrors: Array.from(dialog.querySelectorAll(".provider-editor-field-error")).filter((node) => !node.hasAttribute("hidden")).map((node) => node.textContent.trim())
    };
  })()`);
}

async function waitEditorClosed(pageCdp, timeoutMs = 20000) {
  await waitFor("平台编辑器关闭", () => pageCdp.evaluate(`!document.querySelector(".provider-editor-dialog")`), { timeoutMs });
}

async function closeEditorIfOpen(pageCdp) {
  const open = await pageCdp.evaluate(`Boolean(document.querySelector(".provider-editor-dialog"))`);
  if (!open) return;
  await clickCenter(pageCdp, ".provider-editor-cancel");
  // dirty 时会弹「放弃更改」，按确认收掉
  const confirm = await waitFor("放弃更改确认", () => pageCdp.evaluate(`Boolean(document.querySelector(".confirm-dialog"))`), { timeoutMs: 2500 }).catch(() => null);
  if (confirm) {
    await clickCenter(pageCdp, ".confirm-dialog-confirm");
  }
  await waitEditorClosed(pageCdp).catch(() => {});
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
  if (!(await pageCdp.evaluate(`document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") === true`))) {
    await clickCenter(pageCdp, "#biliscript-reading-settings-btn");
    await waitFor("设置抽屉打开", () => pageCdp.evaluate(`document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") === true`), { timeoutMs: 15000 });
  }
  await clickCenter(pageCdp, `.biliscript-settings-nav-item[data-section="${section}"]`);
  await sleep(350);
}

async function openSearchSection() {
  await openSettingsSection(page.cdp, "search");
  // 搜索平台列表收在「搜索链」折叠体里：展开后才参与布局 / 命中测试
  const expanded = await page.cdp.evaluate(`document.getElementById("toggleSearchChainBtn")?.getAttribute("aria-expanded") === "true"`);
  if (!expanded) {
    await clickCenter(page.cdp, "#toggleSearchChainBtn");
    await waitFor("搜索链展开", () => page.cdp.evaluate(`document.getElementById("toggleSearchChainBtn")?.getAttribute("aria-expanded") === "true" && document.getElementById("searchChainContainer")?.hidden === false`), { timeoutMs: 8000 });
  }
  await sleep(200);
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

async function failShot(pageCdp, name) {
  try {
    const file = path.join(OUT_DIR, `failure-${name}.png`);
    await screenshot(pageCdp, file);
    screenshots.push(file);
  } catch (error) {
    log(`失败截图未生成：${error.message}`);
  }
}

async function shot(pageCdp, name) {
  const file = path.join(OUT_DIR, name);
  await screenshot(pageCdp, file);
  screenshots.push(file);
}

// ===== 存储与行工具 =====

async function readStorage(area, keys) {
  return worker.evaluate(`chrome.storage.${area}.get(${JSON.stringify(keys)})`);
}

async function seedSync(patch) {
  await worker.evaluate(`chrome.storage.sync.set(${JSON.stringify(patch)})`);
}

async function seedLocal(patch) {
  await worker.evaluate(`chrome.storage.local.set(${JSON.stringify(patch)})`);
}

const AI_BASE = "https://api.bilibili.com/ai-fixture/v1";
const AI_ALPHA = { id: "ai-alpha", presetId: "custom", name: "AI Alpha", baseUrl: AI_BASE, models: ["fixture-model-existing"], requiresKey: true, enabled: true, protocol: "openai" };
const AI_DEEPSEEK = { id: "ai-deepseek-official", presetId: "deepseek", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"], requiresKey: true, enabled: true, protocol: "openai" };
const AI_GEMINI = { id: "ai-gemini-official", presetId: "gemini", name: "Gemini 官方", baseUrl: "https://generativelanguage.googleapis.com", models: ["gemini-3-flash"], requiresKey: true, enabled: true, protocol: "gemini" };
const SEARCH_DEEPSEEK = { id: "search_deepseek", presetId: "deepseek", name: "DeepSeek 搜索", type: "deepseek", baseUrl: "https://api.deepseek.com", enabled: true };
const SEARCH_ANY = { id: "search_anysearch", presetId: "anysearch", name: "AnySearch", type: "anysearch", baseUrl: "https://api.anysearch.com", enabled: true };
const SEARCH_TAVILY = { id: "search_tavily", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true };
const LIVE_GEMINI = { id: "live_gemini", presetId: "gemini-live", type: "gemini-live", name: "Gemini Live", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3-flash-live", enabled: true };

async function seedBaseline() {
  await seedSync({
    aiProviders: [AI_ALPHA],
    liveProviders: [LIVE_GEMINI],
    searchProviders: [SEARCH_DEEPSEEK, SEARCH_ANY],
    defaultModel: "ai-alpha"
  });
  await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat } });
}

async function openRowEditor(listId, providerId, expectSubmit = "保存") {
  await clickCenter(page.cdp, `#${listId} [data-provider-id="${providerId}"] .provider-row-edit`);
  return waitEditor(page.cdp, { submit: expectSubmit });
}

async function rowState(listId, providerId) {
  return page.cdp.evaluate(`(() => {
    const row = document.querySelector('#${listId} [data-provider-id="${providerId}"]');
    if (!row) return null;
    return {
      name: row.querySelector(".provider-row-name")?.textContent?.trim() || "",
      dot: row.querySelector(".provider-row-dot")?.dataset.state || "",
      dotTitle: row.querySelector(".provider-row-dot")?.title || "",
      note: row.querySelector(".provider-row-model")?.textContent?.trim() || ""
    };
  })()`);
}

// ===== 主流程占位 =====
// ===== 阶段 A：无 fixture 域名常驻权限（拒绝态 / 编辑器 / 搜索授权 / 窄面板）=====

async function phaseA() {
  await boot({ grantedFixtureHosts: false });
  results.permissions = {};
  results.focusTrace = focusTrace;
  const permanent = JSON.parse(readFileSync(path.join(distDir, "manifest.json"), "utf8")).host_permissions;

  await seedBaseline();
  await page.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("视频页扩展按钮", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await shot(page.cdp, "01-reader-open.png");

  // ============================================================
  // C1 两类凭据引用的四态与同层往返
  // ============================================================
  results.credentialStates = {};

  // C1.1 搜索（DeepSeek）四态
  {
    await seedSync({ aiProviders: [AI_ALPHA] });
    await openSettingsSection(page.cdp, "llm");
    await openSearchSection();
    let editor = await openRowEditor("searchProvidersList", SEARCH_DEEPSEEK.id);
    const noRecord = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    await seedSync({ aiProviders: [AI_ALPHA, AI_DEEPSEEK, AI_GEMINI] });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat } });
    await openSettingsSection(page.cdp, "llm");
    await openSearchSection();
    editor = await openRowEditor("searchProvidersList", SEARCH_DEEPSEEK.id);
    const noKey = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    await seedSync({
      aiProviders: [
        AI_ALPHA,
        { ...AI_DEEPSEEK, baseUrl: DEEPSEEK_RELAY_BASE },
        { ...AI_GEMINI, baseUrl: GEMINI_RELAY_BASE }
      ]
    });
    await openSettingsSection(page.cdp, "llm");
    await openSearchSection();
    editor = await openRowEditor("searchProvidersList", SEARCH_DEEPSEEK.id);
    const unofficial = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    await seedSync({ aiProviders: [AI_ALPHA, AI_DEEPSEEK, AI_GEMINI] });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat, "ai-deepseek-official": FAKE_KEYS.searchRoundTrip, "ai-gemini-official": FAKE_KEYS.liveRoundTrip } });
    await openSettingsSection(page.cdp, "llm");
    await openSearchSection();
    editor = await openRowEditor("searchProvidersList", SEARCH_DEEPSEEK.id);
    const ok = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    results.credentialStates.search = { noRecord, noKey, unofficial, ok };
    check(
      "C1.1-搜索 DeepSeek 编辑器四态文案与动作",
      noRecord?.linked?.text === "请先在 AI 平台添加官方 DeepSeek 记录" &&
        noRecord?.linked?.action === "配置官方 DeepSeek Key" &&
        noKey?.linked?.text === "官方 DeepSeek AI Key 缺失或引用已失效" &&
        noKey?.linked?.action === "填写 AI Key" &&
        unofficial?.linked?.text === "AI 平台配置的并非 DeepSeek 官方接口地址" &&
        unofficial?.linked?.action === "新建独立官方记录" &&
        ok?.linked?.text === "已复用 AI 平台 Key · DeepSeek 官方" &&
        ok?.linked?.action === "" &&
        ok?.keyHidden === true &&
        noKey?.keyHidden === true,
      { noRecord: noRecord?.linked, noKey: noKey?.linked, unofficial: unofficial?.linked, ok: ok?.linked, keyHidden: ok?.keyHidden }
    );
  }

  // C1.2 伴看（Gemini Live）四态
  {
    await seedSync({ aiProviders: [AI_ALPHA] });
    await openSettingsSection(page.cdp, "live");
    await openRowEditor("liveProvidersList", LIVE_GEMINI.id);
    const noRecord = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    await seedSync({ aiProviders: [AI_ALPHA, AI_GEMINI] });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat } });
    await openSettingsSection(page.cdp, "llm");
    await openSettingsSection(page.cdp, "live");
    await openRowEditor("liveProvidersList", LIVE_GEMINI.id);
    const noKey = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    await seedSync({ aiProviders: [AI_ALPHA, { ...AI_GEMINI, baseUrl: GEMINI_RELAY_BASE }] });
    await openSettingsSection(page.cdp, "llm");
    await openSettingsSection(page.cdp, "live");
    await openRowEditor("liveProvidersList", LIVE_GEMINI.id);
    const unofficial = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    await seedSync({ aiProviders: [AI_ALPHA, AI_GEMINI] });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat, "ai-gemini-official": FAKE_KEYS.liveRoundTrip } });
    await openSettingsSection(page.cdp, "llm");
    await openSettingsSection(page.cdp, "live");
    await openRowEditor("liveProvidersList", LIVE_GEMINI.id);
    const ok = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);

    results.credentialStates.live = { noRecord, noKey, unofficial, ok };
    check(
      "C1.2-伴看 Gemini Live 编辑器四态文案与动作",
      noRecord?.linked?.text === "尚未配置官方 Gemini AI Key" &&
        noRecord?.linked?.action === "配置官方 Gemini Key" &&
        noKey?.linked?.text === "官方 Gemini AI Key 缺失或引用已失效" &&
        noKey?.linked?.action === "填写 AI Key" &&
        unofficial?.linked?.text === "AI 平台配置的并非 Gemini 官方接口地址" &&
        unofficial?.linked?.action === "新建独立官方记录" &&
        ok?.linked?.text === "已复用 AI 平台 Key" &&
        ok?.linked?.action === "" &&
        ok?.keyHidden === true,
      { noRecord: noRecord?.linked, noKey: noKey?.linked, unofficial: unofficial?.linked, ok: ok?.linked }
    );
  }

  // C1.3 搜索同层往返：消费族草稿 → AI 编辑器 → 返回原草稿
  {
    await seedSync({ aiProviders: [AI_ALPHA, AI_DEEPSEEK], liveProviders: [LIVE_GEMINI] });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat } });
    await openSettingsSection(page.cdp, "llm");
    await openSearchSection();
    await openRowEditor("searchProvidersList", SEARCH_DEEPSEEK.id);
    await fillField(page.cdp, ".provider-editor-name", "搜索草稿-往返");
    const before = await readEditor(page.cdp);
    await clickCenter(page.cdp, ".provider-editor-linked-credential-btn");
    const aiEditor = await waitEditor(page.cdp, { title: "编辑AI 平台", submit: "保存并返回搜索平台" });
    const focusedKey = await focusInfo(page.cdp);
    await fillField(page.cdp, ".provider-editor-apikey", FAKE_KEYS.searchRoundTrip);
    await clickCenter(page.cdp, ".provider-editor-save");
    const restored = await waitEditor(page.cdp, { title: "编辑搜索平台", submit: "保存" });
    const after = await readEditor(page.cdp);
    const hint = await page.cdp.evaluate(`document.getElementById("biliscriptSettingsStatus")?.textContent?.trim() || ""`);
    await clickCenter(page.cdp, ".provider-editor-save");
    await waitEditorClosed(page.cdp);
    const keys = await readStorage("local", ["aiProviderKeys"]);
    const providers = await readStorage("sync", ["searchProviders"]);
    const keyIds = Object.keys(keys.aiProviderKeys || {});
    results.searchRoundTrip = { before, aiEditor, focusedKey, restored, after, hint, keyIds, searchProviders: providers.searchProviders };
    check(
      "C1.3-搜索编辑器同层往返且草稿恢复、提示仍需显式保存搜索记录",
      aiEditor?.submit === "保存并返回搜索平台" &&
        aiEditor?.cancel === "返回搜索平台" &&
        focusedKey?.className?.includes("provider-editor-apikey") &&
        restored?.title === "编辑搜索平台" &&
        after?.name === "搜索草稿-往返" &&
        after?.linked?.text === "已复用 AI 平台 Key · DeepSeek 官方" &&
        hint.includes("AI Key 已保存，请继续保存搜索平台记录") &&
        keys.aiProviderKeys?.["ai-deepseek-official"] === FAKE_KEYS.searchRoundTrip &&
        Boolean(providers.searchProviders?.find((item) => item.id === SEARCH_DEEPSEEK.id)),
      { aiEditor, focusedKey, restored, name: after?.name, linked: after?.linked, hint }
    );
  }

  // C1.4 伴看同层往返（返回后以 dirty 确认收场，草稿本身已恢复）
  {
    await seedSync({ aiProviders: [AI_ALPHA, AI_DEEPSEEK, AI_GEMINI] });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat, "ai-deepseek-official": FAKE_KEYS.searchRoundTrip } });
    await openSettingsSection(page.cdp, "llm");
    await openSettingsSection(page.cdp, "live");
    await openRowEditor("liveProvidersList", LIVE_GEMINI.id);
    await fillField(page.cdp, ".provider-editor-name", "伴看草稿-往返");
    await clickCenter(page.cdp, ".provider-editor-linked-credential-btn");
    const aiEditor = await waitEditor(page.cdp, { title: "编辑AI 平台", submit: "保存并返回伴看平台" });
    await fillField(page.cdp, ".provider-editor-apikey", FAKE_KEYS.liveRoundTrip);
    await clickCenter(page.cdp, ".provider-editor-save");
    const restored = await waitEditor(page.cdp, { title: "编辑实时伴看平台", submit: "保存" });
    const after = await readEditor(page.cdp);
    const hint = await page.cdp.evaluate(`document.getElementById("biliscriptSettingsStatus")?.textContent?.trim() || ""`);
    // 返回的编辑器保留原 dirty 基线：取消走「放弃更改」确认
    await clickCenter(page.cdp, ".provider-editor-cancel");
    const discard = await waitFor("放弃更改确认框", () => page.cdp.evaluate(`(() => {
      const dialog = document.querySelector(".confirm-dialog");
      return dialog ? { title: dialog.querySelector(".confirm-dialog-title")?.textContent?.trim() || "", confirm: dialog.querySelector(".confirm-dialog-confirm")?.textContent?.trim() || "" } : null;
    })()`), { timeoutMs: 8000 });
    await clickCenter(page.cdp, ".confirm-dialog-confirm");
    await waitEditorClosed(page.cdp);
    results.liveRoundTrip = { aiEditor, restored, after, hint, discard };
    check(
      "C1.4-伴看编辑器同层往返且草稿恢复、返回路径保留 dirty 语义",
      aiEditor?.submit === "保存并返回伴看平台" &&
        restored?.title === "编辑实时伴看平台" &&
        after?.name === "伴看草稿-往返" &&
        after?.linked?.text === "已复用 AI 平台 Key" &&
        hint.includes("AI Key 已保存，请继续保存伴看平台记录") &&
        discard?.title === "放弃更改" &&
        discard?.confirm === "放弃更改",
      { aiEditor, restored, name: after?.name, linked: after?.linked, hint, discard }
    );
  }

  // ============================================================
  // C2 Key 只进 AI 族；AI 编辑 / 删除后两族状态同步；证据不泄露 Key
  // ============================================================
  {
    const keys = await readStorage("local", ["aiProviderKeys"]);
    const live = await readStorage("sync", ["liveProviders"]);
    const search = await readStorage("sync", ["searchProviders"]);
    const liveRecord = live.liveProviders?.find((item) => item.id === LIVE_GEMINI.id) || {};
    const searchRecord = search.searchProviders?.find((item) => item.id === SEARCH_DEEPSEEK.id) || {};
    const consumerHasOwnKey = ["liveProviders", "searchProviders"].some((area) =>
      Object.keys(area === "liveProviders" ? liveRecord : searchRecord).some((field) => /apikey|api_key/i.test(field))
    );
    results.keyLocation = { keys: Object.keys(keys.aiProviderKeys || {}), liveRecord, searchRecord };
    check(
      "C2.1-Key 只落 AI 族且消费族编辑器无自有 Key 输入框",
      keys.aiProviderKeys?.["ai-deepseek-official"] === FAKE_KEYS.searchRoundTrip &&
        keys.aiProviderKeys?.["ai-gemini-official"] === FAKE_KEYS.liveRoundTrip &&
        !consumerHasOwnKey,
      { keyIds: Object.keys(keys.aiProviderKeys || {}), consumerHasOwnKey }
    );

    // 两族行与编辑器在 AI 保存后同步为「可用」
    await openSettingsSection(page.cdp, "llm");
    await openSearchSection();
    const searchRow = await rowState("searchProvidersList", SEARCH_DEEPSEEK.id);
    await openSettingsSection(page.cdp, "live");
    const liveRow = await rowState("liveProvidersList", LIVE_GEMINI.id);
    results.syncedRows = { searchRow, liveRow };
    check(
      "C2.2-AI Key 保存后搜索与伴看行状态同步可用",
      searchRow?.dot === "saved" &&
        searchRow?.dotTitle === "已复用 AI 平台 Key" &&
        searchRow?.note.includes("已复用 AI 平台 Key") &&
        liveRow?.dot === "saved" &&
        liveRow?.note.includes("已复用 AI 平台 Key"),
      results.syncedRows
    );
    await shot(page.cdp, "02-credential-rows-synced.png");

    // AI 族删除两条官方记录 → 两族状态回落（DeepSeek 先无记录、Gemini 随后）
    await openSettingsSection(page.cdp, "llm");
    for (const providerId of ["ai-deepseek-official", "ai-gemini-official"]) {
      await clickCenter(page.cdp, `#aiProvidersList [data-provider-id="${providerId}"] .provider-row-remove`);
      const dialog = await waitFor("删除确认框", () => page.cdp.evaluate(`(() => {
        const box = document.querySelector(".confirm-dialog");
        return box ? { title: box.querySelector(".confirm-dialog-title")?.textContent?.trim() || "", confirm: box.querySelector(".confirm-dialog-confirm")?.textContent?.trim() || "" } : null;
      })()`), { timeoutMs: 8000 });
      if (providerId === "ai-deepseek-official") results.deleteDialog = dialog;
      await clickCenter(page.cdp, ".confirm-dialog-confirm");
      await waitFor(`删除后列表移除 ${providerId}`, () => page.cdp.evaluate(`!document.querySelector('#aiProvidersList [data-provider-id="${providerId}"]')`), { timeoutMs: 15000 });
    }
    const keysAfterDelete = await readStorage("local", ["aiProviderKeys"]);
    await openSearchSection();
    const searchRowAfter = await rowState("searchProvidersList", SEARCH_DEEPSEEK.id);
    await openSettingsSection(page.cdp, "live");
    const liveRowAfter = await rowState("liveProvidersList", LIVE_GEMINI.id);
    await openRowEditor("liveProvidersList", LIVE_GEMINI.id);
    const liveEditorAfter = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);
    await openSearchSection();
    await openRowEditor("searchProvidersList", SEARCH_DEEPSEEK.id);
    const searchEditorAfter = await readEditor(page.cdp);
    await closeEditorIfOpen(page.cdp);
    results.afterAiDelete = { keyIdsAfterDelete: Object.keys(keysAfterDelete.aiProviderKeys || {}), searchRowAfter, liveRowAfter, liveEditorAfter: liveEditorAfter?.linked, searchEditorAfter: searchEditorAfter?.linked, deleteDialog: results.deleteDialog };
    check(
      "C2.3-AI 删除后搜索与伴看状态同步回落且 Key 被移除",
      results.deleteDialog?.title === "删除平台" &&
        results.deleteDialog?.confirm === "删除" &&
        !keysAfterDelete.aiProviderKeys?.["ai-deepseek-official"] &&
        !keysAfterDelete.aiProviderKeys?.["ai-gemini-official"] &&
        searchRowAfter?.dot === "missing" &&
        liveRowAfter?.dot === "missing" &&
        searchEditorAfter?.linked?.text === "请先在 AI 平台添加官方 DeepSeek 记录" &&
        liveEditorAfter?.linked?.text === "尚未配置官方 Gemini AI Key",
      results.afterAiDelete
    );
  }

  // ============================================================
  // C3 模型子视图：跨过滤选择、逐层 Esc、dirty 确认、Tab 约束与焦点归还
  // ============================================================
  {
    await seedSync({ aiProviders: [AI_ALPHA], liveProviders: [LIVE_GEMINI], searchProviders: [SEARCH_DEEPSEEK] });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat } });
    await openSettingsSection(page.cdp, "llm");
    await openRowEditor("aiProvidersList", AI_ALPHA.id);
    await clickCenter(page.cdp, ".provider-editor-fetch");
    const subview = await waitFor("模型子视图打开", () => page.cdp.evaluate(`(() => {
      const dialog = document.querySelector(".provider-editor-fetch-dialog");
      if (!dialog) return null;
      return {
        items: Array.from(dialog.querySelectorAll(".provider-editor-fetch-item")).map((item) => item.dataset.modelId),
        focus: document.activeElement?.className || "",
        title: dialog.querySelector(".provider-editor-fetch-title")?.textContent?.trim() || ""
      };
    })()`), { timeoutMs: 20000 });
    const subviewLog = [];
    results.models = subviewLog;
    check(
      "C3.1-模型子视图拉取 fixture 模型且焦点进入返回键",
      subviewLog.length === 0 && subview.items.length === 3 && subview.items.includes("fixture-model-beta") && subview.focus.includes("provider-editor-fetch-back"),
      subview
    );

    await clickCenter(page.cdp, '.provider-editor-fetch-item[data-model-id="fixture-model-alpha"] .provider-editor-fetch-name');
    let selection = await page.cdp.evaluate(`(() => {
      const dialog = document.querySelector(".provider-editor-fetch-dialog");
      return { confirm: dialog?.querySelector(".provider-editor-fetch-confirm")?.textContent?.trim() || "", disabled: dialog?.querySelector(".provider-editor-fetch-confirm")?.disabled };
    })()`);
    subviewLog.push({ step: "select-alpha", ...selection });
    await fillField(page.cdp, ".provider-editor-fetch-search", "beta");
    await sleep(300);
    const filtered = await page.cdp.evaluate(`(() => {
      const dialog = document.querySelector(".provider-editor-fetch-dialog");
      return {
        items: Array.from(dialog.querySelectorAll(".provider-editor-fetch-item")).map((item) => item.dataset.modelId),
        note: dialog.querySelector(".provider-editor-fetch-note")?.textContent?.trim() || "",
        noteHidden: dialog.querySelector(".provider-editor-fetch-note")?.hidden === true,
        confirm: dialog.querySelector(".provider-editor-fetch-confirm")?.textContent?.trim() || ""
      };
    })()`);
    subviewLog.push({ step: "filter-beta", ...filtered });
    await clickCenter(page.cdp, '.provider-editor-fetch-item[data-model-id="fixture-model-beta"] .provider-editor-fetch-name');
    const afterSecond = await page.cdp.evaluate(`document.querySelector(".provider-editor-fetch-confirm")?.textContent?.trim() || ""`);
    subviewLog.push({ step: "select-beta", confirm: afterSecond });
    await clickCenter(page.cdp, ".provider-editor-fetch-confirm");
    await waitFor("子视图关闭", () => page.cdp.evaluate(`!document.querySelector(".provider-editor-fetch-dialog")`), { timeoutMs: 8000 });
    const appended = await page.cdp.evaluate(`Array.from(document.querySelectorAll(".provider-editor-model-id")).map((input) => input.value)`);
    subviewLog.push({ step: "confirm", appended });
    check(
      "C3.2-跨过滤选择保留并只追加目录外模型",
      selection.confirm === "添加所选 (1)" &&
        selection.disabled === false &&
        filtered.items.length === 1 &&
        filtered.items[0] === "fixture-model-beta" &&
        filtered.note.includes("另有 1 项已选不在当前筛选结果中") &&
        filtered.noteHidden === false &&
        afterSecond === "添加所选 (2)" &&
        appended.includes("fixture-model-alpha") &&
        appended.includes("fixture-model-beta"),
      subviewLog
    );

    // 逐层 Esc：子视图先退，编辑器仍在，焦点归还「获取可用模型」
    await clickCenter(page.cdp, ".provider-editor-fetch");
    await waitFor("模型子视图重开", () => page.cdp.evaluate(`Boolean(document.querySelector(".provider-editor-fetch-dialog"))`), { timeoutMs: 20000 });
    await pressEscape(page.cdp);
    await waitFor("Esc 只关子视图", () => page.cdp.evaluate(`!document.querySelector(".provider-editor-fetch-dialog") && Boolean(document.querySelector(".provider-editor-dialog"))`), { timeoutMs: 8000 });
    const focusAfterEsc = await focusInfo(page.cdp);
    focusTrace.push({ step: "C3.3-subview-esc", focus: focusAfterEsc });
    check(
      "C3.3-子视图 Esc 只退一层并把焦点还给获取可用模型",
      Boolean(focusAfterEsc) && String(focusAfterEsc.className).includes("provider-editor-fetch") && focusAfterEsc.insideDialog === true,
      focusAfterEsc
    );

    // Tab 焦点约束：层内环绕（末 → 首，首 → 末），焦点不出编辑器
    const tabTrace = [];
    await page.cdp.evaluate(`(() => {
      const dialog = document.querySelector(".provider-editor-dialog");
      const items = Array.from(dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
      items[items.length - 1].focus({ preventScroll: true });
      return items.length;
    })()`);
    const focusableCount = await page.cdp.evaluate(`document.querySelectorAll('.provider-editor-dialog a[href],.provider-editor-dialog button:not([disabled]),.provider-editor-dialog input:not([disabled]),.provider-editor-dialog select:not([disabled]),.provider-editor-dialog textarea:not([disabled])').length`);
    await pressTab(page.cdp);
    tabTrace.push(await focusInfo(page.cdp));
    await page.cdp.evaluate(`(() => {
      const dialog = document.querySelector(".provider-editor-dialog");
      const items = Array.from(dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
      items[0].focus({ preventScroll: true });
      return true;
    })()`);
    await pressTab(page.cdp, true);
    tabTrace.push(await focusInfo(page.cdp));
    // 连按 Tab 8 次，焦点始终在编辑器层内
    for (let index = 0; index < 8; index += 1) {
      await pressTab(page.cdp);
      tabTrace.push(await focusInfo(page.cdp));
    }
    focusTrace.push({ step: "C3.4-tab-cycle", trace: tabTrace, focusableCount });
    const allInside = tabTrace.every((item) => item && item.insideDialog === true);
    check(
      "C3.4-编辑器 Tab 焦点约束在层内环绕且不外泄",
      allInside && focusableCount > 5 && tabTrace[0]?.insideDialog === true && tabTrace[1]?.insideDialog === true,
      { focusableCount, trace: tabTrace.map((item) => item?.className || item?.id) }
    );

    // dirty 确认：Esc 弹「放弃更改」，取消回编辑器，确认关闭并归还触发控件
    await fillField(page.cdp, ".provider-editor-name", "dirty-焦点归还");
    await pressEscape(page.cdp);
    const discard = await waitFor("放弃更改确认框", () => page.cdp.evaluate(`(() => {
      const box = document.querySelector(".confirm-dialog");
      if (!box) return null;
      return {
        title: box.querySelector(".confirm-dialog-title")?.textContent?.trim() || "",
        message: box.querySelector(".confirm-dialog-message")?.textContent?.trim() || "",
        confirm: box.querySelector(".confirm-dialog-confirm")?.textContent?.trim() || "",
        cancel: box.querySelector(".confirm-dialog-cancel")?.textContent?.trim() || ""
      };
    })()`), { timeoutMs: 8000 });
    const focusOnCancel = await focusInfo(page.cdp);
    await clickCenter(page.cdp, ".confirm-dialog-cancel");
    const editorStillOpen = await page.cdp.evaluate(`Boolean(document.querySelector(".provider-editor-dialog"))`);
    const focusBack = await focusInfo(page.cdp);
    await pressEscape(page.cdp);
    await waitFor("放弃更改确认框（第二次）", () => page.cdp.evaluate(`Boolean(document.querySelector(".confirm-dialog"))`), { timeoutMs: 8000 });
    await clickCenter(page.cdp, ".confirm-dialog-confirm");
    await waitEditorClosed(page.cdp);
    await waitFor("焦点归还行内编辑键", () => page.cdp.evaluate(`document.activeElement?.classList?.contains("provider-row-edit") === true`), { timeoutMs: 8000 }).catch(() => null);
    const focusReturned = await focusInfo(page.cdp);
    results.focusReturn = { discard, focusOnCancel, editorStillOpen, focusBack, focusReturned };
    check(
      "C3.5-dirty 确认安全默认焦点、取消回编辑器、确认关闭并归还焦点",
      discard?.title === "放弃更改" &&
        discard?.message.includes("未保存的更改将丢失") &&
        discard?.confirm === "放弃更改" &&
        focusOnCancel?.insideConfirm === true &&
        String(focusOnCancel?.className).includes("confirm-dialog-cancel") &&
        editorStillOpen === true &&
        focusBack?.insideDialog === true &&
        focusReturned?.insideDialog === false &&
        String(focusReturned?.className).includes("provider-row-edit"),
      results.focusReturn
    );
  }

  // ============================================================
  // C6 400px 窄面板 + 矮视口
  // ============================================================
  {
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 360, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await openSettingsSection(page.cdp, "llm");
    await page.cdp.evaluate(`document.getElementById("addAiProviderBtn")?.scrollIntoView({ block: "center" })`);
    await sleep(200);
    await clickCenter(page.cdp, "#addAiProviderBtn");
    await waitEditor(page.cdp, { submit: "保存" });
    await clickCenter(page.cdp, ".provider-editor-save");
    await waitFor("字段错误出现", () => page.cdp.evaluate(`Array.from(document.querySelectorAll(".provider-editor-field-error")).some((node) => !node.hasAttribute("hidden"))`), { timeoutMs: 8000 });
    const narrow = await page.cdp.evaluate(`(() => {
      const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
      const dialog = document.querySelector(".provider-editor-dialog");
      const active = document.activeElement;
      return {
        viewport: { w: innerWidth, h: innerHeight },
        docScrollWidth: document.documentElement.scrollWidth,
        reading: rect(document.getElementById("biliscript-reading-view")),
        dialog: rect(dialog),
        dialogScroll: dialog ? { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight } : null,
        save: rect(document.querySelector(".provider-editor-save")),
        cancel: rect(document.querySelector(".provider-editor-cancel")),
        errors: Array.from(document.querySelectorAll(".provider-editor-field-error")).filter((node) => !node.hasAttribute("hidden")).map((node) => ({ text: node.textContent.trim(), rect: rect(node) })),
        active: active ? { id: active.id, cls: typeof active.className === "string" ? active.className : "", invalid: active.getAttribute("aria-invalid") } : null
      };
    })()`);
    await shot(page.cdp, "03-narrow-form-errors.png");
    await pressEscape(page.cdp);
    await waitEditorClosed(page.cdp).catch(() => {});
    await closeEditorIfOpen(page.cdp);
    results.narrowForm = narrow;
    check(
      "C6.1-400px 矮视口表单错误可见、聚焦首个无效字段且不横向溢出",
      narrow.dialog !== null &&
        narrow.dialog.x >= -1 &&
        narrow.dialog.right <= narrow.viewport.w + 1 &&
        narrow.dialogScroll.scrollWidth <= narrow.dialogScroll.clientWidth + 1 &&
        narrow.docScrollWidth <= narrow.viewport.w + 1 &&
        narrow.reading.right <= narrow.viewport.w + 1 &&
        narrow.errors.length >= 1 &&
        narrow.errors.every((entry) => entry.rect && entry.rect.w > 0 && entry.rect.h > 0) &&
        narrow.active?.invalid === "true" &&
        narrow.save.bottom <= narrow.viewport.h + 1 &&
        narrow.cancel.bottom <= narrow.viewport.h + 1,
      narrow
    );

    // 确认框：矮容器内动作可达；内容超高时容器内部滚动
    await page.cdp.evaluate(`document.getElementById("addAiProviderBtn")?.scrollIntoView({ block: "center" })`);
    await clickCenter(page.cdp, "#addAiProviderBtn");
    await waitEditor(page.cdp, { submit: "保存" });
    await fillField(page.cdp, ".provider-editor-name", "窄面板放弃更改");
    await pressEscape(page.cdp);
    await waitFor("窄面板放弃更改确认框", () => page.cdp.evaluate(`Boolean(document.querySelector(".confirm-dialog"))`), { timeoutMs: 8000 });
    const narrowConfirm = await page.cdp.evaluate(`(() => {
      const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
      const box = document.querySelector(".confirm-dialog");
      const style = box ? getComputedStyle(box) : null;
      return {
        viewport: { w: innerWidth, h: innerHeight },
        confirm: rect(box),
        foot: rect(document.querySelector(".confirm-dialog-foot")),
        cancel: rect(document.querySelector(".confirm-dialog-cancel")),
        confirmBtn: rect(document.querySelector(".confirm-dialog-confirm")),
        scroll: box ? { overflowY: style.overflowY, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight } : null
      };
    })()`);
    await shot(page.cdp, "04-narrow-confirm.png");
    await clickCenter(page.cdp, ".confirm-dialog-cancel");
    await closeEditorIfOpen(page.cdp);
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    results.narrowConfirm = narrowConfirm;
    check(
      "C6.2-400px 矮视口确认框内部滚动且动作可达",
      narrowConfirm.confirm !== null &&
        narrowConfirm.confirm.y >= -1 &&
        narrowConfirm.confirm.bottom <= narrowConfirm.viewport.h + 1 &&
        narrowConfirm.foot.bottom <= narrowConfirm.viewport.h + 1 &&
        narrowConfirm.cancel.bottom <= narrowConfirm.viewport.h + 1 &&
        narrowConfirm.confirmBtn.bottom <= narrowConfirm.viewport.h + 1 &&
        (narrowConfirm.scroll.scrollHeight <= narrowConfirm.scroll.clientHeight + 1 || ["auto", "scroll"].includes(narrowConfirm.scroll.overflowY)),
      narrowConfirm
    );
  }

  // ============================================================
  // C4 Live 保存的 http(s)+ws(s) 多 origin 域名权限（拒绝态）
  // ============================================================
  {
    await installPermissionProbe(permanent);
    await openSettingsSection(page.cdp, "live");
    await clickCenter(page.cdp, "#addLiveProviderBtn");
    await waitEditor(page.cdp, { submit: "保存" });
    await fillField(page.cdp, ".provider-editor-baseurl", LIVE_FIXTURE_BASE);
    await fillField(page.cdp, ".provider-editor-apikey", FAKE_KEYS.liveFixtureHost);
    const baselineContains = await permissionContains(LIVE_FIXTURE_ORIGINS);
    await clickCenter(page.cdp, ".provider-editor-save");
    const denied = await waitFor("未授权保存中止", () => page.cdp.evaluate(`(() => {
      const status = document.querySelector(".provider-editor-dialog .provider-editor-status");
      if (!status || status.hidden || status.dataset.error !== "true") return null;
      return { text: status.innerText.trim(), editorOpen: Boolean(document.querySelector(".provider-editor-dialog")), baseUrl: document.querySelector(".provider-editor-baseurl")?.value || "" };
    })()`), { timeoutMs: 20000 });
    const calls = await permissionCalls();
    const deniedOrigins = await permissionDenied();
    results.liveDenied = { baselineContains, denied, calls, deniedOrigins };
    check(
      "C4.5-Live 保存申请 http(s)+ws(s) 多 origin，拒绝时中止且草稿保留",
      baselineContains === false &&
        denied.text.includes("未保存") &&
        denied.text.includes("请重新授权后重试") &&
        denied.editorOpen === true &&
        denied.baseUrl === LIVE_FIXTURE_BASE &&
        JSON.stringify(calls.at(-1)?.origins || []) === JSON.stringify(LIVE_FIXTURE_ORIGINS) &&
        LIVE_FIXTURE_ORIGINS.every((origin) => deniedOrigins.includes(origin)),
      { calls, deniedOrigins, status: denied.text }
    );
    await clickCenter(page.cdp, ".provider-editor-cancel");
    await waitFor("放弃更改确认框（Live 拒绝后）", () => page.cdp.evaluate(`Boolean(document.querySelector(".confirm-dialog"))`), { timeoutMs: 8000 });
    await clickCenter(page.cdp, ".confirm-dialog-confirm");
    await waitEditorClosed(page.cdp);
  }

  // ============================================================
  // C5 搜索首次授权：付费提示 / 拒绝后开关同步 / 不重复询问 / 重新开启 / 同意
  // ============================================================
  {
    await seedSync({
      aiProviders: [AI_ALPHA, AI_DEEPSEEK],
      defaultModel: "ai-alpha",
      webSearchEnabled: true,
      searchOptInNoticeAcknowledged: false,
      searchProviders: [SEARCH_TAVILY, SEARCH_ANY, SEARCH_DEEPSEEK],
      allowPaidSearchProviders: true
    });
    await seedLocal({ aiProviderKeys: { "ai-alpha": FAKE_KEYS.chat, "ai-deepseek-official": FAKE_KEYS.searchRoundTrip } });
    if (await page.cdp.evaluate(`document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") === true`)) {
      await closeSettings(page.cdp);
    }
    await activateTab(page.cdp, "biliscript-reading-tab-chat");
    await waitFor("对话输入就绪", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-reading-chat-input"))`), { timeoutMs: 20000 });

    const completionsBase = requestLog.filter((entry) => entry.kind === "completion").length;
    const searchesBase = requestLog.filter((entry) => entry.kind === "search").length;
    toolCallBudget = 1;
    await fillField(page.cdp, "#biliscript-reading-chat-input", "票13对话授权-第一次");
    await waitFor("发送键可用", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-send-btn")?.disabled === false`), { timeoutMs: 15000 });
    await clickCenter(page.cdp, "#biliscript-reading-chat-send-btn");
    const optIn = await waitFor("搜索首次授权弹层", () => page.cdp.evaluate(`(() => {
      const box = document.querySelector(".confirm-dialog");
      if (!box) return null;
      return {
        title: box.querySelector(".confirm-dialog-title")?.textContent?.trim() || "",
        message: box.querySelector(".confirm-dialog-message")?.textContent?.trim() || "",
        confirm: box.querySelector(".confirm-dialog-confirm")?.textContent?.trim() || "",
        cancel: box.querySelector(".confirm-dialog-cancel")?.textContent?.trim() || "",
        focus: document.activeElement?.className || "",
        scroll: (() => { const s = getComputedStyle(box); return { overflowY: s.overflowY, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight }; })()
      };
    })()`), { timeoutMs: 15000 });
    await shot(page.cdp, "05-search-opt-in.png");
    results.searchOptIn = { optIn };
    check(
      "C5.1-首次联网搜索弹出授权：标题、查询词外发说明、付费提示与双动作",
      optIn.title === "允许联网搜索？" &&
        optIn.message.includes("查询词") &&
        optIn.message.includes("会产生费用") &&
        optIn.confirm === "允许并继续" &&
        optIn.cancel === "本次不搜索" &&
        String(optIn.focus).includes("confirm-dialog-cancel"),
      optIn
    );

    await clickCenter(page.cdp, ".confirm-dialog-cancel");
    const declinedAnswer = await waitFor("拒绝后对话仍继续", () => page.cdp.evaluate(`(() => {
      const text = document.getElementById("biliscript-reading-chat-messages")?.innerText || "";
      return text.includes("受控对话回答") ? text : null;
    })()`), { timeoutMs: 45000 });
    const completionsAfterDecline = requestLog.filter((entry) => entry.kind === "completion").length;
    const searchesAfterDecline = requestLog.filter((entry) => entry.kind === "search").length;
    const afterDecline = await readStorage("sync", ["webSearchEnabled", "searchOptInNoticeAcknowledged"]);
    const pillAfterDecline = await page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-web-search-pill")?.classList.contains("is-active") === true`);
    results.searchDecline = {
      declinedAnswer: declinedAnswer.slice(-300),
      completions: requestLog.filter((entry) => entry.kind === "completion").slice(-3),
      completionDelta: completionsAfterDecline - completionsBase,
      searchDelta: searchesAfterDecline - searchesBase,
      settings: afterDecline,
      pillActive: pillAfterDecline
    };
    check(
      "C5.2-拒绝后本轮无搜索继续、偏好关闭且开关同步",
      completionsAfterDecline - completionsBase === 1 &&
        searchesAfterDecline - searchesBase === 0 &&
        afterDecline.webSearchEnabled === false &&
        afterDecline.searchOptInNoticeAcknowledged === false &&
        pillAfterDecline === false,
      results.searchDecline
    );

    // 下一条消息不重复询问
    await fillField(page.cdp, "#biliscript-reading-chat-input", "票13对话授权-第二次");
    await waitFor("发送键可用（第二条）", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-send-btn")?.disabled === false`), { timeoutMs: 15000 });
    await clickCenter(page.cdp, "#biliscript-reading-chat-send-btn");
    const secondAnswer = await waitFor("第二条继续", () => page.cdp.evaluate(`(() => {
      const text = document.getElementById("biliscript-reading-chat-messages")?.innerText || "";
      return text.includes("票13对话授权-第二次") && text.includes("受控对话回答") ? text : null;
    })()`), { timeoutMs: 45000 }).catch(() => null);
    const dialogAfterSecond = await page.cdp.evaluate(`Boolean(document.querySelector(".confirm-dialog"))`);
    const completionsAfterSecond = requestLog.filter((entry) => entry.kind === "completion").length;
    results.searchNoRepeat = { answered: Boolean(secondAnswer), dialog: dialogAfterSecond, completionDelta: completionsAfterSecond - completionsAfterDecline };
    check(
      "C5.3-拒绝后的下一条消息不重复询问",
      Boolean(secondAnswer) && dialogAfterSecond === false && completionsAfterSecond - completionsAfterDecline === 1,
      results.searchNoRepeat
    );

    // 重新开启联网搜索 → 再次询问；同意 → 写授权位且真实发出搜索请求
    await clickCenter(page.cdp, "#biliscript-reading-chat-web-search-pill");
    await waitFor("联网搜索开关打开", async () => (await readStorage("sync", ["webSearchEnabled"])).webSearchEnabled === true, { timeoutMs: 10000 });
    toolCallBudget = 1;
    await fillField(page.cdp, "#biliscript-reading-chat-input", "票13对话授权-第三次");
    await waitFor("发送键可用（第三条）", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-send-btn")?.disabled === false`), { timeoutMs: 15000 });
    await clickCenter(page.cdp, "#biliscript-reading-chat-send-btn");
    const optInAgain = await waitFor("重新开启后再次询问", () => page.cdp.evaluate(`Boolean(document.querySelector(".confirm-dialog"))`), { timeoutMs: 15000 }).catch(() => null);
    const searchBaseAgree = requestLog.filter((entry) => entry.kind === "search").length;
    await clickCenter(page.cdp, ".confirm-dialog-confirm");
    const agreeAnswer = await waitFor("同意后对话继续", () => page.cdp.evaluate(`(() => {
      const text = document.getElementById("biliscript-reading-chat-messages")?.innerText || "";
      return text.includes("票13对话授权-第三次") && text.includes("受控对话回答") ? text : null;
    })()`), { timeoutMs: 60000 });
    await sleep(600);
    const agreeSettings = await readStorage("sync", ["webSearchEnabled", "searchOptInNoticeAcknowledged"]);
    const searchesAfterAgree = requestLog.filter((entry) => entry.kind === "search").length;
    results.searchAgree = { reAsked: Boolean(optInAgain), answered: Boolean(agreeAnswer), settings: agreeSettings, searchDelta: searchesAfterAgree - searchBaseAgree };
    check(
      "C5.4-重新开启后再次询问；同意后写授权位并真实带搜索继续",
      Boolean(optInAgain) === true &&
        agreeSettings.searchOptInNoticeAcknowledged === true &&
        agreeSettings.webSearchEnabled === true &&
        searchesAfterAgree - searchBaseAgree >= 1,
      results.searchAgree
    );
  }

  // 解释链路：授权与平台可用性分开；拒绝后解释主任务继续且不发搜索请求
  {
    await seedSync({ webSearchEnabled: true, searchOptInNoticeAcknowledged: false, searchProviders: [SEARCH_ANY], allowPaidSearchProviders: false });
    await activateTab(page.cdp, "biliscript-reading-tab-subtitle");
    await waitFor("字幕列表就绪", () => page.cdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length > 0`), { timeoutMs: 45000 });
    const completionsBase = requestLog.filter((entry) => entry.kind === "completion").length;
    const searchesBase = requestLog.filter((entry) => entry.kind === "search").length;
    const selection = await selectExplainText(page.cdp);
    await clickCenter(page.cdp, ".biliscript-reading-explain-btn");
    const explainOptIn = await waitFor("解释链搜索授权弹层", () => page.cdp.evaluate(`(() => {
      const box = document.querySelector(".confirm-dialog");
      if (!box) return null;
      return { title: box.querySelector(".confirm-dialog-title")?.textContent?.trim() || "", message: box.querySelector(".confirm-dialog-message")?.textContent?.trim() || "" };
    })()`), { timeoutMs: 45000 });
    await clickCenter(page.cdp, ".confirm-dialog-cancel");
    const explainAnswer = await waitFor("拒绝后解释继续", () => page.cdp.evaluate(`(() => {
      const text = document.querySelector("#biliscript-reading-explain-card .biliscript-reading-explain-card-answer")?.innerText?.trim() || "";
      return text.includes("受控解释回答") ? text : null;
    })()`), { timeoutMs: 45000 });
    const afterExplain = await readStorage("sync", ["webSearchEnabled"]);
    const explainCompletions = requestLog.filter((entry) => entry.kind === "completion").length;
    const explainSearches = requestLog.filter((entry) => entry.kind === "search").length;
    await clickCenter(page.cdp, '#biliscript-reading-explain-card [data-explain-card-action="close"]');
    results.explainOptIn = {
      selection,
      title: explainOptIn.title,
      paidNotice: explainOptIn.message.includes("会产生费用"),
      answered: Boolean(explainAnswer),
      completionDelta: explainCompletions - completionsBase,
      searchDelta: explainSearches - searchesBase,
      webSearchEnabled: afterExplain.webSearchEnabled
    };
    check(
      "C5.5-解释链拒绝后主任务继续、无搜索请求且免费链无付费提示",
      explainOptIn.title === "允许联网搜索？" &&
        results.explainOptIn.paidNotice === false &&
        results.explainOptIn.answered === true &&
        results.explainOptIn.completionDelta === 1 &&
        results.explainOptIn.searchDelta === 0 &&
        afterExplain.webSearchEnabled === false,
      results.explainOptIn
    );
  }

  // ============================================================
  // C4 浏览器权限 API（mic）：拒绝 / 授权 / 重新授权 / 多 origin
  // ============================================================
  {
    const queryMic = async () => page.cdp.evaluate(`(async () => {
      try {
        const status = await navigator.permissions.query({ name: "microphone" });
        return status.state;
      } catch (error) {
        return "query-error:" + error.message;
      }
    })()`);
    const requestMic = async () => page.cdp.evaluate(`(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        return { ok: true };
      } catch (error) {
        return { ok: false, name: error.name, message: String(error.message || "").slice(0, 200) };
      }
    })()`);

    await browserCdp.send("Browser.resetPermissions", {});
    await sleep(300);
    const deniedState = await queryMic();
    const deniedMedia = await requestMic();

    await browserCdp.send("Browser.grantPermissions", { permissions: ["audioCapture"], origin: "https://www.bilibili.com" });
    await sleep(300);
    const grantedState = await queryMic();
    const grantedMedia = await requestMic();

    await browserCdp.send("Browser.resetPermissions", {});
    await sleep(200);
    const revokedState = await queryMic();
    await browserCdp.send("Browser.grantPermissions", { permissions: ["audioCapture"], origin: "https://www.bilibili.com" });
    await sleep(300);
    const regrantedState = await queryMic();
    const regrantedMedia = await requestMic();

    // 多 origin：同一浏览器权限库对视频页与直播页两个 origin 分别授权
    await browserCdp.send("Browser.grantPermissions", { permissions: ["audioCapture"], origin: "https://live.bilibili.com" });
    await sleep(200);
    await page.cdp.send("Page.navigate", { url: LIVE_URL });
    await waitFor("直播页 fixture", () => page.cdp.evaluate(`Boolean(document.getElementById("live-player"))`), { timeoutMs: 20000 });
    const liveState = await queryMic();
    const liveMedia = await requestMic();
    await page.cdp.send("Page.navigate", { url: VIDEO_URL });
    try {
      await waitFor("回到视频页", () => page.cdp.evaluate(`Boolean(document.querySelector(".bpx-player-container"))`), { timeoutMs: 20000 });
    } catch (error) {
      results.returnToVideo = await page.cdp.evaluate(`(() => ({ href: location.href, title: document.title, body: document.body.innerText.slice(0, 300), root: document.body.innerHTML.slice(0, 500) }))()`).catch(() => null);
      throw error;
    }

    results.mic = { deniedState, deniedMedia, grantedState, grantedMedia, revokedState, regrantedState, regrantedMedia, liveState, liveMedia };
    check(
      "C4.1-浏览器权限 API：首次拒绝、授权、重新授权与多 origin 均按真实权限库结算",
      ["denied", "prompt"].includes(deniedState) &&
        deniedMedia?.ok === false &&
        deniedMedia?.name === "NotAllowedError" &&
        grantedState === "granted" &&
        grantedMedia?.ok === true &&
        ["denied", "prompt"].includes(revokedState) &&
        regrantedState === "granted" &&
        regrantedMedia?.ok === true &&
        liveState === "granted" &&
        liveMedia?.ok === true,
      results.mic
    );
  }

  // C7 外部出网审计（fixture 之外的真实请求一条都不许有）
  check("C7.1-全程可控 fixture，无白名单外的真实出网请求", externalRequests.length === 0, { externalRequests: externalRequests.slice(0, 10) });
}

// ===== 阶段 B：装期授权 fixture 域名后的真实权限结算 =====

async function phaseB() {
  await boot({ grantedFixtureHosts: true });
  results.permissions = results.permissions || {};
  const permanent = JSON.parse(readFileSync(path.join(distDir, "manifest.json"), "utf8")).host_permissions;
  const aiGranted = await permissionContains([AI_FIXTURE_ORIGIN]);
  const liveGranted = [
    await permissionContains([LIVE_FIXTURE_ORIGINS[0]]),
    await permissionContains([LIVE_FIXTURE_ORIGINS[1]])
  ];
  results.permissions.grantedState = { aiGranted, liveGranted };

  await seedBaseline();
  await installPermissionProbe(permanent);
  await page.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("视频页扩展按钮", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await openSettingsSection(page.cdp, "live");

  // Live 保存：真实 chrome.permissions.request 对已授权 origin 直接放行，保存落盘
  const callsBefore = (await permissionCalls()).length;
  await clickCenter(page.cdp, "#addLiveProviderBtn");
  await waitEditor(page.cdp, { submit: "保存" });
  await fillField(page.cdp, ".provider-editor-baseurl", LIVE_FIXTURE_BASE);
  await fillField(page.cdp, ".provider-editor-apikey", FAKE_KEYS.liveFixtureHost);
  await clickCenter(page.cdp, ".provider-editor-save");
  await waitEditorClosed(page.cdp);
  const liveProviders = await readStorage("sync", ["liveProviders"]);
  const liveSaved = liveProviders.liveProviders?.find((item) => String(item.baseUrl || "").startsWith(LIVE_FIXTURE_BASE));
  const calls = (await permissionCalls()).slice(callsBefore);
  results.permissions.liveSave = { calls, liveSaved: liveSaved ? { id: liveSaved.id, baseUrl: liveSaved.baseUrl } : null };
  const liveOriginsRequested = calls.at(-1)?.origins || [];
  check(
    "C4.7-重新授权后 Live 保存经真实权限 API 放行并落盘 http(s)+ws(s) 双 origin",
    liveGranted?.length === 2 &&
      liveGranted.every((value) => value === true) &&
      Boolean(liveSaved) &&
      JSON.stringify(liveOriginsRequested) === JSON.stringify(LIVE_FIXTURE_ORIGINS),
    { liveGranted, liveSaved: results.permissions.liveSave.liveSaved, calls }
  );

  // AI 保存到已授权 fixture 宿主
  await openSettingsSection(page.cdp, "llm");
  const aiCallsBefore = (await permissionCalls()).length;
  await clickCenter(page.cdp, "#addAiProviderBtn");
  await waitEditor(page.cdp, { submit: "保存" });
  await fillField(page.cdp, ".provider-editor-baseurl", AI_FIXTURE_BASE);
  await fillField(page.cdp, ".provider-editor-apikey", FAKE_KEYS.aiFixtureHost);
  await clickCenter(page.cdp, ".provider-editor-model-add");
  await waitFor("模型行出现", () => page.cdp.evaluate(`Boolean(document.querySelector(".provider-editor-model-id"))`), { timeoutMs: 8000 });
  await fillField(page.cdp, ".provider-editor-model-id", "fixture-model-alpha");
  await clickCenter(page.cdp, ".provider-editor-save");
  await waitEditorClosed(page.cdp);
  const aiProviders = await readStorage("sync", ["aiProviders"]);
  const aiSaved = aiProviders.aiProviders?.find((item) => String(item.baseUrl || "").startsWith("https://api.fixture-ai.test"));
  const aiCalls = (await permissionCalls()).slice(aiCallsBefore);
  results.permissions.aiSave = { calls: aiCalls, aiSaved: aiSaved ? { id: aiSaved.id, baseUrl: aiSaved.baseUrl } : null };
  check(
    "C4.8-已授权 fixture 宿主的 AI 保存走真实权限 API 且编辑器成功关闭",
    aiGranted === true && liveGranted.length === 2 && liveGranted.every((value) => value === true) && Boolean(liveSaved) && Boolean(aiSaved),
    { aiGranted, liveGranted, liveCalls: calls, aiCalls, liveSaved: results.permissions.liveSave.liveSaved, aiSaved: results.permissions.aiSave.aiSaved }
  );
  await shot(page.cdp, "06-granted-saves.png");
}

// ===== 证据与收场 =====

async function main() {
  // 上一轮的失败截图 / 证据不与本轮混放：工件目录每次重建。
  await rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
  try {
    await phaseA();
  } catch (error) {
    if (activePage) {
      results.failureDiagnostics = await activePage.cdp.evaluate(`(() => ({
        href: location.href,
        bodyText: document.body.innerText.slice(-3000),
        settings: document.getElementById("biliscript-reading-settings-host")?.innerText?.slice(0, 1500) || null,
        editor: document.querySelector(".provider-editor-dialog")?.innerText?.slice(0, 1500) || null,
        confirm: document.querySelector(".confirm-dialog")?.innerText?.slice(0, 800) || null,
        chat: document.getElementById("biliscript-reading-chat-messages")?.innerText?.slice(-1200) || null
      }))()`).catch((diagnosticError) => ({ error: diagnosticError.message }));
      await failShot(activePage.cdp, "phase-a");
    }
    check("scenario-infrastructure-a", false, { error: error.message, stack: String(error.stack || "").slice(0, 3000) });
    log(`阶段 A 异常：${error.stack || error.message}`);
  } finally {
    await shutdown();
  }

  try {
    await phaseB();
  } catch (error) {
    if (activePage) {
      results.failureDiagnosticsB = await activePage.cdp.evaluate(`(() => ({
        href: location.href,
        bodyText: document.body.innerText.slice(-3000),
        settings: document.getElementById("biliscript-reading-settings-host")?.innerText?.slice(0, 1500) || null,
        editor: document.querySelector(".provider-editor-dialog")?.innerText?.slice(0, 1500) || null
      }))()`).catch((diagnosticError) => ({ error: diagnosticError.message }));
      await failShot(activePage.cdp, "phase-b");
    }
    check("scenario-infrastructure-b", false, { error: error.message, stack: String(error.stack || "").slice(0, 3000) });
    log(`阶段 B 异常：${error.stack || error.message}`);
  } finally {
    await shutdown();
  }
}

try {
  await main();
} finally {
  // 证据自检：断言覆盖面、权限结果、焦点记录、截图，以及任何假 Key 不得进证据文件。
  // C8 的判据就是这个工件自检本身：前七组各至少一条断言，工件带齐权限结果 /
  // 焦点记录 / 截图 / 日志。
  const sections = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"];
  const covered = sections.filter((prefix) => checks.some((entry) => String(entry.name).startsWith(prefix)));
  const evidencePayload = {
    scenario: NAME,
    generatedAt: new Date().toISOString(),
    engine: browser?.version?.Browser || "",
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks,
    results,
    permissions: results.permissions || {},
    focusTrace,
    requests: requestLog,
    externalRequests,
    logs: getLog(),
    pages: pageWatchers,
    screenshots,
    boundary: [
      "离线 fixture：B 站文档/接口、AI SSE、模型列表、搜索平台应答全部由本场景回放；不使用真实账号、真实 Key 或外部付费服务。",
      "headless 无浏览器 UI：交互式 chrome.permissions.request 的原生弹窗无法结算（实测 pending 不 resolve），未常驻 manifest 的 origin 由 SW 单点替身按拒绝结算；已常驻 origin 仍走真实 chrome.permissions.request。「重新授权」用第二次装机（fixture 域名写入 host_permissions）建立真实授权态再复核 contains()。",
      "浏览器权限库的首次拒绝/授权/重新授权/多 origin 走 CDP Browser.resetPermissions / grantPermissions（真实权限 API）。"
    ]
  };
  const evidenceText = JSON.stringify(evidencePayload);
  const leakedKeyNames = Object.entries(FAKE_KEYS).filter(([, value]) => evidenceText.includes(value)).map(([name]) => name);
  const leakedKeys = leakedKeyNames;
  check(
    "C8.1-证据工件完整且不含 Key 明文",
    covered.length === sections.length &&
      checks.length >= 20 &&
      leakedKeys.length === 0 &&
      Object.keys(evidencePayload.permissions).length > 0 &&
      focusTrace.length > 0 &&
      screenshots.length > 0,
    { covered, checks: checks.length, leakedKeys: leakedKeyNames, focusEntries: focusTrace.length, screenshots: screenshots.length }
  );
  // C2.4 与 C8.1 合并判据之外，再把「Key 不进证据」单列一条便于失败定位。
  check("C2.4-证据文本不含任何假 Key 明文", leakedKeys.length === 0, { leaked: leakedKeyNames });

  await writeEvidence(OUT_DIR, evidencePayload);
  log(`证据目录：${OUT_DIR}`);
  if (checks.some((entry) => !entry.ok) || checks.length === 0) process.exitCode = 1;
}
