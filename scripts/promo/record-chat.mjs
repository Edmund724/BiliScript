import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {click} from "./lib.mjs";
import {encodeRecording, recordScene, withSessionPage} from "./recorder.mjs";

async function pauseVideo(cdp) {
  await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
}

async function ensureReader(cdp) {
  await waitFor("文摘入口或已恢复面板", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button') || document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 45000});
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`))) {
    await click(cdp, `document.getElementById('biliscript-script-button')`);
  }
  await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 15000});
  await pauseVideo(cdp);
}

async function typeText(cdp, selector, text) {
  await click(cdp, `document.querySelector(${JSON.stringify(selector)})`);
  await cdp.send("Input.insertText", {text});
}

export async function record() {
  return withSessionPage(async ({cdp, target}) => {
    await cdp.send("Page.reload", {ignoreCache: false});
    await waitFor("文摘入口或已恢复面板", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button') || document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 45000});
    await ensureReader(cdp);
    if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-tab-chat')?.classList.contains('is-active')`))) {
      await click(cdp, `document.getElementById('biliscript-reading-tab-chat')`);
      await sleep(700);
    }
    if (await cdp.evaluate(`!!document.querySelector('#biliscript-reading-chat-messages .chat-msg-assistant')`)) {
      await click(cdp, `document.getElementById('biliscript-reading-chat-more-btn')`);
      await click(cdp, `document.getElementById('biliscript-reading-chat-new-btn')`);
      await sleep(800);
    }
    if (await cdp.evaluate(`document.getElementById('biliscript-reading-chat-web-search-pill')?.getAttribute('aria-pressed') === 'true'`)) {
      await click(cdp, `document.getElementById('biliscript-reading-chat-web-search-pill')`);
      await sleep(500);
    }
    if (await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('data-theme') === 'dark'`)) {
      await click(cdp, `document.getElementById('biliscript-reading-theme-select')`);
      await sleep(700);
    }
    await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
    await sleep(300);
    const recording = await recordScene(cdp, "04-chat", async () => {
      await sleep(800);
      await typeText(cdp, "#biliscript-reading-chat-input", "为什么作者认为选 AI 要看适配，而不是只看强弱？请用三个要点回答。");
      await sleep(700);
      await click(cdp, `document.getElementById('biliscript-reading-chat-send-btn')`);
      await waitFor("真实 AI 回答开始", () => cdp.evaluate(`(document.querySelector('#biliscript-reading-chat-messages .chat-msg-assistant:last-child')?.innerText || '').length > 20`), {timeoutMs: 60000, intervalMs: 300});
      await waitFor("真实 AI 回答完成", () => cdp.evaluate(`(() => {
        const text = document.querySelector('#biliscript-reading-chat-messages .chat-msg-assistant:last-child')?.innerText || '';
        const stop = document.querySelector('#biliscript-reading-chat-send-btn .chat-stop-icon');
        return text.length > 100 && stop && getComputedStyle(stop).display === 'none';
      })()`), {timeoutMs: 180000, intervalMs: 500});
      await sleep(3000);
      const timestamp = `document.querySelector('#biliscript-reading-chat-messages .chat-msg-assistant:last-child .chat-timestamp-link')`;
      if (await cdp.evaluate(`!!${timestamp}`)) {
        await waitFor("聊天记录时间戳可点击", async () => {
          await click(cdp, timestamp);
          return true;
        }, {timeoutMs: 10000, intervalMs: 200});
        await sleep(1500);
        await pauseVideo(cdp);
      }
    }, {captureMode: "snapshot", clipToPanel: true});
    const output = await encodeRecording(recording, "chat.mp4", {frameCount: 450});
    return {sourceUrl: target.url, outputs: [output], recordings: [recording.metadata]};
  });
}
