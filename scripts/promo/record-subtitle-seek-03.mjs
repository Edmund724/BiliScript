import {readFile, stat} from "node:fs/promises";
import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {click} from "./lib.mjs";
import {encodeRecording, recordScene, withSessionPage} from "./recorder.mjs";

const SCENE_NAME = "02-subtitle-seek-03";
const SEARCH_INPUT = "#biliscript-reading-search-input";
const SEARCH_NEXT = "#biliscript-reading-search-next";
const CURRENT_HIT = "#biliscript-reading-subtitle .biliscript-reading-item.search-current";
const SEARCH_QUERY = "幻觉";
const TARGET_MATCH_INDEX = 4;
const TARGET_SECONDS = 247.14;
const TARGET_TIMESTAMP = "4:07";

async function ensureReader(cdp) {
  await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`))) {
    await waitFor("文摘按钮", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button')`), {timeoutMs: 30000});
    await cdp.evaluate(`document.getElementById('biliscript-script-button').click(); true`);
  }
  await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 15000});
  await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.classList.add('open'); true`);
  await sleep(300);
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-tab-subtitle')?.classList.contains('is-active')`))) {
    await click(cdp, `document.getElementById('biliscript-reading-tab-subtitle')`);
  }
  await waitFor("真实字幕", () => cdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length >= 8`), {timeoutMs: 90000});
  await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
}

async function setSearch(cdp, text) {
  await cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(SEARCH_INPUT)});
    input.value = '';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);
  if (!text) return;
  await click(cdp, `document.querySelector(${JSON.stringify(SEARCH_INPUT)})`);
  await cdp.evaluate(`document.querySelector(${JSON.stringify(SEARCH_INPUT)}).focus(); true`);
  for (const character of text) {
    await cdp.send("Input.insertText", {text: character});
    await sleep(320);
  }
}

async function selectTargetMatch(cdp) {
  await waitFor("搜索首条命中", async () => (await searchState(cdp)).count.startsWith("1/"), {timeoutMs: 10000});
  for (let index = 1; index < TARGET_MATCH_INDEX; index += 1) {
    await cdp.evaluate(`document.querySelector(${JSON.stringify(SEARCH_NEXT)}).click(); true`);
    await waitFor(`搜索第 ${index + 1} 条命中`, async () => (await searchState(cdp)).count.startsWith(`${index + 1}/`), {timeoutMs: 5000});
    await sleep(80);
  }
  await positionTargetRow(cdp);
}

async function positionTargetRow(cdp, top = 600) {
  await cdp.evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(CURRENT_HIT)});
    const timestamp = item?.querySelector('.biliscript-reading-time');
    const list = document.getElementById('biliscript-reading-subtitle');
    if (!item || !timestamp || !list) return false;
    list.scrollTop += timestamp.getBoundingClientRect().top - ${top};
    scrollTo({top: 0, behavior: 'instant'});
    return true;
  })()`);
  await sleep(300);
}

async function videoTime(cdp) {
  return cdp.evaluate(`document.querySelector('video')?.currentTime ?? null`);
}

async function searchState(cdp) {
  return cdp.evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(CURRENT_HIT)});
    const timestamp = item?.querySelector('[data-seconds], .biliscript-reading-time');
    const video = document.querySelector('video');
    return {
      query: document.querySelector(${JSON.stringify(SEARCH_INPUT)})?.value || '',
      count: (document.getElementById('biliscript-reading-search-count')?.textContent || '').replace(/\\s+/g, ''),
      targetText: item?.innerText || '',
      targetTimestamp: timestamp?.textContent?.trim() || '',
      targetSeconds: Number(item?.getAttribute('data-seconds') ?? timestamp?.getAttribute('data-seconds')),
      targetRect: timestamp ? {x: timestamp.getBoundingClientRect().x, y: timestamp.getBoundingClientRect().y, width: timestamp.getBoundingClientRect().width, height: timestamp.getBoundingClientRect().height} : null,
      searchRect: (() => { const element = document.querySelector('.biliscript-reading-search'); const rect = element?.getBoundingClientRect(); return rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null; })(),
      videoTime: video?.currentTime ?? null
    };
  })()`);
}

export async function record() {
  return withSessionPage(async ({cdp, target}) => {
    await ensureReader(cdp);
    await cdp.evaluate(`(() => { const video = document.querySelector('video'); if (video) { video.pause(); video.currentTime = 0.5; } return true; })()`);
    await setSearch(cdp, SEARCH_QUERY);
    await waitFor("搜索首条真实匹配", async () => (await searchState(cdp)).count.startsWith("1/"), {timeoutMs: 15000});
    await selectTargetMatch(cdp);
    const preflight = await searchState(cdp);
    if (
      preflight.targetTimestamp !== TARGET_TIMESTAMP ||
      Math.abs(preflight.targetSeconds - TARGET_SECONDS) > 0.1 ||
      Math.abs(preflight.videoTime - 0.5) > 0.2 ||
      !preflight.targetRect ||
      preflight.targetRect.y + preflight.targetRect.height > 1080
    ) {
      throw new Error(`目标命中不在预期位置或不可见：${JSON.stringify(preflight)}`);
    }
    await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
    await sleep(800);

    const events = [];
    const mark = (name, state) => events.push({name, at: Date.now(), state});
    const recording = await recordScene(cdp, SCENE_NAME, async () => {
      const state = preflight;
      await sleep(400);
      mark("search-ready", state);
      await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: state.targetRect.x + state.targetRect.width / 2, y: state.targetRect.y + state.targetRect.height / 2, button: "none"});
      await sleep(400);
      mark("timestamp-hover", state);
      await click(cdp, `document.querySelector(${JSON.stringify(`${CURRENT_HIT} .biliscript-reading-time`)})`);
      await waitFor("播放器真实跳播", async () => Math.abs((await videoTime(cdp)) - state.targetSeconds) < 2.5, {timeoutMs: 10000});
      await cdp.evaluate(`document.querySelector('video').play().catch(() => {}); true`);
      await sleep(400);
      await cdp.evaluate(`document.querySelector('video').pause(); true`);
      await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
      await positionTargetRow(cdp);
      mark("seeked", {...state, videoTime: await videoTime(cdp)});
      await sleep(900);
      await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
      mark("settled", {...state, videoTime: await videoTime(cdp)});
      await sleep(5000);
    });

    const firstFrame = JSON.parse(await readFile(recording.metadata, "utf8")).frames[0];
    const origin = (await stat(firstFrame.file)).mtimeMs - firstFrame.at;
    const timelineEvents = events.map((event) => ({...event, at: Number(((event.at - origin) / 1000).toFixed(3))}));
    const before = timelineEvents.find((event) => event.name === "timestamp-hover")?.state;
    const after = timelineEvents.find((event) => event.name === "seeked")?.state;
    const expectedCount = before?.count.split("/")[1] ? `${TARGET_MATCH_INDEX}/${before.count.split("/")[1]}` : "";
    if (
      !before ||
      !after ||
      before.count !== expectedCount ||
      after.count !== expectedCount ||
      before.query !== SEARCH_QUERY ||
      after.query !== SEARCH_QUERY ||
      before.targetTimestamp !== TARGET_TIMESTAMP ||
      after.targetTimestamp !== TARGET_TIMESTAMP ||
      before.targetText !== after.targetText
    ) {
      throw new Error("录制前后搜索词、命中位置或目标字幕不一致");
    }
    if (!(after.videoTime - before.videoTime > 60) || !(Math.abs(after.videoTime - after.targetSeconds) < 2.5)) {
      throw new Error(`跳播距离不足或未落到目标位置：${JSON.stringify({before, after})}`);
    }

    const output = await encodeRecording(recording, "subtitle-seek-03.mp4", {frameCount: 240, filters: ["scale=3840:2160"]});
    return {sourceUrl: target.url, outputs: [output], recordings: [recording.metadata], events: timelineEvents};
  });
}
