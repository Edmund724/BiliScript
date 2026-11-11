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
const extensionRequests: Array<{ command?: string; options?: unknown }> = [];

function runCli(command: "status" | "tabs" | "subtitles" | "comments", args: string[] = []): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, command, ...args], { env }, (error, stdout, stderr) => {
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
    extension.onMessage = (message: { type?: string; id?: string; command?: string; options?: unknown }) => {
      if (message.type !== "request") return;
      extensionRequests.push(message);
      const result = message.command === "subtitles"
        ? { video: { bvid: "BV1test000000" }, subtitle: { items: [{ from: 10, to: 12, content: "字幕" }] } }
        : message.command === "comments"
          ? { video: { bvid: "BV1test000000" }, comments: [{ uname: "观众", like: 9, message: "热评" }] }
          : {
              tabs: [{
                tabId: 42,
                bvid: "BV1test000000",
                cid: "123456",
                title: "桥接测试视频",
                currentTime: 12.5,
                duration: 120,
                subtitlesReady: true
              }]
            };
      extension?.sendJSON({ type: "response", id: message.id, ok: true, result });
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

  it("subtitles 与 comments 经真实 Daemon 转发参数并返回结构化结果", async () => {
    const subtitles = await runCli("subtitles", [
      "--bvid", "https://www.bilibili.com/video/BV1test000000/?p=2",
      "--from", "10",
      "--to", "20"
    ]);
    expect(subtitles).toMatchObject({
      ok: true,
      command: "subtitles",
      extensionOnline: true,
      subtitle: { items: [{ content: "字幕" }] }
    });
    const comments = await runCli("comments", ["--tab", "42"]);
    expect(comments).toMatchObject({ ok: true, command: "comments", comments: [{ message: "热评" }] });
    expect(extensionRequests).toContainEqual({
      type: "request",
      id: expect.any(String),
      command: "subtitles",
      options: { bvid: "https://www.bilibili.com/video/BV1test000000/?p=2", from: 10, to: 20 }
    });
    expect(extensionRequests).toContainEqual({
      type: "request",
      id: expect.any(String),
      command: "comments",
      options: { tabId: 42 }
    });
  });

  it("扩展业务错误不会触发 Daemon 重启或重复执行", async () => {
    const previous = extension?.onMessage;
    extensionRequests.length = 0;
    if (extension) {
      extension.onMessage = (message: { type?: string; id?: string; command?: string }) => {
        if (message.type !== "request") return;
        extensionRequests.push(message);
        extension?.sendJSON({ type: "response", id: message.id, ok: false, error: "请配置 ASR" });
      };
    }
    await expect(runCli("subtitles", ["--bvid", "BV1test000000"])).rejects.toThrow("请配置 ASR");
    expect(extensionRequests).toHaveLength(1);
    if (extension) extension.onMessage = previous;
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
