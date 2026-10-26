import path from "node:path";
import {execFile} from "node:child_process";
import {copyFile, mkdir, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {assertPromoCaptureClean, preparePromoCapture} from "./capture.mjs";
import {PROMO_DIR, connectPage, readSession, click} from "./lib.mjs";

const execFileAsync = promisify(execFile);
const FRAME_DIR = path.join(PROMO_DIR, "frames", "00-hero-hook");
const OUTPUT = path.join(PROMO_DIR, "clips", "00-hero-hook.mp4");
const PANEL_SOURCE = path.join(PROMO_DIR, "clips", "01-intro.mp4");
const PUBLIC_DIR = path.join(PROMO_DIR, "public", "media");
const PUBLIC_OUTPUT = path.join(PUBLIC_DIR, "hero-hook.mp4");
const PUBLIC_PANEL = path.join(PUBLIC_DIR, "hero-panel.png");
const ROOT_DIR = path.dirname(path.dirname(PROMO_DIR));
const runFfmpeg = (args) => execFileAsync(process.execPath, [path.join(ROOT_DIR, "node_modules", "@remotion", "cli", "remotion-cli.js"), "ffmpeg", ...args], {cwd: ROOT_DIR});

async function prepareHeroCapture(cdp) {
  await preparePromoCapture(cdp);
  await cdp.evaluate(`(() => {
    let style = document.getElementById('biliscript-hero-capture-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'biliscript-hero-capture-style';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = [
      '[class*="avatar"] { visibility: hidden !important; }',
      '#right-container, .right-container { visibility: hidden !important; }'
    ].join('\\n');
    return true;
  })()`);
  await cdp.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const unclean = await cdp.evaluate(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
    };
    return [...document.querySelectorAll('[class*="avatar"], #right-container, .right-container')]
      .filter((element) => !element.closest('#biliscript-reading-view') && visible(element))
      .map((element) => element.id || element.className || element.tagName)
      .slice(0, 12);
  })()`);
  if (unclean.length) throw new Error(`片头画面仍有头像或推荐栏：${JSON.stringify(unclean)}`);
  await assertPromoCaptureClean(cdp);
}

const session = await readSession();
const {cdp} = await connectPage(session);
const frames = [];
let writes = Promise.resolve();
try {
  await cdp.send("Page.bringToFront");
  await cdp.send("Emulation.setFocusEmulationEnabled", {enabled: true});
  await cdp.send("Page.setWebLifecycleState", {state: "active"});
  await waitFor("B 站真实视频帧就绪", () => cdp.evaluate(`document.readyState === 'complete' && (document.querySelector('video')?.readyState || 0) >= 2`), {timeoutMs: 45000});
  if (await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`)) {
    await click(cdp, "document.getElementById('biliscript-reading-close-btn')");
  }
  await waitFor("文摘按钮就绪", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button')`), {timeoutMs: 30000});
  await cdp.evaluate(`(() => {
    document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} });
    const video = document.querySelector('video');
    if (video) video.currentTime = Math.min(5, Math.max(0, (video.duration || 6) - 1));
    scrollTo({top: 0, behavior: 'instant'});
    return true;
  })()`);
  await prepareHeroCapture(cdp);
  await mkdir(FRAME_DIR, {recursive: true});
  await mkdir(path.dirname(OUTPUT), {recursive: true});
  await mkdir(path.dirname(PUBLIC_OUTPUT), {recursive: true});

  const startedAt = Date.now();
  cdp.on("Page.screencastFrame", (params) => {
    const index = frames.length;
    const file = path.join(FRAME_DIR, `${String(index).padStart(6, "0")}.jpg`);
    frames.push({file, at: Date.now() - startedAt});
    writes = writes.then(() => writeFile(file, Buffer.from(params.data, "base64")));
    void cdp.send("Page.screencastFrameAck", {sessionId: params.sessionId}).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1});
  await waitFor("片头录屏首帧", () => frames.length > 0, {timeoutMs: 10000, intervalMs: 50});
  await sleep(1200);
  await click(cdp, "document.getElementById('biliscript-script-button')");
  await waitFor("文摘面板展开", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 15000});
  const remaining = 4300 - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
  await assertPromoCaptureClean(cdp);
  await cdp.send("Page.stopScreencast");
  await writes;
} finally {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await cdp.evaluate("document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true").catch(() => {});
  cdp.close();
}

if (frames.length < 8) throw new Error(`片头有效帧不足：${frames.length}`);
const origin = frames[0].at;
const normalizedDir = path.join(FRAME_DIR, "normalized");
await mkdir(normalizedDir, {recursive: true});
let sourceIndex = 0;
for (let index = 0; index < 120; index += 1) {
  const at = index * 1000 / 30;
  while (sourceIndex + 1 < frames.length && frames[sourceIndex + 1].at - origin <= at) sourceIndex += 1;
  await copyFile(frames[sourceIndex].file, path.join(normalizedDir, `${String(index).padStart(6, "0")}.jpg`));
}
await writeFile(path.join(FRAME_DIR, "frames.json"), JSON.stringify({name: "00-hero-hook", origin, frames}, null, 2), "utf8");

await runFfmpeg(["-y", "-framerate", "30", "-i", path.join(normalizedDir, "%06d.jpg"), "-frames:v", "120", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", OUTPUT]);
await runFfmpeg(["-y", "-i", OUTPUT, "-c", "copy", PUBLIC_OUTPUT]);
await runFfmpeg(["-y", "-ss", "3.8", "-i", PANEL_SOURCE, "-frames:v", "1", "-update", "1", PUBLIC_PANEL]);
console.log(`片头素材已输出：${OUTPUT}\n${PUBLIC_OUTPUT}\n${PUBLIC_PANEL}\n${frames.length} 个真实截帧，30fps / 4 秒`);
