import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {assertPromoCaptureClean, preparePromoCapture} from "./capture.mjs";
import {click} from "./lib.mjs";
import {encodeRecording, exportRecordingFrame, recordScene, withSessionPage} from "./recorder.mjs";

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

export async function record() {
  return withSessionPage(async ({cdp, target}) => {
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
    const recording = await recordScene(cdp, "00-hero-hook", async () => {
      const startedAt = Date.now();
      await sleep(1200);
      await click(cdp, "document.getElementById('biliscript-script-button')");
      await waitFor("文摘面板展开", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 15000});
      const remaining = 4300 - (Date.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    }, {captureScale: 1, quality: 95, prepareCapture: prepareHeroCapture});
    const output = await encodeRecording(recording, "hero-hook.mp4", {frameCount: 120, preset: "medium", crf: 17});
    const panel = await exportRecordingFrame(recording, "hero-panel.png", {at: 3.8});
    return {sourceUrl: target.url, outputs: [output, panel], recordings: [recording.metadata]};
  });
}
