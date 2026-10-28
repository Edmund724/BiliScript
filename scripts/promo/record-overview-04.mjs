import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {click} from "./lib.mjs";
import {restoreRealOverview} from "./fixtures.mjs";
import {encodeRecording, exportRecordingFrame, recordScene, withSessionPage} from "./recorder.mjs";

async function ensureReader(cdp) {
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`))) {
    await click(cdp, `document.getElementById('biliscript-script-button')`);
  }
  await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 30000});
  await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
}

export async function record() {
  return withSessionPage(async ({cdp, target}) => {
    await ensureReader(cdp);
    await restoreRealOverview(cdp, target, {generatedFor: "promo-recut-04"});
    const chapters = await recordScene(cdp, "04-overview-chapters", async () => {
      await cdp.evaluate(`document.getElementById('biliscript-reading-overview-body').scrollTop = 0; true`);
      await sleep(5100);
    });
    await cdp.evaluate(`document.querySelector('#biliscript-reading-overview-body .biliscript-reading-ov-quote').scrollIntoView({block: 'center', behavior: 'instant'}); true`);
    await sleep(500);
    const quote = await recordScene(cdp, "04-overview-quote", async () => {
      await sleep(900);
      await click(cdp, `document.querySelector('#biliscript-reading-overview-body [data-overview-action="share-quote"]')`);
      await waitFor("分享金句卡片", () => cdp.evaluate(`!!document.querySelector('.biliscript-quote-share-host')`), {timeoutMs: 10000});
      await sleep(900);
      await click(cdp, `document.querySelector('.biliscript-quote-share-host [data-preset="slate-brown"]')`);
      await sleep(1000);
      await click(cdp, `document.querySelector('.biliscript-quote-share-host [data-preset="mist-deep-sea"]')`);
      await sleep(1200);
    });
    await cdp.evaluate(`document.querySelector('.biliscript-quote-share-close')?.click(); true`);
    const outputs = await Promise.all([
      encodeRecording(chapters, "overview-04-chapters.mp4", {frameCount: 168}),
      encodeRecording(quote, "overview-04-quote.mp4", {frameCount: 142})
    ]);
    outputs.push(await exportRecordingFrame(chapters, "overview-poster.jpg"));
    return {sourceUrl: target.url, outputs, recordings: [chapters.metadata, quote.metadata]};
  });
}
