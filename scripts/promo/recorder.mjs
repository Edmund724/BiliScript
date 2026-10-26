import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PROMO_DIR } from "./lib.mjs";
import { assertPromoCaptureClean, preparePromoCapture } from "./capture.mjs";

export async function recordScene(cdp, name, action) {
  const directory = path.join(PROMO_DIR, "frames", name);
  await mkdir(directory, { recursive: true });
  const frames = [];
  let active = true;
  const startedAt = Date.now();
  await cdp.send("Page.bringToFront");
  await preparePromoCapture(cdp);
  const captureLoop = (async () => {
    while (active) {
      await cdp.evaluate("window.__biliscriptPromoScrub?.(); true");
      const result = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true, captureBeyondViewport: false });
      const index = frames.length;
      const file = path.join(directory, `${String(index).padStart(6, "0")}.jpg`);
      frames.push({ file, at: Date.now() - startedAt });
      await writeFile(file, Buffer.from(result.data, "base64"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  try {
    await action();
    await assertPromoCaptureClean(cdp);
  } finally {
    active = false;
    await captureLoop;
  }
  if (!frames.length) throw new Error(`分镜 ${name} 没有录到画面`);
  let concat = "ffconcat version 1.0\n";
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const duration = index + 1 < frames.length ? Math.max(0.034, (frames[index + 1].at - frame.at) / 1000) : 0.5;
    concat += `file '${frame.file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'\nduration ${duration.toFixed(3)}\n`;
  }
  concat += `file '${frames.at(-1).file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'\n`;
  const manifest = path.join(directory, "frames.ffconcat");
  await writeFile(manifest, concat, "utf8");
  const metadata = path.join(directory, "frames.json");
  await writeFile(metadata, JSON.stringify({ name, duration: (frames.at(-1).at + 500) / 1000, frames }, null, 2), "utf8");
  console.log(`分镜 ${name}：${frames.length} 帧，${((frames.at(-1).at + 500) / 1000).toFixed(1)} 秒`);
  return { directory, manifest, metadata, duration: (frames.at(-1).at + 500) / 1000 };
}
