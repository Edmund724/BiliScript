import path from "node:path";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {REPO_ROOT} from "../browser-harness/harness.mjs";

export const PANEL_CROPS_FILE = path.join(REPO_ROOT, "scripts", "promo", "generated", "panel-crops.json");

const PANEL_RECORDINGS = {
  hero: "00-hero-hook",
  overview: "04-overview-chapters",
  chat: "04-chat"
};

function validateCrop(panel, context) {
  if (!panel || ![panel.x, panel.y, panel.width, panel.height].every(Number.isFinite) || panel.width <= 0 || panel.height <= 0) {
    throw new Error(`${context} 缺少有效的面板边界`);
  }
  return panel;
}

export async function readPanelCrops() {
  const text = await readFile(PANEL_CROPS_FILE, "utf8").catch((error) => {
    if (error?.code !== "ENOENT") throw error;
    throw new Error("宣传片裁剪框缺失：请恢复已提交的 generated/panel-crops.json，或完整重录 overview、chat");
  });
  const crops = JSON.parse(text);
  for (const scene of Object.keys(PANEL_RECORDINGS)) {
    validateCrop(crops[scene], `宣传片裁剪框 ${scene}`);
  }
  return crops;
}

export async function updateRecordedPanelCrop(scene, recordings) {
  const recordingName = PANEL_RECORDINGS[scene];
  if (!recordingName) return null;
  const metadataPath = recordings.find((file) => path.basename(path.dirname(file)) === recordingName && path.basename(file) === "frames.json");
  if (!metadataPath) throw new Error(`镜头 ${scene} 缺少 ${recordingName}/frames.json，无法更新裁剪框`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const current = await readFile(PANEL_CROPS_FILE, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const crops = current === null ? {} : await readPanelCrops();
  crops[scene] = validateCrop(metadata.panel, `录制 ${recordingName}`);
  await mkdir(path.dirname(PANEL_CROPS_FILE), {recursive: true});
  await writeFile(PANEL_CROPS_FILE, JSON.stringify(crops, null, 2) + "\n", "utf8");
  return PANEL_CROPS_FILE;
}
