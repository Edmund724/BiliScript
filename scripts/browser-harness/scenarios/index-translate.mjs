#!/usr/bin/env node
// 内置免 Key Index-Translate 真机验证场景 —— `pnpm harness:scenario index-translate`。
//
// 判据（jsdom 够不着的真实 Chromium MV3 + 真网边界）：
//   1. 新装零 API Key 环境（无 aiProviders / 无 aiProviderKeys / 无 asrProviderKeys）：
//      - 设置页默认投影为 `Index-Translate（免 Key）` + `Index-Translate-35B-A3B`，与通用 AI 解耦；
//      - 打开真实 B 站视频页，触发字幕双语翻译；
//   2. 真实 MV3 offscreen + DNR 会话规则（ruleId 9003）链路实际打通
//      `https://index-translate.bilibili.com/v1/chat/completions`（HTTP 200，无 412 WAF 拦截）；
//   3. 列表真实渲染双语译文（`.biliscript-reading-subtext[data-state="ready"]`），内容为中文译文、
//      无 `<think>` / `</think>` 标签残留，且页面 / SW / offscreen 无 CORS 或 CSP 报错。
//
// 用法：
//   pnpm harness:scenario index-translate
//   pnpm harness:scenario index-translate -- --headed

import path from "node:path";
import { existsSync } from "node:fs";
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

const NAME = "index-translate";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const SAMPLE = { bvid: "BV1mAam6tEL8", url: "https://www.bilibili.com/video/BV1mAam6tEL8/" };
const headed = process.argv.includes("--headed");

const ENGLISH_SAMPLE_LINES = [
  { content: "Hello everyone, welcome back to our channel." },
  { content: "Today we will test real-time bilingual subtitle translation in Chromium." },
  { content: "Thank you for watching and let us get started." }
];

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 320)}`}`);
  return Boolean(ok);
}

async function dispatchClick(pageCdp, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 });
  return { x: px, y: py };
}

async function clickElement(pageCdp, checkName, locateExpr) {
  const info = await pageCdp.evaluate(`(() => {
    const el = ${locateExpr};
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      found: true,
      rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2), left: +r.left.toFixed(2), top: +r.top.toFixed(2) },
      center: { x: cx, y: cy },
      hitSelf: !!hit && (hit === el || el.contains(hit)),
      hitTag: hit ? hit.tagName + "." + String(hit.className || "").slice(0, 40) : null
    };
  })()`);
  const ok =
    Boolean(info?.found) &&
    info.rect.w > 0 &&
    info.rect.h > 0 &&
    info.hitSelf === true &&
    info.center.x >= 0 &&
    info.center.y >= 0 &&
    info.center.x <= DEFAULT_VIEWPORT.width &&
    info.center.y <= DEFAULT_VIEWPORT.height;
  if (!ok) {
    check(checkName, false, info);
    return false;
  }
  await dispatchClick(pageCdp, info.center.x, info.center.y);
  check(checkName, true, info);
  return true;
}

async function listJsonTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

function attachNetworkAndErrorMonitor(cdp, bucket) {
  const reqById = new Map();
  cdp.on("Network.requestWillBeSent", (p) => {
    const url = p?.request?.url || "";
    reqById.set(p.requestId, { url, method: p?.request?.method, headers: p?.request?.headers || {} });
    if (url.includes("index-translate.bilibili.com")) {
      bucket.indexRequests.push({
        requestId: p.requestId,
        url,
        method: p?.request?.method,
        headers: p?.request?.headers || {}
      });
    }
  });
  cdp.on("Network.responseReceived", (p) => {
    const url = p?.response?.url || reqById.get(p.requestId)?.url || "";
    if (url.includes("index-translate.bilibili.com")) {
      bucket.indexResponses.push({
        requestId: p.requestId,
        url,
        status: p?.response?.status,
        statusText: p?.response?.statusText,
        headers: p?.response?.headers || {}
      });
    }
  });
  cdp.on("Network.loadingFinished", (p) => {
    const req = reqById.get(p.requestId);
    if (req?.url?.includes("index-translate.bilibili.com")) {
      void cdp
        .send("Network.getResponseBody", { requestId: p.requestId })
        .then((bodyRes) => {
          bucket.indexBodies = bucket.indexBodies || [];
          bucket.indexBodies.push({
            requestId: p.requestId,
            body: String(bodyRes?.body || "").slice(0, 1500),
            base64Encoded: Boolean(bodyRes?.base64Encoded)
          });
        })
        .catch(() => {});
    }
  });
  cdp.on("Network.loadingFailed", (p) => {
    const url = reqById.get(p.requestId)?.url || "";
    if (url.includes("index-translate.bilibili.com")) {
      bucket.indexFailures.push({
        requestId: p.requestId,
        url,
        errorText: p?.errorText,
        blockedReason: p?.blockedReason
      });
    }
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (p.type === "error" || /cors|csp|content security policy|412|failed to fetch/i.test(text)) {
      bucket.errors.push({ kind: `console.${p.type}`, text: text.slice(0, 400) });
    }
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    const text = p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "";
    bucket.errors.push({ kind: "exception", text: String(text).slice(0, 400) });
  });
  cdp.on("Log.entryAdded", (p) => {
    const e = p?.entry;
    if (!e) return;
    if (e.level === "error" || /cors|csp|content security policy|index-translate/i.test(e.text || "")) {
      bucket.errors.push({ kind: `log.${e.level}`, source: e.source, text: String(e.text || "").slice(0, 400) });
    }
  });
}

const evidence = {
  meta: {
    startedAt: new Date().toISOString(),
    scenario: NAME,
    dist: DEFAULT_DIST,
    sampleUrl: SAMPLE.url,
    headed
  },
  checks,
  network: {
    page: { indexRequests: [], indexResponses: [], indexFailures: [], errors: [] },
    offscreen: { indexRequests: [], indexResponses: [], indexFailures: [], errors: [] },
    swErrors: []
  }
};

let browser = null;
const cdps = [];
const t0 = Date.now();

try {
  browser = await launchBrowser({ headless: !headed });
  const page = await attachPage(browser);
  cdps.push(page.cdp);
  const pageWatcher = watchPage(page.cdp);
  attachNetworkAndErrorMonitor(page.cdp, evidence.network.page);

  const worker = createWorkerSession({ pageCdp: page.cdp, browser });
  const workerUp = await worker.ensureAlive();
  check("sw-attach", workerUp, { url: worker.handle?.url });
  if (!workerUp) throw new Error("SW 未连接");
  cdps.push(worker.handle.cdp);

  // 确认零 API Key 与默认配置状态，以及 DNR 规则 9003 已就位（等待 onInstalled 初始化落盘）
  const initProbe = await waitFor(
    "onInstalled 默认设置与 DNR 9003 就绪",
    async () =>
      worker.evaluate(
        `(async () => {
          const sync = await chrome.storage.sync.get(null);
          if (!sync || !sync.subtitleTranslateProviderId) return null;
          const local = await chrome.storage.local.get(null);
          const rules = chrome.declarativeNetRequest?.getSessionRules
            ? await chrome.declarativeNetRequest.getSessionRules()
            : [];
          return {
            sync,
            aiProviderKeys: local.aiProviderKeys || null,
            asrProviderKeys: local.asrProviderKeys || null,
            dnrRuleIds: rules.map((r) => r.id),
            dnrRule9003: rules.find((r) => r.id === 9003) || null
          };
        })()`,
        15000
      ),
    { timeoutMs: 15000, intervalMs: 200 }
  );
  evidence.initProbe = initProbe;
  check(
    "zero-api-keys-by-default",
    !initProbe?.aiProviderKeys &&
      !initProbe?.asrProviderKeys &&
      (!Array.isArray(initProbe?.sync?.aiProviders) || initProbe.sync.aiProviders.length === 0),
    {
      aiProviderKeys: initProbe?.aiProviderKeys,
      asrProviderKeys: initProbe?.asrProviderKeys,
      aiProviders: initProbe?.sync?.aiProviders
    }
  );
  check(
    "default-subtitle-translate-is-index-translate",
    initProbe?.sync?.subtitleTranslateProviderId === "bilibili-index-translate" &&
      initProbe?.sync?.subtitleTranslateModel === "Index-Translate-35B-A3B",
    {
      subtitleTranslateProviderId: initProbe?.sync?.subtitleTranslateProviderId,
      subtitleTranslateModel: initProbe?.sync?.subtitleTranslateModel
    }
  );
  check(
    "dnr-rule-9003-active",
    Boolean(initProbe?.dnrRule9003),
    initProbe?.dnrRule9003
  );

  // 1. 打开真实 B 站视频页
  await page.cdp.send("Page.navigate", { url: SAMPLE.url });
  await waitFor(
    "文摘触发按钮注入",
    async () =>
      page.cdp.evaluate(`(() => {
        const btn = document.getElementById("biliscript-script-button");
        return Boolean(btn);
      })()`),
    { timeoutMs: 45000 }
  );
  await page.cdp.evaluate(`[...document.querySelectorAll("video,audio")].forEach(n => { try { n.pause(); } catch {} })`);

  // 读取真实视频的 cid 与时长，用于构造该视频的本地主字幕缓存（免 ASR 外部 Key，仅字幕翻译走真网）
  const videoIdentity = await page.cdp.evaluate(`(() => {
    const init = window.__INITIAL_STATE__ || {};
    const vd = init.videoData || {};
    const cid = String(vd.cid || (vd.pages && vd.pages[0] && vd.pages[0].cid) || "");
    const duration = Number(vd.duration || document.querySelector("video")?.duration || 120);
    return { bvid: String(vd.bvid || ${JSON.stringify(SAMPLE.bvid)}), cid, duration };
  })()`);
  evidence.videoIdentity = videoIdentity;
  check("video-identity-resolved", Boolean(videoIdentity?.bvid && videoIdentity?.cid), videoIdentity);

  // 写入 ASR 缓存主字幕（无任何 API Key），使匿名页上的阅读器直接拥有英文待译主轨
  const dur = Math.max(30, Math.floor(Number(videoIdentity.duration) || 120));
  const lastStart = Math.max(15, Math.ceil(dur * 0.24));
  const primaryBody = [
    { from: 2, to: 6, content: ENGLISH_SAMPLE_LINES[0].content },
    { from: 7, to: 11, content: ENGLISH_SAMPLE_LINES[1].content },
    { from: lastStart, to: lastStart + 4, content: ENGLISH_SAMPLE_LINES[2].content }
  ];
  const asrCacheKey = `biliscript_subtitle_cache_${videoIdentity.bvid}_${videoIdentity.cid}_id_asr:asr-harness:whisper-1:auto`;
  await worker.evaluate(
    `(async () => {
      await chrome.storage.sync.set({
        asrProviders: [
          {
            id: "asr-harness",
            name: "ASR Cache",
            type: "openai-transcriptions",
            baseUrl: "https://example.invalid/v1",
            model: "whisper-1",
            enabled: true
          }
        ],
        activeAsrProviderId: "asr-harness",
        bilingualSubtitles: false
      });
      await chrome.storage.local.set({
        ${JSON.stringify(asrCacheKey)}: { body: ${JSON.stringify(primaryBody)}, timestamp: Date.now() }
      });
      return true;
    })()`,
    15000
  );

  // 刷新页面让缓存主字幕自然加载进入阅读器，并保持零 AI Key 状态
  await page.cdp.send("Page.navigate", { url: SAMPLE.url });
  await waitFor(
    "文摘按钮就绪且有几何",
    async () =>
      page.cdp.evaluate(`(() => {
        const btn = document.getElementById("biliscript-script-button");
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })()`),
    { timeoutMs: 45000, intervalMs: 200 }
  );
  await page.cdp.evaluate(`[...document.querySelectorAll("video,audio")].forEach(n => { try { n.pause(); } catch {} })`);

  // 打开文摘阅读面板
  await clickElement(page.cdp, "open-reader-panel", `document.getElementById("biliscript-script-button")`);
  await waitFor(
    "阅读面板主字幕渲染",
    async () =>
      page.cdp.evaluate(`(() => {
        const view = document.getElementById("biliscript-reading-view");
        const items = document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item");
        return Boolean(view?.classList.contains("open") && items.length >= 3);
      })()`),
    { timeoutMs: 30000 }
  );
  await page.cdp.evaluate(`[...document.querySelectorAll("video,audio")].forEach(n => { try { n.pause(); } catch {} })`);

  // 2. 验证设置页：打开设置 → 字幕翻译与导出，校验默认来源与 3 档模型且通用 AI 仍未配置
  await clickElement(
    page.cdp,
    "open-settings-drawer",
    `document.getElementById("biliscript-reading-settings-btn")`
  );
  await waitFor(
    "设置抽屉渲染",
    async () => page.cdp.evaluate(`Boolean(document.querySelector("#openSubtitleSettingsBtn"))`),
    { timeoutMs: 15000 }
  );
  await clickElement(
    page.cdp,
    "enter-subtitle-settings-subpage",
    `document.querySelector("#openSubtitleSettingsBtn")`
  );
  await waitFor(
    "字幕设置子页可见",
    async () =>
      page.cdp.evaluate(`(() => {
        const subpage = document.getElementById("biliscriptSettingsSubpageSubtitle");
        return Boolean(subpage && !subpage.hidden);
      })()`),
    { timeoutMs: 10000 }
  );
  const settingsUiState = await page.cdp.evaluate(`(() => {
    const sourceSel = document.getElementById("subtitleTranslateSource");
    const modelSel = document.getElementById("subtitleTranslateModel");
    const aiDefaultSel = document.getElementById("aiDefaultModel");
    const subRowCount = document.querySelectorAll("#biliscriptSettingsSubpageSubtitle [data-settings-section='subtitle'] .biliscript-set-row-sub").length;
    return {
      sourceValue: sourceSel?.value || "",
      modelValue: modelSel?.value || "",
      modelDisabled: Boolean(modelSel?.disabled),
      modelOptions: modelSel ? [...modelSel.options].map((o) => o.textContent) : [],
      aiDefaultDisabled: Boolean(aiDefaultSel?.disabled),
      aiDefaultFirstOption: aiDefaultSel?.options?.[0]?.textContent || "",
      subRowCount
    };
  })()`);
  evidence.settingsUiState = settingsUiState;
  check(
    "settings-ui-index-translate-default-and-decoupled",
    settingsUiState?.sourceValue === "bilibili-index-translate" &&
      settingsUiState?.modelDisabled === false &&
      JSON.stringify(settingsUiState?.modelOptions) ===
        JSON.stringify(["Index-Translate-35B-A3B", "Index-Translate-9B", "Index-Translate-2B"]) &&
      settingsUiState?.aiDefaultDisabled === true &&
      settingsUiState?.subRowCount === 0,
    settingsUiState
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "01-settings-subtitle-translate.png"));

  // 关闭设置抽屉回到字幕 Tab
  await clickElement(
    page.cdp,
    "close-settings-drawer",
    `document.getElementById("biliscript-reading-settings-btn")`
  );
  await sleep(250);

  // 3. 挂载 offscreen target 监听（若 offscreen 尚未启动，则周期性扫描 /json/list 捕获新出现的 offscreen.html target）
  let offscreenCdp = null;
  const offscreenTimer = setInterval(() => {
    if (offscreenCdp) return;
    void (async () => {
      try {
        const targets = await listJsonTargets(browser.port);
        const target = targets.find((t) => String(t.url || "").includes("entry/offscreen.html"));
        if (target?.webSocketDebuggerUrl && !offscreenCdp) {
          const client = await CDP.connect(target.webSocketDebuggerUrl);
          offscreenCdp = client;
          cdps.push(client);
          await client.send("Network.enable");
          await client.send("Runtime.enable");
          await client.send("Log.enable");
          attachNetworkAndErrorMonitor(client, evidence.network.offscreen);
          log(`offscreen target 已挂载：${target.url}`);
        }
      } catch {}
    })();
  }, 150);

  // 提前唤醒 offscreen 文档以便 Network.enable 在请求发出前已附着
  await worker.evaluate(
    `(async () => {
      if (chrome.offscreen?.createDocument) {
        const url = chrome.runtime.getURL("entry/offscreen.html");
        const existing = chrome.runtime.getContexts
          ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })
          : [];
        if (!existing || existing.length === 0) {
          await chrome.offscreen.createDocument({
            url: "entry/offscreen.html",
            reasons: ["BLOBS"],
            justification: "Browser harness network observation"
          });
        }
      }
      return true;
    })()`,
    15000
  );
  await waitFor("offscreen-target-attached", async () => Boolean(offscreenCdp), { timeoutMs: 10000, intervalMs: 100 });
  clearInterval(offscreenTimer);

  // 4. 在真实 B 站视频页阅读面板打开选轨浮层，真实点击「双语字幕」开关触发翻译
  await clickElement(
    page.cdp,
    "open-track-picker",
    `document.querySelector(".biliscript-reading-track-picker .custom-select-trigger")`
  );
  await waitFor(
    "双语开关可见",
    async () =>
      page.cdp.evaluate(`(() => {
        const sw = document.querySelector(".biliscript-reading-track-picker .biliscript-bilingual-switch");
        const r = sw?.getBoundingClientRect();
        return Boolean(sw && r && r.width > 0 && r.height > 0);
      })()`),
    { timeoutMs: 10000 }
  );

  await clickElement(
    page.cdp,
    "toggle-bilingual-switch-on",
    `document.querySelector(".biliscript-reading-track-picker .biliscript-bilingual-switch")`
  );

  // 5. 等待真实 Index-Translate HTTP 200 与双语副行就绪
  let lastRows = null;
  let renderedBilingual = null;
  try {
    renderedBilingual = await waitFor(
      "双语副行译文就绪",
      async () => {
        const snapshot = await page.cdp.evaluate(`(() => {
          const items = [...document.querySelectorAll("#biliscript-reading-subtitle .biliscript-reading-item")];
          const rows = items.map((it) => {
            const textEl = it.querySelector(".biliscript-reading-text");
            const subEl = it.querySelector(".biliscript-reading-subtext");
            const clone = textEl ? textEl.cloneNode(true) : null;
            clone?.querySelectorAll(".biliscript-reading-subtext").forEach((n) => n.remove());
            return {
              main: (clone?.textContent || "").trim(),
              sub: (subEl?.textContent || "").trim(),
              state: subEl?.dataset?.state || ""
            };
          });
          return {
            rows,
            notice: document.querySelector("#biliscript-reading-subtitle-notice")?.textContent || "",
            subAllReady: rows.length >= 3 && rows.every((r) => r.state === "ready" && r.sub.length > 0)
          };
        })()`);
        lastRows = snapshot;
        return snapshot?.subAllReady ? snapshot.rows : null;
      },
      { timeoutMs: 25000, intervalMs: 300 }
    );
  } finally {
    evidence.lastRows = lastRows;
  }
  // 点击收起选轨弹层以便截图清晰展示双语字幕列表
  await clickElement(
    page.cdp,
    "close-track-picker",
    `document.querySelector(".biliscript-reading-track-picker .custom-select-trigger")`
  );
  await sleep(200);
  evidence.renderedBilingual = renderedBilingual;
  await screenshot(page.cdp, path.join(OUT_DIR, "02-bilingual-rendered.png"));

  const allResponses = [
    ...evidence.network.offscreen.indexResponses,
    ...evidence.network.page.indexResponses
  ];
  const allFailures = [
    ...evidence.network.offscreen.indexFailures,
    ...evidence.network.page.indexFailures
  ];
  const hasHttp200 = allResponses.some(
    (r) => r.url.startsWith("https://index-translate.bilibili.com/v1/chat/completions") && r.status === 200
  );
  check("real-index-translate-http-200", hasHttp200 && allFailures.length === 0, {
    responses: allResponses,
    failures: allFailures
  });

  const hasChinese = renderedBilingual.every((r) => /[\u4e00-\u9fff]/.test(r.sub) && r.sub !== r.main);
  const hasThinkTag = renderedBilingual.some((r) => /<\/?think>/i.test(r.sub));
  check("bilingual-subtitles-rendered-chinese-no-think", hasChinese && !hasThinkTag, {
    rows: renderedBilingual,
    hasThinkTag
  });

  const allErrors = [
    ...pageWatcher.consoleLog.filter((entry) => entry.type === "error" || /error|cors|csp/i.test(String(entry.text || ""))),
    ...pageWatcher.netLog.filter(
      (entry) => entry.phase === "loadingFailed" && String(entry.url || "").includes("index-translate")
    ),
    ...evidence.network.offscreen.errors,
    ...evidence.network.page.errors
  ];
  // 过滤掉 B 站自身页面无关日志，聚焦扩展 / CORS / CSP / index-translate 错误
  const relevantErrors = allErrors.filter((e) => {
    const txt = JSON.stringify(e);
    return /cors|csp|content security policy|index-translate|biliscript|chrome-extension/i.test(txt);
  });
  evidence.relevantErrors = relevantErrors;
  check("no-cors-csp-extension-errors", relevantErrors.length === 0, relevantErrors);

  evidence.meta.ms = Date.now() - t0;
} catch (error) {
  check("no-fatal", false, { message: error.message });
  evidence.__fatal = { message: error.message, stack: String(error.stack || "").slice(0, 2000) };
} finally {
  if (browser) {
    try {
      const pages = await listJsonTargets(browser.port).catch(() => []);
      if (pages.length > 0) {
        // 确保卸载前暂停页内媒体
        const pageCdp = cdps[0];
        await pageCdp?.evaluate?.(`[...document.querySelectorAll("video,audio")].forEach(n => { try { n.pause(); } catch {} })`).catch(() => {});
      }
    } catch {}
  }
  await teardown({ browser, cdps });
  check("profile-removed", Boolean(browser?.profileRemoved), { profileDir: browser?.profileDir });
  evidence.checks = checks;
  evidence.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  evidence.meta.ms = evidence.meta.ms ?? Date.now() - t0;
  await writeEvidence(OUT_DIR, evidence);
  log(`结果：${checks.length - evidence.failed.length}/${checks.length} 通过，用时 ${evidence.meta.ms}ms`);
  if (evidence.failed.length) {
    log(`失败项：${evidence.failed.join(", ")}`);
    process.exitCode = 1;
  }
}
