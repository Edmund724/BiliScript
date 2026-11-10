#!/usr/bin/env node

import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  REPO_ROOT,
  artifactDir,
  attachPage,
  log,
  waitFor,
  watchPage,
  withBrowser,
  writeEvidence
} from "../harness.mjs";

const NAME = "hidden-video-seek-probe";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const fixture = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "hidden-video-seek-probe.json"), "utf8"));
const headed = process.argv.includes("--headed");
const evidence = { checks: [], samples: [], network: [], console: [] };

function check(name, ok, detail = null) {
  evidence.checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)?.slice(0, 500) || ""}`);
}

function publicUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(raw || "").slice(0, 300);
  }
}

function isProbeNetworkUrl(raw) {
  try {
    const pathname = new URL(raw).pathname;
    return pathname.endsWith("/x/player/playurl") || pathname.endsWith(".mp4");
  } catch {
    return false;
  }
}

async function savePng(label, kind, dataUrl) {
  if (!dataUrl?.startsWith("data:image/png;base64,")) return null;
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  if (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  const file = path.join(OUT_DIR, `${label}-${kind}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  log(`截帧 ${path.relative(REPO_ROOT, file)}`);
  return { file: path.relative(REPO_ROOT, file), bytes: bytes.length };
}

async function probe(page, sample) {
  return page.cdp.evaluate(`(async () => {
    const sample = ${JSON.stringify(sample)};
    const player = document.querySelector("video");
    if (!player) throw new Error("页面没有 video 元素");
    const mediaEvents = [];
    const playerSeekEvents = [];
    const onPlayerSeeking = () => playerSeekEvents.push({ currentTime: player.currentTime, at: performance.now() });
    player.addEventListener("seeking", onPlayerSeeking);
    const snapshot = () => ({
      currentTime: player.currentTime,
      paused: player.paused,
      muted: player.muted,
      volume: player.volume,
      playbackRate: player.playbackRate,
      readyState: player.readyState
    });
    const capture = (media) => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const scale = Math.min(canvas.width / media.videoWidth, canvas.height / media.videoHeight);
      const width = media.videoWidth * scale;
      const height = media.videoHeight * scale;
      const context = canvas.getContext("2d");
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(media, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      return canvas.toDataURL("image/png");
    };
    let hidden = null;
    let result = null;
    let pageFrame = null;
    let pageFrameError = null;
    try {
      pageFrame = capture(player);
    } catch (error) {
      pageFrameError = { name: error.name, message: error.message };
    }
    const before = snapshot();
    const startedAt = performance.now();
    try {
      const api = new URL("https://api.bilibili.com/x/player/playurl");
      api.search = new URLSearchParams({
        bvid: sample.bvid,
        cid: sample.cid,
        fnval: "16",
        high_quality: "1",
        platform: "html5"
      });
      const response = await fetch(api, { credentials: "include" });
      const payload = await response.json();
      if (!response.ok || payload.code !== 0) {
        throw new Error("playurl 失败：HTTP " + response.status + "，code=" + payload.code + "，" + (payload.message || ""));
      }
      const source = payload.data?.durl?.[0]?.url;
      if (!source) {
        throw new Error("playurl 没有 durl MP4；可用字段=" + Object.keys(payload.data || {}).join(","));
      }
      const sourceUrl = new URL(source);
      hidden = document.createElement("video");
      hidden.crossOrigin = "anonymous";
      hidden.muted = true;
      hidden.defaultMuted = true;
      hidden.preload = "auto";
      hidden.playsInline = true;
      hidden.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;visibility:hidden";
      for (const type of ["loadedmetadata", "canplay", "seeking", "seeked", "stalled", "suspend", "abort", "emptied", "error"]) {
        hidden.addEventListener(type, () => mediaEvents.push({
          type,
          currentTime: hidden.currentTime,
          readyState: hidden.readyState,
          networkState: hidden.networkState,
          at: performance.now()
        }));
      }
      const waitMedia = (type, predicate, timeoutMs) => {
        if (predicate()) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanupWait();
            reject(new Error("等待 " + type + " 超时；readyState=" + hidden.readyState + "，networkState=" + hidden.networkState));
          }, timeoutMs);
          const onReady = () => { if (predicate()) { cleanupWait(); resolve(); } };
          const onError = () => {
            cleanupWait();
            const mediaError = hidden.error;
            reject(new Error("隐藏视频 " + type + " 失败：" + (mediaError ? mediaError.code + " " + mediaError.message : "未知媒体错误")));
          };
          const cleanupWait = () => {
            clearTimeout(timer);
            hidden.removeEventListener(type, onReady);
            hidden.removeEventListener("canplay", onReady);
            hidden.removeEventListener("error", onError);
          };
          hidden.addEventListener(type, onReady);
          hidden.addEventListener("canplay", onReady);
          hidden.addEventListener("error", onError);
        });
      };
      hidden.src = source;
      document.body.appendChild(hidden);
      await waitMedia("loadedmetadata", () => hidden.readyState >= 1, 45000);
      await waitMedia("canplay", () => hidden.readyState >= 2, 45000);
      const firstFrame = capture(hidden);
      const seekStartedAt = performance.now();
      const seeked = waitMedia("seeked", () => Math.abs(hidden.currentTime - sample.targetTime) < 0.15 && hidden.readyState >= 2, 60000);
      hidden.currentTime = sample.targetTime;
      await seeked;
      const targetFrame = capture(hidden);
      result = {
        ok: true,
        stage: "direct-media-probe",
        source: {
          pageOrigin: location.origin,
          mediaOrigin: sourceUrl.origin,
          mediaPath: sourceUrl.pathname,
          crossOrigin: hidden.crossOrigin,
          api: api.origin + api.pathname,
          duration: hidden.duration,
          videoWidth: hidden.videoWidth,
          videoHeight: hidden.videoHeight
        },
        actualTime: hidden.currentTime,
        targetFrame,
        firstFrame,
        seekMilliseconds: performance.now() - seekStartedAt
      };
    } catch (error) {
      result = {
        ok: false,
        stage: "direct-media-probe",
        error: { name: error.name, message: error.message },
        mediaError: hidden?.error ? { code: hidden.error.code, message: hidden.error.message } : null,
        hiddenState: hidden ? {
          currentTime: hidden.currentTime,
          duration: hidden.duration,
          readyState: hidden.readyState,
          networkState: hidden.networkState,
          videoWidth: hidden.videoWidth,
          videoHeight: hidden.videoHeight
        } : null
      };
    }
    const after = snapshot();
    if (hidden) {
      hidden.pause();
      hidden.removeAttribute("src");
      hidden.load();
      hidden.remove();
    }
    player.removeEventListener("seeking", onPlayerSeeking);
    result.player = { before, after, elapsedSeconds: (performance.now() - startedAt) / 1000, seekEvents: playerSeekEvents };
    result.pageFrame = pageFrame;
    result.pageFrameError = pageFrameError;
    result.mediaEvents = mediaEvents;
    result.cleanup = { hiddenRemoved: !hidden || !hidden.isConnected, hiddenSourceRemoved: !hidden || !hidden.getAttribute("src") };
    return result;
  })()`, { timeoutMs: 150000 });
}

async function runSample(page, sample) {
  const url = `https://www.bilibili.com/video/${sample.bvid}/?p=1`;
  log(`验证 ${sample.label}：${sample.bvid} @ ${sample.targetTime}s`);
  let result;
  let stage = "page-setup";
  try {
    await page.cdp.send("Page.navigate", { url });
    await waitFor(`${sample.label} 页面视频元数据`, () => page.cdp.evaluate("document.querySelector('video')?.readyState >= 1"), { timeoutMs: 60000, intervalMs: 300 });
    await page.cdp.evaluate("document.querySelector('video').play()");
    await waitFor(`${sample.label} 页面播放中`, () => page.cdp.evaluate("document.querySelector('video') && !document.querySelector('video').paused"), { timeoutMs: 15000, intervalMs: 200 });
    stage = "direct-media-probe";
    result = await probe(page, sample);
  } catch (error) {
    result = { ok: false, stage, error: { name: error.name, message: error.message } };
  }
  const record = {
    input: sample,
    url,
    result: { ...result, targetFrame: undefined, firstFrame: undefined, pageFrame: undefined }
  };
  evidence.samples.push(record);

  try {
    if (result.ok) {
      record.artifacts = {
        target: await savePng(sample.label, `target-${sample.targetTime}`, result.targetFrame),
        first: await savePng(sample.label, "first", result.firstFrame),
        pageCurrent: await savePng(sample.label, "page-current", result.pageFrame)
      };
    }
    check(`${sample.label}-直接媒体加载与画布导出`, result.ok && Boolean(record.artifacts?.target), result.ok ? result.source : result.error);
    if (result.ok) {
      check(`${sample.label}-实际 seek 到目标时间`, Math.abs(result.actualTime - sample.targetTime) <= 0.15, { target: sample.targetTime, actual: result.actualTime });
      check(`${sample.label}-媒体时长匹配输入视频`, Math.abs(result.source.duration - sample.duration) <= 1, { expected: sample.duration, actual: result.source.duration });
      check(`${sample.label}-目标帧不是隐藏视频首帧`, result.targetFrame !== result.firstFrame, { seekMilliseconds: result.seekMilliseconds });
      check(`${sample.label}-目标帧不是页面当前帧`, Boolean(result.pageFrame) && result.targetFrame !== result.pageFrame, { pageFrameError: result.pageFrameError });
      check(`${sample.label}-截图非空`, (record.artifacts.target?.bytes || 0) > 1000, record.artifacts.target);
    }
    const sampleNetwork = evidence.network.filter((entry) => entry.sample === sample.label);
    const playurlResponses = sampleNetwork.filter((entry) => entry.phase === "response" && entry.url.endsWith("/x/player/playurl"));
    const mediaUrl = result.source ? `${result.source.mediaOrigin}${result.source.mediaPath}` : null;
    const mediaResponses = sampleNetwork.filter((entry) => entry.phase === "response" && entry.url === mediaUrl);
    check(`${sample.label}-playurl 网络证据`, playurlResponses.some((entry) => entry.status === 200), playurlResponses);
    check(
      `${sample.label}-直接媒体跨域与防盗链网络证据`,
      mediaResponses.some((entry) => [200, 206].includes(entry.status) && ["*", "https://www.bilibili.com"].includes(entry.accessControlAllowOrigin)),
      mediaResponses
    );
    const player = result.player;
    check(
      `${sample.label}-页面播放与声音状态不变`,
      Boolean(player) && player.before.paused === false && player.after.paused === false &&
        player.before.muted === player.after.muted && player.before.volume === player.after.volume &&
        player.before.playbackRate === player.after.playbackRate,
      player || null
    );
    const expectedAdvance = player ? player.elapsedSeconds * player.before.playbackRate : Infinity;
    const actualAdvance = player ? player.after.currentTime - player.before.currentTime : NaN;
    check(
      `${sample.label}-页面播放位置未被 seek`,
      Boolean(player) && player.seekEvents.length === 0 && actualAdvance >= -0.1 && actualAdvance <= expectedAdvance + 1.5,
      player ? { actualAdvance, expectedAdvance, seekEvents: player.seekEvents } : null
    );
    check(`${sample.label}-隐藏媒体已清理`, Boolean(result.cleanup?.hiddenRemoved && result.cleanup?.hiddenSourceRemoved), result.cleanup || null);
  } finally {
    await page.cdp.evaluate("document.querySelectorAll('video,audio').forEach((media) => { media.pause(); media.removeAttribute('src'); media.load(); media.remove(); })").catch(() => {});
  }
}

if (!Array.isArray(fixture.samples) || fixture.samples.length < 2 || fixture.samples.some((sample) =>
  !sample.label || !sample.bvid || !sample.cid || !(sample.targetTime > 0) || !(sample.targetTime < sample.duration)
)) {
  throw new Error("hidden-video-seek-probe fixture 必须包含普通视频与长视频的有效目标时间点");
}

try {
  await withBrowser({ autoplay: true, headless: !headed }, async ({ browser }) => {
    const page = await attachPage(browser);
    const watched = watchPage(page.cdp);
    const requestUrls = new Map();
    let activeLabel = "setup";
    page.cdp.on("Network.requestWillBeSent", (params) => {
      const url = params.request?.url || "";
      requestUrls.set(params.requestId, url);
      if (isProbeNetworkUrl(url)) {
        evidence.network.push({ sample: activeLabel, phase: "request", url: publicUrl(url) });
      }
    });
    page.cdp.on("Network.responseReceived", (params) => {
      const url = params.response?.url || "";
      if (!isProbeNetworkUrl(url)) return;
      const headers = params.response.headers || {};
      const header = (name) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] || null;
      evidence.network.push({
        sample: activeLabel,
        phase: "response",
        url: publicUrl(url),
        status: params.response.status,
        mimeType: params.response.mimeType,
        accessControlAllowOrigin: header("access-control-allow-origin"),
        acceptRanges: header("accept-ranges"),
        contentRange: header("content-range")
      });
    });
    page.cdp.on("Network.loadingFailed", (params) => {
      const url = requestUrls.get(params.requestId) || "";
      if (isProbeNetworkUrl(url)) {
        evidence.network.push({ sample: activeLabel, phase: "failed", url: publicUrl(url), errorText: params.errorText, blockedReason: params.blockedReason || null });
      }
    });
    for (const sample of fixture.samples) {
      activeLabel = sample.label;
      await runSample(page, sample);
    }
    activeLabel = "teardown";
    evidence.console = watched.consoleLog.filter((entry) => /CORS|Access-Control|media|video|ERR_/i.test(entry.text)).slice(-100);
  });
} catch (error) {
  check("场景无致命错误", false, { message: error.message, stack: String(error.stack || "").slice(0, 1200) });
}

const allProbesReachedMedia = evidence.samples.length === fixture.samples.length &&
  evidence.samples.every((sample) => sample.result.stage === "direct-media-probe");
const directSuccess = allProbesReachedMedia && evidence.samples.every((sample) =>
  sample.result.ok && Math.abs(sample.result.actualTime - sample.input.targetTime) <= 0.15
);
evidence.conclusion = directSuccess ? {
  approach: "direct-media-loading",
  directMediaLoadingSufficient: true,
  rangeMediaSourceRequired: false,
  summary: "普通视频与长视频均可通过 playurl 的 durl MP4 在独立隐藏视频中 seek，并以 crossOrigin=anonymous 导出目标帧；后续实现无需 Range + MediaSource。"
} : allProbesReachedMedia ? {
  approach: "range-plus-mediasource",
  directMediaLoadingSufficient: false,
  rangeMediaSourceRequired: true,
  summary: "普通视频与长视频都已进入直接媒体探针，但至少一个样本未形成目标时间点的可导出帧；后续不能把直接加载当作已验证能力。",
  cost: "Range + MediaSource 需要自行按范围拉取与缓冲分片、维护 SourceBuffer 和 seek 窗口，并处理编码初始化段、分片边界、重试及清理；实现与验证成本显著高于直接媒体加载。"
} : {
  approach: "inconclusive",
  directMediaLoadingSufficient: null,
  rangeMediaSourceRequired: null,
  summary: "至少一个样本未进入直接媒体探针；页面准备或浏览器失败不能作为 Range + MediaSource 必要性的证据。"
};
evidence.failed = evidence.checks.filter((entry) => !entry.ok).map((entry) => entry.name);
await writeEvidence(OUT_DIR, evidence);
if (evidence.failed.length) process.exitCode = 1;
