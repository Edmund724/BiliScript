import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {attachPage, createWorkerSession, launchBrowser, REPO_ROOT, teardown} from "../browser-harness/harness.mjs";
import {PROMO_DIR, SAMPLE_URL, VIEWPORT, connectPage, readSession} from "./lib.mjs";
import {assertPromoCaptureClean, preparePromoCapture} from "./capture.mjs";
import {recordedMediaPath} from "./media.mjs";

const execFileAsync = promisify(execFile);
const CAPTURE_SCALE = 2;

async function runFfmpeg(args) {
  await execFileAsync("ffmpeg", args, {cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024});
}

export async function withSessionPage(action) {
  const session = await readSession();
  const {cdp, target} = await connectPage(session);
  try {
    await cdp.send("Emulation.setFocusEmulationEnabled", {enabled: true});
    await cdp.send("Page.bringToFront");
    return await action({cdp, target});
  } finally {
    await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`).catch(() => {});
    cdp.close();
  }
}

export async function withIsolatedPage(action) {
  const browser = await launchBrowser({headless: false, muted: true, sync: false, viewport: VIEWPORT, extraArgs: ["--force-device-scale-factor=2"], profilePrefix: "biliscript-promo-"});
  const page = await attachPage(browser, {viewport: VIEWPORT});
  const worker = createWorkerSession({pageCdp: page.cdp, browser});
  try {
    await worker.ensureAlive();
    return await action({cdp: page.cdp, target: {url: SAMPLE_URL}});
  } finally {
    await teardown({browser, cdps: [page.cdp, worker.handle?.cdp].filter(Boolean)});
  }
}

export async function encodeRecording(recording, outputName, {frameCount, filters = [], preset = "slow", crf = 12}) {
  const output = recordedMediaPath(outputName);
  await mkdir(path.dirname(output), {recursive: true});
  const videoFilters = [
    ...(recording.capture ? [`pad=${recording.source.width}:${recording.source.height}:${recording.capture.x}:${recording.capture.y}:black`] : []),
    ...filters,
    `tpad=stop_mode=clone:stop_duration=${(frameCount / 30).toFixed(3)}`
  ];
  await runFfmpeg([
    "-y", "-f", "concat", "-safe", "0", "-i", recording.manifest,
    "-vf", videoFilters.join(","),
    "-frames:v", String(frameCount), "-r", "30", "-c:v", "libx264",
    "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", output
  ]);
  return output;
}

export async function exportRecordingFrame(recording, outputName, {at = 0} = {}) {
  const metadata = JSON.parse(await readFile(recording.metadata, "utf8"));
  const frame = metadata.frames.reduce((nearest, candidate) => Math.abs(candidate.at / 1000 - at) < Math.abs(nearest.at / 1000 - at) ? candidate : nearest);
  const output = recordedMediaPath(outputName);
  await mkdir(path.dirname(output), {recursive: true});
  await runFfmpeg(["-y", "-i", frame.file, "-frames:v", "1", "-update", "1", output]);
  return output;
}

export async function writeRecordingEvidence(scene, {sourceUrl, outputs, recordings = [], events = []}) {
  const relative = (file) => path.relative(REPO_ROOT, file).replaceAll("\\", "/");
  const evidence = path.join(PROMO_DIR, "evidence", `${scene}.json`);
  await mkdir(path.dirname(evidence), {recursive: true});
  await writeFile(evidence, JSON.stringify({sourceUrl, outputs: outputs.map(relative), recordings: recordings.map(relative), events}, null, 2) + "\n", "utf8");
  return evidence;
}

export async function recordScene(cdp, name, action, {
  panelSelector = "#biliscript-reading-view",
  quality = 100,
  everyNthFrame = 1,
  captureMode = "screencast",
  clipToPanel = false,
  captureScale = CAPTURE_SCALE,
  prepareCapture = preparePromoCapture
} = {}) {
  const directory = path.join(PROMO_DIR, "frames", name);
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  const frames = [];
  let writes = Promise.resolve();
  let active = true;
  let startedAt = 0;
  await cdp.send("Page.bringToFront");
  await cdp.send("Emulation.setDeviceMetricsOverride", {...VIEWPORT, deviceScaleFactor: captureScale});
  await prepareCapture(cdp);
  const measurePanel = () => cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(panelSelector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  })()`);
  const clipPanel = clipToPanel ? await measurePanel() : null;
  if (clipToPanel && (!clipPanel || clipPanel.x < 0 || clipPanel.y < 0 || clipPanel.width <= 0 || clipPanel.height <= 0 || clipPanel.x + clipPanel.width > VIEWPORT.width || clipPanel.y + clipPanel.height > VIEWPORT.height)) {
    throw new Error(`分镜 ${name} 的局部截帧边界超出视口：${JSON.stringify(clipPanel)}`);
  }
  const saveFrame = (data) => {
    const index = frames.length;
    const file = path.join(directory, `${String(index).padStart(6, "0")}.jpg`);
    frames.push({file, at: Date.now() - startedAt});
    writes = writes.then(() => writeFile(file, Buffer.from(data, "base64")));
  };
  let captureLoop;
  let scrubTimer;
  startedAt = Date.now();
  if (captureMode === "snapshot") {
    captureLoop = (async () => {
      while (active) {
        const result = await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality,
          fromSurface: true,
          captureBeyondViewport: false,
          ...(clipPanel ? {clip: {...clipPanel, scale: 1}} : {})
        });
        saveFrame(result.data);
        await writes;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
  } else {
    cdp.on("Page.screencastFrame", (params) => {
      saveFrame(params.data);
      void cdp.send("Page.screencastFrameAck", {sessionId: params.sessionId}).catch(() => {});
    });
    scrubTimer = setInterval(() => {
      void cdp.evaluate("window.__biliscriptPromoScrub?.(); true").catch(() => {});
    }, 50);
  }
  let duration;
  try {
    if (captureMode === "screencast") {
      await cdp.send("Page.startScreencast", {format: "jpeg", quality, maxWidth: VIEWPORT.width * captureScale, maxHeight: VIEWPORT.height * captureScale, everyNthFrame});
    } else if (captureMode !== "snapshot") {
      throw new Error(`未知录制模式：${captureMode}`);
    }
    await action();
    await assertPromoCaptureClean(cdp);
    duration = (Date.now() - startedAt + 500) / 1000;
  } finally {
    active = false;
    if (scrubTimer) clearInterval(scrubTimer);
    if (captureMode === "screencast") await cdp.send("Page.stopScreencast").catch(() => {});
    if (captureLoop) await captureLoop;
    await writes;
  }
  if (!frames.length) throw new Error(`分镜 ${name} 没有录到画面`);
  const panel = clipPanel || await measurePanel();
  if (!panel || panel.width <= 0 || panel.height <= 0) throw new Error(`分镜 ${name} 没有有效的面板边界`);
  let concat = "ffconcat version 1.0\n";
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const frameDuration = index + 1 < frames.length
      ? Math.max(0.034, (frames[index + 1].at - frame.at) / 1000)
      : Math.max(0.034, duration - frame.at / 1000);
    concat += `file '${frame.file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'\nduration ${frameDuration.toFixed(3)}\n`;
  }
  concat += `file '${frames.at(-1).file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'\n`;
  const manifest = path.join(directory, "frames.ffconcat");
  await writeFile(manifest, concat, "utf8");
  const metadata = path.join(directory, "frames.json");
  const source = {width: VIEWPORT.width * captureScale, height: VIEWPORT.height * captureScale, scale: captureScale};
  const capture = clipPanel ? {
    x: Math.round(clipPanel.x * captureScale),
    y: Math.round(clipPanel.y * captureScale),
    width: Math.round(clipPanel.width * captureScale),
    height: Math.round(clipPanel.height * captureScale)
  } : null;
  await writeFile(metadata, JSON.stringify({name, duration, source, panel, capture, frames}, null, 2), "utf8");
  console.log(`分镜 ${name}：${frames.length} 帧，${duration.toFixed(1)} 秒，${source.width}×${source.height}`);
  return {directory, manifest, metadata, duration, source, capture};
}
