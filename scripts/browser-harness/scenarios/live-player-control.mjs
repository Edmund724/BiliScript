#!/usr/bin/env node
import path from "node:path";
import { build } from "esbuild";
import {
  REPO_ROOT,
  artifactDir,
  attachPage,
  launchBrowser,
  log,
  teardown,
  waitFor,
  writeEvidence
} from "../harness.mjs";

const NAME = "live-player-control";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

function makeWavDataUri(seconds = 4) {
  const sampleRate = 8000;
  const dataSize = seconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

const bundled = await build({
  entryPoints: [path.join(REPO_ROOT, "extension/live/live-tools-bridge.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "LiveTools",
  platform: "browser"
});
const bridgeSource = bundled.outputFiles[0].text;
const browser = await launchBrowser({ autoplay: true });
const page = await attachPage(browser);

try {
  await page.cdp.send("Page.setDocumentContent", {
    frameId: page.target.id,
    html: `<!doctype html><html><body><div class="bpx-player-video-wrap"><video preload="auto" src="${makeWavDataUri()}"></video></div></body></html>`
  });
  await page.cdp.evaluate(bridgeSource);
  await page.cdp.evaluate(`(() => {
    const video = document.querySelector('.bpx-player-video-wrap video');
    const clip = {
      bvid: 'BV1test000000',
      cid: '123',
      title: '播放器控制仿真',
      pageIndex: 1,
      pageCount: 1,
      pageTitle: '',
      subtitleFetchState: 'ready',
      subtitleBody: [
        { from: 0, to: 0.8, content: '开场介绍' },
        { from: 2, to: 3, content: '本章总结' }
      ],
      chapters: []
    };
    window.testVideo = video;
    window.testBridge = LiveTools.createLiveToolsBridge({ getClip: () => clip, getUrl: () => 'https://www.bilibili.com/video/BV1test000000/' });
    window.testCall = (name, args, stampedVideo = { bvid: 'BV1test000000', cid: '123', pageIndex: 1 }) =>
      testBridge.executeTool({ callId: Math.random().toString(36), name, arguments: args, video: stampedVideo });
  })()`);
  await waitFor("本地媒体元数据", () => page.cdp.evaluate("testVideo.readyState >= 1 && testVideo.duration === 4"));

  const results = await page.cdp.evaluate(`(async () => {
    const output = {};
    output.play = await testCall('control_bilibili_player', { command: 'play' });
    output.playing = !testVideo.paused;
    output.pause = await testCall('control_bilibili_player', { command: 'pause' });
    output.paused = testVideo.paused;
    output.rate = await testCall('control_bilibili_player', { command: 'rate', rate: 1.5 });
    output.actualRate = testVideo.playbackRate;
    output.seek = await testCall('control_bilibili_player', { command: 'seek', time: 0.5 });
    output.seekTime = testVideo.currentTime;
    output.search = await testCall('search_video_subtitles', { query: '总结' });
    output.semanticSeek = await testCall('control_bilibili_player', {
      command: 'seek',
      time: output.search.items[0].from
    });
    output.semanticTime = testVideo.currentTime;
    output.invalidTime = await testCall('control_bilibili_player', { command: 'seek', time: -1 });
    output.invalidRate = await testCall('control_bilibili_player', { command: 'rate', rate: 1.2 });
    output.missingArgument = await testCall('control_bilibili_player', { command: 'seek' });
    output.staleVideo = await testCall(
      'control_bilibili_player',
      { command: 'seek', time: 1 },
      { bvid: 'BV1old0000000', cid: '123', pageIndex: 1 }
    );
    output.afterRejectedSeek = testVideo.currentTime;
    testVideo.removeAttribute('src');
    testVideo.load();
    output.notReady = await testCall('control_bilibili_player', { command: 'pause' });
    return output;
  })()`);

  check("play", results.play.ok && results.playing, results.play);
  check("pause", results.pause.ok && results.paused, results.pause);
  check("rate", results.rate.ok && results.actualRate === 1.5, results.rate);
  check("seek", results.seek.ok && Math.abs(results.seekTime - 0.5) < 0.05, results.seek);
  check(
    "subtitle-semantic-seek",
    results.search.ok && results.search.items[0]?.from === 2 && results.semanticSeek.ok && Math.abs(results.semanticTime - 2) < 0.05,
    { search: results.search, seek: results.semanticSeek, currentTime: results.semanticTime }
  );
  check("invalid-time", results.invalidTime.ok === false && results.invalidTime.error, results.invalidTime);
  check("invalid-rate", results.invalidRate.ok === false && results.invalidRate.error, results.invalidRate);
  check("missing-argument", results.missingArgument.ok === false && results.missingArgument.error, results.missingArgument);
  check(
    "stale-video-identity",
    results.staleVideo.ok === false && Math.abs(results.afterRejectedSeek - 2) < 0.05,
    results.staleVideo
  );
  check("player-not-ready", results.notReady.ok === false && results.notReady.error.includes("尚未就绪"), results.notReady);

  await writeEvidence(OUT_DIR, {
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks,
    results
  });
  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
} finally {
  await page.cdp.evaluate("testVideo.pause(); testVideo.removeAttribute('src'); testVideo.load();").catch(() => {});
  await teardown({ browser, cdps: [page.cdp] });
}
