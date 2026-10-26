import path from "node:path";
import {mkdir} from "node:fs/promises";
import {screenshot, waitFor} from "../browser-harness/harness.mjs";
import {preparePromoCapture} from "./capture.mjs";
import {PROMO_DIR, connectPage, readSession} from "./lib.mjs";

const session = await readSession();
const {cdp, target} = await connectPage(session);
try {
  await waitFor("B 站视频元数据就绪", () => cdp.evaluate("document.readyState === 'complete' && (document.querySelector('video')?.readyState || 0) >= 1 && !!document.querySelector('video')?.videoWidth"), {timeoutMs: 45000});
  await cdp.evaluate("(() => { const video = document.querySelector('video'); if (video) video.currentTime = Math.min(5, Math.max(0, (video.duration || 6) - 1)); return true; })()");
  await waitFor("B 站真实视频帧就绪", () => cdp.evaluate("(document.querySelector('video')?.readyState || 0) >= 2"), {timeoutMs: 30000});
  await cdp.evaluate("document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); scrollTo({top: 0, behavior: 'instant'}); true");
  await preparePromoCapture(cdp);
  const directory = path.join(PROMO_DIR, "evidence");
  await mkdir(directory, {recursive: true});
  const topOutput = path.join(directory, "capture-clean.png");
  await screenshot(cdp, topOutput);
  await cdp.evaluate("scrollTo({top: 900, behavior: 'instant'}); new Promise((resolve) => setTimeout(() => resolve(true), 1200))");
  await preparePromoCapture(cdp);
  const scrolledOutput = path.join(directory, "capture-clean-scrolled.png");
  await screenshot(cdp, scrolledOutput);
  console.log(`干净录制画面已输出：${topOutput}\n${scrolledOutput}\n${target.url}`);
} finally {
  await cdp.evaluate("document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true").catch(() => {});
  cdp.close();
}
