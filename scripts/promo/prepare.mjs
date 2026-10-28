import path from "node:path";
import {fileURLToPath} from "node:url";
import {copyFile, mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {AUDIO} from "./audio.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";

export const PROMO_PUBLIC_DIR = path.join(PROMO_DIR, "public");

const PROMO_MEDIA_DIR = path.join(REPO_ROOT, "scripts", "promo", "public", "media");

const sources = {
  "hero-hook.mp4": path.join(PROMO_MEDIA_DIR, "hero-hook.mp4"),
  "hero-panel.png": path.join(PROMO_MEDIA_DIR, "hero-panel.png"),
  "overview-04-chapters.mp4": path.join(PROMO_MEDIA_DIR, "overview-04-chapters.mp4"),
  "overview-04-quote.mp4": path.join(PROMO_MEDIA_DIR, "overview-04-quote.mp4"),
  "overview-poster.jpg": path.join(PROMO_MEDIA_DIR, "overview-poster.jpg"),
  "subtitle-seek-03.mp4": path.join(PROMO_MEDIA_DIR, "subtitle-seek-03.mp4"),
  "chat.mp4": path.join(PROMO_MEDIA_DIR, "chat.mp4"),
  "appearance.mp4": path.join(PROMO_MEDIA_DIR, "appearance.mp4"),
  "ai-providers.mp4": path.join(PROMO_MEDIA_DIR, "ai-providers.mp4"),
  ...Object.fromEntries(PROVIDER_LOGOS.map((logo) => [`providers/${logo.file}`, path.join(REPO_ROOT, "scripts", "promo", "assets", "providers", logo.file)])),
  "promo-score.wav": path.join(PROMO_DIR, "assets", "audio", "promo-score.wav"),
  ...Object.fromEntries([...new Set([...AUDIO.cues, ...(AUDIO.voices ?? [])].map((cue) => cue.src.replace("media/", "")))].map((name) => [name, path.join(PROMO_DIR, "assets", "audio", name)])),
  "logo.svg": path.join(REPO_ROOT, "docs", "images", "biliscript-logo.svg")
};

const panelRecordings = {
  overview: "04-overview-chapters",
  chat: "04-chat",
  appearance: "05-appearance-motion"
};

async function writeRecordedPanelCrops() {
  const destination = path.join(REPO_ROOT, "scripts", "promo", "generated", "panel-crops.json");
  const recordings = await Promise.all(Object.entries(panelRecordings).map(async ([name, recording]) => {
    const text = await readFile(path.join(PROMO_DIR, "frames", recording, "frames.json"), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    return {name, recording, text};
  }));
  const missing = recordings.filter(({text}) => text === null);
  if (missing.length === recordings.length) {
    const fallback = await stat(destination).catch(() => null);
    if (!fallback?.isFile()) {
      throw new Error("宣传片裁剪框缺失：请恢复已提交的 generated/panel-crops.json，或完整录制 overview、chat、appearance");
    }
    return;
  }
  if (missing.length > 0) {
    const names = missing.map(({recording}) => `${recording}/frames.json`).join("、");
    throw new Error(`宣传片录制帧不完整：缺少 ${names}；请补齐三份录制帧，或移除全部录制帧以沿用已提交裁剪框`);
  }
  const crops = {};
  for (const {name, recording, text} of recordings) {
    const metadata = JSON.parse(text);
    const panel = metadata.panel;
    if (!panel || ![panel.x, panel.y, panel.width, panel.height].every(Number.isFinite) || panel.width <= 0 || panel.height <= 0) {
      throw new Error(`录制 ${recording} 缺少有效的面板边界`);
    }
    crops[name] = panel;
  }
  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, JSON.stringify(crops, null, 2) + "\n", "utf8");
}

export async function preparePromoAssets() {
  await writeRecordedPanelCrops();
  const mediaDir = path.join(PROMO_PUBLIC_DIR, "media");
  await mkdir(mediaDir, {recursive: true});
  const files = [];
  for (const [name, source] of Object.entries(sources)) {
    const info = await stat(source).catch(() => null);
    if (!info?.isFile() || info.size < 100) {
      throw new Error(`宣传片素材缺失或为空：${path.relative(REPO_ROOT, source)}`);
    }
    const destination = path.join(mediaDir, name);
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFile(source, destination);
    files.push({name, source: path.relative(REPO_ROOT, source).replaceAll("\\", "/"), bytes: info.size});
  }
  if (PROVIDER_LOGOS.length !== 14 || new Set(PROVIDER_LOGOS.map((logo) => logo.id)).size !== 14) {
    throw new Error("平台 Logo 必须恰好覆盖 14 个 AI 平台预设");
  }
  const manifest = {mediaRoot: "media", excluded: ["01-intro"], files};
  await writeFile(path.join(PROMO_PUBLIC_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const logoEvidenceDir = path.join(PROMO_DIR, "evidence");
  await mkdir(logoEvidenceDir, {recursive: true});
  await writeFile(path.join(logoEvidenceDir, "provider-logos.json"), JSON.stringify(PROVIDER_LOGOS.map((logo) => ({
    ...logo,
    localFile: `scripts/promo/assets/providers/${logo.file}`
  })), null, 2) + "\n", "utf8");
  return {publicDir: PROMO_PUBLIC_DIR, manifest};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {manifest} = await preparePromoAssets();
  console.log(`宣传片素材已准备：${manifest.files.length} 个文件；01-intro 已排除`);
}
