import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir} from "node:fs/promises";
import {promisify} from "node:util";
import {bundle} from "@remotion/bundler";
import {getCompositions, renderStill} from "@remotion/renderer";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {preparePromoAssets} from "./prepare.mjs";

await preparePromoAssets();
const evidenceDir = path.join(PROMO_DIR, "evidence", "outro-07");
await mkdir(evidenceDir, {recursive: true});
const serveUrl = await bundle({
  entryPoint: path.join(REPO_ROOT, "scripts", "promo", "index.ts"),
  publicDir: path.join(PROMO_DIR, "public"),
  outDir: path.join(PROMO_DIR, "outro-07-bundle"),
  rspack: true
});
const compositions = await getCompositions(serveUrl, {inputProps: {}, port: 3107});
const composition = compositions.find((item) => item.id === "BiliScript");
if (!composition) throw new Error("未找到 BiliScript 合成");

async function still(frame, output) {
  await renderStill({composition, serveUrl, inputProps: {}, port: 3107, frame, imageFormat: "png", output, overwrite: true});
}

const stills = [
  ...OUTRO_TIMELINE.features.map((feature) => [feature.id, feature.at]),
  ["common-hold", 84],
  ["converged", OUTRO_TIMELINE.convergeAt + 16]
];
for (const [name, localFrame] of stills) {
  const frame = OUTRO_TIMELINE.from + localFrame;
  const output = path.join(evidenceDir, `${name}-frame-${frame}.png`);
  await still(frame, output);
  console.log(`全尺寸静帧已输出：${output}`);
}

async function strip(name, first, last, tile) {
  const frames = [];
  for (let frame = first; frame <= last; frame += 3) frames.push(frame);
  for (const [index, frame] of frames.entries()) {
    await still(frame, path.join(evidenceDir, `${name}-${String(index).padStart(2, "0")}.png`));
  }
  const output = path.join(evidenceDir, `${name}-10fps.png`);
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "10",
    "-i", path.join(evidenceDir, `${name}-%02d.png`),
    "-vf", `scale=640:360,tile=${tile}`,
    "-frames:v", "1",
    "-update", "1",
    output
  ]);
  console.log(`10fps 条带已输出：${output}`);
}

await strip("provider-handoff", 648, 675, "5x2");
await strip("feature-reveal", 667, 720, "6x3");
await strip("feature-converge", 762, 786, "3x3");
