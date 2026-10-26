import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir, readdir, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {CDP, REPO_ROOT, sleep, waitFor} from "../browser-harness/harness.mjs";
import {PROMO_DIR, click, connectPage, readSession} from "./lib.mjs";
import {recordScene} from "./recorder.mjs";

const execFileAsync = promisify(execFile);
const SCENE_NAME = "05-appearance-motion";
const REAL_OVERVIEW = {
  phase: "ready",
  aiChapters: true,
  chapterSourceKind: "auto",
  progressText: "",
  errorText: "",
  generatedFor: "promo-recut-05",
  analysis: {
    chapters: [
      {
        from: 0,
        title: "机器幻觉的成因：大模型的评分机制与语言本质",
        summary: "通过考试猜题的类比，解释大模型训练机制中“答错不扣分、答对得非零分、不答得零分”的逻辑，说明模型宁可“蒙”也不空着；同时指出对话模型只模仿语言规律，追求“说得像人”而非“事实正确”。"
      },
      {
        from: 152,
        title: "幻觉无法彻底避免：商业价值与数据局限",
        summary: "分析若模型过度谨慎只会回答“不知道”则失去商业价值。即使给出大量精确数据，也无法推测无关联的事实（如知道全班49人生日也猜不出第50个），因此幻觉无法彻底杜绝，只能通过横向比对和多重查证来降低。"
      },
      {
        from: 267,
        title: "人机协作国际象棋实验：适配重于强弱",
        summary: "介绍一项“强AI与弱搭档”协作的下象棋实验，每步由随机机制决定谁落子。结果显示懂得为同伴留后路、注重协作的组合击败了单纯追求最强算力的组合，证明协作中强弱并非决定因素。"
      }
    ],
    quotes: [
      {
        from: 130,
        content: "他只要去答这个题目，得的就不是零分，但是他如果不答一定是零分。我们训练大模型的时候就是这样训练的，那么在这种情况下，他一定会去蒙。"
      }
    ],
    failedRanges: []
  }
};

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
  if (!(await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`))) {
    await click(cdp, `document.getElementById('biliscript-script-button')`);
  }
  await waitFor("文摘面板", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`), {timeoutMs: 30000});
  if ((await appearanceState(cdp)).settingsOpen) {
    await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
    await sleep(300);
  }
  await click(cdp, `document.getElementById('biliscript-reading-tab-overview')`);
  const isolated = await CDP.connect(target.webSocketDebuggerUrl);
  try {
    const contexts = [];
    isolated.on("Runtime.executionContextCreated", ({context}) => contexts.push(context));
    await isolated.send("Runtime.enable");
    await sleep(100);
    const context = contexts.find((item) => item.origin.startsWith("chrome-extension://") && item.auxData?.type === "isolated");
    if (!context) throw new Error("找不到扩展内容脚本上下文");
    const result = await isolated.send("Runtime.evaluate", {
      contextId: context.id,
      expression: `(async () => {
        const reader = await import(chrome.runtime.getURL('entry/chunks/reader.mjs'));
        reader.closeQuoteShareModal();
        reader.renderReadingOverview(${JSON.stringify(REAL_OVERVIEW)});
        document.getElementById('biliscript-reading-overview-body').scrollTop = 0;
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  } finally {
    isolated.close();
  }
  await waitFor("概览章节", () => cdp.evaluate(`document.querySelectorAll('#biliscript-reading-overview-body .biliscript-reading-ov-chapter').length > 0`), {timeoutMs: 10000});
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

async function ffmpegPath() {
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  const packageDir = (await readdir(pnpmDir)).find((name) => name.startsWith("@remotion+compositor-win32-x64-msvc@"));
  if (!packageDir) throw new Error("找不到 Remotion 自带的 Windows ffmpeg");
  return path.join(pnpmDir, packageDir, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffmpeg.exe");
}

const session = await readSession();
const {cdp, target} = await connectPage(session);
try {
  await cdp.send("Emulation.setFocusEmulationEnabled", {enabled: true});
  await cdp.send("Page.bringToFront");
  await ensureReader(cdp, target);
  const initial = await appearanceState(cdp);
  if (initial.mode === "dark") await click(cdp, `document.getElementById('biliscript-reading-theme-select')`);
  if (!(await appearanceState(cdp)).settingsOpen) {
    await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);
  }
  await click(cdp, `document.querySelector('[data-section="appearance"]')`);
  await sleep(500);
  await setPalette(cdp, "flyme");
  await click(cdp, `document.getElementById('biliscript-reading-settings-btn')`);

  const events = [];
  const mark = async (name) => events.push({name, at: Date.now(), state: await appearanceState(cdp)});
  const recording = await recordScene(cdp, SCENE_NAME, async () => {
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
  });

  const clipsDir = path.join(PROMO_DIR, "clips");
  await mkdir(clipsDir, {recursive: true});
  const output = path.join(clipsDir, "05-appearance.mp4");
  await execFileAsync(await ffmpegPath(), [
    "-y", "-f", "concat", "-safe", "0", "-i", recording.manifest,
    "-frames:v", "180", "-r", "30", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", output
  ]);
  const evidence = path.join(PROMO_DIR, "evidence", "appearance-05.json");
  await mkdir(path.dirname(evidence), {recursive: true});
  await writeFile(evidence, JSON.stringify({sourceUrl: target.url, output: path.relative(REPO_ROOT, output), events}, null, 2) + "\n", "utf8");
  console.log(`外观真实操作已输出：${output}\n操作证据：${evidence}`);
} finally {
  cdp.close();
}
