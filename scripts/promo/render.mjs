import path from "node:path";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {bundle} from "@remotion/bundler";
import {getCompositions, getVideoMetadata, renderMedia, renderStill} from "@remotion/renderer";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {preparePromoAssets} from "./prepare.mjs";
import {CAPTIONS, EVIDENCE_TIMES, PROMO_DURATION, PROMO_FPS} from "./timeline.mjs";

const RELEASE_DIR = path.join(REPO_ROOT, "release");
const EVIDENCE_DIR = path.join(PROMO_DIR, "evidence");
const args = new Set(process.argv.slice(2));
const stillsOnly = args.has("--stills-only");
const draft = args.has("--draft") || stillsOnly;

function srtTime(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function validateCaptions() {
  let previousEnd = 0;
  for (const caption of CAPTIONS) {
    if (!caption.text.trim() || !Number.isSafeInteger(caption.startMs) || !Number.isSafeInteger(caption.endMs)) {
      throw new Error(`字幕内容或时间无效：${JSON.stringify(caption)}`);
    }
    if (caption.startMs < previousEnd || caption.endMs <= caption.startMs || caption.endMs > PROMO_DURATION / PROMO_FPS * 1000) {
      throw new Error(`字幕时间范围无效：${JSON.stringify(caption)}`);
    }
    previousEnd = caption.endMs;
  }
}

validateCaptions();

async function writeReleaseText() {
  const srt = CAPTIONS.map((caption, index) => `${index + 1}\n${srtTime(caption.startMs / 1000)} --> ${srtTime(caption.endMs / 1000)}\n${caption.text}\n`).join("\n");
  const credits = `演示视频：复旦赵斌《AI并非越强越好，适配才是关键》\nhttps://www.bilibili.com/video/BV1mAam6tEL8/\n\n音乐：“Wholesome” Kevin MacLeod (incompetech.com)\nhttps://incompetech.com/music/royalty-free/index.html?isrc=USUAN1900022\nLicensed under Creative Commons: By Attribution 4.0 License\nhttps://creativecommons.org/licenses/by/4.0/\n\nBiliScript\nhttps://github.com/Edmund724/BiliScript\n`;
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

async function validateFinalVideo(output) {
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
  await writeFile(path.join(EVIDENCE_DIR, "final-metadata.json"), JSON.stringify({...metadata, fastStart: true}, null, 2) + "\n", "utf8");
}

const {publicDir, manifest} = await preparePromoAssets();
for (const [name, duration] of [["subtitle.mp4", 10], ["overview.mp4", 12], ["chat.mp4", 15], ["appearance.mp4", 8]]) {
  const metadata = await getVideoMetadata(path.join(publicDir, "media", name));
  if (metadata.width !== 1920 || metadata.height !== 1080 || metadata.fps !== PROMO_FPS || Math.abs(metadata.durationInSeconds - duration) > 0.05) {
    throw new Error(`素材规格不符 ${name}：${JSON.stringify(metadata)}`);
  }
}
await mkdir(EVIDENCE_DIR, {recursive: true});
console.log("素材校验通过；01-intro 不在素材清单中");

const RENDER_PORT = 3100;
const serveUrl = await bundle({
  entryPoint: path.join(REPO_ROOT, "scripts", "promo", "index.ts"),
  publicDir,
  outDir: path.join(PROMO_DIR, "render-bundle"),
  rspack: true,
  onProgress: progressLogger("打包", true)
});
const compositions = await getCompositions(serveUrl, {inputProps: {}, port: RENDER_PORT});
const promo = compositions.find((composition) => composition.id === "BiliScript");
const cover = compositions.find((composition) => composition.id === "Cover");
if (!promo || !cover) throw new Error("未找到 BiliScript / Cover 合成");

const output = draft
  ? path.join(EVIDENCE_DIR, "BiliScript-promo-draft.mp4")
  : path.join(RELEASE_DIR, "BiliScript-promo-1080p.mp4");
if (!stillsOnly) {
  await mkdir(path.dirname(output), {recursive: true});
  await renderMedia({
    composition: promo,
    serveUrl,
    inputProps: {},
    port: RENDER_PORT,
    codec: "h264",
    audioCodec: "aac",
    audioBitrate: "192k",
    crf: draft ? 21 : 17,
    pixelFormat: "yuv420p",
    jpegQuality: 95,
    x264Preset: draft ? "veryfast" : "medium",
    scale: draft ? 0.5 : 1,
    concurrency: draft ? 4 : 3,
    enforceAudioTrack: true,
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
  frame: 0,
  imageFormat: "png",
  output: draft ? path.join(EVIDENCE_DIR, "cover-draft.png") : path.join(RELEASE_DIR, "BiliScript-promo-cover.png"),
  overwrite: true
});
if (!draft) {
  await writeReleaseText();
  await validateFinalVideo(output);
}

const prefix = draft ? "draft" : "final";
const evidenceFrames = [];
for (const seconds of EVIDENCE_TIMES) {
  const frame = Math.round(seconds * PROMO_FPS);
  const file = `${prefix}-${String(frame).padStart(4, "0")}.jpg`;
  await renderStill({
    composition: promo,
    serveUrl,
    inputProps: {},
    port: RENDER_PORT,
    frame,
    scale: 0.5,
    imageFormat: "jpeg",
    jpegQuality: 92,
    output: path.join(EVIDENCE_DIR, file),
    overwrite: true
  });
  evidenceFrames.push({seconds, frame, file});
}
await writeFile(path.join(EVIDENCE_DIR, `${prefix}-frames.json`), JSON.stringify({excluded: manifest.excluded, frames: evidenceFrames}, null, 2) + "\n", "utf8");
console.log(`关键帧证据已输出：${EVIDENCE_DIR}`);
