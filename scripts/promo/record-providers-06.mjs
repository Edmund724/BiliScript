import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {SAMPLE_URL, click} from "./lib.mjs";
import {encodeRecording, recordScene, withIsolatedPage} from "./recorder.mjs";

export async function record() {
  return withIsolatedPage(async ({cdp, target}) => {
    await cdp.send("Page.navigate", {url: SAMPLE_URL});
    await waitFor("文摘入口", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button')`), {timeoutMs: 45000});
    await click(cdp, `document.getElementById('biliscript-script-button')`);
    await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 30000});
    await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
    await waitFor("设置抽屉", () => cdp.evaluate(`!!document.getElementById('biliscript-reading-settings-panel')?.getBoundingClientRect().width`), {timeoutMs: 10000});
    await waitFor("语言模型导航", () => cdp.evaluate(`!!document.querySelector('[data-section="llm"]')`), {timeoutMs: 10000});
    await click(cdp, `document.querySelector('[data-section="llm"]')`);
    await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
    await sleep(500);

    const events = [];
    const mark = async (name) => events.push({name, at: Date.now()});
    const recording = await recordScene(cdp, "06-ai-providers", async () => {
      await sleep(1200);
      await mark("settings-established");
      await click(cdp, `document.getElementById('addAiProviderBtn')`);
      await waitFor("添加平台弹层", () => cdp.evaluate(`document.querySelector('.provider-editor-dialog')?.getAttribute('aria-label') === '添加AI 平台'`), {timeoutMs: 10000});
      await mark("provider-editor-opened");
      await sleep(900);
      await click(cdp, `document.querySelector('.provider-editor-preset-wrapper .custom-select-trigger')`);
      await waitFor("平台预设展开", () => cdp.evaluate(`document.querySelectorAll('.provider-editor-preset-wrapper .custom-select-option').length === 15 && !document.querySelector('.provider-editor-preset-wrapper .custom-select-dropdown')?.hidden`), {timeoutMs: 10000});
      await mark("presets-expanded");
      await sleep(2800);
    }, {captureMode: "snapshot", clipToPanel: true});
    const output = await encodeRecording(recording, "ai-providers.mp4", {frameCount: 177});
    return {sourceUrl: target.url, outputs: [output], recordings: [recording.metadata], events};
  });
}
