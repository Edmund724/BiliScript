import path from "node:path";
import {mkdir, writeFile} from "node:fs/promises";
import {bundle} from "@remotion/bundler";
import {getCompositions, renderMedia, renderStill} from "@remotion/renderer";
import {PROMO_DIR} from "./lib.mjs";
import {preparePromoAssets} from "./prepare.mjs";

await preparePromoAssets();
const evidenceDir = path.join(PROMO_DIR, "evidence", "appearance-05");
const entryPoint = path.join(PROMO_DIR, "appearance-05-entry.tsx");
await mkdir(evidenceDir, {recursive: true});
await writeFile(entryPoint, `import React from "react";
import {AbsoluteFill, Composition, registerRoot} from "remotion";
import {Backdrop, SceneShell} from "../../scripts/promo/video/design";
import {AppearanceScene} from "../../scripts/promo/video/scenes";

const AppearancePreview = () => (
  <AbsoluteFill>
    <Backdrop />
    <SceneShell duration={90} direction={1}>
      <AppearanceScene />
    </SceneShell>
  </AbsoluteFill>
);

export const RemotionRoot = () => (
  <Composition id="Appearance05" component={AppearancePreview} durationInFrames={90} fps={30} width={1920} height={1080} />
);

registerRoot(RemotionRoot);
`, "utf8");

const serveUrl = await bundle({
  entryPoint,
  publicDir: path.join(PROMO_DIR, "public"),
  outDir: path.join(PROMO_DIR, "appearance-05-bundle"),
  rspack: true
});
const compositions = await getCompositions(serveUrl, {inputProps: {}, port: 3105});
const composition = compositions.find((item) => item.id === "Appearance05");
if (!composition) throw new Error("未找到 Appearance05 独立合成");

for (const frame of [12, 30, 44, 50, 62, 78, 86]) {
  const output = path.join(evidenceDir, `frame-${String(frame).padStart(4, "0")}.png`);
  await renderStill({composition, serveUrl, inputProps: {}, port: 3105, frame, imageFormat: "png", output, overwrite: true});
  console.log(`关键帧已输出：${output}`);
}

const output = path.join(evidenceDir, "appearance-05-draft.mp4");
await renderMedia({
  composition,
  serveUrl,
  inputProps: {},
  port: 3105,
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
