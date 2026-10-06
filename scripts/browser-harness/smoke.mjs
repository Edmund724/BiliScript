#!/usr/bin/env node
// 真机验证自检 —— `pnpm harness:browser`。
//
// 它是 scripts/browser-harness/ 的回归测试，同时是 harness API 的用法示例：
// 起一个隔离的 headless Edge + 未打包扩展，连页面 target 与扩展服务工作线程，
// 各自求值，落一张截图与 evidence.json。
//
// 为什么值得跑：这条链上每一步都可能静默坏掉——Edge 改了侧载策略、dist 没构建、
// 同 profile 里 Edge 自带组件扩展的 SW 抢了 target、SW 被 MV3 回收、临时 profile 没删、
// 云端把别的设备的旧设置回放进 chrome.storage.sync。每一条都在下面变成一个具名 check，
// 任一失败即非零退出。
//
// 用法：
//   pnpm harness:browser                    # headless
//   pnpm harness:browser --headed           # 带窗口跑，看真实渲染
//   BILISCRIPT_EDGE=<路径> pnpm harness:browser

import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  DEFAULT_DIST,
  REPO_ROOT,
  artifactDir,
  attachPage,
  createWorkerSession,
  launchBrowser,
  log,
  resolveEdgePath,
  screenshot,
  teardown,
  writeEvidence
} from "./harness.mjs";

const OUT_DIR = artifactDir("smoke");
const headed = process.argv.includes("--headed");
const checks = [];
const t0 = Date.now();

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  return Boolean(ok);
}

function readDistManifest() {
  const file = path.join(DEFAULT_DIST, "manifest.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

let browser = null;
const cdps = [];
const evidence = { meta: { headed, distDir: DEFAULT_DIST, repoRoot: REPO_ROOT }, checks };

try {
  // 1. 环境：Edge 在场、dist 已构建
  const edgePath = resolveEdgePath();
  check("edge-found", existsSync(edgePath), { edgePath });

  const manifest = readDistManifest();
  check("dist-built", Boolean(manifest), { manifestPath: path.join(DEFAULT_DIST, "manifest.json") });
  if (!manifest) throw new Error("dist 未构建，先跑 pnpm build");

  // 2. 起隔离实例。这里显式开 autoplay：默认策略下 video.play() 抛 NotAllowedError、
  //    AudioContext 停在 suspended，就没法验证「静音没有把音频栈打死」。
  browser = await launchBrowser({ headless: !headed, autoplay: true });
  check("devtools-up", Boolean(browser.version?.Browser), { browser: browser.version?.Browser, port: browser.port });
  evidence.meta.browser = browser.version?.Browser;
  evidence.meta.port = browser.port;
  evidence.meta.browserPid = browser.pid;
  check("mute-flag-present", browser.args.includes("--mute-audio"), { muted: browser.muted });
  check("sync-flag-present", browser.args.includes("--disable-sync"), { sync: browser.sync });

  // 3. 页面 target
  const page = await attachPage(browser);
  cdps.push(page.cdp);
  check("page-attached", Boolean(page.target?.url !== undefined), { url: page.target.url });
  const ua = await page.cdp.evaluate("navigator.userAgent");
  const readyState = await page.cdp.evaluate("document.readyState");
  check("page-eval", typeof ua === "string" && ua.includes("Edg/"), { ua, readyState });
  evidence.page = { url: await page.cdp.evaluate("location.href"), readyState, ua };

  // 3b. 静音不等于把音频栈打死：--mute-audio 该在「输出到设备」那层静音，而不是禁用
  //     音频渲染——本仓的 ASR 路径要从视频取音，音频栈死掉等于把那条路测废了。
  //     两问：媒体能播吗（autoplay 缝可用）、AudioContext 真在跑吗（时钟在走）。
  //     两者都必须当场收干净：headless 里留着一个还在播的 <video> 会让整个浏览器
  //     在几秒后不再响应 CDP（实测：连 /json/list 的 ws 都连不上）。
  const media = await page.cdp.evaluate(
    `(async () => {
      const v = document.createElement("video");
      v.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
      document.body.appendChild(v);
      let played = "ok";
      try {
        await v.play();
      } catch (error) {
        played = "blocked:" + error.name;
      }
      const out = { played, paused: v.paused };
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
      return out;
    })()`,
    { timeoutMs: 8000 }
  );
  // play() 不抛 NotAllowedError 就算这条缝通了。样本是零长度的 WAV，播完即自发暂停，
  // 所以 `paused` 为 true 是正常的，只当信息记下，不作判据。
  check("autoplay-seam-works", media?.played === "ok", media);

  const audio = await page.cdp.evaluate(
    `(async () => {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return { error: "no AudioContext" };
      const ctx = new C();
      if (ctx.state === "suspended") await ctx.resume();
      const osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      osc.start();
      const t0 = ctx.currentTime;
      await new Promise((r) => setTimeout(r, 300));
      const advanced = ctx.currentTime - t0;
      const out = { state: ctx.state, sampleRate: ctx.sampleRate, advanced };
      osc.stop();
      osc.disconnect();
      ctx.close();
      return out;
    })()`,
    { timeoutMs: 8000 }
  );
  check("audio-pipeline-alive", audio?.state === "running" && Number(audio?.advanced) > 0.1, audio);
  evidence.audio = { media, audio };

  // 4. 扩展服务工作线程：必须按 dist/manifest.json 声明的入口挑，
  //    并回读 chrome.runtime.getManifest() 证明装配的就是这份 dist。
  const worker = createWorkerSession({ pageCdp: page.cdp, browser });
  // 走 ensureAlive 而不是 connect：MV3 SW 起步阶段 target 可能刚被回收，直连会吊住；
  // 这条路会重新 attach 拿当前 target，是真机上的常态路径。
  const workerUp = await worker.ensureAlive();
  check("sw-attach", workerUp, { url: worker.handle?.url, via: worker.handle?.via });
  if (!workerUp) throw new Error("扩展服务工作线程没连上，后续步骤无从谈起");
  cdps.push(worker.handle.cdp);
  const swManifest = await worker.evaluate(
    "({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version })"
  );
  const entryMatch = worker.handle.url.endsWith(worker.handle.suffix);
  check("sw-is-this-extension", entryMatch, { url: worker.handle.url, via: worker.handle.via });
  // manifest.json 的 name 是 __MSG_appName__ 占位，chrome.runtime 给的是本地化后的文本，
  // 两者不可直接比；version 是可比的不变式。网址与 runtime.id 已证明连的就是这份 dist。
  check("sw-manifest-matches-dist", swManifest?.version === manifest.version, {
    swVersion: swManifest?.version,
    distVersion: manifest.version,
    nameLocalized: swManifest?.name
  });
  evidence.extension = { runtimeId: swManifest?.id, name: swManifest?.name, version: swManifest?.version, attachVia: worker.handle.via };

  // 5. `--disable-sync` 关的是「同步」这件事本身，不是 storage 能力：产品把设置写在
  //    chrome.storage.sync 上，这个开关一旦顺手把该 API 也弄哑，整个扩展的偏好面就废了。
  //    jsdom 里的 chrome.storage.sync 是假的，这件事只有真机说了算：写进去、读回来、清掉。
  const syncProbe = await worker.evaluate(
    `(async () => {
      const key = "__harness_sync_probe__";
      const value = "v" + Date.now();
      const out = { available: Boolean(chrome.storage && chrome.storage.sync), value, setError: null, getError: null, readBack: null };
      try { await chrome.storage.sync.set({ [key]: value }); } catch (error) { out.setError = String(error); }
      try { out.readBack = (await chrome.storage.sync.get(key))[key] ?? null; } catch (error) { out.getError = String(error); }
      try { await chrome.storage.sync.remove(key); } catch (error) { out.removeError = String(error); }
      return out;
    })()`,
    15000
  );
  check("sw-storage-sync-works", syncProbe?.available === true && syncProbe?.readBack === syncProbe?.value, syncProbe);

  // 6. 重连路径：MV3 SW 会被回收、连接会断，这不是异常路径。手动掐断连接后
  //    再求值一次，证明 createWorkerSession 的重连兜底真的接上了。
  const urlBefore = worker.handle.url;
  worker.handle.cdp.close();
  const afterReconnect = await worker.evaluate("({ id: chrome.runtime.id, alive: true })");
  const urlAfter = worker.handle.url;
  cdps.push(worker.handle.cdp);
  check("sw-reconnects", afterReconnect?.alive === true && afterReconnect.id === swManifest?.id, {
    urlBefore,
    urlAfter,
    runtimeId: afterReconnect?.id
  });

  // 7. 截图
  const shot = await screenshot(page.cdp, path.join(OUT_DIR, "smoke.png"));
  check("screenshot-written", existsSync(shot), { file: path.relative(REPO_ROOT, shot) });

  evidence.meta.ms = Date.now() - t0;
} catch (error) {
  check("no-fatal", false, { message: error.message });
  evidence.__fatal = { message: error.message, stack: String(error.stack || "").slice(0, 2000) };
} finally {
  const profileDir = browser?.profileDir;
  await teardown({ browser, cdps });
  check("profile-removed", Boolean(browser?.profileRemoved), { profileDir });
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
