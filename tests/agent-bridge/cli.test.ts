import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connectWebSocket } from "../../skills/biliscript/scripts/biliscript.mjs";

const port = 21000 + Math.floor(Math.random() * 1000);
const scratch = mkdtempSync(join(process.cwd(), ".scratch", "agent-bridge-test-"));
const script = resolve("skills/biliscript/scripts/biliscript.mjs");
const env = {
  ...process.env,
  BILISCRIPT_BRIDGE_PORT: String(port),
  BILISCRIPT_BRIDGE_TOKEN_PATH: join(scratch, "token"),
  BILISCRIPT_BRIDGE_IDLE_MS: "2500"
};
let daemonPid = 0;
let extension: Awaited<ReturnType<typeof connectWebSocket>> | null = null;

function runCli(command: "status" | "tabs"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, command], { env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

afterAll(() => {
  extension?.close();
  if (daemonPid) {
    try {
      process.kill(daemonPid);
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("桌面 Agent CLI 端到端", () => {
  it("首次 status 自动拉起单实例 Daemon", async () => {
    const status = await runCli("status");
    expect(status).toMatchObject({
      ok: true,
      command: "status",
      bridgeOnline: true,
      extensionOnline: false
    });
    daemonPid = Number(status.daemonPid);
    expect(daemonPid).toBeGreaterThan(0);
  });

  it("tabs 经真实 Daemon 返回扩展快照的完整字段", async () => {
    extension = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"a".repeat(32)}`
    });
    extension.sendJSON({ type: "hello", role: "extension", version: 1 });
    extension.onMessage = (message: { type?: string; id?: string; command?: string }) => {
      if (message.type !== "request" || message.command !== "tabs") return;
      extension?.sendJSON({
        type: "response",
        id: message.id,
        ok: true,
        result: {
          tabs: [{
            tabId: 42,
            bvid: "BV1test000000",
            cid: "123456",
            title: "桥接测试视频",
            currentTime: 12.5,
            duration: 120,
            subtitlesReady: true
          }]
        }
      });
    };

    const result = await runCli("tabs");
    expect(result).toMatchObject({
      ok: true,
      command: "tabs",
      bridgeOnline: true,
      extensionOnline: true,
      tabs: [{
        tabId: 42,
        bvid: "BV1test000000",
        cid: "123456",
        title: "桥接测试视频",
        currentTime: 12.5,
        duration: 120,
        subtitlesReady: true
      }]
    });
  });

  it("并发终端复用同一个 Daemon", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => runCli("status")));
    expect(new Set(results.map((result) => result.daemonPid))).toEqual(new Set([daemonPid]));
    expect(results.every((result) => result.extensionOnline === true)).toBe(true);
  });

  it("普通网页来源不能冒充扩展", async () => {
    await expect(connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: "https://www.bilibili.com"
    })).rejects.toThrow("拒绝连接");
  });

  it("空闲超时后自动退出", async () => {
    extension?.close();
    extension = null;
    await new Promise((resolve) => setTimeout(resolve, 4200));
    expect(() => process.kill(daemonPid, 0)).toThrow();
    daemonPid = 0;
  });
});
