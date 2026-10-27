import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir, readdir, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {attachPage, createWorkerSession, launchBrowser, REPO_ROOT, sleep, teardown, waitFor} from "../browser-harness/harness.mjs";
import {PROMO_DIR, SAMPLE_URL, VIEWPORT, click} from "./lib.mjs";
import {recordScene} from "./recorder.mjs";

const execFileAsync = promisify(execFile);

async function ffmpegPath() {
  const packageDir = (await readdir(path.join(REPO_ROOT, "node_modules", ".pnpm")))
    .find((name) => name.startsWith("@remotion+compositor-win32-x64-msvc@"));
  if (!packageDir) throw new Error("找不到 Remotion 自带的 Windows ffmpeg");
  return path.join(REPO_ROOT, "node_modules", ".pnpm", packageDir, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffmpeg.exe");
}

const browser = await launchBrowser({headless: false, muted: true, sync: false, viewport: VIEWPORT, profilePrefix: "biliscript-promo-"});
const page = await attachPage(browser, {viewport: VIEWPORT});
const worker = createWorkerSession({pageCdp: page.cdp, browser});
try {
  await worker.ensureAlive();
  await page.cdp.send("Page.navigate", {url: SAMPLE_URL});
  await waitFor("文摘入口", () => page.cdp.evaluate(`!!document.getElementById('biliscript-script-button')`), {timeoutMs: 45000});
  await click(page.cdp, `document.getElementById('biliscript-script-button')`);
  await waitFor("文摘面板", () => page.cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 30000});
  await click(page.cdp, `document.getElementById('biliscript-reading-settings-btn')`);
  await waitFor("设置抽屉", () => page.cdp.evaluate(`!!document.getElementById('biliscript-reading-settings-panel')?.getBoundingClientRect().width`), {timeoutMs: 10000});
  await waitFor("语言模型导航", () => page.cdp.evaluate(`!!document.querySelector('[data-section="llm"]')`), {timeoutMs: 10000});
  await click(page.cdp, `document.querySelector('[data-section="llm"]')`);
  await page.cdp.evaluate(`document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} }); true`);
  await sleep(500);

  const events = [];
  const mark = async (name) => events.push({name, at: Date.now()});
  const recording = await recordScene(page.cdp, "06-ai-providers", async () => {
    await sleep(1200);
    await mark("settings-established");
    await click(page.cdp, `document.getElementById('addAiProviderBtn')`);
    await waitFor("添加平台弹层", () => page.cdp.evaluate(`document.querySelector('.provider-editor-dialog')?.getAttribute('aria-label') === '添加AI 平台'`), {timeoutMs: 10000});
    await mark("provider-editor-opened");
    await sleep(900);
    await click(page.cdp, `document.querySelector('.provider-editor-preset-wrapper .custom-select-trigger')`);
    await waitFor("平台预设展开", () => page.cdp.evaluate(`document.querySelectorAll('.provider-editor-preset-wrapper .custom-select-option').length === 15 && !document.querySelector('.provider-editor-preset-wrapper .custom-select-dropdown')?.hidden`), {timeoutMs: 10000});
    await mark("presets-expanded");
    await sleep(2800);
  });

  const clipsDir = path.join(PROMO_DIR, "clips");
  await mkdir(clipsDir, {recursive: true});
  const output = path.join(clipsDir, "06-ai-providers.mp4");
  await execFileAsync(await ffmpegPath(), [
    "-y", "-f", "concat", "-safe", "0", "-i", recording.manifest,
    "-frames:v", "180", "-r", "30", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", output
  ]);
  const evidence = path.join(PROMO_DIR, "evidence", "providers-06.json");
  await mkdir(path.dirname(evidence), {recursive: true});
  await writeFile(evidence, JSON.stringify({sourceUrl: SAMPLE_URL, output: path.relative(REPO_ROOT, output), events}, null, 2) + "\n", "utf8");
  console.log(`平台预设真实操作已输出：${output}\n操作证据：${evidence}`);
} finally {
  await teardown({browser, cdps: [page.cdp, worker.handle?.cdp].filter(Boolean)});
}
