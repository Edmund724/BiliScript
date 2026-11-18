#!/usr/bin/env node
// onboarding.mjs — 内置引导页真机回归验收：
//   1. 首次安装自动打开 onboarding.html 且无 CSP / 控制台报错；
//   2. 在引导页保存 AI 平台配置并完成联网搜索 opt-in 授权闭环后，打开 B 站视频页，
//      「文摘面板」立即可读取到新配置；
//   3. 从「文摘面板 -> 设置」点击「新手引导 / 快速上手」能正常重开 onboarding.html，
//      且重开页回显已保存的就绪状态。

import path from "node:path";
import { readFileSync } from "node:fs";
import {
  CDP,
  DEFAULT_DIST,
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

const NAME = "onboarding";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const BVID = "BV1mAam6tEL8";
const AID = 117370433574328;
const CID = 42393338874;
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/?p=1`;

const fixtureRoot = path.join(REPO_ROOT, "tests/fixtures/bilibili/bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureRoot, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureRoot, "bodies.json"), "utf8"));
const subtitleBody = bodies[`${BVID}-zh`];

const checks = [];
const cdps = [];
const handledInterceptions = new Set();

function check(name, ok, detail = null) {
  const entry = { name, ok: Boolean(ok), detail };
  checks.push(entry);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === null ? "" : `  ${JSON.stringify(detail).slice(0, 500)}`}`);
  return entry.ok;
}

function videoHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Onboarding E2E</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#eee;font-family:Arial,sans-serif;overflow:hidden}
.player{position:relative;width:900px;height:520px;margin:20px;background:#050505;border:1px solid #333}
video{width:100%;height:100%;background:#050505}
.controls{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;z-index:2}
.quality{width:70px;height:36px;color:white;background:#333;border:0}
</style></head><body>
<div id="playerWrap"><div id="bilibili-player"><div class="bpx-player-container player"><div class="bpx-player-video-wrap"><video preload="none"></video></div><div class="bpx-player-control-bottom-right controls"><button class="bpx-player-ctrl-quality quality" aria-label="清晰度 1080P">1080P</button></div></div></div></div>
<div id="arc_toolbar_report" style="margin-left:20px"><div class="video-toolbar-left"></div></div>
</body></html>`;
}

function viewResponse() {
  return {
    code: 0,
    message: "0",
    data: {
      aid: AID,
      bvid: BVID,
      cid: CID,
      title: "Onboarding 真机回归视频",
      desc: "离线 fixture 视频",
      duration: 461,
      pubdate: 1767225600,
      owner: { name: "fixture" },
      pages: [{ cid: CID, page: 1, part: "P1", duration: 461 }]
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

async function listPageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === "page");
}

async function clickCenter(cdp, selector) {
  const rect = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      width: r.width,
      height: r.height,
      x,
      y,
      hitOk: Boolean(hit && (hit === el || el.contains(hit)))
    };
  })()`);
  if (!rect || rect.width <= 0 || rect.height <= 0 || !rect.hitOk) {
    throw new Error(`点击目标不可达：${selector} -> ${JSON.stringify(rect)}`);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  return rect;
}

function installSwFixtures(handle) {
  const { cdp, sessionId } = handle;
  return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId).then(() => {
    cdp.on("Fetch.requestPaused", async (params) => {
      const url = params.request?.url || "";
      const requestId = params.requestId;
      if (handledInterceptions.has(requestId)) return;
      handledInterceptions.add(requestId);
      let payload = null;
      if (/x\/web-interface\/view/.test(url)) {
        payload = viewResponse();
      } else if (/x\/player\/(?:wbi\/)?v2/.test(url)) {
        payload = playerResponse();
      } else if (/aisubtitle\.hdslb\.com/.test(url)) {
        payload = subtitleBody;
      } else if (/x\/v2\/reply\/main/.test(url)) {
        payload = { code: 0, message: "0", data: { replies: [] } };
      }
      if (payload !== null) {
        await cdp.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(payload)).toString("base64")
        }, sessionId).catch(() => {});
        return;
      }
      await cdp.send("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
    });
  });
}

let browser = null;
const evidence = { meta: { distDir: DEFAULT_DIST, repoRoot: REPO_ROOT }, checks };
const t0 = Date.now();

try {
  browser = await launchBrowser({ distDir: DEFAULT_DIST, headless: true });

  // 1. 首次安装自动打开 onboarding.html
  const onboardingTarget = await waitFor(
    "首次安装自动打开 onboarding.html",
    async () => {
      const pages = await listPageTargets(browser.port);
      return pages.find((t) => /\/onboarding\.html(?:$|\?)/.test(t.url || "")) || null;
    },
    { timeoutMs: 20000, intervalMs: 250 }
  );
  check("first-install-opened-onboarding", Boolean(onboardingTarget), { url: onboardingTarget?.url });

  const onboardingCdp = await CDP.connect(onboardingTarget.webSocketDebuggerUrl);
  cdps.push(onboardingCdp);
  await onboardingCdp.send("Page.enable");
  await onboardingCdp.send("Runtime.enable");
  await onboardingCdp.send("Log.enable");
  await onboardingCdp.send("Network.enable");
  await onboardingCdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  const onboardingLogs = watchPage(onboardingCdp);
  const cspViolations = [];
  onboardingCdp.on("Security.securityStateChanged", () => {});
  onboardingCdp.on("Log.entryAdded", (params) => {
    const entry = params?.entry;
    if (entry && (entry.level === "error" || /csp|content security policy/i.test(String(entry.text || "")))) {
      cspViolations.push(entry);
    }
  });

  const initialHydration = await waitFor(
    "onboarding 表单水合",
    async () =>
      onboardingCdp.evaluate(`(() => {
        const aiPreset = document.getElementById("aiPresetSelect");
        const aiUrl = document.getElementById("aiBaseUrlInput");
        const asrPreset = document.getElementById("asrPresetSelect");
        const asrModel = document.getElementById("asrModelInput");
        const links = Array.from(document.querySelectorAll(".onboarding-footer a")).map((a) => ({
          href: a.getAttribute("href"),
          target: a.getAttribute("target"),
          rel: a.getAttribute("rel")
        }));
        if (!aiPreset || !asrModel || !aiPreset.value) return null;
        return {
          aiPreset: aiPreset.value,
          aiBaseUrl: aiUrl?.value,
          asrPreset: asrPreset?.value,
          asrModel: asrModel.value,
          links
        };
      })()`),
    { timeoutMs: 10000 }
  );

  check(
    "onboarding-initial-defaults",
    initialHydration?.aiPreset === "modelscope" &&
      initialHydration?.aiBaseUrl === "https://api-inference.modelscope.cn/v1" &&
      initialHydration?.asrPreset === "siliconflow-sensevoice" &&
      initialHydration?.asrModel === "XingChenAGI/XingChenASR-V3.2",
    initialHydration
  );

  check(
    "onboarding-docs-links",
    Array.isArray(initialHydration?.links) &&
      initialHydration.links.some((l) => l.href === "https://edmund724.github.io/BiliScript/docs/guide.html" && l.target === "_blank") &&
      initialHydration.links.some((l) => l.href === "https://edmund724.github.io/BiliScript/docs/agent-bridge.html" && l.target === "_blank") &&
      initialHydration.links.some((l) => l.href === "https://edmund724.github.io/BiliScript/privacy.html" && l.target === "_blank"),
    initialHydration?.links
  );

  await screenshot(onboardingCdp, path.join(OUT_DIR, "01-onboarding-initial.png"));

  // 2. 在引导页保存 DeepSeek（https://api.deepseek.com 在常驻 host_permissions 内，headless 可直过权限弹窗）并完成联网搜索授权闭环
  await onboardingCdp.evaluate(`(() => {
    const preset = document.getElementById("aiPresetSelect");
    preset.value = "deepseek";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
    const key = document.getElementById("aiApiKeyInput");
    key.value = "sk-harness-onboarding-e2e";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    const model = document.getElementById("aiModelInput");
    model.value = "deepseek-chat";
    model.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickCenter(onboardingCdp, "#aiSaveBtn");

  const aiSaved = await waitFor(
    "onboarding AI 保存就绪",
    async () =>
      onboardingCdp.evaluate(`(() => {
        const badge = document.getElementById("aiReadyBadge");
        return badge?.dataset.ready === "true" ? badge.textContent : null;
      })()`),
    { timeoutMs: 10000 }
  );
  check("onboarding-ai-saved", Boolean(aiSaved && aiSaved.includes("DeepSeek")), { badge: aiSaved });

  // 点击联网搜索开关并完成 opt-in 确认对话框
  await clickCenter(onboardingCdp, "#webSearchToggle + .biliscript-toggle-track");
  await waitFor(
    "opt-in 确认弹窗出现",
    async () => onboardingCdp.evaluate("Boolean(document.querySelector('.confirm-dialog-confirm'))"),
    { timeoutMs: 8000 }
  );
  await clickCenter(onboardingCdp, ".confirm-dialog-confirm");
  const searchSaved = await waitFor(
    "联网搜索授权开启",
    async () =>
      onboardingCdp.evaluate(`(() => {
        const badge = document.getElementById("searchReadyBadge");
        const toggle = document.getElementById("webSearchToggle");
        return badge?.dataset.ready === "true" && toggle?.checked ? badge.textContent : null;
      })()`),
    { timeoutMs: 8000 }
  );
  check("onboarding-web-search-opt-in", Boolean(searchSaved), { badge: searchSaved });

  const consoleErrors = onboardingLogs.consoleLog.filter((e) => e.type === "error" || e.type === "exception");
  check("onboarding-zero-csp-console-errors", consoleErrors.length === 0 && cspViolations.length === 0, {
    consoleErrors,
    cspViolations
  });
  await screenshot(onboardingCdp, path.join(OUT_DIR, "02-onboarding-configured.png"));

  // 3. 打开 B 站视频页（离线 fixture），验证文摘面板立即读到新配置
  const videoPage = await attachPage(browser);
  cdps.push(videoPage.cdp);
  const worker = createWorkerSession({
    pageCdp: videoPage.cdp,
    browser,
    onReconnect: installSwFixtures
  });
  await worker.ensureAlive();
  cdps.push(worker.handle.cdp);

  await videoPage.cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "https://www.bilibili.com/video/*", requestStage: "Request" }]
  });
  videoPage.cdp.on("Fetch.requestPaused", async (params) => {
    if (params.request?.url?.startsWith("https://www.bilibili.com/video/")) {
      await videoPage.cdp.send("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
        body: Buffer.from(videoHtml()).toString("base64")
      }).catch(() => {});
      return;
    }
    await videoPage.cdp.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
  });

  await videoPage.cdp.send("Page.navigate", { url: VIDEO_URL });
  await waitFor(
    "B 站页面文摘按钮就绪",
    async () => videoPage.cdp.evaluate("Boolean(document.getElementById('biliscript-script-button'))"),
    { timeoutMs: 15000 }
  );
  await clickCenter(videoPage.cdp, "#biliscript-script-button");
  await waitFor(
    "文摘面板展开",
    async () => videoPage.cdp.evaluate("Boolean(document.querySelector('#biliscript-reading-view.open'))"),
    { timeoutMs: 15000 }
  );

  // 切到 AI 对话 tab 检查模型与联网开关是否立即同步
  await clickCenter(videoPage.cdp, "#biliscript-reading-tab-chat");
  const chatSync = await waitFor(
    "AI 对话同步新配置",
    async () =>
      videoPage.cdp.evaluate(`(() => {
        const modelBtn = document.getElementById("biliscript-reading-chat-model-chip") ||
          document.getElementById("biliscript-reading-chat-model-select");
        const pill = document.getElementById("biliscript-reading-chat-web-search-pill");
        const modelText = (modelBtn?.textContent || modelBtn?.value || "").trim();
        const pillActive = Boolean(pill?.classList.contains("is-active"));
        return modelText.includes("deepseek-chat") && pillActive ? { modelText, pillActive } : null;
      })()`),
    { timeoutMs: 10000 }
  );
  check("reader-panel-synced-onboarding-config", Boolean(chatSync), chatSync);
  await screenshot(videoPage.cdp, path.join(OUT_DIR, "03-reader-panel-synced.png"));

  // 4. 打开设置抽屉并点击「新手引导 / 快速上手」重开 onboarding.html
  await clickCenter(videoPage.cdp, "#biliscript-reading-settings-btn");
  await waitFor(
    "设置抽屉中的新手引导入口渲染",
    async () =>
      videoPage.cdp.evaluate(`(() => {
        const btn = document.getElementById("openOnboardingBtn");
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })()`),
    { timeoutMs: 10000 }
  );

  const beforeTargetIds = new Set(
    (await listPageTargets(browser.port))
      .filter((t) => /\/onboarding\.html(?:$|\?)/.test(t.url || ""))
      .map((t) => t.id)
  );
  await clickCenter(videoPage.cdp, "#openOnboardingBtn");

  const reopenedTarget = await waitFor(
    "从设置页重开 onboarding.html",
    async () => {
      const pages = await listPageTargets(browser.port);
      return pages.find((t) => /\/onboarding\.html(?:$|\?)/.test(t.url || "") && !beforeTargetIds.has(t.id)) || null;
    },
    { timeoutMs: 10000, intervalMs: 200 }
  );
  check("settings-reopened-onboarding", Boolean(reopenedTarget), { url: reopenedTarget?.url });

  const reopenedCdp = await CDP.connect(reopenedTarget.webSocketDebuggerUrl);
  cdps.push(reopenedCdp);
  await reopenedCdp.send("Runtime.enable");
  await reopenedCdp.send("Page.enable");
  await reopenedCdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  const reopenedState = await waitFor(
    "重开引导页回显已保存状态",
    async () =>
      reopenedCdp.evaluate(`(() => {
        const aiBadge = document.getElementById("aiReadyBadge");
        const model = document.getElementById("aiModelInput");
        const searchBadge = document.getElementById("searchReadyBadge");
        if (aiBadge?.dataset.ready !== "true") return null;
        return {
          aiBadge: aiBadge.textContent,
          model: model?.value,
          searchBadge: searchBadge?.textContent,
          searchReady: searchBadge?.dataset.ready
        };
      })()`),
    { timeoutMs: 10000 }
  );
  check(
    "reopened-onboarding-preserves-config",
    reopenedState?.model === "deepseek-chat" && reopenedState?.searchReady === "true",
    reopenedState
  );
  await screenshot(reopenedCdp, path.join(OUT_DIR, "04-onboarding-reopened.png"));

  evidence.meta.ms = Date.now() - t0;
} catch (error) {
  check("no-fatal", false, { message: error.message });
  evidence.__fatal = { message: error.message, stack: String(error.stack || "").slice(0, 2000) };
} finally {
  await teardown({ browser, cdps });
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
