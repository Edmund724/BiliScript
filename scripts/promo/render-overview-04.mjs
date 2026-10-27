import path from "node:path";
import {mkdir, writeFile} from "node:fs/promises";
import {bundle} from "@remotion/bundler";
import {getCompositions, renderMedia, renderStill} from "@remotion/renderer";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";

const evidenceDir = path.join(PROMO_DIR, "evidence", "overview-04");
const entryPoint = path.join(PROMO_DIR, "overview-04-entry.tsx");
await mkdir(evidenceDir, {recursive: true});
await writeFile(entryPoint, `import React from "react";
import {AbsoluteFill, Composition, registerRoot} from "remotion";
import {Backdrop, SceneShell} from "../../scripts/promo/video/design";
import {OverviewScene} from "../../scripts/promo/video/OverviewScene";

const OverviewPreview = () => (
  <AbsoluteFill>
    <Backdrop />
    <SceneShell duration={132}>
      <OverviewScene duration={132} />
    </SceneShell>
  </AbsoluteFill>
);

export const RemotionRoot = () => (
  <Composition
    id="Overview04"
    component={OverviewPreview}
    durationInFrames={132}
    fps={30}
    width={1920}
    height={1080}
  />
);

registerRoot(RemotionRoot);
`, "utf8");

const serveUrl = await bundle({
  entryPoint,
  publicDir: path.join(REPO_ROOT, "scripts", "promo", "public"),
  outDir: path.join(PROMO_DIR, "overview-04-bundle"),
  rspack: true
});
const compositions = await getCompositions(serveUrl, {inputProps: {}, port: 3104});
const composition = compositions.find((item) => item.id === "Overview04");
if (!composition) throw new Error("未找到 Overview04 独立合成");

for (const frame of [12, 50, 62, 74, 92, 108, 125]) {
  const output = path.join(evidenceDir, `frame-${String(frame).padStart(4, "0")}.png`);
  await renderStill({
    composition,
    serveUrl,
    inputProps: {},
    port: 3104,
    frame,
    imageFormat: "png",
    output,
    overwrite: true
  });
  console.log(`关键帧已输出：${output}`);
}

const output = path.join(evidenceDir, "overview-04-draft.mp4");
await renderMedia({
  composition,
  serveUrl,
  inputProps: {},
  port: 3104,
  codec: "h264",
  crf: 20,
  pixelFormat: "yuv420p",
  x264Preset: "veryfast",
  scale: 0.5,
  concurrency: 4,
  overwrite: true,
  outputLocation: output
});
console.log(`独立试片已输出：${output}`);
