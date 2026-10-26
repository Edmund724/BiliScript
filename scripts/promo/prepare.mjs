import path from "node:path";
import {fileURLToPath} from "node:url";
import {copyFile, mkdir, stat, writeFile} from "node:fs/promises";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";

export const PROMO_PUBLIC_DIR = path.join(PROMO_DIR, "public");

const sources = {
  "hero-hook.mp4": path.join(REPO_ROOT, "scripts", "promo", "public", "media", "hero-hook.mp4"),
  "hero-panel.png": path.join(REPO_ROOT, "scripts", "promo", "public", "media", "hero-panel.png"),
  "overview-04-chapters.mp4": path.join(REPO_ROOT, "scripts", "promo", "public", "media", "overview-04-chapters.mp4"),
  "overview-04-quote.mp4": path.join(REPO_ROOT, "scripts", "promo", "public", "media", "overview-04-quote.mp4"),
  "subtitle-seek-03.mp4": path.join(REPO_ROOT, "scripts", "promo", "public", "media", "subtitle-seek-03.mp4"),
  "chat.mp4": path.join(PROMO_DIR, "clips", "04-chat.mp4"),
  "appearance.mp4": path.join(PROMO_DIR, "clips", "05-appearance.mp4"),
  "overview-poster.jpg": path.join(PROMO_DIR, "frames", "03-overview", "000000.jpg"),
  "Wholesome.mp3": path.join(PROMO_DIR, "assets", "Wholesome.mp3"),
  "logo.svg": path.join(REPO_ROOT, "docs", "images", "biliscript-logo.svg")
};

export async function preparePromoAssets() {
  const mediaDir = path.join(PROMO_PUBLIC_DIR, "media");
  await mkdir(mediaDir, {recursive: true});
  const files = [];
  for (const [name, source] of Object.entries(sources)) {
    const info = await stat(source).catch(() => null);
    if (!info?.isFile() || info.size < 100) {
      throw new Error(`宣传片素材缺失或为空：${path.relative(REPO_ROOT, source)}`);
    }
    const destination = path.join(mediaDir, name);
    await copyFile(source, destination);
    files.push({name, source: path.relative(REPO_ROOT, source).replaceAll("\\", "/"), bytes: info.size});
  }
  const manifest = {mediaRoot: "media", excluded: ["01-intro"], files};
  await writeFile(path.join(PROMO_PUBLIC_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return {publicDir: PROMO_PUBLIC_DIR, manifest};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {manifest} = await preparePromoAssets();
  console.log(`宣传片素材已准备：${manifest.files.length} 个文件；01-intro 已排除`);
}
