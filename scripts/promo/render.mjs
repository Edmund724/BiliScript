import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir, readFile, readdir, rename, stat, unlink, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {bundle} from "@remotion/bundler";
import {getCompositions, getVideoMetadata, renderStill, renderMedia} from "@remotion/renderer";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {resolveSharedBrowserExecutable} from "./browser-executable.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {availableCpus, createLimiter} from "./parallel.mjs";
import {preparePromoAssets} from "./prepare.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";
import {AUDIO} from "./audio.mjs";
import {CAPTIONS} from "./captions.mjs";
import {CHAT_SHOTS, EVIDENCE_TIMES, PROMO_DURATION, PROMO_FPS, SCENES} from "./timeline.mjs";

const execFileAsync = promisify(execFile);
const RELEASE_DIR = path.join(REPO_ROOT, "release");
const EVIDENCE_DIR = path.join(PROMO_DIR, "evidence");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const sceneArg = rawArgs.find((arg) => arg.startsWith("--scene="))?.slice("--scene=".length);
const stillsOnly = args.has("--stills-only");
const postOnly = args.has("--post-only");
const draft = args.has("--draft") || stillsOnly || Boolean(sceneArg);

function srtTime(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function validateTimeline() {
  let nextFrom = 0;
  for (const scene of SCENES) {
    if (scene.from !== nextFrom) throw new Error(`镜头不连续：${scene.id}`);
    nextFrom += scene.duration;
  }
  if (nextFrom !== PROMO_DURATION) throw new Error(`镜头总时长不符：${nextFrom}`);
  if (CHAT_SHOTS.reduce((total, shot) => total + shot.duration, 0) !== SCENES.find((scene) => scene.id === "chat")?.duration) {
    throw new Error("AI 分镜时长不符");
  }
  let previousEnd = 0;
  for (const caption of CAPTIONS) {
    if (!caption.text.trim() || !Number.isSafeInteger(caption.startMs) || !Number.isSafeInteger(caption.endMs)) {
      throw new Error(`字幕内容或时间无效：${JSON.stringify(caption)}`);
    }
    const scene = SCENES.find((candidate) => candidate.id === caption.sceneId);
    const sceneStart = (scene.from / PROMO_FPS) * 1000;
    const sceneEnd = ((scene.from + scene.duration) / PROMO_FPS) * 1000;
    if (caption.startMs < previousEnd || caption.startMs < sceneStart || caption.endMs <= caption.startMs || caption.endMs > sceneEnd) {
      throw new Error(`字幕时间范围无效：${JSON.stringify(caption)}`);
    }
    previousEnd = caption.endMs;
  }
}

validateTimeline();

async function writeReleaseText() {
  const srt = CAPTIONS.map((caption, index) => `${index + 1}\n${srtTime(caption.startMs / 1000)} --> ${srtTime(caption.endMs / 1000)}\n${caption.text}\n`).join("\n");
  const logoCredits = PROVIDER_LOGOS.map((logo) => `${logo.name} (${logo.id})\n官方素材：${logo.officialFileUrl}\n来源页：${logo.sourcePage}\n依据：${logo.usageBasis}${logo.usageBasisUrl ? `\n条款/品牌页：${logo.usageBasisUrl}` : ""}\n获取：${logo.acquiredAt}；${logo.modifications}`).join("\n\n");
  const sfxNames = [...new Set(AUDIO.cues.map((cue) => path.basename(cue.src, ".wav")))];
  const bubbleNames = sfxNames.filter((name) => /^bubble-\d+$/.test(name));
  const sfxList = [
    ...sfxNames.filter((name) => !/^bubble-\d+$/.test(name)),
    ...(bubbleNames.length ? [`bubble-${bubbleNames[0].slice(-2)}..${bubbleNames.at(-1).slice(-2)}`] : [])
  ].join(" / ");
  const credits = `演示视频与原片讲课同期声片段（02:32 / 04:07 / 04:44）：复旦赵斌《AI并非越强越好，适配才是关键》\nhttps://www.bilibili.com/video/BV1mAam6tEL8/\n\n实时伴看演示语音片段（27.5s–29.1s 用户提问原声 / 29.5s–32.7s AI 回复）：作者原声提问 + MOSS Live (moss-live-1.0) 实时多模态语音对话实录\nhttps://api.mosi.cn\n\n无原生 CC 字幕转写与概念检索演示视频：隔壁的程序员老王《一听就懂的傅里叶变换》\nhttps://www.bilibili.com/video/BV1Yqpx6pEuF/\n\n音乐：“BiliScript Pulse” — BiliScript\n原创合成：scripts/promo/synthesize-audio.mjs\nLicense: MIT License\nhttps://github.com/Edmund724/BiliScript/blob/main/LICENSE\n\n音效：${sfxList} — BiliScript\n均为原创合成；来源与许可同上。\n\n平台 Logo：权利归各平台权利人；仅标识对应预设，不暗示合作或背书。\n${logoCredits}\n\nBiliScript\nhttps://github.com/Edmund724/BiliScript\n`;
  await mkdir(RELEASE_DIR, {recursive: true});
  await writeFile(path.join(RELEASE_DIR, "BiliScript-promo-zh-CN.srt"), srt, "utf8");
  await writeFile(path.join(RELEASE_DIR, "BiliScript-promo-credits.txt"), credits, "utf8");
}

function progressLogger(label, alreadyPercent = false) {
  let reported = -1;
  return (progress) => {
    const percent = Math.floor(alreadyPercent ? progress : progress * 100);
    if (percent >= reported + 10 || percent === 100) {
      reported = percent;
      console.log(`${label} ${percent}%`);
    }
  };
}

async function muxMasteredAudio(input, destination) {
  const mixWavPath = path.join(PROMO_DIR, "assets", "audio", "remotion-mix.wav");
  const muxedOutput = path.join(EVIDENCE_DIR, `muxed-${path.basename(destination)}`);
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-i",
      mixWavPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-movflags",
      "+faststart",
      "-metadata",
      "title=BiliScript｜B 站视频文摘",
      muxedOutput
    ],
    {maxBuffer: 4 * 1024 * 1024}
  );
  await rename(muxedOutput, destination);
}

async function encodeMaster(input) {
  const masterOutput = path.join(RELEASE_DIR, "BiliScript-promo-master.mp4");
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-b:v",
      "14M",
      "-minrate",
      "14M",
      "-maxrate",
      "14M",
      "-bufsize",
      "14M",
      "-x264-params",
      "nal-hrd=cbr:filler=1:force-cfr=1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-movflags",
      "+faststart",
      masterOutput
    ],
    {maxBuffer: 4 * 1024 * 1024}
  );
  return masterOutput;
}

async function validateFinalVideo(output, masterOutput) {
  const metadata = await getVideoMetadata(output);
  if (metadata.width !== 1920 || metadata.height !== 1080 || metadata.fps !== PROMO_FPS) {
    throw new Error(`成片规格不符：${JSON.stringify(metadata)}`);
  }
  if (Math.abs(metadata.durationInSeconds - PROMO_DURATION / PROMO_FPS) > 0.05) {
    throw new Error(`成片时长不符：${metadata.durationInSeconds}`);
  }
  if (metadata.audioCodec !== "aac") {
    throw new Error(`成片缺少 AAC 音轨：${metadata.audioCodec}`);
  }
  const bytes = await readFile(output);
  const moov = bytes.indexOf(Buffer.from("moov"));
  const mdat = bytes.indexOf(Buffer.from("mdat"));
  if (moov < 0 || mdat < 0 || moov > mdat) {
    throw new Error("成片未启用 fast-start");
  }
  const masterBytes = await readFile(masterOutput);
  const masterBitrateMbps = Number(((masterBytes.length * 8) / metadata.durationInSeconds / 1_000_000).toFixed(2));
  if (masterBitrateMbps < 10) {
    throw new Error(`高码率上传母版码率不足 10 Mbps：${masterBitrateMbps} Mbps`);
  }
  const webBitrateMbps = Number(((bytes.length * 8) / metadata.durationInSeconds / 1_000_000).toFixed(2));
  await writeFile(
    path.join(EVIDENCE_DIR, "final-metadata.json"),
    JSON.stringify(
      {
        ...metadata,
        fastStart: true,
        webBitrateMbps,
        masterPath: "release/BiliScript-promo-master.mp4",
        masterBitrateMbps
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

const {publicDir, manifest} = await preparePromoAssets();
for (const [name, duration, width, height] of [
  // hero-hook 源素材含约 10s 模型思考段（镜头内跳切压缩），素材契约按源素材 18s。
  ["hero-hook.mp4", 18, 3840, 2160],
  ["subtitle-seek-03.mp4", 8, 3840, 2160],
  ["chat.mp4", 15, 3840, 2160],
  ["subtools-fourier.mp4", 7, 1920, 1080],
  ["ai-providers.mp4", 5.9, 3840, 2160]
]) {
  const metadata = await getVideoMetadata(path.join(publicDir, "media", name));
  if (metadata.width !== width || metadata.height !== height || metadata.fps !== PROMO_FPS || Math.abs(metadata.durationInSeconds - duration) > 0.05) {
    throw new Error(`素材规格不符 ${name}：${JSON.stringify(metadata)}`);
  }
}
await mkdir(EVIDENCE_DIR, {recursive: true});
console.log("素材校验通过；面板素材为 3840×2160，01-intro 不在素材清单中");

const RENDER_PORT = 3100;
const browserExecutable = resolveSharedBrowserExecutable(REPO_ROOT);
if (browserExecutable) console.log(`复用浏览器：${browserExecutable}`);
const serveUrl = await bundle({
  entryPoint: path.join(REPO_ROOT, "scripts", "promo", "index.ts"),
  publicDir,
  outDir: path.join(PROMO_DIR, "render-bundle"),
  rspack: true,
  onProgress: progressLogger("打包", true)
});
const compositions = await getCompositions(serveUrl, {inputProps: {}, port: RENDER_PORT, browserExecutable});
if (sceneArg) {
  const targetScene = SCENES.find((scene) => scene.id === sceneArg);
  const sceneComposition = compositions.find((composition) => composition.id === `Scene-${sceneArg}`);
  if (!targetScene || !sceneComposition) {
    throw new Error(`未知分镜 ${sceneArg}，可选：${SCENES.map((scene) => scene.id).join(", ")}`);
  }
  const sceneEvidenceDir = path.join(EVIDENCE_DIR, targetScene.id);
  await mkdir(sceneEvidenceDir, {recursive: true});
  if (!stillsOnly && !postOnly) {
    const sceneOutput = path.join(sceneEvidenceDir, `${targetScene.id}-draft.mp4`);
    await renderMedia({
      composition: sceneComposition,
      serveUrl,
      inputProps: sceneComposition.defaultProps,
      port: RENDER_PORT,
      browserExecutable,
      codec: "h264",
      crf: 20,
      pixelFormat: "yuv420p",
      x264Preset: "veryfast",
      scale: 0.5,
      concurrency: 4,
      overwrite: true,
      outputLocation: sceneOutput,
      onProgress: progressLogger(`分镜 ${targetScene.id}`)
    });
    console.log(`分镜试片已输出：${sceneOutput}`);
  }
  const sceneFrames = EVIDENCE_TIMES
    .map((seconds) => Math.round(seconds * PROMO_FPS))
    .filter((frame) => frame >= targetScene.from && frame < targetScene.from + targetScene.duration);
  for (const globalFrame of sceneFrames) {
    const localFrame = globalFrame - targetScene.from;
    const outputStill = path.join(sceneEvidenceDir, `frame-${String(localFrame).padStart(4, "0")}.png`);
    await renderStill({
      composition: sceneComposition,
      serveUrl,
      inputProps: sceneComposition.defaultProps,
      port: RENDER_PORT,
      browserExecutable,
      frame: localFrame,
      imageFormat: "png",
      output: outputStill,
      overwrite: true
    });
  }
  console.log(`分镜关键帧已输出：${sceneEvidenceDir}`);
  process.exit(0);
}
const promo = compositions.find((composition) => composition.id === "BiliScript");
const cover = compositions.find((composition) => composition.id === "Cover");
if (!promo || !cover) throw new Error("未找到 BiliScript / Cover 合成");

const output = draft
  ? path.join(EVIDENCE_DIR, "BiliScript-promo-draft.mp4")
  : path.join(RELEASE_DIR, "BiliScript-promo-1080p.mp4");
if (!stillsOnly && !postOnly) {
  await mkdir(path.dirname(output), {recursive: true});
  await renderMedia({
    composition: promo,
    serveUrl,
    inputProps: {},
    port: RENDER_PORT,
    browserExecutable,
    codec: "h264",
    muted: true,
    crf: draft ? 21 : 15,
    pixelFormat: "yuv420p",
    jpegQuality: 95,
    x264Preset: draft ? "veryfast" : "medium",
    scale: draft ? 0.5 : 1,
    overwrite: true,
    outputLocation: output,
    metadata: {title: "BiliScript｜B 站视频文摘"},
    onProgress: progressLogger(draft ? "试渲染" : "正式渲染")
  });
  console.log(`视频已输出：${output}`);
}

await renderStill({
  composition: cover,
  serveUrl,
  inputProps: {},
  port: RENDER_PORT,
  browserExecutable,
  frame: 0,
  imageFormat: "png",
  output: draft ? path.join(EVIDENCE_DIR, "cover-draft.png") : path.join(RELEASE_DIR, "BiliScript-promo-cover.png"),
  overwrite: true
});
if (!stillsOnly) await muxMasteredAudio(output, output);

const prefix = draft ? "draft" : "final";
const staleFrames = (await readdir(EVIDENCE_DIR)).filter((name) => new RegExp(`^${prefix}-\\d{4}\\.(?:jpg|png)$`).test(name));
await Promise.all(staleFrames.map((name) => unlink(path.join(EVIDENCE_DIR, name))));
const evidenceFrames = EVIDENCE_TIMES.map((seconds) => {
  const frame = Math.round(seconds * PROMO_FPS);
  return {seconds, frame, file: `${prefix}-${String(frame).padStart(4, "0")}.png`};
});
const evidenceSource = await stat(output).catch(() => null);
const renderedVideo = evidenceSource?.isFile() ?? false;

async function writeEvidenceFrames() {
  // 成片已包含全部帧：直接多路抽帧，避免逐帧重开页面重渲 4K 源。
  const ffmpegLimiter = createLimiter(Math.max(2, Math.min(8, availableCpus())));
  await Promise.all(
    evidenceFrames.map((evidenceFrame) =>
      ffmpegLimiter(() =>
        execFileAsync(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            String(Math.max(0, evidenceFrame.frame - 0.5) / PROMO_FPS),
            "-i",
            output,
            "-frames:v",
            "1",
            path.join(EVIDENCE_DIR, evidenceFrame.file)
          ],
          {maxBuffer: 4 * 1024 * 1024}
        )
      )
    )
  );
}

async function renderEvidenceFrames() {
  for (const evidenceFrame of evidenceFrames) {
    await renderStill({
      composition: promo,
      serveUrl,
      inputProps: {},
      port: RENDER_PORT,
      browserExecutable,
      frame: evidenceFrame.frame,
      scale: 1,
      imageFormat: "png",
      output: path.join(EVIDENCE_DIR, evidenceFrame.file),
      overwrite: true
    });
  }
}

let masterOutput = null;
await Promise.all([
  renderedVideo ? writeEvidenceFrames() : renderEvidenceFrames(),
  // 母版编码与关键帧抽取互不依赖，同时跑；母版直接由成片音画重编码。
  draft
    ? null
    : encodeMaster(output).then((file) => {
        masterOutput = file;
      })
]);
await writeFile(
  path.join(EVIDENCE_DIR, `${prefix}-frames.json`),
  JSON.stringify(
    {
      excluded: manifest.excluded,
      ...(evidenceSource
        ? {source: {file: path.relative(REPO_ROOT, output).replaceAll("\\", "/"), size: evidenceSource.size, mtimeMs: evidenceSource.mtimeMs}}
        : {}),
      frames: evidenceFrames
    },
    null,
    2
  ) + "\n",
  "utf8"
);
if (!draft) {
  await writeReleaseText();
  await validateFinalVideo(output, masterOutput);
}
console.log(`关键帧证据已输出：${EVIDENCE_DIR}`);
