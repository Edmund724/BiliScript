import path from "node:path";
import { readFile } from "node:fs/promises";
import { CDP, REPO_ROOT } from "../browser-harness/harness.mjs";

export const PROMO_DIR = path.join(REPO_ROOT, ".scratch", "promo");
export const SESSION_FILE = path.join(PROMO_DIR, "session.json");
export const SAMPLE_URL = "https://www.bilibili.com/video/BV1mAam6tEL8/";
export const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false };

export async function readSession() {
  return JSON.parse(await readFile(SESSION_FILE, "utf8"));
}

export async function connectPage(session, { viewport = VIEWPORT } = {}) {
  const response = await fetch(`http://127.0.0.1:${session.port}/json/list`);
  const targets = await response.json();
  const target = targets.find((item) => item.type === "page" && item.url.includes("bilibili.com/video/")) ||
    targets.find((item) => item.type === "page");
  if (!target) throw new Error("找不到演示浏览器页面");
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", viewport);
  return { cdp, target };
}

export async function click(cdp, expression) {
  const point = await cdp.evaluate(`(() => {
    const element = ${expression};
    if (!element) return null;
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!rect.width || !rect.height || !hit || !element.contains(hit)) return { error: '目标不可见或被遮挡' };
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point || point.error) throw new Error(`无法点击 ${expression}: ${JSON.stringify(point)}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
}
