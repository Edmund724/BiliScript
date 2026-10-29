import path from "node:path";
import {REPO_ROOT} from "../browser-harness/harness.mjs";

export const PROMO_MEDIA_DIR = path.join(REPO_ROOT, "scripts", "promo", "public", "media");

export const RECORDED_MEDIA_FILES = [
  "hero-hook.mp4",
  "hero-panel.png",
  "overview-poster.jpg",
  "subtitle-seek-03.mp4",
  "chat.mp4",
  "ai-providers.mp4"
];

export function recordedMediaPath(name) {
  if (!RECORDED_MEDIA_FILES.includes(name)) throw new Error(`未知宣传片录制素材：${name}`);
  return path.join(PROMO_MEDIA_DIR, name);
}
