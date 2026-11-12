import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function runCli(command: "status" | "tabs" | "subtitles" | "comments" | "frame", args: string[] = []): Promise<Record<string, unknown>> {
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
      const targetTime = (message.options as { targetTime?: unknown } | undefined)?.targetTime;
      const frameTimes = typeof targetTime === "number" ? [targetTime - 2, targetTime, targetTime + 2] : [12.5];
      const result = message.command === "subtitles"
        ? { video: { bvid: "BV1test000000" }, subtitle: { items: [{ from: 10, to: 12, content: "字幕" }] } }
        : message.command === "comments"
          ? { video: { bvid: "BV1test000000" }, comments: [{ uname: "观众", like: 9, message: "热评" }] }
          : message.command === "frame"
            ? {
                bvid: "BV1test000000",
                cid: "123456",
                frames: frameTimes.map((time) => ({
                  data: "/9j/2Q==",
                  targetTime: time,
                  currentTime: time + (typeof targetTime === "number" ? 0.05 : 0)
                }))
              }
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

  it("frame 写入当前帧与历史三帧 JPEG，输出绝对路径和逐帧时间", async () => {
    const current = await runCli("frame", ["--tab", "42"]);
    const currentFrames = current.frames as Array<{ path: string; targetTime: number; currentTime: number; data?: string }>;
    const defaultOut = dirname(currentFrames[0].path);
    try {
      expect(current).toMatchObject({ ok: true, command: "frame", extensionOnline: true, bvid: "BV1test000000" });
      expect(currentFrames).toHaveLength(1);
      expect(currentFrames[0]).toMatchObject({ targetTime: 12.5, currentTime: 12.5 });
      expect(currentFrames[0].path).toBe(resolve(currentFrames[0].path));
      expect(currentFrames[0].data).toBeUndefined();
      expect(readFileSync(currentFrames[0].path, "base64")).toBe("/9j/2Q==");
    } finally {
      rmSync(defaultOut, { recursive: true, force: true });
    }

    const out = join(scratch, "frames");
    const historical = await runCli("frame", ["--bvid", "BV1test000000", "--time", "10", "--out", out]);
    const historicalFrames = historical.frames as Array<{ path: string; targetTime: number; currentTime: number }>;
    expect(historicalFrames.map((frame) => frame.targetTime)).toEqual([8, 10, 12]);
    expect(historicalFrames.map((frame) => frame.currentTime)).toEqual([8.05, 10.05, 12.05]);
    expect(historicalFrames.every((frame) => dirname(frame.path) === resolve(out))).toBe(true);
    expect(historicalFrames.every((frame) => readFileSync(frame.path, "base64") === "/9j/2Q==")).toBe(true);
    expect(extensionRequests).toContainEqual({
      type: "request",
      id: expect.any(String),
      command: "frame",
      options: { tabId: 42 }
    });
    expect(extensionRequests).toContainEqual({
      type: "request",
      id: expect.any(String),
      command: "frame",
      options: { bvid: "BV1test000000", targetTime: 10 }
    });
  });

  it("并发截帧逐条转发且复用同一个 Daemon", async () => {
    const previous = extension?.onMessage;
    let active = 0;
    let maxActive = 0;
    if (extension) {
      extension.onMessage = (message: { type?: string; id?: string; command?: string }) => {
        if (message.type !== "request") return;
        if (message.command !== "frame") {
          previous?.(message as never);
          return;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active -= 1;
          extension?.sendJSON({
            type: "response",
            id: message.id,
            ok: true,
            result: {
              bvid: "BV1test000000",
              cid: "123456",
              frames: [8, 10, 12].map((time) => ({
                data: "/9j/2Q==",
                targetTime: time,
                currentTime: time
              }))
            }
          });
        }, 30);
      };
    }
    try {
      const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        runCli("frame", ["--bvid", "BV1test000000", "--time", "10", "--out", join(scratch, `concurrent-${index}`)])
      ));
      expect(maxActive).toBe(1);
      expect(results.every((result) => result.ok === true)).toBe(true);
      expect(new Set(results.map((result) => result.daemonPid))).toEqual(new Set([daemonPid]));
    } finally {
      if (extension) extension.onMessage = previous;
    }
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
