import path from "node:path";
import {execFile} from "node:child_process";
import {copyFile, mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {REPO_ROOT, sleep, waitFor} from "../browser-harness/harness.mjs";
import {PROMO_DIR, connectPage, click, readSession} from "./lib.mjs";
import {recordScene} from "./recorder.mjs";

const execFileAsync = promisify(execFile);
const SCENE_NAME = "02-subtitle-seek-03";
const OUTPUT_NAME = "subtitle-seek-03.mp4";
const SEARCH_INPUT = "#biliscript-reading-search-input";
const CURRENT_HIT = "#biliscript-reading-subtitle .biliscript-reading-item.search-current";

async function ensureReader(cdp) {
  await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`))) {
    await waitFor("文摘按钮", () => cdp.evaluate(`!!document.getElementById('biliscript-script-button')`), {timeoutMs: 30000});
    await click(cdp, `document.getElementById('biliscript-script-button')`);
  }
  await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 15000});
  await click(cdp, `document.getElementById('biliscript-reading-tab-subtitle')`);
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

async function searchState(cdp) {
  return cdp.evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(CURRENT_HIT)});
    const timestamp = item?.querySelector('[data-seconds], .biliscript-reading-time');
    const video = document.querySelector('video');
    return {
      query: document.querySelector(${JSON.stringify(SEARCH_INPUT)})?.value || '',
      count: (document.getElementById('biliscript-reading-search-count')?.textContent || '').replace(/\\s+/g, ''),
      targetText: item?.innerText || '',
      targetSeconds: Number(item?.getAttribute('data-seconds') ?? timestamp?.getAttribute('data-seconds')),
      targetRect: timestamp ? {x: timestamp.getBoundingClientRect().x, y: timestamp.getBoundingClientRect().y, width: timestamp.getBoundingClientRect().width, height: timestamp.getBoundingClientRect().height} : null,
      searchRect: (() => { const element = document.querySelector('.biliscript-reading-search'); const rect = element?.getBoundingClientRect(); return rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null; })(),
      videoTime: video?.currentTime ?? null
    };
  })()`);
}

async function ffmpegPath() {
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  const packageDir = (await readdir(pnpmDir)).find((name) => name.startsWith("@remotion+compositor-win32-x64-msvc@"));
  if (!packageDir) throw new Error("找不到 Remotion 自带的 Windows ffmpeg");
  return path.join(pnpmDir, packageDir, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffmpeg.exe");
}

const session = await readSession();
const {cdp, target} = await connectPage(session);
try {
  await ensureReader(cdp);
  await setSearch(cdp, "幻觉");
  await waitFor("幻觉的 1/5 真实匹配", async () => (await searchState(cdp)).count === "1/5", {timeoutMs: 15000});
  await setSearch(cdp, "");
  await cdp.evaluate(`(() => { const video = document.querySelector('video'); if (video) { video.pause(); video.currentTime = 0.5; } scrollTo({top: 0, behavior: 'instant'}); return true; })()`);
  await sleep(800);

  const events = [];
  const mark = async (name) => events.push({name, at: Date.now(), state: await searchState(cdp)});
  const recording = await recordScene(cdp, SCENE_NAME, async () => {
    await sleep(500);
    await mark("search-start");
    await setSearch(cdp, "幻觉");
    await waitFor("录制中的 1/5 匹配", async () => (await searchState(cdp)).count === "1/5", {timeoutMs: 10000});
    await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
    await mark("search-ready");
    await sleep(700);
    const state = await searchState(cdp);
    if (!state.targetRect || !Number.isFinite(state.targetSeconds) || state.targetSeconds <= 0) {
      throw new Error(`目标字幕或时间戳不可用：${JSON.stringify(state)}`);
    }
    await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: state.targetRect.x + state.targetRect.width / 2, y: state.targetRect.y + state.targetRect.height / 2, button: "none"});
    await sleep(450);
    await mark("timestamp-hover");
    await click(cdp, `document.querySelector(${JSON.stringify(`${CURRENT_HIT} .biliscript-reading-time`)})`);
    await waitFor("播放器真实跳播", async () => {
      const current = await searchState(cdp);
      return Math.abs(current.videoTime - state.targetSeconds) < 2.5;
    }, {timeoutMs: 10000});
    await cdp.evaluate(`scrollTo({top: 0, behavior: 'instant'}); true`);
    await mark("seeked");
    await sleep(1000);
    await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
    await mark("settled");
  });

  const firstFrame = JSON.parse(await readFile(recording.metadata, "utf8")).frames[0];
  const origin = (await stat(firstFrame.file)).mtimeMs - firstFrame.at;
  const timelineEvents = events.map((event) => ({...event, at: Number(((event.at - origin) / 1000).toFixed(3))}));
  const before = timelineEvents.find((event) => event.name === "timestamp-hover")?.state;
  const after = timelineEvents.find((event) => event.name === "seeked")?.state;
  if (!before || !after || before.count !== "1/5" || after.count !== "1/5" || before.query !== "幻觉" || after.query !== "幻觉") {
    throw new Error("录制前后搜索词或匹配计数不一致");
  }
  if (!(Math.abs(after.videoTime - before.videoTime) > 0.5) || !(Math.abs(after.videoTime - before.targetSeconds) < 2.5)) {
    throw new Error(`跳播前后时间不符合预期：${JSON.stringify({before, after})}`);
  }

  const clipsDir = path.join(PROMO_DIR, "clips");
  const mediaDir = path.join(REPO_ROOT, "scripts", "promo", "public", "media");
  await mkdir(clipsDir, {recursive: true});
  await mkdir(mediaDir, {recursive: true});
  const clip = path.join(clipsDir, `${SCENE_NAME}.mp4`);
  await execFileAsync(await ffmpegPath(), ["-y", "-safe", "0", "-i", recording.manifest, "-frames:v", "120", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", clip]);
  const output = path.join(mediaDir, OUTPUT_NAME);
  await copyFile(clip, output);
  const evidence = path.join(PROMO_DIR, "evidence", "subtitle-seek-03.json");
  await mkdir(path.dirname(evidence), {recursive: true});
  await writeFile(evidence, JSON.stringify({sourceUrl: target.url, recording: path.relative(REPO_ROOT, clip), output: path.relative(REPO_ROOT, output), events: timelineEvents}, null, 2) + "\n", "utf8");
  console.log(`字幕搜索闭环已输出：${output}\n连续录制证据：${evidence}`);
} finally {
  await cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`).catch(() => {});
  cdp.close();
}
