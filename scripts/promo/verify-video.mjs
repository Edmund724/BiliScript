import http from "node:http";
import path from "node:path";
import {createReadStream} from "node:fs";
import {mkdir, rm, stat, writeFile} from "node:fs/promises";
import {attachPage, launchBrowser, REPO_ROOT, teardown, waitFor} from "../browser-harness/harness.mjs";
import {PROMO_DIR, VIEWPORT} from "./lib.mjs";
import {PROMO_DURATION, PROMO_FPS, PROMO_HEIGHT, PROMO_WIDTH} from "./timeline.mjs";

const input = path.resolve(process.argv[2] || path.join(REPO_ROOT, "release", "BiliScript-promo-1080p.mp4"));
const inputInfo = await stat(input);
if (!inputInfo.isFile()) throw new Error(`视频不是文件：${input}`);
const output = path.join(PROMO_DIR, "evidence", process.argv[2] ? "draft-playback" : "final-playback");
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});

const server = http.createServer(async (request, response) => {
  if (request.url === "/") {
    response.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
    response.end("<!doctype html><meta charset='utf-8'><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f6f8fc}video{display:block;width:100%;height:100%;object-fit:contain}</style><video playsinline src='/video.mp4'></video>");
    return;
  }
  if (request.url !== "/video.mp4") {
    response.writeHead(404).end();
    return;
  }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), inputInfo.size - 1) : inputInfo.size - 1;
  if (start > end || start >= inputInfo.size) {
    response.writeHead(416, {"Content-Range": `bytes */${inputInfo.size}`}).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(range ? {"Content-Range": `bytes ${start}-${end}/${inputInfo.size}`} : {})
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(input, {start, end}).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法启动视频检查服务");
const browser = await launchBrowser({headless: true, muted: false, autoplay: true, sync: false, viewport: VIEWPORT, profilePrefix: "biliscript-video-check-"});
const page = await attachPage(browser, {viewport: VIEWPORT});
try {
  await page.cdp.send("Page.navigate", {url: `http://127.0.0.1:${address.port}/`});
  await waitFor("视频解码就绪", () => page.cdp.evaluate("document.querySelector('video')?.readyState >= 2"), {timeoutMs: 30000});
  const metadata = await page.cdp.evaluate(`(() => {
    const video = document.querySelector('video');
    video.pause();
    return {duration: video.duration, width: video.videoWidth, height: video.videoHeight};
  })()`);
  if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || !metadata.width || !metadata.height) {
    throw new Error(`视频元数据无效：${JSON.stringify(metadata)}`);
  }
  if (metadata.width !== PROMO_WIDTH || metadata.height !== PROMO_HEIGHT || Math.abs(metadata.duration - PROMO_DURATION / PROMO_FPS) > 0.05) {
    throw new Error(`回放文件与当前时间轴不符：${JSON.stringify({metadata, expected: {width: PROMO_WIDTH, height: PROMO_HEIGHT, duration: PROMO_DURATION / PROMO_FPS}})}`);
  }
  const sampleTimes = Array.from({length: Math.ceil(metadata.duration * 2)}, (_, index) => Math.min(index / 2, metadata.duration - 1 / 60));
  const sheets = [];
  for (let start = 0; start < sampleTimes.length; start += 16) {
    const indices = [];
    for (let index = start; index < Math.min(start + 16, sampleTimes.length); index += 1) {
      const seconds = sampleTimes[index];
      const captured = await page.cdp.evaluate(`(async () => {
        const video = document.querySelector('video');
        if (video.error) throw new Error(video.error.message);
        const target = ${seconds};
        if (Math.abs(video.currentTime - target) > 0.01) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('视频定位超时')), 10000);
            video.addEventListener('seeked', () => { clearTimeout(timer); resolve(true); }, {once: true});
            video.currentTime = target;
          });
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {time: video.currentTime, width: video.videoWidth, height: video.videoHeight};
      })()`);
      if (Math.abs(captured.time - seconds) > 0.1) throw new Error(`视频定位不准：${JSON.stringify({seconds, captured})}`);
      const screenshot = await page.cdp.send("Page.captureScreenshot", {format: "jpeg", quality: 90, fromSurface: true, captureBeyondViewport: false});
      indices.push({seconds, jpeg: screenshot.data});
    }
    const sheet = await page.cdp.evaluate(`(async () => {
      const frames = ${JSON.stringify(indices)};
      const canvas = document.createElement('canvas');
      canvas.width = 1920;
      canvas.height = 1080;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f6f8fc';
      context.fillRect(0, 0, 1920, 1080);
      for (let index = 0; index < frames.length; index += 1) {
        const image = new Image();
        image.src = 'data:image/jpeg;base64,' + frames[index].jpeg;
        await image.decode();
        const x = (index % 4) * 480;
        const y = Math.floor(index / 4) * 270;
        context.drawImage(image, x, y, 480, 270);
        context.fillStyle = 'rgba(36, 52, 71, 0.86)';
        context.fillRect(x + 8, y + 8, 70, 26);
        context.fillStyle = '#ffffff';
        context.font = '16px sans-serif';
        context.fillText(frames[index].seconds.toFixed(1) + ' s', x + 16, y + 27);
      }
      return canvas.toDataURL('image/jpeg', 0.94).split(',')[1];
    })()`, {timeoutMs: 60000});
    const file = `sheet-${String(sheets.length + 1).padStart(2, "0")}.jpg`;
    await writeFile(path.join(output, file), Buffer.from(sheet, "base64"));
    sheets.push({file, from: sampleTimes[start], to: sampleTimes[Math.min(start + 15, sampleTimes.length - 1)]});
  }
  const playback = await page.cdp.evaluate(`(async () => {
    const video = document.querySelector('video');
    video.currentTime = 0;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('完整播放超时')), ${Math.ceil(metadata.duration * 1000) + 10000});
      video.addEventListener('ended', () => { clearTimeout(timer); resolve(true); }, {once: true});
      video.play().catch(reject);
    });
    const quality = video.getVideoPlaybackQuality();
    return {ended: video.ended, currentTime: video.currentTime, decodedFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames, audioDecodedBytes: video.webkitAudioDecodedByteCount || 0, muted: video.muted};
  })()`, {timeoutMs: Math.ceil(metadata.duration * 1000) + 15000});
  if (!playback.ended || Math.abs(playback.currentTime - metadata.duration) > 0.1) {
    throw new Error(`视频未完整播放：${JSON.stringify(playback)}`);
  }
  if (playback.audioDecodedBytes <= 0 || playback.muted) throw new Error("完整回放未有效解码非静音音频");
  const evidence = {video: path.relative(REPO_ROOT, input).replaceAll("\\", "/"), metadata, sampleTimes, sheets, playback};
  await writeFile(path.join(output, "inspection.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`视频解码检查工件：${output}`);
} finally {
  await teardown({browser, cdps: [page.cdp]});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
