#!/usr/bin/env node
// 票 provider-onboarding-consistency/12：首配（概览 / AI 对话 / 解释卡 / 语音转写）
// 的真机验收——未配置 → 保存 → 一次性续跑，以及取消 / 换分P / 保存失败 / 普通编辑
// 下旧任务意图不复活。
//
// 全程离线：B 站文档与接口、AI 完成请求、ASR 音轨与转写请求都是本文件的 fixture
// 回放（页面 Fetch 与 SW/offscreen Fetch 两处拦截），不使用真实账号、真实 Key 或
// 任何外部付费服务。
import path from "node:path";
import { rm } from "node:fs/promises";
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

const NAME = "provider-onboarding-acceptance";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const BVID = "BV1mAam6tEL8";
const AID = 117370433574328;
const CID = 42393338874;
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/?p=1`;
const VIDEO_URL_P2 = `https://www.bilibili.com/video/${BVID}/?p=2`;
// 无字幕视频（ASR 链路）：手工构造的合法 BVID，只在本场景的 fixture 里存在。
const ASR_BVID = "BV1xr4y1c7dE";
const ASR_CID = 42393349999;
const ASR_URL = `https://www.bilibili.com/video/${ASR_BVID}/?p=1`;
// 真实 B 站 DASH 音轨 m4s 片段（tests/asr/fixtures 的可提交数据）：ASR 需要真
// fMP4 才能解出音帧，切片与转写请求都由此驱动。
const ASR_AUDIO_BYTES = readFileSync(path.join(REPO_ROOT, "tests/asr/fixtures/fmp4-audio-sample.bin"));
const ASR_AUDIO_URL = "https://upos-sz-mirrorcos.bilivideo.com/fixture/asr-audio.m4s";
const AI_BASE_URL = "https://api.bilibili.com";
const ASR_BASE_URL = "https://api.bilibili.com/v1";

const fixtureRoot = path.join(REPO_ROOT, "tests/fixtures/bilibili/bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureRoot, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureRoot, "bodies.json"), "utf8"));
const subtitleBody = bodies[`${BVID}-zh`];

const checks = [];
const results = {};
const requestLog = []; // SW 侧 AI 完成 / 搜索 / 播放器接口请求（Node 侧记录）
// createWorkerSession 在 ensureAlive 时会先跑一次 onReconnect，本文件的显式安装会
// 让同一 CDP 会话上挂两个 Fetch 监听：同一请求因此被暂停两次。按 requestId 去重，
// 只处理第一次（第二次 fulfill 会拿到 Invalid InterceptionId）。
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>首配真机验收</title>
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
      title: bvid === ASR_BVID ? "无字幕首配验收视频" : "首配闭环真机验收视频",
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
          { baseUrl: ASR_AUDIO_URL, backupUrl: [], bandwidth: 65553, id: 30216 },
          { baseUrl: ASR_AUDIO_URL, backupUrl: [], bandwidth: 128066, id: 30232 }
        ]
      }
    }
  };
}

function sseHeaders() {
  return [{ name: "content-type", value: "text/event-stream" }];
}

function openAiSse(content) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
}

// 概览管线与对话共用一个受控 SSE 出口：系统提示词含「内容助理」即概览结构化
// JSON，其余是对话回答。
function completionKind(body) {
  const prompt = JSON.stringify(body?.messages || []);
  if (prompt.includes("内容助理")) return "overview";
  if (prompt.includes("被观众选中的内容")) return "explain";
  return "chat";
}

function completionFixture(body, url) {
  const prompt = JSON.stringify(body?.messages || []);
  const content = prompt.includes("内容助理")
    ? '{"summary":"受控概览摘要","chapters":[],"keyQuotes":[]}'
    : prompt.includes("被观众选中的内容")
      ? "受控解释回答。"
      : "受控对话回答。";
  // 流式链路（概览 / 对话）吃 SSE；非流式链路（选区解释）吃普通 JSON 回包。
  if (body?.stream === false) {
    return {
      headers: [{ name: "content-type", value: "application/json" }],
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] })
    };
  }
  return { headers: sseHeaders(), body: openAiSse(content) };
}

let distDir;
let browser;
let page;
let worker;
let offscreen;
let activePage;

async function createHarnessDist() {
  // 本场景不需要额外 host 权限：AI 平台地址取已在 manifest host_permissions 里的
  // api.bilibili.com，ASR 音轨走被拦截的伪造 CDN，转写地址同域。故直接用 dist。
  return DEFAULT_DIST;
}

function installSwFixtures(handle) {
  const { cdp, sessionId } = handle;
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      const requestId = params.requestId;
      const method = params.request?.method || "GET";
      if (handledInterceptions.has(requestId)) return;
      handledInterceptions.add(requestId);
      let payload = null;
      let sseBody = null;
      let responseHeaders = [{ name: "content-type", value: "application/json" }];
      if (/x\/web-interface\/view/.test(url)) {
        const bvid = new URL(url).searchParams.get("bvid") || BVID;
        payload = bvid === ASR_BVID ? viewResponse(ASR_BVID, 11737043359999, ASR_CID) : viewResponse();
      } else if (/x\/player\/(?:wbi\/)?v2/.test(url)) {
        const request = new URL(url);
        const cid = request.searchParams.get("cid");
        const bvid = request.searchParams.get("bvid") || BVID;
        payload = bvid === ASR_BVID
          ? playerResponse({ bvid: ASR_BVID, cid: ASR_CID, aid: 11737043359999, withSubtitles: false })
          : playerResponse({ cid: cid === String(CID) ? CID : Number(cid) });
      } else if (/x\/player\/playurl/.test(url)) {
        payload = playurlResponse();
      } else if (url.includes(`walkthrough-fixture/${BVID}-zh.json`)) {
        payload = subtitleBody;
      } else if (url.includes("/chat/completions")) {
        // 非流式链路（选区解释）在 SW 侧直发 fetch；流式链路走 offscreen。
        let body = {};
        try { body = JSON.parse(params.request.postData || "{}"); } catch {}
        requestLog.push({ kind: "completion", url, model: body?.model || "", promptKind: completionKind(body), prompt: JSON.stringify(body?.messages || []).slice(0, 240), at: Date.now() });
        const fixture = completionFixture(body, url);
        sseBody = fixture.body;
        responseHeaders = fixture.headers;
      }
      try {
        if (sseBody !== null) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders,
            body: Buffer.from(sseBody).toString("base64")
          }, sessionId);
        } else if (payload) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders,
            body: Buffer.from(JSON.stringify(payload)).toString("base64")
          }, sessionId);
        } else {
          await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
        }
      } catch {}
    });
  });
}

// AI 完成请求由流式通道在 offscreen 文档发起（SW 只发 provider-http 代发消息），
// 故 offscreen 的 Fetch 域接管：「/chat/completions」回放受控 SSE，ASR 音轨与转写
// 请求同样在此回放。
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
          requestLog.push({ kind: "completion", url, model: body?.model || "", promptKind: completionKind(body), prompt: JSON.stringify(body?.messages || []).slice(0, 240), at: Date.now() });
          const fixture = completionFixture(body, url);
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: fixture.headers,
            body: Buffer.from(fixture.body).toString("base64")
          });
          return;
        }
        if (url.startsWith(ASR_AUDIO_URL)) {
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
          const payload = {
            text: "离线验收语音字幕内容。",
            segments: [{ start: 0, end: 30, text: "离线验收语音字幕内容。" }],
            language: "zh"
          };
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(JSON.stringify(payload)).toString("base64")
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
        return { blocked: "covered", rect: [rect.left, rect.top, rect.width, rect.height], hit: hit?.className || hit?.tagName || null, style: getComputedStyle(element).visibility + "/" + getComputedStyle(element).opacity };
      }
      return { x, y, width: rect.width, height: rect.height, hit: true };
    })()`);
    if (value && value.blocked) throw new Error(`不可点击：${JSON.stringify(value)}`);
    return value;
  }, { timeoutMs: 10000, intervalMs: 100 });
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120);
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

// 选区解释入口：用 Range + selectionchange 构造真实选区（README 说明文本拖选在
// 这一层够不着，这是产品自己监听的选区通道）。
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
    const rect = range.getBoundingClientRect();
    return { text: trimmed, seconds: item.dataset.seconds || "", rect: [rect.left, rect.top, rect.width, rect.height] };
  })()`);
  if (!selection) throw new Error("字幕条目里找不到可选中文本");
  return selection;
}

// 概览/解释的错误条会随状态机整块重建：探测到几何与真正按下之间节点可能已被
// 替换，真实点击于是落到相邻的「重试」。给「点一下 → 等目标出现」加重试，
// 保证判的是点击目标本身而不是一次竞态。
async function clickExpect(pageCdp, selector, waitFn, label, { attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await clickCenter(pageCdp, selector);
    } catch (error) {
      lastError = error;
      await sleep(400);
      continue;
    }
    const value = await waitFor(label, waitFn, { timeoutMs: 12000 }).catch((error) => {
      lastError = error;
      return null;
    });
    if (value) return value;
    await sleep(300);
  }
  throw lastError || new Error(`点击后未达到预期：${label}`);
}

async function failShot(pageCdp, name) {
  try {
    await screenshot(pageCdp, path.join(OUT_DIR, `failure-${name}.png`));
  } catch (error) {
    log(`失败截图未生成：${error.message}`);
  }
}

// ===== 平台编辑（真实输入）=====
async function waitProviderEditor(pageCdp, expectLabel = "保存并继续") {
  return waitFor("平台编辑器打开", () => pageCdp.evaluate(`(() => {
    const save = document.querySelector(".provider-editor-save");
    const key = document.querySelector(".provider-editor-apikey");
    if (!save || !key) return null;
    return { label: save.textContent.trim(), title: document.querySelector(".provider-editor-title")?.textContent || "" };
  })()`).then((value) => value && value.label === expectLabel ? value : null), { timeoutMs: 15000 });
}

async function fillNewAiProvider(pageCdp, { baseUrl, apiKey, model, name = "" }) {
  if (name) await fillField(pageCdp, ".provider-editor-name", name);
  await fillField(pageCdp, ".provider-editor-baseurl", baseUrl);
  await fillField(pageCdp, ".provider-editor-apikey", apiKey);
  await clickCenter(pageCdp, ".provider-editor-model-add");
  await waitFor("模型行出现", () => pageCdp.evaluate(`Boolean(document.querySelector(".provider-editor-model-id"))`));
  await fillField(pageCdp, ".provider-editor-model-id", model);
}

async function readStorage(workerSession, area, keys) {
  return workerSession.evaluate(`chrome.storage.${area}.get(${JSON.stringify(keys)})`);
}

const completions = () => requestLog.filter((entry) => entry.kind === "completion");
const transcriptions = () => requestLog.filter((entry) => entry.kind === "transcription");

async function hoverPlayer(pageCdp) {
  // AI 快捷动作按光标活动显形（host mousemove → .is-active）：先发一次真实
  // 鼠标移动进播放器，按钮几何与命中才是真机可达状态。
  const point = await pageCdp.evaluate(`(() => {
    const host = document.querySelector(".bpx-player-container");
    const rect = host.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
  await waitFor("AI 快捷动作显形", () => pageCdp.evaluate(`document.getElementById("biliscript-player-ai-quick-action")?.closest(".biliscript-player-ai-wrap")?.classList.contains("is-active") === true`), { timeoutMs: 8000 });
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

async function openReader(pageCdp) {
  await hoverPlayer(pageCdp);
  await clickCenter(pageCdp, "#biliscript-player-ai-quick-action");
  await waitFor("阅读视图打开", () => pageCdp.evaluate(`document.getElementById("biliscript-reading-view")?.classList.contains("open") === true && Boolean(document.getElementById("biliscript-reading-chat-input"))`), { timeoutMs: 45000 });
}

async function waitOverviewError(pageCdp) {
  return waitFor("概览配置类错误", () => pageCdp.evaluate(`(() => {
    const button = document.querySelector('[data-overview-action="setup"]');
    if (!button) return null;
    const strip = document.querySelector(".biliscript-reading-ov-strip.is-error");
    return { setupClass: button.dataset.setupClass, text: strip?.innerText || "" };
  })()`), { timeoutMs: 45000 });
}

async function waitSettingsClosed(pageCdp) {
  return waitFor("设置抽屉关闭", () => pageCdp.evaluate(`!document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") && !document.querySelector(".provider-editor-dialog")`), { timeoutMs: 20000 });
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
  await installDocumentFixture(page.cdp);

  worker = createWorkerSession({ pageCdp: page.cdp, browser, distDir, onReconnect: installSwFixtures });
  if (!(await worker.ensureAlive())) throw new Error("扩展 SW 不可用");
  await installSwFixtures(worker.handle);
  await worker.evaluate(`(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    await chrome.storage.sync.set({
      enablePlayerAiQuickAction: true,
      autoOpenReader: false,
      asrAutoFallback: false,
      webSearchEnabled: false,
      aiProviders: [],
      liveProviders: [],
      asrProviders: [],
      searchProviders: []
    });
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("entry/offscreen.html"),
      reasons: ["BLOBS"],
      justification: "Offline first-setup acceptance fixture"
    });
    return true;
  })()`);
  offscreen = await attachOffscreen(browser);
  await installOffscreenFixtures(offscreen);

  // ============================================================
  // A1 概览：未配置 → 保存并继续 → 一次性续跑
  // ============================================================
  await page.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("视频页扩展按钮", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await activateTab(page.cdp, "biliscript-reading-tab-overview");
  const overviewError = await waitOverviewError(page.cdp);
  results.overviewError = overviewError;
  check("A1.1-概览无平台显示配置类设置动作", overviewError?.setupClass === "no-provider" && overviewError.text.includes("还没有配置 AI 平台"), overviewError);
  await screenshot(page.cdp, path.join(OUT_DIR, "01-overview-no-provider.png"));

  const completionsBeforeOverviewSave = completions().length;
  const overviewEditor = await clickExpect(page.cdp, '[data-overview-action="setup"]', () => page.cdp.evaluate(`(() => {
    const save = document.querySelector(".provider-editor-save");
    if (!save || save.textContent.trim() !== "保存并继续") return null;
    return { label: save.textContent.trim(), title: document.querySelector(".provider-editor-title")?.textContent || "" };
  })()`), "平台编辑器打开（概览首配）");
  results.overviewEditor = overviewEditor;
  check("A1.2-概览去设置直达新增平台编辑器", Boolean(overviewEditor) && overviewEditor.label === "保存并继续", overviewEditor);
  await fillNewAiProvider(page.cdp, { baseUrl: AI_BASE_URL, apiKey: "fixture-ai-key", model: "fixture-overview-model" });
  await clickCenter(page.cdp, ".provider-editor-save");
  await waitSettingsClosed(page.cdp);
  const overviewReady = await waitFor("概览续跑完成", () => page.cdp.evaluate(`(() => {
    const body = document.getElementById("biliscript-reading-overview-body");
    const summary = body?.querySelector(".biliscript-reading-ov-summary");
    const text = summary?.textContent?.trim() || "";
    return text.includes("受控概览摘要") ? { text, href: location.href } : null;
  })()`), { timeoutMs: 45000 });
  results.overviewReady = overviewReady;
  const completionDelta = completions().length - completionsBeforeOverviewSave;
  const providerStorage = await readStorage(worker, "sync", ["aiProviders"]);
  const keyStorage = await readStorage(worker, "local", ["aiProviderKeys"]);
  results.overviewSaveStorage = { providers: providerStorage?.aiProviders, keys: keyStorage?.aiProviderKeys };
  check(
    "A1.3-保存后回到概览并一次性续跑出结果",
    overviewReady.text.includes("受控概览摘要") &&
      completionDelta === 1 &&
      Array.isArray(providerStorage?.aiProviders) && providerStorage.aiProviders.length === 1 &&
      keyStorage?.aiProviderKeys?.[providerStorage.aiProviders[0].id] === "fixture-ai-key",
    { completionDelta, providers: providerStorage?.aiProviders, keys: keyStorage?.aiProviderKeys }
  );
  const overviewShell = await page.cdp.evaluate(`(() => ({
    settingsExpanded: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open"),
    editor: Boolean(document.querySelector(".provider-editor-dialog")),
    activeTab: document.getElementById("biliscript-reading-tab-overview")?.classList.contains("is-active"),
    chatInputExists: Boolean(document.getElementById("biliscript-reading-chat-input"))
  }))()`);
  results.overviewShell = overviewShell;
  check("A1.4-续跑后设置关闭且停留概览 tab", !overviewShell.settingsExpanded && !overviewShell.editor && overviewShell.activeTab === true, overviewShell);
  await screenshot(page.cdp, path.join(OUT_DIR, "02-overview-resumed.png"));

  // 一次性消费：同一意图不能二次续跑（保存后再无续跑请求）。
  await sleep(800);
  check("A1.5-续跑只发生一次", completions().length - completionsBeforeOverviewSave === 1, { delta: completions().length - completionsBeforeOverviewSave });

  // ============================================================
  // A2 普通平台编辑不被首配意图触发任务
  // ============================================================
  const completionsBeforeNormalEdit = completions().length;
  await clickCenter(page.cdp, "#biliscript-reading-settings-btn");
  await waitFor("设置抽屉打开", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") && document.querySelectorAll("#aiProvidersList .ai-provider-row").length === 1`));
  await clickCenter(page.cdp, "#aiProvidersList .ai-provider-row .provider-row-edit");
  const normalEditor = await waitProviderEditor(page.cdp, "保存");
  results.normalEditor = normalEditor;
  await fillField(page.cdp, ".provider-editor-apikey", "fixture-ai-key");
  await clickCenter(page.cdp, ".provider-editor-save");
  await waitFor("普通编辑保存完成", () => page.cdp.evaluate(`!document.querySelector(".provider-editor-dialog")`));
  await sleep(900);
  const afterNormalEdit = await page.cdp.evaluate(`(() => ({
    settingsExpanded: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open"),
    overviewText: document.getElementById("biliscript-reading-overview-body")?.innerText || ""
  }))()`);
  results.normalEdit = { editorLabel: normalEditor?.label, completionDelta: completions().length - completionsBeforeNormalEdit, ...afterNormalEdit };
  check(
    "A2-普通平台编辑不触发续跑任务也不关设置",
    normalEditor?.label === "保存" &&
      completions().length - completionsBeforeNormalEdit === 0 &&
      afterNormalEdit.settingsExpanded === true &&
      afterNormalEdit.overviewText.includes("受控概览摘要"),
    results.normalEdit
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "03-normal-edit.png"));
  await clickCenter(page.cdp, "#biliscript-reading-settings-btn");
  await sleep(300);

  // ============================================================
  // A3 AI 对话：无平台拦截 + 草稿恢复 + 用户明确发送
  // ============================================================
  await worker.evaluate(`chrome.storage.sync.set({ aiProviders: [] })`);
  await activateTab(page.cdp, "biliscript-reading-tab-chat");
  const chatNoProvider = await waitFor("对话无平台状态屏", () => page.cdp.evaluate(`(() => {
    const link = document.getElementById("biliscript-reading-chat-open-settings");
    const input = document.getElementById("biliscript-reading-chat-input");
    if (!link || !input) return null;
    return { text: document.getElementById("biliscript-reading-chat-messages")?.innerText || "", settingsLink: Boolean(link) };
  })()`), { timeoutMs: 30000 });
  results.chatNoProvider = chatNoProvider;
  check("A3.1-对话无平台显示前往设置", chatNoProvider.text.includes("还没有配置 AI 平台") && chatNoProvider.settingsLink, chatNoProvider);

  const draft = "这是首配前写下的草稿，保存后不自动发送。";
  await fillField(page.cdp, "#biliscript-reading-chat-input", draft);
  const completionsBeforeChatSave = completions().length;
  const chatEditor = await clickExpect(page.cdp, "#biliscript-reading-chat-open-settings", () => page.cdp.evaluate(`(() => {
    const save = document.querySelector(".provider-editor-save");
    if (!save || save.textContent.trim() !== "保存并继续") return null;
    return { label: save.textContent.trim(), title: document.querySelector(".provider-editor-title")?.textContent || "" };
  })()`), "平台编辑器打开（对话首配）");
  check("A3.2-对话去设置直达新增平台编辑器", Boolean(chatEditor) && chatEditor.label === "保存并继续", chatEditor);
  await fillNewAiProvider(page.cdp, { baseUrl: AI_BASE_URL, apiKey: "fixture-chat-key", model: "fixture-chat-model" });
  await clickCenter(page.cdp, ".provider-editor-save");
  const chatRestored = await waitFor("对话返回提示", () => page.cdp.evaluate(`(() => {
    const notice = document.querySelector(".chat-context-notice");
    const input = document.getElementById("biliscript-reading-chat-input");
    if (!notice || !notice.innerText.includes("平台已就绪，请确认发送")) return null;
    return {
      notice: notice.innerText,
      draft: input?.value || "",
      userMessages: document.querySelectorAll("#biliscript-reading-chat-messages .chat-msg-user").length,
      settingsExpanded: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open"),
      focused: document.activeElement?.id || ""
    };
  })()`), { timeoutMs: 30000 });
  results.chatRestored = { ...chatRestored, completionDelta: completions().length - completionsBeforeChatSave };
  check(
    "A3.3-保存后回到对话保留草稿且不自动发送",
    chatRestored.draft === draft &&
      chatRestored.userMessages === 0 &&
      completions().length - completionsBeforeChatSave === 0 &&
      chatRestored.settingsExpanded === false &&
      chatRestored.focused === "biliscript-reading-chat-input",
    results.chatRestored
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "04-chat-draft-restored.png"));

  await waitFor("发送键可用", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-chat-send-btn")?.disabled === false`), { timeoutMs: 30000 });
  await clickCenter(page.cdp, "#biliscript-reading-chat-send-btn");
  const chatSent = await waitFor("对话回答上屏", () => page.cdp.evaluate(`(() => {
    const messages = document.getElementById("biliscript-reading-chat-messages");
    const text = messages?.innerText || "";
    if (!text.includes("这是首配前写下的草稿") || !text.includes("受控对话回答")) return null;
    return { text, userMessages: messages.querySelectorAll(".chat-msg-user").length };
  })()`), { timeoutMs: 45000 });
  const chatCompletion = completions().at(-1);
  results.chatSent = { ...chatSent, completionDelta: completions().length - completionsBeforeChatSave, model: chatCompletion?.model };
  check(
    "A3.4-用户明确发送后使用新平台发出一次请求",
    chatSent.userMessages === 1 && completions().length - completionsBeforeChatSave === 1 && chatCompletion?.model === "fixture-chat-model",
    results.chatSent
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "05-chat-sent.png"));

  // ============================================================
  // A4 解释卡：未配置 → 保存并继续 → 同一卡片续跑
  // ============================================================
  await worker.evaluate(`chrome.storage.sync.set({ aiProviders: [], defaultModel: "" })`);
  await activateTab(page.cdp, "biliscript-reading-tab-subtitle");
  await waitFor("字幕列表就绪", () => page.cdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length > 0`), { timeoutMs: 45000 });
  const selection = await selectExplainText(page.cdp);
  results.explainSelection = selection;
  await waitFor("解释浮层显形", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-explain-pop")?.hidden === false`), { timeoutMs: 8000 });
  await clickCenter(page.cdp, ".biliscript-reading-explain-btn");
  const explainError = await waitFor("解释卡配置类错误", () => page.cdp.evaluate(`(() => {
    const state = document.querySelector("#biliscript-reading-explain-card .biliscript-reading-explain-card-state.is-error");
    const setup = document.querySelector('#biliscript-reading-explain-card [data-explain-card-action="setup"]');
    const quote = document.querySelector("#biliscript-reading-explain-card .biliscript-reading-explain-card-quote");
    if (!state || !setup) return null;
    return { error: state.innerText, quote: quote?.innerText || "" };
  })()`), { timeoutMs: 45000 });
  results.explainError = explainError;
  check(
    "A4.1-解释配置类错误保留原选区并给出去设置",
    explainError.error.includes("还没有配置 AI 平台") && explainError.quote === selection.text,
    explainError
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "06-explain-no-provider.png"));

  const completionsBeforeExplainSave = completions().length;
  const explainEditor = await clickExpect(page.cdp, '#biliscript-reading-explain-card [data-explain-card-action="setup"]', () => page.cdp.evaluate(`(() => {
    const save = document.querySelector(".provider-editor-save");
    if (!save || save.textContent.trim() !== "保存并继续") return null;
    return { label: save.textContent.trim(), title: document.querySelector(".provider-editor-title")?.textContent || "" };
  })()`), "平台编辑器打开（解释首配）");
  check("A4.2-解释卡去设置直达新增平台编辑器", Boolean(explainEditor) && explainEditor.label === "保存并继续", explainEditor);
  await fillNewAiProvider(page.cdp, { baseUrl: AI_BASE_URL, apiKey: "fixture-explain-key", model: "fixture-explain-model" });
  await clickCenter(page.cdp, ".provider-editor-save");
  const explainResumed = await waitFor("解释卡续跑结果", () => page.cdp.evaluate(`(() => {
    const answer = document.querySelector("#biliscript-reading-explain-card .biliscript-reading-explain-card-answer");
    const quote = document.querySelector("#biliscript-reading-explain-card .biliscript-reading-explain-card-quote");
    const text = answer?.innerText?.trim() || "";
    if (!text.includes("受控解释回答")) return null;
    return { text, quote: quote?.innerText || "", settingsOpen: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open") };
  })()`), { timeoutMs: 45000 });
  const explainDelta = completions().length - completionsBeforeExplainSave;
  results.explainResumed = { ...explainResumed, completionDelta: explainDelta };
  check(
    "A4.3-保存后回到同一解释卡续跑一次",
    explainResumed.quote === selection.text && explainDelta === 1 && explainResumed.settingsOpen === false,
    results.explainResumed
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "07-explain-resumed.png"));
  await clickCenter(page.cdp, '#biliscript-reading-explain-card [data-explain-card-action="close"]');

  // ============================================================
  // A6 旧意图不复活：取消 / 保存失败 / 重复保存 / 换分P
  // ============================================================
  await worker.evaluate(`chrome.storage.sync.set({ aiProviders: [], defaultModel: "" })`);
  await page.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor("回到有字幕视频", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await activateTab(page.cdp, "biliscript-reading-tab-overview");
  await waitOverviewError(page.cdp);

  // A6a 取消配置：意图作废，外部补齐平台也不自动续跑
  const completionsBeforeCancel = completions().length;
  await clickCenter(page.cdp, '[data-overview-action="setup"]');
  await waitProviderEditor(page.cdp);
  await clickCenter(page.cdp, ".provider-editor-cancel");
  await waitFor("取消后编辑器关闭", () => page.cdp.evaluate(`!document.querySelector(".provider-editor-dialog")`), { timeoutMs: 10000 });
  await worker.evaluate(`chrome.storage.sync.set({
    aiProviders: [{ id: "fixture-cancel-provider", presetId: "custom", name: "取消后外部新增", baseUrl: "${AI_BASE_URL}", models: ["fixture-cancel-model"], requiresKey: false, enabled: true, protocol: "openai" }]
  })`);
  await sleep(1800);
  const cancelState = await page.cdp.evaluate(`(() => ({
    setupButton: Boolean(document.querySelector('[data-overview-action="setup"]')),
    overviewText: document.getElementById("biliscript-reading-overview-body")?.innerText || "",
    settingsOpen: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open")
  }))()`);
  results.cancelState = { ...cancelState, completionDelta: completions().length - completionsBeforeCancel };
  check(
    "A6.1-取消后旧续跑意图不复活",
    cancelState.setupButton === true &&
      cancelState.overviewText.includes("还没有配置 AI 平台") &&
      completions().length - completionsBeforeCancel === 0,
    results.cancelState
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "10-overview-cancel.png"));
  await clickCenter(page.cdp, "#biliscript-reading-settings-back-btn").catch(() => {});
  await sleep(300);

  // A6b 保存失败 + 重复保存：失败不续跑、重试成功只续跑一次
  await worker.evaluate(`chrome.storage.sync.set({ aiProviders: [] })`);
  await clickCenter(page.cdp, '[data-overview-action="retry"]');
  await waitOverviewError(page.cdp);
  const completionsBeforeFailure = completions().length;
  await clickCenter(page.cdp, '[data-overview-action="setup"]');
  await waitProviderEditor(page.cdp);
  await fillNewAiProvider(page.cdp, { baseUrl: AI_BASE_URL, apiKey: "fixture-failure-key", model: "fixture-failure-model" });
  await worker.evaluate(`(() => {
    globalThis.__fixtureOriginalSyncSet = chrome.storage.sync.set.bind(chrome.storage.sync);
    chrome.storage.sync.set = async (items, callback) => {
      if (items && Object.prototype.hasOwnProperty.call(items, "aiProviders")) {
        throw new Error("fixture 保存失败");
      }
      return globalThis.__fixtureOriginalSyncSet(items, callback);
    };
    return true;
  })()`);
  await clickCenter(page.cdp, ".provider-editor-save");
  const saveFailure = await waitFor("保存失败状态行", () => page.cdp.evaluate(`(() => {
    const status = document.querySelector(".provider-editor-dialog .provider-editor-status");
    if (!status || status.hidden || status.dataset.error !== "true") return null;
    return { text: status.innerText, editorOpen: Boolean(document.querySelector(".provider-editor-dialog")) };
  })()`), { timeoutMs: 20000 });
  await clickCenter(page.cdp, ".provider-editor-save");
  await sleep(700);
  const saveFailureRepeat = await page.cdp.evaluate(`(() => {
    const status = document.querySelector(".provider-editor-dialog .provider-editor-status");
    return { text: status?.innerText || "", editorOpen: Boolean(document.querySelector(".provider-editor-dialog")) };
  })()`);
  results.saveFailure = { first: saveFailure, repeat: saveFailureRepeat, completionDelta: completions().length - completionsBeforeFailure };
  check(
    "A6.2-保存失败不续跑且可重复重试",
    saveFailure.text.includes("保存失败") &&
      saveFailure.editorOpen &&
      saveFailureRepeat.text.includes("保存失败") &&
      saveFailureRepeat.editorOpen &&
      completions().length - completionsBeforeFailure === 0,
    results.saveFailure
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "11-overview-save-failure.png"));

  await worker.evaluate(`(() => {
    if (globalThis.__fixtureOriginalSyncSet) chrome.storage.sync.set = globalThis.__fixtureOriginalSyncSet;
    return true;
  })()`);
  await clickCenter(page.cdp, ".provider-editor-save");
  await waitFor("失败后重试保存成功并续跑", () => page.cdp.evaluate(`(() => {
    const body = document.getElementById("biliscript-reading-overview-body");
    const summary = body?.querySelector(".biliscript-reading-ov-summary")?.textContent?.trim() || "";
    return summary.includes("受控概览摘要") && !document.querySelector(".provider-editor-dialog");
  })()`), { timeoutMs: 45000 });
  results.saveRecovered = { completionDelta: completions().length - completionsBeforeFailure };
  check("A6.3-失败后重试保存成功且只续跑一次", completions().length - completionsBeforeFailure === 1, results.saveRecovered);
  await screenshot(page.cdp, path.join(OUT_DIR, "12-overview-save-recovered.png"));

  // A6c 换分 P：概览身份键失配，保存后不续跑
  await worker.evaluate(`chrome.storage.sync.set({ aiProviders: [], defaultModel: "" })`);
  // 上一轮概览已是 ready（同一身份键会去重、不会自动重跑）：刷新页面拿到干净的
  // 「无平台 → 概览配置类错误」起点，再在配置过程中换分 P。
  await page.cdp.send("Page.reload", { ignoreCache: false });
  await waitFor("刷新后视频页扩展按钮", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await activateTab(page.cdp, "biliscript-reading-tab-overview");
  await waitOverviewError(page.cdp);
  await clickCenter(page.cdp, '[data-overview-action="setup"]');
  await waitProviderEditor(page.cdp);
  await fillNewAiProvider(page.cdp, { baseUrl: AI_BASE_URL, apiKey: "fixture-part-key", model: "fixture-part-model" });
  await page.cdp.evaluate(`(() => {
    history.pushState({}, "", ${JSON.stringify(VIDEO_URL_P2)});
    window.dispatchEvent(new PopStateEvent("popstate"));
    return location.href;
  })()`);
  await waitFor("分 P 已切换", () => page.cdp.evaluate(`location.search.includes("p=2")`), { timeoutMs: 8000 });
  await sleep(2000);
  const completionsBeforePartSave = completions().length;
  await clickCenter(page.cdp, ".provider-editor-save");
  await waitFor("换分P后编辑器关闭", () => page.cdp.evaluate(`!document.querySelector(".provider-editor-dialog")`), { timeoutMs: 15000 });
  await sleep(1600);
  const partState = await page.cdp.evaluate(`(() => ({
    href: location.href,
    setupButton: Boolean(document.querySelector('[data-overview-action="setup"]')),
    overviewText: document.getElementById("biliscript-reading-overview-body")?.innerText || "",
    settingsOpen: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open")
  }))()`);
  results.partState = { ...partState, completionDelta: completions().length - completionsBeforePartSave };
  check(
    "A6.4-换分P后旧概览意图不复活",
    partState.href.includes("p=2") &&
      completions().length - completionsBeforePartSave === 0 &&
      partState.settingsOpen === false &&
      !partState.overviewText.includes("受控概览摘要"),
    results.partState
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "13-overview-part-switch.png"));

  // A6d 解释卡换分P：保存后不回到旧卡
  await worker.evaluate(`chrome.storage.sync.set({ aiProviders: [] })`);
  await activateTab(page.cdp, "biliscript-reading-tab-subtitle");
  await waitFor("P2 字幕就绪", () => page.cdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length > 0`), { timeoutMs: 60000 });
  const selection2 = await selectExplainText(page.cdp);
  await waitFor("解释浮层显形", () => page.cdp.evaluate(`document.getElementById("biliscript-reading-explain-pop")?.hidden === false`), { timeoutMs: 8000 });
  await clickCenter(page.cdp, ".biliscript-reading-explain-btn");
  await waitFor("解释卡错误（P2）", () => page.cdp.evaluate(`Boolean(document.querySelector('#biliscript-reading-explain-card [data-explain-card-action="setup"]'))`), { timeoutMs: 45000 });
  await clickCenter(page.cdp, '#biliscript-reading-explain-card [data-explain-card-action="setup"]');
  await waitProviderEditor(page.cdp);
  await fillNewAiProvider(page.cdp, { baseUrl: AI_BASE_URL, apiKey: "fixture-explain-part-key", model: "fixture-explain-part-model" });
  await page.cdp.evaluate(`(() => {
    history.pushState({}, "", ${JSON.stringify(VIDEO_URL)});
    window.dispatchEvent(new PopStateEvent("popstate"));
    return location.href;
  })()`);
  await waitFor("回到 P1", () => page.cdp.evaluate(`!location.search.includes("p=2")`), { timeoutMs: 8000 });
  await sleep(1800);
  const completionsBeforeExplainPartSave = completions().length;
  await clickCenter(page.cdp, ".provider-editor-save");
  await waitFor("换分P后解释编辑器关闭", () => page.cdp.evaluate(`!document.querySelector(".provider-editor-dialog")`), { timeoutMs: 15000 });
  await sleep(1200);
  const explainPartState = await page.cdp.evaluate(`(() => ({
    href: location.href,
    cardText: document.getElementById("biliscript-reading-explain-card")?.innerText || "",
    settingsOpen: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open")
  }))()`);
  results.explainPartState = { selection: selection2, ...explainPartState, completionDelta: completions().length - completionsBeforeExplainPartSave };
  check(
    "A6.5-换分P后解释续跑意图不复活",
    completions().length - completionsBeforeExplainPartSave === 0 &&
      !explainPartState.cardText.includes("受控解释回答") &&
      explainPartState.settingsOpen === false,
    results.explainPartState
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "14-explain-part-switch.png"));

  // ============================================================
  // A5 语音转写：无字幕 → 未配置 → 保存并继续 → 续跑字幕链
  // ============================================================
  await worker.evaluate(`chrome.storage.sync.set({ asrAutoFallback: true, asrProviders: [], activeAsrProviderId: "" })`);
  await page.cdp.send("Page.navigate", { url: ASR_URL });
  await waitFor("无字幕视频页", () => page.cdp.evaluate(`Boolean(document.getElementById("biliscript-player-ai-quick-action"))`), { timeoutMs: 45000 });
  await page.cdp.evaluate("document.querySelector('video')?.pause()");
  await openReader(page.cdp);
  await activateTab(page.cdp, "biliscript-reading-tab-subtitle");
  const asrEmpty = await waitFor("无字幕配置类空态", () => page.cdp.evaluate(`(() => {
    const button = document.querySelector('[data-subtitle-action="asr-setup"]');
    if (!button) return null;
    return { text: document.getElementById("biliscript-reading-subtitle")?.innerText || "", state: document.querySelector('[data-biliscript-reader-ready]')?.getAttribute("data-biliscript-reader-ready") || "" };
  })()`), { timeoutMs: 60000 });
  results.asrEmpty = asrEmpty;
  check("A5.1-无字幕配置类空态给出前往设置", asrEmpty.text.includes("前往设置") && asrEmpty.text.includes("语音"), asrEmpty);
  await screenshot(page.cdp, path.join(OUT_DIR, "08-asr-no-provider.png"));

  const transcriptionsBeforeSave = transcriptions().length;
  const asrEditor = await clickExpect(page.cdp, '[data-subtitle-action="asr-setup"]', () => page.cdp.evaluate(`(() => {
    const save = document.querySelector(".provider-editor-save");
    if (!save || save.textContent.trim() !== "保存并继续") return null;
    return { label: save.textContent.trim(), title: document.querySelector(".provider-editor-title")?.textContent || "" };
  })()`), "语音转写编辑器打开");
  results.asrEditor = asrEditor;
  check("A5.2-语音转写去设置直达新增 ASR 编辑器", Boolean(asrEditor) && asrEditor.label === "保存并继续", asrEditor);
  await fillField(page.cdp, ".provider-editor-baseurl", ASR_BASE_URL);
  await fillField(page.cdp, ".provider-editor-apikey", "fixture-asr-key");
  await fillField(page.cdp, ".provider-editor-model", "fixture-asr");
  await clickCenter(page.cdp, ".provider-editor-save");
  const asrTranscribed = await waitFor("语音转写字幕上屏", () => page.cdp.evaluate(`(() => {
    const list = document.getElementById("biliscript-reading-subtitle");
    const text = list?.innerText || "";
    if (!text.includes("离线验收语音字幕内容")) return null;
    return {
      text,
      items: list.querySelectorAll(".biliscript-reading-item").length,
      settingsOpen: document.getElementById("biliscript-reading-script-panel")?.hasAttribute("data-biliscript-settings-open"),
      status: document.getElementById("biliscript-reading-status")?.innerText || ""
    };
  })()`), { timeoutMs: 90000 });
  const transcriptionDelta = transcriptions().length - transcriptionsBeforeSave;
  const asrStorage = await readStorage(worker, "sync", ["asrProviders"]);
  results.asrTranscribed = {
    ...asrTranscribed,
    transcriptionDelta,
    transcriptionUrl: transcriptions().at(-1)?.url || "",
    asrProviders: asrStorage?.asrProviders
  };
  check(
    "A5.3-保存后续跑既有字幕链并完成转写",
    asrTranscribed.items > 0 &&
      transcriptionDelta >= 1 &&
      String(transcriptions().at(-1)?.url || "").startsWith(`${ASR_BASE_URL}/audio/transcriptions`) &&
      Array.isArray(asrStorage?.asrProviders) && asrStorage.asrProviders.length === 1 &&
      asrStorage.asrProviders[0].baseUrl === ASR_BASE_URL &&
      asrTranscribed.settingsOpen === false,
    results.asrTranscribed
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "09-asr-transcribed.png"));

  // ============================================================
  // 结果
  // ============================================================
} catch (error) {
  if (activePage) {
    results.failureDiagnostics = await activePage.cdp.evaluate(`(() => ({
      href: location.href,
      bodyText: document.body.innerText.slice(-4000),
      overview: document.getElementById("biliscript-reading-overview-body")?.innerText || null,
      settings: document.getElementById("biliscript-reading-settings-host")?.innerText?.slice(0, 2000) || null,
      editor: document.querySelector(".provider-editor-dialog")?.innerText?.slice(0, 2000) || null,
      chat: document.getElementById("biliscript-reading-chat-messages")?.innerText?.slice(0, 2000) || null
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
    boundary: "离线 fixture：B 站文档/接口、AI 完成 SSE、ASR 音轨与转写响应全部由本场景回放；不使用真实账号、真实 Key 或外部付费服务。"
  });
  if (checks.some((entry) => !entry.ok) || checks.length === 0) process.exitCode = 1;
}
