import path from "node:path";
import { readFile } from "node:fs/promises";
import { launchBrowser, attachPage, screenshot, teardown, REPO_ROOT } from "../browser-harness/harness.mjs";
import { PROMO_DIR, VIEWPORT } from "./lib.mjs";

const logo = await readFile(path.join(REPO_ROOT, "docs", "images", "biliscript-logo.svg"), "utf8");
const coverFrame = await readFile(path.join(PROMO_DIR, "frames", "03-overview", "000000.jpg"), "base64");
const logoUrl = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;
const common = `
  * { box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; margin: 0; overflow: hidden; }
  body { font-family: "Microsoft YaHei", "Noto Sans SC", sans-serif; }
  img.logo { width: 112px; height: 112px; border-radius: 25px; box-shadow: 0 18px 50px #f0508a33; }
  .brand { display: flex; align-items: center; gap: 28px; }
  h1 { margin: 0; font-size: 76px; line-height: 1.15; letter-spacing: -2px; }
  .en { font-size: 26px; letter-spacing: 4px; font-weight: 600; opacity: .62; margin-bottom: 10px; }
`;

function endCard() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${common}
    body { color: #172033; background: radial-gradient(circle at 16% 12%, #fff 0, #edf5ff 32%, #e7effc 66%, #f8ecf4 100%); }
    body::before { content: ""; position: absolute; width: 700px; height: 700px; right: -100px; top: -180px; border-radius: 50%; background: #ffffff80; filter: blur(4px); }
    main { position: relative; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .brand { flex-direction: column; gap: 30px; }
    h1 { font-size: 82px; }
    .tagline { margin-top: 26px; font-size: 34px; color: #526078; letter-spacing: 2px; }
    .actions { display: flex; gap: 18px; margin-top: 62px; }
    .action { padding: 20px 30px; border: 1px solid #ffffffb0; border-radius: 18px; background: #ffffffa8; box-shadow: 0 12px 36px #52607816; font-size: 25px; color: #263650; }
    .action.primary { color: white; background: #2188e9; border-color: #2188e9; }
    .credit { position: absolute; bottom: 34px; font-size: 17px; color: #6f7a8d; }
  </style></head><body><main>
    <div class="brand"><img class="logo" src="${logoUrl}"><div><div class="en">BILISCRIPT</div><h1>B 站视频文摘</h1></div></div>
    <div class="tagline">不离开视频页，读懂整条视频</div>
    <div class="actions"><div class="action primary">Edge 应用商店 · 即装即用</div><div class="action">github.com/Edmund724/BiliScript</div></div>
    <div class="credit">Music: “Wholesome” — Kevin MacLeod (incompetech.com) · CC BY 4.0</div>
  </main></body></html>`;
}

function coverCard() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${common}
    body { color: white; background: url(data:image/jpeg;base64,${coverFrame}) center/cover no-repeat; }
    .shade { position: absolute; inset: 0; background: linear-gradient(90deg, #101b31f5 0%, #101b31e8 32%, #101b3190 52%, #101b3108 78%); }
    main { position: relative; width: 750px; padding: 220px 0 0 86px; }
    .brand { gap: 22px; }
    img.logo { width: 94px; height: 94px; }
    .en { color: #a8c7ee; margin: 0 0 5px; }
    h2 { margin: 0; font-size: 46px; }
    h1 { margin-top: 64px; font-size: 72px; line-height: 1.3; letter-spacing: 1px; }
    .tagline { margin-top: 28px; font-size: 29px; line-height: 1.6; color: #d5e4f8; }
    .pill { display: inline-block; margin-top: 48px; padding: 14px 22px; border-radius: 999px; background: #ffffff18; border: 1px solid #ffffff28; color: #eef5ff; font-size: 22px; }
  </style></head><body><div class="shade"></div><main>
    <div class="brand"><img class="logo" src="${logoUrl}"><div><div class="en">BILISCRIPT</div><h2>B 站视频文摘</h2></div></div>
    <h1>不离开视频页<br>读懂整条视频</h1>
    <div class="tagline">字幕阅读 · AI 概览 · 随片追问</div>
    <div class="pill">开源浏览器扩展</div>
  </main></body></html>`;
}

const browser = await launchBrowser({ viewport: VIEWPORT });
const page = await attachPage(browser, { viewport: VIEWPORT });
try {
  for (const [name, html] of [["end", endCard()], ["cover", coverCard()]]) {
    await page.cdp.send("Page.setDocumentContent", { frameId: page.target.id, html });
    await page.cdp.evaluate("document.fonts.ready.then(() => true)");
    await screenshot(page.cdp, path.join(PROMO_DIR, "assets", `${name}.png`));
  }
} finally {
  await teardown({ browser, cdps: [page.cdp] });
}
