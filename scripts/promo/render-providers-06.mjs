import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {bundle} from "@remotion/bundler";
import {getCompositions, renderStill} from "@remotion/renderer";
import {PROMO_DIR} from "./lib.mjs";
import {preparePromoAssets} from "./prepare.mjs";

await preparePromoAssets();
const evidenceDir = path.join(PROMO_DIR, "evidence", "providers-06");
const entryPoint = path.join(PROMO_DIR, "providers-06-entry.tsx");
await mkdir(evidenceDir, {recursive: true});
await writeFile(entryPoint, `import React from "react";
import {AbsoluteFill, Composition, registerRoot} from "remotion";
import {Backdrop, SceneShell} from "../../scripts/promo/video/design";
import {ProviderScene} from "../../scripts/promo/video/ProviderScene";

const ProviderPreview = () => (
  <AbsoluteFill>
    <Backdrop />
    <SceneShell duration={60}>
      <ProviderScene />
    </SceneShell>
  </AbsoluteFill>
);

export const RemotionRoot = () => (
  <Composition id="Providers06" component={ProviderPreview} durationInFrames={60} fps={30} width={1920} height={1080} />
);

registerRoot(RemotionRoot);
`, "utf8");

const serveUrl = await bundle({
  entryPoint,
  publicDir: path.join(PROMO_DIR, "public"),
  outDir: path.join(PROMO_DIR, "providers-06-bundle"),
  rspack: true
});
const compositions = await getCompositions(serveUrl, {inputProps: {}, port: 3106});
const composition = compositions.find((item) => item.id === "Providers06");
if (!composition) throw new Error("未找到 Providers06 独立合成");

for (const [name, frame] of [["settings", 6], ["editor", 15], ["expanded", 24], ["count", 30], ["peak", 42], ["collapse", 55]]) {
  const output = path.join(evidenceDir, `${name}-frame-${String(frame).padStart(4, "0")}.png`);
  await renderStill({composition, serveUrl, inputProps: {}, port: 3106, frame, imageFormat: "png", output, overwrite: true});
  console.log(`全尺寸静帧已输出：${output}`);
}

for (const [index, frame] of [45, 48, 51, 54, 57, 59].entries()) {
  await renderStill({
    composition,
    serveUrl,
    inputProps: {},
    port: 3106,
    frame,
    imageFormat: "png",
    output: path.join(evidenceDir, `strip-${String(index).padStart(2, "0")}.png`),
    overwrite: true
  });
}
const stripOutput = path.join(evidenceDir, "collapse-10fps.png");
await promisify(execFile)("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-framerate", "10",
  "-i", path.join(evidenceDir, "strip-%02d.png"),
  "-vf", "scale=640:360,tile=3x2",
  "-frames:v", "1",
  "-update", "1",
  stripOutput
]);
console.log(`10fps 转场条带已输出：${stripOutput}`);
