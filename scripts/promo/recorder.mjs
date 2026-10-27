import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { PROMO_DIR, VIEWPORT } from "./lib.mjs";
import { assertPromoCaptureClean, preparePromoCapture } from "./capture.mjs";

const CAPTURE_SCALE = 2;

export async function recordScene(cdp, name, action, {
  panelSelector = "#biliscript-reading-view",
  quality = 100,
  everyNthFrame = 1,
  captureMode = "screencast",
  clipToPanel = false
} = {}) {
  const directory = path.join(PROMO_DIR, "frames", name);
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  const frames = [];
  let writes = Promise.resolve();
  let active = true;
  let startedAt = 0;
  await cdp.send("Page.bringToFront");
  await cdp.send("Emulation.setDeviceMetricsOverride", {...VIEWPORT, deviceScaleFactor: CAPTURE_SCALE});
  await preparePromoCapture(cdp);
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
      await cdp.send("Page.startScreencast", {format: "jpeg", quality, maxWidth: VIEWPORT.width * CAPTURE_SCALE, maxHeight: VIEWPORT.height * CAPTURE_SCALE, everyNthFrame});
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
  const source = {width: VIEWPORT.width * CAPTURE_SCALE, height: VIEWPORT.height * CAPTURE_SCALE, scale: CAPTURE_SCALE};
  const capture = clipPanel ? {
    x: Math.round(clipPanel.x * CAPTURE_SCALE),
    y: Math.round(clipPanel.y * CAPTURE_SCALE),
    width: Math.round(clipPanel.width * CAPTURE_SCALE),
    height: Math.round(clipPanel.height * CAPTURE_SCALE)
  } : null;
  await writeFile(metadata, JSON.stringify({name, duration, source, panel, capture, frames}, null, 2), "utf8");
  console.log(`分镜 ${name}：${frames.length} 帧，${duration.toFixed(1)} 秒，${source.width}×${source.height}`);
  return {directory, manifest, metadata, duration, source, capture};
}
