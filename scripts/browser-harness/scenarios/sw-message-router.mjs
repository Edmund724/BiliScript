#!/usr/bin/env node
// 消息入口路由的真机场景 —— `pnpm harness:scenario sw-message-router`。
//
// 判据（jsdom 够不着的部分）：路由 / 来源守卫 / payload 形状守卫 / 派发 / 回包口径
// 收进 core/message-router 之后，真实 MV3 SW 里的这条链是否还接在组合根上——
// 未登记的类型不答、offscreen 专属来源的页面发送者拿到拒绝信封、已知类型照常路由、
// 设置读写经路由器往返稳定。jsdom 里的 chrome.runtime 是假管道，守卫与组合根接线
// 在那一层没有承载物。
//
// 发送者上下文（诚实声明）：页面 target 导航到 chrome-extension://<id>/entry/offscreen.html
// ——这是**标签页里的扩展页**（sender.tab 在场、url 恰为 offscreen 文档 URL），是本仓
// 离线可达的唯一页面发送者；真实 content script 发送者只有真网 bilibili 页能给，本场景
// 不联网。SW 自己给自己发消息不投回自己（实测见 evidence.s6.selfSend），故「未登记
// 类型不答」与「已知类型照常路由」都从页面 target 发出；SW 侧只用 worker.evaluate 读
// 路由器的注册事实（onMessage.hasListeners）与被动观察发送者形状（只记、不答、不持
// 通道的旁观监听器）。
//
// 场景（id 同时是 evidence.json 里的键）：
//   S1 SW 就位：worker 连上，chrome.runtime.getManifest().version 与 dist/manifest.json 一致，
//      页面 target 落在扩展页上（页面发送者就位）
//   S2 未登记类型：无回包载荷（promise 以 undefined 落定 / reject / 不落定，三者都记录），
//      且 SW 侧的旁观监听器证明确实收到了这条消息（不是「无人接收」）
//   S3 来源守卫：segment-cache 从页面发送者发出 → { ok:false, error: 仅接受 offscreen
//      文档发送 }；期望值从 asr/protocol.ts 的 ASR_OFFSCREEN_REJECTION_MESSAGE 单源读出，
//      不在这里手抄第二份
//   S4 已知类型：get-settings 回 { ok:true, settings }
//   S5 设置往返：读 → 原样写回 → 再读，三趟无错误信封，两份快照逐字段相同（不新增键、不改值）
//   S6 路由表在组合根：SW 的 onMessage 有监听者；第二个 / 第三个已知类型（sync 回包、
//      零副作用）从页面发送者发出也照常应答
//
// 不在判据内（也不做）：起 ASR / AI 转写、建 offscreen 文档、真 B 站播放、任何出网。
// 硬约束：只杀自己 spawn 的进程（harness teardown）；工件落
// .scratch/browser-harness/scenarios/sw-message-router/；只 import ../harness.mjs。

import path from "node:path";
import { readFileSync } from "node:fs";
import {
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

const NAME = "sw-message-router";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const VIEWPORT = DEFAULT_VIEWPORT;
const headed = process.argv.includes("--headed");
// 页面侧 sendMessage 的等待上限：路由器要么答、要么不答，绝不把它当死连接吊着。
const PAGE_SEND_TIMEOUT_MS = 8000;

// 扩展侧的两个字面量期望值都从单源读出（不在这里手抄第二份）：
//   ① 拒绝文案 asr/protocol.ts 的 ASR_OFFSCREEN_REJECTION_MESSAGE；
//   ② 页面发送者所在的扩展页 shared/offscreen-constants.ts 的 OFFSCREEN_URL。
function readExtensionConst(relPath, name) {
  const file = path.join(REPO_ROOT, relPath);
  const source = readFileSync(file, "utf8");
  const match = new RegExp(`export const ${name}\\b[^=]*=\\s*"([^"]+)"`).exec(source);
  return { file: path.relative(REPO_ROOT, file), value: match ? match[1] : null };
}
const rejectionSource = readExtensionConst(path.join("extension", "asr", "protocol.ts"), "ASR_OFFSCREEN_REJECTION_MESSAGE");
const offscreenUrlSource = readExtensionConst(path.join("extension", "shared", "offscreen-constants.ts"), "OFFSCREEN_URL");

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

let pageCdp = null;
let browser = null;
let worker = null;
let watched = null;

function readDistManifest() {
  return JSON.parse(readFileSync(path.join(DEFAULT_DIST, "manifest.json"), "utf8"));
}

async function shot(base, note) {
  try {
    await screenshot(pageCdp, path.join(OUT_DIR, `${base}.png`));
    log(`截图 ${base}.png（${note}）`);
  } catch (error) {
    log(`截图失败 ${base}: ${error.message}`);
  }
}

// ===== 页面发送者：一条消息一趟 sendMessage，落定方式与载荷都如实记下 =====
function sendExpr(messageLiteral) {
  return `(async () => {
    const timeout = new Promise((resolve) => setTimeout(() => resolve("__harness-timeout__"), ${PAGE_SEND_TIMEOUT_MS}));
    try {
      const value = await Promise.race([chrome.runtime.sendMessage(${messageLiteral}), timeout]);
      if (value === "__harness-timeout__") return { settled: "timeout" };
      return { settled: "resolved", isUndefined: value === undefined, valueType: typeof value, value: value === undefined ? null : value };
    } catch (error) {
      return { settled: "rejected", error: String((error && error.message) || error) || String(error) };
    }
  })()`;
}
async function sendFromPage(messageLiteral) {
  return pageCdp.evaluate(sendExpr(messageLiteral), { timeoutMs: PAGE_SEND_TIMEOUT_MS + 7000 });
}

// ===== SW 侧旁观监听器：只记「SW 收到的发送者形状」，不答、不持通道（返回值恒 undefined）=====
// 用途：把「拒绝 / 沉默发生在路由之后」从推断变成实测——旁观记录能证明消息确实进了 SW，
// 以及发送者带没带 sender.tab。SW 被回收后（新实例）由 onReconnect 重装。
async function installSenderObserver() {
  return worker.evaluate(`(() => {
    globalThis.__harnessSenderLog = globalThis.__harnessSenderLog || [];
    if (globalThis.__harnessSenderObserverInstalled) return true;
    globalThis.__harnessSenderObserverInstalled = true;
    chrome.runtime.onMessage.addListener((message, sender) => {
      globalThis.__harnessSenderLog.push({
        type: message && typeof message === "object" ? message.type : null,
        senderUrl: sender && sender.url ? sender.url : null,
        hasTab: Boolean(sender && sender.tab),
        tabId: sender && sender.tab ? sender.tab.id ?? null : null
      });
    });
    return true;
  })()`, 20000);
}
async function readSenderLog() {
  return (await worker.evaluate("globalThis.__harnessSenderLog || []", 20000)) || [];
}
// 旁观记录是异步 push：等这一条类型出现再断言，不与消息投递赛跑。
async function waitSenderEntry(type, timeoutMs = 4000) {
  const found = await waitFor(`SW 旁观记录：${type}`, async () => {
    const entries = await readSenderLog();
    return entries.find((entry) => entry.type === type) || false;
  }, { timeoutMs, intervalMs: 100 }).catch(() => false);
  return found || null;
}

function dumpDiagnostics(tag) {
  const entry = {};
  evidence.diagnostics[tag] = entry;
  Promise.resolve(pageCdp ? pageCdp.evaluate("({ href: location.href, visibilityState: document.visibilityState })") : null)
    .then((v) => { entry.page = v; })
    .catch((error) => { entry.page = { error: error.message }; });
  entry.consoleTail = (watched?.consoleLog || []).slice(-20).map((line) => String(line).slice(0, 200));
  log(`诊断[${tag}]：console ${entry.consoleTail.length} 条`);
  for (const line of (watched?.consoleLog || []).filter((l) => /BILISCRIPT/.test(String(l))).slice(-10)) {
    log(`  console(BILISCRIPT): ${String(line).slice(0, 200)}`);
  }
}

// ===== 主流程 =====
async function main() {
  // ===== S1：SW 就位，装配的就是这份 dist；页面发送者就位 =====
  await phase("s1", async () => {
    const manifest = readDistManifest();
    check("s1-expected-literals-from-single-source", Boolean(rejectionSource.value) && Boolean(offscreenUrlSource.value), {
      rejection: { file: rejectionSource.file, message: rejectionSource.value },
      offscreenPage: { file: offscreenUrlSource.file, url: offscreenUrlSource.value }
    });
    check("s1-dist-manifest-readable", Boolean(manifest?.version), { version: manifest?.version });

    browser = await launchBrowser({ headless: !headed, viewport: VIEWPORT });
    const page = await attachPage(browser, { viewport: VIEWPORT });
    pageCdp = page.cdp;
    watched = watchPage(pageCdp);

    worker = createWorkerSession({
      pageCdp,
      browser,
      onReconnect: async () => {
        await installSenderObserver();
        log("SW 重连：发送者旁观监听器已重装");
      }
    });
    const workerUp = await worker.ensureAlive();
    check("s1-sw-attach", workerUp, { url: worker.handle?.url, via: worker.handle?.via });
    if (!workerUp) throw new Error("扩展服务工作线程没连上，后续步骤无从谈起");
    const swManifest = await worker.evaluate(
      "({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version })"
    );
    check("s1-sw-is-this-extension", worker.handle.url.endsWith(worker.handle.suffix), {
      url: worker.handle.url, suffix: worker.handle.suffix
    });
    check("s1-sw-manifest-matches-dist", swManifest?.version === manifest?.version, {
      swVersion: swManifest?.version, distVersion: manifest?.version, nameLocalized: swManifest?.name
    });
    evidence.meta.extensionId = swManifest?.id;
    evidence.meta.swVersion = swManifest?.version;
    evidence.meta.distVersion = manifest?.version;

    // 页面 target 落到扩展页上：本场景的页面发送者（标签页里的扩展页，sender.tab 在场）。
    const extensionPageUrl = `chrome-extension://${swManifest.id}/${offscreenUrlSource.value}`;
    evidence.meta.extensionPageUrl = extensionPageUrl;
    await pageCdp.send("Page.navigate", { url: extensionPageUrl });
    const pageCtx = await waitFor("页面 target 落在扩展页上（chrome.runtime 可用）", async () => {
      const info = await pageCdp.evaluate(`({
        href: location.href,
        origin: location.origin,
        hasRuntime: typeof chrome === "object" && !!chrome && !!chrome.runtime && typeof chrome.runtime.sendMessage === "function"
      })`);
      return info?.hasRuntime && info.href === extensionPageUrl ? info : false;
    }, { timeoutMs: 20000, intervalMs: 200 });
    check("s1-page-sender-context", Boolean(pageCtx), pageCtx);
    await installSenderObserver();
    await shot("01-page-sender", "页面发送者：标签页里的扩展页");
  });

  // ===== S2：未登记类型不答 =====
  await phase("s2", async () => {
    const outcome = await sendFromPage(`{ type: "no-such-message" }`);
    const noResponse = outcome?.settled === "rejected" || outcome?.settled === "timeout" || (outcome?.settled === "resolved" && outcome?.isUndefined === true);
    check("s2-unknown-type-gets-no-response", noResponse, {
      resolution: outcome?.settled === "resolved" && outcome?.isUndefined ? "resolved-undefined" : outcome?.settled,
      error: outcome?.error ?? null,
      value: outcome?.value ?? null,
      note: "有接收端（SW 的路由器）但不认识这个类型 ⇒ 无回包载荷"
    });
    const seen = await waitSenderEntry("no-such-message");
    check("s2-unknown-type-reached-sw", Boolean(seen), {
      entry: seen, note: "旁观监听器证明消息进了 SW 且带页面发送者形状——沉默发生在路由之后，不是无人接收"
    });
    evidence.s2 = { outcome, seenBySw: seen };
  });

  // ===== S3：来源守卫（offscreen 专属消息 + 页面发送者）=====
  await phase("s3", async () => {
    // 形状合法化：SegmentCacheContext 的键位字段取自 ai/segment-cache-key-fields.ts 的
    // 字段名（camel 形态）。segment-cache 本身没有 payload 形状判据，所以这条只可能
    // 触发来源守卫——观测到的错误文案就是判据。
    const payload = {
      type: "segment-cache",
      op: "load-summary",
      context: {
        bvid: "BV1harness000",
        cid: 1,
        selectedSubtitleId: "0",
        selectedSubtitleUrl: "https://harness.invalid/subtitle.json",
        subtitleLang: "zh-CN",
        chapters: []
      },
      segmentIndex: 0
    };
    const outcome = await sendFromPage(JSON.stringify(payload));
    const value = outcome?.settled === "resolved" ? outcome.value : null;
    check("s3-page-sender-refused", value?.ok === false && Boolean(value?.error), {
      resolution: outcome?.settled, value, error: outcome?.error ?? null
    });
    check("s3-refusal-is-offscreen-rejection", value?.error === rejectionSource.value, {
      observed: value?.error ?? null,
      expected: rejectionSource.value,
      observedRefusal: value?.error === rejectionSource.value ? "来源守卫（仅接受 offscreen 文档发送）" : "非来源守卫（见 observed）"
    });
    // sender.url 与 offscreen 文档 URL 逐字相同，却被拒 ⇒ 拒绝来自「sender.tab 在场」这半边判据
    // （isOffscreenDocumentSender = !sender.tab && url === getURL(OFFSCREEN_URL)）。
    const seen = await waitSenderEntry("segment-cache");
    check("s3-refusal-sender-was-a-page", Boolean(seen) && seen.hasTab === true && seen.senderUrl === evidence.meta.extensionPageUrl, {
      entry: seen, note: "sender.tab 在场 ⇒ 发送者是标签页（页面 sender），不是 offscreen 文档本身"
    });
    evidence.s3 = { payload, outcome, seenBySw: seen };
  });

  // ===== S4：已知类型照常路由（来源无关）=====
  let settingsFirst = null;
  await phase("s4", async () => {
    const outcome = await sendFromPage(`{ type: "get-settings" }`);
    settingsFirst = outcome?.settled === "resolved" ? outcome.value : null;
    check("s4-get-settings-answers", settingsFirst?.ok === true, {
      resolution: outcome?.settled, ok: settingsFirst?.ok ?? null, error: settingsFirst?.error ?? outcome?.error ?? null
    });
    const settings = settingsFirst?.settings;
    check("s4-get-settings-returns-settings-object", Boolean(settings) && typeof settings === "object" && !Array.isArray(settings) && Object.keys(settings).length > 0, {
      valueType: settings === null ? "null" : typeof settings,
      keys: settings && typeof settings === "object" ? Object.keys(settings).length : null
    });
    evidence.s4 = { ok: settingsFirst?.ok ?? null, keyCount: settings && typeof settings === "object" ? Object.keys(settings).length : null };
  });

  // ===== S5：设置往返（读 → 原样写回 → 再读）=====
  await phase("s5", async () => {
    if (!settingsFirst?.settings) throw new Error("S4 没拿到设置快照，往返无从谈起");
    const before = settingsFirst.settings;
    const saveOutcome = await sendFromPage(JSON.stringify({ type: "save-settings", settings: before }));
    const saveValue = saveOutcome?.settled === "resolved" ? saveOutcome.value : null;
    const afterOutcome = await sendFromPage(`{ type: "get-settings" }`);
    const afterValue = afterOutcome?.settled === "resolved" ? afterOutcome.value : null;

    check("s5-save-settings-no-error-envelope", saveValue?.ok === true, {
      resolution: saveOutcome?.settled, value: saveValue, error: saveOutcome?.error ?? null
    });
    check("s5-second-read-no-error-envelope", afterValue?.ok === true, {
      resolution: afterOutcome?.settled, ok: afterValue?.ok ?? null, error: afterValue?.error ?? afterOutcome?.error ?? null
    });
    const after = afterValue?.settings ?? null;
    const beforeKeys = Object.keys(before).sort();
    const afterKeys = Object.keys(after || {}).sort();
    const changedKeys = beforeKeys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after?.[key]));
    const addedKeys = afterKeys.filter((key) => !beforeKeys.includes(key));
    const removedKeys = beforeKeys.filter((key) => !afterKeys.includes(key));
    check("s5-round-trip-stable", JSON.stringify(before) === JSON.stringify(after), {
      keys: beforeKeys.length, changedKeys, addedKeys, removedKeys,
      note: "回写的就是读到的同一份快照（不新增键、不改值）"
    });
    evidence.s5 = { saveValue, keyCount: beforeKeys.length, changedKeys, addedKeys, removedKeys };
  });

  // ===== S6：路由表在组合根 =====
  await phase("s6", async () => {
    const hasListeners = await worker.evaluate("chrome.runtime.onMessage.hasListeners()");
    check("s6-sw-registers-message-entry", hasListeners === true, {
      hasListeners, via: "worker.evaluate", note: "组合根在 SW 顶层同步注册了消息入口（路由器的委派点）"
    });
    // SW 自问自答到不了自己的路由器，这是平台事实不是缺陷：记下来，说明路由表只能从
    // 别的扩展上下文探测（本场景 = 页面发送者）。
    const selfSend = await worker.evaluate(
      `(async () => {
        const timeout = new Promise((resolve) => setTimeout(() => resolve("__harness-timeout__"), 3000));
        try {
          const value = await Promise.race([chrome.runtime.sendMessage({ type: "asr-presets-list" }), timeout]);
          return { settled: value === "__harness-timeout__" ? "timeout" : "resolved", value: value === "__harness-timeout__" || value === undefined ? null : value };
        } catch (error) {
          return { settled: "rejected", error: String((error && error.message) || error) || String(error) };
        }
      })()`, 15000
    );
    evidence.s6 = { hasListeners, selfSend };
    // 第二个 / 第三个已知类型：sync 回包 + 零副作用（纯预设目录切片），从页面发送者发出。
    const asrPre = await sendFromPage(`{ type: "asr-presets-list" }`);
    const asrPreValue = asrPre?.settled === "resolved" ? asrPre.value : null;
    check("s6-second-known-type-answers", asrPreValue?.ok === true && Array.isArray(asrPreValue?.presets) && asrPreValue.presets.length > 0, {
      resolution: asrPre?.settled, ok: asrPreValue?.ok ?? null, presets: asrPreValue?.presets?.length ?? null,
      error: asrPreValue?.error ?? asrPre?.error ?? null
    });
    const aiPre = await sendFromPage(`{ type: "ai-presets-list" }`);
    const aiPreValue = aiPre?.settled === "resolved" ? aiPre.value : null;
    check("s6-third-known-type-answers", aiPreValue?.ok === true && Array.isArray(aiPreValue?.presets) && aiPreValue.presets.length > 0, {
      resolution: aiPre?.settled, ok: aiPreValue?.ok ?? null, presets: aiPreValue?.presets?.length ?? null,
      error: aiPreValue?.error ?? aiPre?.error ?? null
    });
    evidence.s6.asrPresets = { ok: asrPreValue?.ok ?? null, presets: asrPreValue?.presets?.length ?? null };
    evidence.s6.aiPresets = { ok: aiPreValue?.ok ?? null, presets: aiPreValue?.presets?.length ?? null };

    // 旁观记录汇总：页面发出的每一条（含被拒的那条）都各进 SW 一次。
    evidence.senderLog = await readSenderLog();
    const expectedTypes = ["no-such-message", "segment-cache", "get-settings", "save-settings", "asr-presets-list", "ai-presets-list"];
    const observedTypes = evidence.senderLog.map((entry) => entry.type);
    const missingTypes = expectedTypes.filter((type) => !observedTypes.includes(type));
    check("s6-every-page-message-entered-sw", missingTypes.length === 0, {
      missingTypes, observed: observedTypes, note: "被拒的与陌生的类型同样先到 SW，才谈得上守卫与沉默"
    });
  });
}

const evidence = {
  meta: {
    name: NAME,
    distDir: DEFAULT_DIST,
    senderContext: "标签页里的扩展页（sender.tab 在场）",
    rejectionMessageSource: rejectionSource.file
  },
  s2: {}, s3: {}, s4: {}, s5: {}, s6: {}, senderLog: [], diagnostics: {}
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
  await sleep(50);
  const profileDir = browser?.profileDir;
  await teardown({ browser, cdps: [pageCdp, worker?.handle?.cdp].filter(Boolean) });
  check("profile-removed", Boolean(browser?.profileRemoved), { profileDir });
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
