import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SUBTITLE_INLINE_MAX_BYTES,
  applySubtitleSpillover,
  connectWebSocket,
  formatSubtitleClock
} from "../../skills/biliscript/scripts/biliscript.mjs";
import { formatClock } from "../../extension/shared/clock-text.js";
import { buildTxt } from "../../extension/notes/render.js";

const port = 21000 + Math.floor(Math.random() * 1000);
mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
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

function runCli(
  command: "status" | "tabs" | "fetch" | "subtitles" | "comments" | "frame",
  args: string[] = []
): Promise<Record<string, unknown>> {
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

  it("fetch 单趟合并拉取元信息、分P、章节、短字幕内联与热评，并支持 --out 与 --from/--to", async () => {
    const previous = extension?.onMessage;
    extensionRequests.length = 0;
    const allItems = [
      { from: 5, to: 8, content: "片头开场" },
      { from: 150, to: 155, content: "核心台词" },
      { from: 260, to: 265, content: "片尾总结" }
    ];
    if (extension) {
      extension.onMessage = (message: { type?: string; id?: string; command?: string; options?: { from?: number; to?: number } }) => {
        if (message.type !== "request" || message.command !== "fetch") {
          previous?.(message as never);
          return;
        }
        extensionRequests.push(message);
        const from = message.options?.from ?? 0;
        const to = message.options?.to ?? Number.POSITIVE_INFINITY;
        extension?.sendJSON({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            video: { bvid: "BV1test000000", cid: "123456", page: 2, pageCount: 2, title: "测试视频" },
            pages: [{ cid: "100", page: 1, part: "P1", duration: 60 }, { cid: "123456", page: 2, part: "P2", duration: 300 }],
            chapters: [{ title: "章节一", from: 0, to: 200, source: "player-view-points" }],
            subtitle: {
              source: "player-wbi-v2",
              trackId: "track-1",
              language: "中文",
              items: allItems.filter((item) => item.to >= from && item.from <= to)
            },
            comments: [{ uname: "热评用户", like: 120, message: "好视频", subMessages: ["高赞楼中楼"] }]
          }
        });
      };
    }

    try {
      const inline = await runCli("fetch", ["--bvid", "BV1test000000"]);
      expect(inline).toMatchObject({
        ok: true,
        command: "fetch",
        extensionOnline: true,
        video: { bvid: "BV1test000000", page: 2 },
        pages: [{ page: 1 }, { page: 2 }],
        chapters: [{ title: "章节一" }],
        subtitle: {
          source: "player-wbi-v2",
          trackId: "track-1",
          language: "中文",
          items: allItems
        },
        comments: [{ uname: "热评用户", like: 120, message: "好视频", subMessages: ["高赞楼中楼"] }]
      });

      const outDir = join(scratch, "fetch-out");
      const filteredOut = await runCli("fetch", [
        "--tab", "42",
        "--from", "100",
        "--to", "200",
        "--out", outDir
      ]);
      const subtitle = filteredOut.subtitle as {
        path: string;
        count: number;
        from: number;
        to: number;
        items?: unknown;
      };
      expect(filteredOut).toMatchObject({
        ok: true,
        command: "fetch",
        comments: [{ uname: "热评用户", message: "好视频", subMessages: ["高赞楼中楼"] }]
      });
      expect(subtitle.items).toBeUndefined();
      expect(subtitle.path).toBe(resolve(subtitle.path));
      expect(dirname(subtitle.path)).toBe(resolve(outDir));
      expect(subtitle.count).toBe(1);
      expect(subtitle.from).toBe(150);
      expect(subtitle.to).toBe(155);
      expect(readFileSync(subtitle.path, "utf8")).toBe("2:30 核心台词\n");
    } finally {
      if (extension) extension.onMessage = previous;
    }
  });

  it("长字幕超安全阈值时自动落盘系统临时目录，stdout 仅保留摘要与绝对路径", async () => {
    const previous = extension?.onMessage;
    const longItems = Array.from({ length: 260 }, (_, index) => ({
      from: index * 15,
      to: index * 15 + 12,
      content: `第${index + 1}条长视频字幕内容用于测试超过终端输出安全阈值后的自动落盘行为`
    }));
    expect(new TextEncoder().encode(JSON.stringify(longItems)).byteLength).toBeGreaterThan(SUBTITLE_INLINE_MAX_BYTES);

    if (extension) {
      extension.onMessage = (message: { type?: string; id?: string; command?: string }) => {
        if (message.type !== "request" || (message.command !== "subtitles" && message.command !== "fetch")) {
          previous?.(message as never);
          return;
        }
        extension?.sendJSON({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            video: { bvid: "BV1long000000", cid: "789", page: 1, pageCount: 1, title: "长视频" },
            pages: [{ cid: "789", page: 1, part: "正片", duration: 4000 }],
            chapters: [],
            subtitle: { source: "player-wbi-v2", trackId: "track-long", language: "中文", items: longItems },
            ...(message.command === "fetch" ? { comments: [{ uname: "观众", like: 10, message: "热评" }] } : {})
          }
        });
      };
    }

    const dirsToClean: string[] = [];
    try {
      const subResult = await runCli("subtitles", ["--bvid", "BV1long000000"]);
      const subSummary = subResult.subtitle as { path: string; count: number; from: number; to: number; items?: unknown };
      dirsToClean.push(dirname(subSummary.path));
      expect(subSummary.items).toBeUndefined();
      expect(subSummary.path).toBe(resolve(subSummary.path));
      expect(subSummary.path.startsWith(resolve(tmpdir()))).toBe(true);
      expect(subSummary.count).toBe(260);
      expect(subSummary.from).toBe(0);
      expect(subSummary.to).toBe(259 * 15 + 12);
      const writtenLines = readFileSync(subSummary.path, "utf8").trimEnd().split("\n");
      expect(writtenLines).toHaveLength(260);
      expect(writtenLines[0]).toBe(`0:00:00 ${longItems[0].content}`);
      expect(writtenLines[10]).toBe(`0:02:30 ${longItems[10].content}`);
      expect(writtenLines[259]).toBe(`1:04:45 ${longItems[259].content}`);

      const fetchResult = await runCli("fetch", ["--bvid", "BV1long000000"]);
      const fetchSub = fetchResult.subtitle as { path: string; count: number; items?: unknown };
      dirsToClean.push(dirname(fetchSub.path));
      expect(fetchSub.items).toBeUndefined();
      expect(fetchSub.count).toBe(260);
      expect(fetchResult.comments).toEqual([{ uname: "观众", like: 10, message: "热评" }]);
    } finally {
      if (extension) extension.onMessage = previous;
      for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("字幕落盘时刻文本与 clock-text / notes buildTxt 同口径，并支持 --from/--to 与空区间", () => {
    const shortBody = [
      { from: 5, to: 10, content: "开场" },
      { from: 150, to: 160, content: "中段" }
    ];
    const longBody = [
      { from: 5, to: 10, content: "开场" },
      { from: 3725, to: 3730, content: "一小时后" }
    ];

    expect(formatSubtitleClock(5, false)).toBe(formatClock(5, { hours: false }));
    expect(formatSubtitleClock(3725, true)).toBe(formatClock(3725, { hours: true }));

    const outShort = join(scratch, "parity-short");
    const shortSpilled = applySubtitleSpillover({
      video: { bvid: "BV1parity0000", page: 1 },
      subtitle: { source: "bilibili", trackId: "1", language: "中文", items: shortBody }
    }, outShort);
    const shortPath = (shortSpilled.subtitle as { path: string }).path;
    expect(readFileSync(shortPath, "utf8")).toBe(`${buildTxt(shortBody, { includeTimestampInBody: true })}\n`);

    const outLong = join(scratch, "parity-long");
    const longSpilled = applySubtitleSpillover({
      video: { bvid: "BV1parity0000", page: 1 },
      subtitle: { source: "bilibili", trackId: "1", language: "中文", items: longBody }
    }, outLong);
    const longPath = (longSpilled.subtitle as { path: string }).path;
    expect(readFileSync(longPath, "utf8")).toBe(`${buildTxt(longBody, { includeTimestampInBody: true })}\n`);

    const outEmpty = join(scratch, "parity-empty");
    const emptySpilled = applySubtitleSpillover({
      video: { bvid: "BV1parity0000", page: 1 },
      subtitle: { source: "bilibili", trackId: "1", language: "中文", items: [] }
    }, outEmpty);
    expect(emptySpilled.subtitle).toMatchObject({
      count: 0,
      from: null,
      to: null
    });
    expect(readFileSync((emptySpilled.subtitle as { path: string }).path, "utf8")).toBe("");
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

  it("并发截帧并发转发且复用同一个 Daemon", async () => {
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
      expect(maxActive).toBeGreaterThan(1);
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
