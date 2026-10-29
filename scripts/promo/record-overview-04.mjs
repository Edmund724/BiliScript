import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {click} from "./lib.mjs";
import {restoreRealOverview} from "./fixtures.mjs";
import {exportRecordingFrame, recordScene, withSessionPage} from "./recorder.mjs";

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
      await sleep(600);
    });
    const output = await exportRecordingFrame(chapters, "overview-poster.jpg");
    return {sourceUrl: target.url, outputs: [output], recordings: [chapters.metadata]};
  });
}
