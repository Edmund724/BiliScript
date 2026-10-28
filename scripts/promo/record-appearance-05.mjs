import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {click} from "./lib.mjs";
import {restoreRealOverview} from "./fixtures.mjs";
import {encodeRecording, recordScene, withSessionPage} from "./recorder.mjs";

async function appearanceState(cdp) {
  return cdp.evaluate(`(() => {
    const reader = document.getElementById('biliscript-reading-view');
    const palette = document.getElementById('readerPalette');
    const wrapper = palette?.closest('.custom-select-wrapper');
    const visibleLabel = wrapper?.querySelector('.custom-select-value')?.textContent?.trim() || '';
    return {
      mode: reader?.getAttribute('data-theme') || document.documentElement.getAttribute('data-biliscript-reader-mode'),
      palette: reader?.getAttribute('data-palette') || palette?.value,
      paletteLabel: visibleLabel || palette?.selectedOptions[0]?.textContent || '',
      settingsOpen: !!document.getElementById('biliscript-reading-settings-panel')?.getBoundingClientRect().width
    };
  })()`);
}

async function ensureReader(cdp, target) {
  await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`))) {
    await click(cdp, `document.getElementById('biliscript-script-button')`);
  }
  await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 30000});
  if ((await appearanceState(cdp)).settingsOpen) {
    await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
    await sleep(300);
  }
  await restoreRealOverview(cdp, target, {generatedFor: "promo-recut-05", chapterCount: 3, quoteCount: 1});
  await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
}

async function setPalette(cdp, value) {
  const current = (await appearanceState(cdp)).palette;
  if (current === value) return;
  await click(cdp, `document.getElementById('readerPalette')?.closest('.custom-select-wrapper')?.querySelector('.custom-select-trigger')`);
  await waitFor("色板下拉展开", () => cdp.evaluate(`!document.getElementById('readerPalette')?.closest('.custom-select-wrapper')?.querySelector('.custom-select-dropdown')?.hidden`), {timeoutMs: 5000});
  await sleep(160);
  await click(cdp, `document.getElementById('readerPalette')?.closest('.custom-select-wrapper')?.querySelector('.custom-select-option[data-value=${JSON.stringify(value)}]')`);
  await waitFor("真实色板切换", async () => {
    const state = await appearanceState(cdp);
    return state.palette === value && state.paletteLabel.length > 0;
  }, {timeoutMs: 10000});
  await sleep(300);
}

export async function record() {
  return withSessionPage(async ({cdp, target}) => {
    await cdp.send("Page.reload", {ignoreCache: false});
    await sleep(1000);
    await waitFor("文摘入口或已恢复面板", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button') || document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 45000});
    await ensureReader(cdp, target);
    const initial = await appearanceState(cdp);
    if (initial.mode === "dark") await click(cdp, `document.getElementById('biliscript-reading-theme-select')`);
    if (!(await appearanceState(cdp)).settingsOpen) {
      await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
    }
    await waitFor("外观设置导航", () => cdp.evaluate(`!!document.querySelector('[data-section="appearance"]')`), {timeoutMs: 10000});
    await click(cdp, `document.querySelector('[data-section="appearance"]')`);
    await sleep(500);
    await setPalette(cdp, "flyme");
    await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);

    const events = [];
    const mark = async (name) => events.push({name, at: Date.now(), state: await appearanceState(cdp)});
    const recording = await recordScene(cdp, "05-appearance-motion", async () => {
      await sleep(900);
      await mark("light-ready");
      await click(cdp, `document.getElementById('biliscript-reading-theme-select')`);
      await waitFor("深色模式生效", async () => (await appearanceState(cdp)).mode === "dark", {timeoutMs: 10000});
      await mark("dark-ready");
      await sleep(1400);
      await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
      await sleep(300);
      await click(cdp, `document.querySelector('[data-section="appearance"]')`);
      await sleep(300);
      await mark("palette-settings-open");
      await setPalette(cdp, "editorial");
      await mark("editorial-ready");
      await sleep(1400);
      await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
      await sleep(1600);
      await mark("editorial-panel");
    }, {captureMode: "snapshot", clipToPanel: true});
    const output = await encodeRecording(recording, "appearance.mp4", {frameCount: 180});
    return {sourceUrl: target.url, outputs: [output], recordings: [recording.metadata], events};
  });
}
