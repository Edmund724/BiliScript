#!/usr/bin/env node
// 字幕预抓取真机场景 —— `pnpm harness:scenario subtitle-prefetch`。
//
// 判据（jsdom 够不着的部分）：预抓取是否在**没有任何用户动作**时起跑、抓取在飞时
// 对话 tab 的反馈是否真的可见（spinner 通知条 / 发送键禁用 / placeholder 切换）、
// 字幕已在手时点 AI 键是否不再有抓取等待、SPA 换片是否也预抓取、无字幕视频是否
// **不会**被预抓取带进 ASR 转写。
//
// 环境口径（诚实声明）：真网真页面。匿名（隔离 profile 无登录 cookie）下
// `x/player/wbi/v2` 返回 0 轨，S2 的终态落在「无字幕拦截」；S3 走 **fixture 补丁**
// （复用 tests/fixtures/bilibili/bilingual-walkthrough/ 的可提交数据：8 轨应答 +
// 中文正文，经 SW 目标上的 CDP Fetch 回放），造出「字幕在手」这一匿名环境给不了的
// 状态——fixture 是数据，渲染路径与闸逻辑全是真的。判的是**等待的有无与反馈的可见性**，
// 不是字幕内容本身。SW 网络日志只记扩展 SW 自己发出的请求，页面自己的播放器请求不计入。
//
// 场景（id 同时是 evidence.json 里的键）：
//   S1 首载预抓取：AI 键挂载后、任何点击之前，SW 侧已发出 player 字幕列表请求
//   S2 在飞等待反馈：SW 目标上扣住 player 请求（CDP Fetch），请求在飞时点 AI 键 →
//      消息区立即出带 spinner 的「正在抓取字幕」通知条、发送键禁用、placeholder 换
//      等待文案；放行后等待解除，终态 = 无字幕拦截（匿名 0 轨是预期）
//   S3 预热秒点：fixture 补丁下预抓落定（字幕在手）后点 AI 键 → 点击到用户消息上屏
//      秒达，且全程未见抓取通知条（这把用户报的「卡一两秒」钉成不再复现）
//   S4 SPA 换片预抓取：普通页（视图未开）pushState 换视频 → SW 侧对新 bvid 发出
//      player 请求（不进面板也抓）
//   S5 ASR 不触发：S2/S3 全程转写状态行未亮、终态不是转写
//
// 每一步都种一个 stub AI 平台（requiresKey:false，POST 必失败）：闸在 provider 检查
// 之后，不种平台则流程在闸之前就返回，等待反馈压根观测不到——stub 只为让流程走到
// 闸，本轮断言与 AI 调用结果无关。
//
// 硬约束：只杀自己 spawn 的进程（harness teardown）；工件落
// `.scratch/browser-harness/scenarios/subtitle-prefetch/`；只 import ../harness.mjs；
// fixture 只从 tests/fixtures/ 读。

import path from "node:path";
import { readFileSync } from "node:fs";
import {
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

const NAME = "subtitle-prefetch";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const VIEWPORT = DEFAULT_VIEWPORT;

const VIDEO_A = { bvid: "BV1mAam6tEL8", url: "https://www.bilibili.com/video/BV1mAam6tEL8/" };
const VIDEO_B = { bvid: "BV1FyHn6JE86", url: "https://www.bilibili.com/video/BV1FyHn6JE86/" };
const PLAYER_API_RE = /x\/player\/(?:wbi\/)?v2/;
const VIEW_API_RE = /x\/web-interface\/view\?/;
const FIXTURE_BODY_RE = /walkthrough-fixture\/([A-Za-z0-9-]+)\.json$/;
const FETCHING_RE = /正在抓取字幕/;
const TERMINAL_RE = /没有字幕|无法总结|无字幕|抓取失败|失败/;
const WARM_CLICK_BUDGET_MS = 3000;

const headed = process.argv.includes("--headed");

// ===== 可提交 fixture（S3 的「字幕在手」环境；场景只读）=====
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
let BUNDLES;
let BODIES;
let META;
try {
  BUNDLES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bundles.json"), "utf8"));
  BODIES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bodies.json"), "utf8"));
  META = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "meta.json"), "utf8"));
} catch (error) {
  console.error(`读不到 committed fixture：${FIXTURE_DIR}\n  ${error.message}`);
  process.exit(1);
}
// fixture 形状自检：轨数与正文键是 S3 判据成立的前提。
const fixtureShapeOk =
  (BUNDLES[VIDEO_A.bvid]?.data?.subtitle?.subtitles?.length ?? 0) > 0 &&
  (BODIES[`${VIDEO_A.bvid}-zh`]?.body?.length ?? 0) > 0 &&
  Number(META.sampleAid) > 0 &&
  Number(META.sampleCid) > 0 &&
  Number(META.sampleDuration) > 0;
if (!fixtureShapeOk) {
  console.error(`fixture 形状不满足 S3 需要：${FIXTURE_DIR}`);
  process.exit(1);
}
// view 应答（fetchVideoMeta 的解析面）：aid/cid/pages/duration 与真实值同源（meta.json）。
const FIXTURE_VIEW_RESPONSE = JSON.stringify({
  code: 0,
  message: "0",
  data: {
    aid: META.sampleAid,
    bvid: VIDEO_A.bvid,
    cid: META.sampleCid,
    duration: META.sampleDuration,
    title: "harness fixture video",
    owner: { name: "harness" },
    desc: "",
    pubdate: 0,
    pages: [{ cid: META.sampleCid, page: 1, part: "P1", duration: META.sampleDuration }]
  }
});

// ===== 断言 =====
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 320)}`}`);
  return Boolean(ok);
}
async function phase(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}-no-fatal`, false, { message: error.message, stack: String(error.stack || "").slice(0, 1200) });
    log(`阶段 ${name} 致命错误：${error.message}`);
    dumpDiagnostics(name);
  }
}

// ===== SW 侧网络观察（只记扩展 SW 自己发的请求；view/player 都记，断言按 URL 过滤）=====
const swNetLog = [];
function noteSwNet(phase, url) {
  const entry = { t: Date.now(), phase, url };
  swNetLog.push(entry);
  if (swNetLog.length > 400) swNetLog.shift();
}
const swInteresting = (url) => PLAYER_API_RE.test(url) || VIEW_API_RE.test(url);
function swPlayerRequests() {
  return swNetLog.filter((e) => e.phase === "request" && PLAYER_API_RE.test(e.url));
}
function swPlayerResponses() {
  return swNetLog.filter((e) => e.phase === "response" && PLAYER_API_RE.test(e.url));
}
function swViewRequests() {
  return swNetLog.filter((e) => e.phase === "request" && VIEW_API_RE.test(e.url));
}

// ===== SW 目标上的 CDP Fetch 通道（S2 扣住请求 / S3 回放 fixture）=====
// 网络条件模拟（emulateNetworkConditions）对 SW 目标无效（实测请求仍 47ms 往返），
// 故在飞窗口与 fixture 应答都走 Fetch 拦截——它有确定的起停点，不靠延迟赌时序。
let fetchMode = "pass"; // pass | hold | fixture
const heldRequests = [];
let worker = null;
const attachedHandles = new WeakSet(); // onReconnect 在首连也会触发：同 handle 不重复挂

async function attachWorkerObservers(handle) {
  if (!handle || attachedHandles.has(handle)) return;
  attachedHandles.add(handle);
  const cdp = handle.cdp;
  const sid = handle.sessionId;
  await cdp.send("Network.enable", {}, sid, 15000);
  cdp.on("Network.requestWillBeSent", (params) => {
    if (swInteresting(params.request?.url || "")) noteSwNet("request", params.request.url);
  });
  cdp.on("Network.responseReceived", (params) => {
    if (swInteresting(params.response?.url || "")) noteSwNet("response", params.response.url);
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sid, 15000);
  cdp.on("Fetch.requestPaused", async (params) => {
    const url = params.request?.url || "";
    const requestId = params.requestId;
    try {
      if (fetchMode === "hold" && PLAYER_API_RE.test(url)) {
        heldRequests.push({ requestId, url, at: Date.now() });
        return; // 扣住不响应：抓取停在「在飞」，等场景放行
      }
      if (fetchMode === "fixture") {
        if (VIEW_API_RE.test(url) && url.includes(VIDEO_A.bvid)) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId, responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(FIXTURE_VIEW_RESPONSE, "utf8").toString("base64")
          }, sid, 15000);
          return;
        }
        if (PLAYER_API_RE.test(url) && url.includes(VIDEO_A.bvid)) {
          const body = JSON.stringify(BUNDLES[VIDEO_A.bvid]);
          await cdp.send("Fetch.fulfillRequest", {
            requestId, responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(body, "utf8").toString("base64")
          }, sid, 15000);
          return;
        }
        const bodyMatch = FIXTURE_BODY_RE.exec(url);
        if (bodyMatch && BODIES[bodyMatch[1]]) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId, responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(JSON.stringify(BODIES[bodyMatch[1]]), "utf8").toString("base64")
          }, sid, 15000);
          return;
        }
      }
      await cdp.send("Fetch.continueRequest", { requestId }, sid, 15000);
    } catch (error) {
      // 请求已被取消 / 会话已断：拦截通道的收尾，不影响判据
      log(`Fetch 处理异常（忽略）：${error.message}`);
    }
  });
}

async function releaseHeldRequests() {
  const handle = worker?.handle;
  if (!handle) return;
  for (const held of heldRequests.splice(0)) {
    try {
      await handle.cdp.send("Fetch.continueRequest", { requestId: held.requestId }, handle.sessionId, 15000);
    } catch (error) {
      log(`放行扣住的请求失败（忽略）：${error.message}`);
    }
  }
}

async function seedStubProvider() {
  try {
    return await worker.evaluate(`(async () => {
      await chrome.storage.sync.set({
        aiProviders: [{
          id: "harness-stub",
          presetId: "custom",
          name: "harness-stub",
          baseUrl: "https://harness.invalid",
          models: ["harness-model"],
          requiresKey: false,
          enabled: true,
          protocol: "openai"
        }]
      });
      return true;
    })()`, 20000);
  } catch (error) {
    log(`stub 平台种入失败：${error.message}`);
    return false;
  }
}

// ===== 页面内状态测量（对话 tab 等待反馈的全部判据面）=====
let pageCdp = null;
let browser = null;
let watched = null;

const CHAT_STATE_EXPR = `(() => {
  const messages = document.getElementById('biliscript-reading-chat-messages');
  const notice = messages ? messages.querySelector('.chat-context-notice') : null;
  const sendBtn = document.getElementById('biliscript-reading-chat-send-btn');
  const input = document.getElementById('biliscript-reading-chat-input');
  const asr = document.getElementById('biliscript-reading-chat-asr-notice');
  return {
    chatReady: !!messages,
    noticeText: notice ? notice.textContent.trim() : null,
    hasSpinner: !!(notice && notice.querySelector('.chat-notice-spinner')),
    sendDisabled: sendBtn ? sendBtn.disabled : null,
    sendIsStop: sendBtn ? sendBtn.classList.contains('is-stop') : null,
    placeholder: input ? input.placeholder : null,
    userMessages: messages ? messages.querySelectorAll('.chat-msg-user').length : 0,
    asrNoticeVisible: asr ? (!asr.hidden && !!asr.textContent.trim()) : false,
    asrNoticeText: asr ? asr.textContent.trim() : null
  };
})()`;

async function sampleChat() {
  return pageCdp.evaluate(CHAT_STATE_EXPR);
}

// 轮询直到终态：用户消息上屏（闸放行）或无字幕/失败通知（闸拦截）。
async function waitTerminal({ timeoutMs = 60000, intervalMs = 150 }) {
  const firstFetching = { at: null, sample: null };
  let sawAsrNotice = false;
  let last = null;
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sampleChat();
    if (s) {
      last = s;
      if (s.asrNoticeVisible) sawAsrNotice = true;
      if (firstFetching.at === null && s.noticeText && FETCHING_RE.test(s.noticeText)) {
        firstFetching.at = Date.now();
        firstFetching.sample = s;
      }
      if (s.userMessages > 0) {
        return { kind: "message-appended", elapsedMs: Date.now() - started, firstFetching, sawAsrNotice, last: s };
      }
      if (s.noticeText && TERMINAL_RE.test(s.noticeText)) {
        return { kind: "notice-intercept", elapsedMs: Date.now() - started, firstFetching, sawAsrNotice, last: s };
      }
    }
    await sleep(intervalMs);
  }
  return { kind: "timeout", elapsedMs: Date.now() - started, firstFetching, sawAsrNotice, last };
}

async function shot(base, note) {
  try {
    await screenshot(pageCdp, path.join(OUT_DIR, `${base}.png`));
    log(`截图 ${base}.png（${note}）`);
  } catch (error) {
    log(`截图失败 ${base}: ${error.message}`);
  }
}

async function waitAiButton(label) {
  return waitFor(label, async () => pageCdp.evaluate("!!document.getElementById('biliscript-player-ai-quick-action')"), { timeoutMs: 45000, intervalMs: 200 });
}

async function clickAiButton() {
  return Boolean(await pageCdp.evaluate(`(() => {
    const btn = document.getElementById('biliscript-player-ai-quick-action');
    if (!btn) return false;
    btn.click();
    return true;
  })()`));
}

async function waitChatReady(label) {
  return waitFor(label, async () => {
    const s = await sampleChat();
    return s && s.chatReady ? s : false;
  }, { timeoutMs: 30000, intervalMs: 150 });
}

function dumpDiagnostics(tag) {
  const entry = {};
  evidence.diagnostics[tag] = entry;
  Promise.resolve(pageCdp ? pageCdp.evaluate(`({ hidden: document.hidden, visibilityState: document.visibilityState, href: location.href })`) : null)
    .then((v) => { entry.visibility = v; })
    .catch((error) => { entry.visibility = { error: error.message }; });
  entry.swTail = swNetLog.slice(-30);
  entry.consoleTail = (watched?.consoleLog || []).slice(-20).map((line) => String(line).slice(0, 200));
  log(`诊断[${tag}]：SW 日志尾 ${entry.swTail.length} 条 / console ${entry.consoleTail.length} 条`);
  for (const line of (watched?.consoleLog || []).filter((l) => /BILISCRIPT/.test(String(l))).slice(-10)) {
    log(`  console(BILISCRIPT): ${String(line).slice(0, 200)}`);
  }
}

// ===== 主流程 =====
async function main() {
  check("fixture-shape", fixtureShapeOk, { tracks: BUNDLES[VIDEO_A.bvid]?.data?.subtitle?.subtitles?.length ?? 0 });

  browser = await launchBrowser({ headless: !headed, viewport: VIEWPORT });
  const page = await attachPage(browser, { viewport: VIEWPORT });
  pageCdp = page.cdp;
  await pageCdp.send("Page.bringToFront").catch(() => {});
  watched = watchPage(pageCdp);

  worker = createWorkerSession({
    pageCdp,
    browser,
    onReconnect: async (handle) => {
      // SW 回收后重挂：Network 观察与 Fetch 通道都只活在当次会话上（README 纪律）。
      await attachWorkerObservers(handle);
      log("SW 重连：Network/Fetch 观察已重挂");
    }
  });
  const workerUp = await worker.ensureAlive();
  check("sw-attach", workerUp, { url: worker.handle?.url });
  if (workerUp) {
    await attachWorkerObservers(worker.handle);
  }
  const seeded = await seedStubProvider();
  check("stub-provider-seeded", seeded === true, { note: "让流程走到发送闸；AI 调用结果不在判据内" });

  // ===== S1：首载预抓取（无任何用户动作，真网）=====
  await phase("s1", async () => {
    log("S1：导航到视频 A，等 AI 键挂载——不点任何东西，看 SW 侧是否自发请求字幕列表");
    const navAt = Date.now();
    await pageCdp.send("Page.navigate", { url: VIDEO_A.url });
    await waitAiButton("S1：AI 键挂载");
    const buttonAt = Date.now();
    const req = await waitFor("S1：SW 发出 player 请求（无点击）", async () => swPlayerRequests()[0] || false, { timeoutMs: 30000, intervalMs: 150 });
    check("s1-prefetch-without-user-action", Boolean(req), {
      navAt, buttonAt, requestAt: req?.t ?? null, msAfterButton: req ? req.t - buttonAt : null
    });
    const viewClosed = await pageCdp.evaluate("!document.getElementById('biliscript-reading-view') || !document.getElementById('biliscript-reading-view').classList.contains('open')");
    check("s1-view-not-open", viewClosed === true, { note: "预抓取发生在面板/对话未打开时" });
  });

  // ===== S2：抓取在飞时的等待反馈（扣住请求造确定性在飞窗口）=====
  await phase("s2", async () => {
    log("S2：扣住 SW 侧 player 请求后导航视频 B，请求在飞时立刻点 AI 键");
    fetchMode = "hold";
    await pageCdp.send("Page.navigate", { url: VIDEO_B.url });
    await waitAiButton("S2：AI 键挂载");
    const held = await waitFor("S2：player 请求被扣住（在飞）", async () => heldRequests[0] || false, { timeoutMs: 30000, intervalMs: 100 });
    const clickAt = Date.now();
    const clicked = await clickAiButton();
    check("s2-ai-button-clicked", clicked, { at: clickAt, heldAt: held?.at ?? null });
    check("s2-fetch-in-flight-at-click", Boolean(held), { heldRequests: heldRequests.length });
    await waitChatReady("S2：对话 tab 就绪");
    await shot("02-s2-during-wait", "S2：抓取在飞时的对话 tab（通知条 / 发送键 / placeholder）");
    // 先取样等待态 UI（此刻请求仍被扣住，在飞窗口不会自己收掉），再放行等终态。
    let sample = null;
    const sampling = await waitFor("S2：等待通知条出现", async () => {
      const s = await sampleChat();
      if (s?.noticeText && FETCHING_RE.test(s.noticeText)) return s;
      return false;
    }, { timeoutMs: 20000, intervalMs: 150 });
    if (sampling) sample = sampling;
    await shot("03-s2-wait-notice", "S2：等待通知条（spinner）特写");
    check("s2-wait-notice-with-spinner", Boolean(sample?.hasSpinner) && FETCHING_RE.test(sample?.noticeText || ""), {
      at: sampling?.at ?? null, noticeText: sample?.noticeText ?? null
    });
    check("s2-send-disabled-during-wait", sample?.sendDisabled === true, {
      sendDisabled: sample?.sendDisabled ?? null, isStop: sample?.sendIsStop ?? null
    });
    check("s2-placeholder-during-wait", sample?.placeholder === "正在抓取字幕…", {
      placeholder: sample?.placeholder ?? null
    });
    fetchMode = "pass";
    await releaseHeldRequests();
    const t = await waitTerminal({ timeoutMs: 45000 });
    check("s2-terminal-reached", t.kind !== "timeout", {
      kind: t.kind, elapsedMs: t.elapsedMs, noticeText: t.last?.noticeText ?? null, userMessages: t.last?.userMessages ?? null
    });
    check("s2-terminal-is-no-subtitle-intercept", t.kind === "notice-intercept", {
      kind: t.kind, noticeText: t.last?.noticeText ?? null,
      note: "匿名 0 轨是预期终态：证明等待解除后走的是无字幕拦截而不是挂着不动"
    });
    check("s2-wait-ended-placeholder-restored", t.last?.placeholder !== "正在抓取字幕…", { placeholder: t.last?.placeholder ?? null });
    evidence.s2 = { kind: t.kind, elapsedMs: t.elapsedMs, sawAsrNotice: t.sawAsrNotice, terminalNotice: t.last?.noticeText ?? null };
  });

  // ===== S3：预热秒点（fixture 造「字幕在手」，点完应当零等待）=====
  await phase("s3", async () => {
    log("S3：fixture 补丁下重载视频 A，等预抓落定（字幕在手）后点 AI 键");
    fetchMode = "fixture";
    swNetLog.length = 0;
    await pageCdp.send("Page.navigate", { url: VIDEO_A.url });
    await waitAiButton("S3：AI 键挂载");
    const resp = await waitFor("S3：SW player 响应到达（预抓落定）", async () => swPlayerResponses()[0] || false, { timeoutMs: 30000, intervalMs: 150 });
    await sleep(2500); // 让取体 + 接受事务落定
    const clickAt = Date.now();
    const clicked = await clickAiButton();
    check("s3-ai-button-clicked", clicked, { responseAt: resp?.t ?? null });
    const t = await waitTerminal({ timeoutMs: 30000 });
    check("s3-warm-click-terminal-fast", t.kind !== "timeout" && t.elapsedMs < WARM_CLICK_BUDGET_MS, {
      kind: t.kind, elapsedMs: t.elapsedMs, budgetMs: WARM_CLICK_BUDGET_MS
    });
    check("s3-no-fetching-notice", !t.firstFetching.sample, {
      firstFetchingAt: t.firstFetching.at, noticeText: t.firstFetching.sample?.noticeText ?? null
    });
    check("s3-message-appended", t.kind === "message-appended", {
      kind: t.kind, userMessages: t.last?.userMessages ?? null,
      note: "字幕在手 ⇒ 闸直接放行 ⇒ 用户消息上屏（stub 平台的调用失败不影响本条）"
    });
    evidence.s3 = { kind: t.kind, elapsedMs: t.elapsedMs, sawAsrNotice: t.sawAsrNotice, terminalNotice: t.last?.noticeText ?? null };
    fetchMode = "pass";
  });

  // ===== S4：SPA 换片预抓取（普通页分支，视图未开；真网）=====
  await phase("s4", async () => {
    log("S4：整页导航视频 A（不开面板），等预抓落定后主世界 pushState 换到视频 B，看 SW 侧是否对新 bvid 自发请求");
    await worker.ensureAlive();
    // 先清日志再导航：否则「等 A 的响应」会等到上一个阶段的陈旧条目，pushState 提前到
    // init 预抓取还在飞时（复刻诊断：settle 后再换片，新 bvid 的请求 158ms 内必达）。
    swNetLog.length = 0;
    await pageCdp.send("Page.navigate", { url: VIDEO_A.url });
    await waitAiButton("S4：AI 键挂载");
    const firstResp = await waitFor("S4：视频 A 预抓响应到达", async () => swPlayerResponses()[0] || false, { timeoutMs: 30000, intervalMs: 150 });
    await sleep(2000); // 让收尾事务落定：换片时上个视频的状态不能再影响守卫
    swNetLog.length = 0;
    const at = Date.now();
    await pageCdp.evaluate(`(() => { history.pushState({}, "", ${JSON.stringify("/video/" + VIDEO_B.bvid + "/")}); return location.href; })()`);
    const req = await waitFor("S4：SW 对视频 B 发出 player 请求", async () => {
      const reqs = swPlayerRequests().filter((e) => e.url.includes(VIDEO_B.bvid));
      return reqs[0] || false;
    }, { timeoutMs: 15000, intervalMs: 200 });
    check("s4-spa-change-prefetch", Boolean(req), { at, requestAt: req?.t ?? null, msAfter: req ? req.t - at : null, firstRespAt: firstResp?.t ?? null });
    const viewReq = swViewRequests().find((e) => e.url.includes(VIDEO_B.bvid));
    evidence.s4 = { requestAt: req?.t ?? null, viewRequestAt: viewReq?.t ?? null, msAfterView: req && viewReq ? req.t - viewReq.t : null };
    const viewClosed = await pageCdp.evaluate("!document.getElementById('biliscript-reading-view') || !document.getElementById('biliscript-reading-view').classList.contains('open')");
    check("s4-view-not-open", viewClosed === true, { note: "SPA 换片走普通页预抓取分支（视图未开）" });
  });

  // ===== S5：无字幕不触发 ASR（S2/S3 记录汇总）=====
  check("s5-asr-not-triggered", evidence.s2.sawAsrNotice === false && evidence.s3.sawAsrNotice === false, {
    s2SawAsr: evidence.s2.sawAsrNotice, s3SawAsr: evidence.s3.sawAsrNotice,
    s2Terminal: evidence.s2.terminalNotice, s3Terminal: evidence.s3.terminalNotice,
    note: "0 轨视频不应被预抓取带进 ASR 转写；判据是全程未进转写态"
  });
}

const evidence = {
  meta: { name: NAME, videos: [VIDEO_A, VIDEO_B], fixture: FIXTURE_DIR },
  s2: {}, s3: {}, diagnostics: {}
};

try {
  await main();
} catch (error) {
  check("no-fatal", false, { message: error.message, stack: String(error.stack || "").slice(0, 1500) });
  log(`致命错误：${error.message}`);
  dumpDiagnostics("fatal");
} finally {
  try {
    if (pageCdp) await pageCdp.evaluate(`document.querySelectorAll('video,audio').forEach(v => v.pause())`).catch(() => {});
  } catch {}
  const profileDir = browser?.profileDir;
  await teardown({ browser, cdps: [pageCdp, worker?.handle?.cdp].filter(Boolean) });
  check("profile-removed", Boolean(browser?.profileRemoved), { profileDir });
  evidence.swNetLog = swNetLog.slice(0, 200);
  evidence.pageConsole = (watched?.consoleLog || []).slice(0, 200).map((l) => String(l).slice(0, 200));
  evidence.checks = checks;
  evidence.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  await writeEvidence(OUT_DIR, evidence);
  const passed = checks.length - evidence.failed.length;
  log(`结果：${passed}/${checks.length} 通过`);
  if (evidence.failed.length) {
    log(`失败项：${evidence.failed.join(", ")}`);
    process.exitCode = 1;
  }
}
