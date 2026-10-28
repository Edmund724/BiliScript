import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, attachPage, createWorkerSession, teardown, REPO_ROOT } from "../browser-harness/harness.mjs";
import { PROMO_DIR, SAMPLE_URL, SESSION_FILE, VIEWPORT, readSession, connectPage } from "./lib.mjs";

const PROMO_PROFILE_DIR = path.join(REPO_ROOT, "scripts", "promo", ".browser-profile");

async function start() {
  await mkdir(PROMO_DIR, { recursive: true });
  const browser = await launchBrowser({ headless: false, muted: true, sync: false, viewport: VIEWPORT, extraArgs: ["--force-device-scale-factor=2"], profileDir: PROMO_PROFILE_DIR, detached: true });
  const page = await attachPage(browser, { viewport: VIEWPORT });
  const worker = createWorkerSession({ pageCdp: page.cdp, browser });
  await worker.ensureAlive();
  await page.cdp.send("Page.navigate", { url: SAMPLE_URL });
  const session = { port: browser.port, pid: browser.pid, exe: browser.exe, profileDir: browser.profileDir };
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
  console.log(`演示浏览器已启动：${SAMPLE_URL}`);
  console.log("请在该窗口登录 B 站，然后在文摘面板设置中配置并测试 AI 平台。");
  page.cdp.close();
  worker.handle?.cdp.close();
  browser.child.unref();
  browser.child.stdout.destroy();
  browser.child.stderr.destroy();
}

async function status() {
  const session = await readSession();
  const { cdp, target } = await connectPage(session);
  const state = await cdp.evaluate(`({
    title: document.title,
    subtitleButton: !!document.getElementById('biliscript-script-button'),
    readerOpen: document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false',
    subtitles: document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length,
    overview: document.getElementById('biliscript-reading-overview-body')?.innerText || '',
    chat: document.getElementById('biliscript-reading-chat-messages')?.innerText || ''
  })`);
  console.log(JSON.stringify({ url: target.url, ...state }, null, 2));
  cdp.close();
}

async function stop() {
  const session = await readSession();
  await teardown({ browser: { ...session, child: true, ownsProfile: false } });
  console.log("演示浏览器已停止，专用录屏配置已保留");
}

const command = process.argv[2] || "start";
if (command === "start") await start();
else if (command === "status") await status();
else if (command === "stop") await stop();
else throw new Error(`未知命令：${command}`);
