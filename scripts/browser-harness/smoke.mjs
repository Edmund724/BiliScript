#!/usr/bin/env node

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
  const edgePath = resolveEdgePath();
  check("edge-found", existsSync(edgePath), { edgePath });

  const manifest = readDistManifest();
  check("dist-built", Boolean(manifest), { manifestPath: path.join(DEFAULT_DIST, "manifest.json") });
  if (!manifest) throw new Error("dist 未构建，先跑 pnpm build");

  browser = await launchBrowser({ headless: !headed, autoplay: true });
  check("devtools-up", Boolean(browser.version?.Browser), { browser: browser.version?.Browser, port: browser.port });
  evidence.meta.browser = browser.version?.Browser;
  evidence.meta.port = browser.port;
  evidence.meta.browserPid = browser.pid;
  check("mute-flag-present", browser.args.includes("--mute-audio"), { muted: browser.muted });
  check("sync-flag-present", browser.args.includes("--disable-sync"), { sync: browser.sync });

  const page = await attachPage(browser);
  cdps.push(page.cdp);
  check("page-attached", Boolean(page.target?.url !== undefined), { url: page.target.url });
  const ua = await page.cdp.evaluate("navigator.userAgent");
  const readyState = await page.cdp.evaluate("document.readyState");
  check("page-eval", typeof ua === "string" && ua.includes("Edg/"), { ua, readyState });
  evidence.page = { url: await page.cdp.evaluate("location.href"), readyState, ua };

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

  const worker = createWorkerSession({ pageCdp: page.cdp, browser });
  const workerUp = await worker.ensureAlive();
  check("sw-attach", workerUp, { url: worker.handle?.url, via: worker.handle?.via });
  if (!workerUp) throw new Error("扩展服务工作线程没连上，后续步骤无从谈起");
  cdps.push(worker.handle.cdp);
  const swManifest = await worker.evaluate(
    "({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version })"
  );
  const entryMatch = worker.handle.url.endsWith(worker.handle.suffix);
  check("sw-is-this-extension", entryMatch, { url: worker.handle.url, via: worker.handle.via });
  check("sw-manifest-matches-dist", swManifest?.version === manifest.version, {
    swVersion: swManifest?.version,
    distVersion: manifest.version,
    nameLocalized: swManifest?.name
  });
  evidence.extension = { runtimeId: swManifest?.id, name: swManifest?.name, version: swManifest?.version, attachVia: worker.handle.via };

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
