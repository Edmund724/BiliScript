import { sleep, waitFor } from "../browser-harness/harness.mjs";
import { readSession, connectPage, click } from "./lib.mjs";
import { recordScene } from "./recorder.mjs";

async function pauseVideo(cdp) {
  await cdp.evaluate(`document.querySelectorAll('video,audio').forEach(media => { try { media.pause(); } catch {} }); true`);
}

async function ensureReader(cdp) {
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`))) {
    await waitFor("文摘按钮", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button')`), { timeoutMs: 30000 });
    await click(cdp, `document.getElementById('biliscript-script-button')`);
  }
  await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), { timeoutMs: 15000 });
  await pauseVideo(cdp);
}

async function activateTab(cdp, tab) {
  await click(cdp, `document.getElementById('biliscript-reading-tab-${tab}')`);
  await sleep(700);
}

async function typeText(cdp, selector, text) {
  await click(cdp, `document.querySelector(${JSON.stringify(selector)})`);
  await cdp.send("Input.insertText", { text });
}

async function recordIntro(cdp) {
  await cdp.evaluate(`scrollTo({ top: 0, behavior: 'instant' }); true`);
  if (await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`)) {
    await click(cdp, `document.getElementById('biliscript-reading-close-btn')`);
    await sleep(800);
  }
  await recordScene(cdp, "01-intro", async () => {
    await sleep(1000);
    await ensureReader(cdp);
    await waitFor("字幕上屏", () => cdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length >= 8`), { timeoutMs: 45000 });
    await sleep(2500);
  });
}

async function recordSubtitle(cdp) {
  await ensureReader(cdp);
  await activateTab(cdp, "subtitle");
  await recordScene(cdp, "02-subtitle", async () => {
    await sleep(1000);
    await typeText(cdp, "#biliscript-reading-search-input", "适配");
    await sleep(1800);
    const timestamp = `document.querySelector('#biliscript-reading-subtitle .biliscript-reading-item [data-seconds], #biliscript-reading-subtitle .biliscript-reading-item .biliscript-reading-time')`;
    await click(cdp, timestamp);
    await sleep(1500);
    await pauseVideo(cdp);
    await cdp.evaluate(`(() => { const input = document.getElementById('biliscript-reading-search-input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(1200);
  });
}

async function recordOverview(cdp) {
  await ensureReader(cdp);
  await activateTab(cdp, "overview");
  await recordScene(cdp, "03-overview", async () => {
    await waitFor("真实 AI 概览", () => cdp.evaluate(`document.querySelectorAll('#biliscript-reading-overview-body .biliscript-reading-ov-chapter').length > 0 && document.querySelectorAll('#biliscript-reading-overview-body [data-overview-action="share-quote"]').length > 0`), { timeoutMs: 180000, intervalMs: 500 });
    await sleep(1800);
    await click(cdp, `document.querySelector('#biliscript-reading-overview-body [data-overview-action="share-quote"]')`);
    await waitFor("金句分享卡片", () => cdp.evaluate(`!!document.querySelector('.biliscript-quote-share-host')`), { timeoutMs: 10000 });
    await sleep(2500);
    await click(cdp, `document.querySelector('.biliscript-quote-share-close')`);
    await sleep(800);
  });
}

async function recordChat(cdp) {
  await ensureReader(cdp);
  await activateTab(cdp, "chat");
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
  await recordScene(cdp, "04-chat", async () => {
    await sleep(800);
    await typeText(cdp, "#biliscript-reading-chat-input", "为什么作者认为选 AI 要看适配，而不是只看强弱？请用三个要点回答。");
    await sleep(700);
    await click(cdp, `document.getElementById('biliscript-reading-chat-send-btn')`);
    await waitFor("真实 AI 回答开始", () => cdp.evaluate(`(document.querySelector('#biliscript-reading-chat-messages .chat-msg-assistant:last-child')?.innerText || '').length > 20`), { timeoutMs: 60000, intervalMs: 300 });
    await waitFor("真实 AI 回答完成", () => cdp.evaluate(`(() => {
      const text = document.querySelector('#biliscript-reading-chat-messages .chat-msg-assistant:last-child')?.innerText || '';
      const stop = document.querySelector('#biliscript-reading-chat-send-btn .chat-stop-icon');
      return text.length > 100 && stop && getComputedStyle(stop).display === 'none';
    })()`), { timeoutMs: 180000, intervalMs: 500 });
    await sleep(3000);
    const timestamp = `document.querySelector('#biliscript-reading-chat-messages .chat-msg-assistant:last-child .chat-timestamp-link')`;
    const hasTimestamp = await cdp.evaluate(`!!${timestamp}`);
    if (hasTimestamp) {
      await click(cdp, timestamp);
      await sleep(1500);
      await pauseVideo(cdp);
    }
  }, {captureMode: "snapshot", clipToPanel: true});
}

async function recordAppearance(cdp) {
  await ensureReader(cdp);
  await activateTab(cdp, "overview");
  await recordScene(cdp, "05-appearance", async () => {
    await click(cdp, `document.getElementById('biliscript-reading-theme-select')`);
    await sleep(1500);
    await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
    await sleep(700);
    await cdp.evaluate(`(() => { const select = document.getElementById('readerPalette'); if (!select) return false; select.value = 'editorial'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(1500);
    await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
    await sleep(1200);
    await click(cdp, `document.getElementById('biliscript-reading-theme-select')`);
    await sleep(1500);
  });
}

const scene = process.argv[2];
const session = await readSession();
const { cdp } = await connectPage(session);
try {
  if (scene === "intro") await recordIntro(cdp);
  else if (scene === "subtitle") await recordSubtitle(cdp);
  else if (scene === "overview") await recordOverview(cdp);
  else if (scene === "chat") await recordChat(cdp);
  else if (scene === "appearance") await recordAppearance(cdp);
  else throw new Error("用法：node scripts/promo/record.mjs <intro|subtitle|overview|chat|appearance>");
} finally {
  cdp.close();
}
