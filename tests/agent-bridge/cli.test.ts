import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MAX_CLI_FRAMES,
  SUBTITLE_INLINE_MAX_BYTES,
  applySubtitleSpillover,
  connectWebSocket,
  expandFrameTargets,
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
  BILISCRIPT_BRIDGE_IDLE_MS: "10000"
};
let daemonPid = 0;
let extension: Awaited<ReturnType<typeof connectWebSocket>> | null = null;
const extensionRequests: Array<{ command?: string; options?: unknown }> = [];

function runCli(
  command: "status" | "tabs" | "fetch" | "subtitles" | "comments" | "frame",
  args: string[] = [],
  customEnv = env
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, command, ...args], { env: customEnv }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function runCliFailure(
  command: "status" | "tabs" | "fetch" | "subtitles" | "comments" | "frame",
  args: string[] = [],
  customEnv = env
): Promise<{ code: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, command, ...args], { env: customEnv }, (error, stdout, stderr) => {
      if (!error) {
        reject(new Error(`预期命令非零退出但成功返回：${stdout}`));
        return;
      }
      try {
        const exitCode = (error as { code?: unknown }).code;
        resolve({
          code: typeof exitCode === "number" ? exitCode : 1,
          body: JSON.parse(stdout)
        });
      } catch {
        reject(new Error(`失败输出不是合法 JSON：${stdout}\n${stderr}`));
      }
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
      const frameOptions = message.options as { times?: number[]; targetTime?: number; spanSeconds?: number } | undefined;
      const rawTimes = Array.isArray(frameOptions?.times)
        ? frameOptions.times
        : typeof frameOptions?.targetTime === "number"
          ? [frameOptions.targetTime]
          : undefined;
      const spanSeconds = typeof frameOptions?.spanSeconds === "number" ? frameOptions.spanSeconds : 0;
      const frameTargets = rawTimes ? expandFrameTargets(rawTimes, { spanSeconds }) : null;
      const result = message.command === "subtitles"
        ? { video: { bvid: "BV1test000000" }, subtitle: { items: [{ from: 10, to: 12, content: "字幕" }] } }
        : message.command === "comments"
          ? { video: { bvid: "BV1test000000" }, comments: [{ uname: "观众", like: 9, message: "热评" }] }
          : message.command === "frame"
            ? {
                bvid: "BV1test000000",
                cid: "123456",
                frames: frameTargets
                  ? frameTargets.map((target) => ({
                      data: "/9j/2Q==",
                      anchorTime: target.anchorTime,
                      targetTime: target.targetTime,
                      currentTime: target.targetTime + 0.05
                    }))
                  : [{
                      data: "/9j/2Q==",
                      targetTime: 12.5,
                      currentTime: 12.5
                    }]
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

    expect(formatSubtitleClock(5, false)).toBe(formatClock(5, { hours: "never" }));
    expect(formatSubtitleClock(3725, true)).toBe(formatClock(3725, { hours: "always" }));

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

  it("frame 写入当前帧与 --time 默认单帧及 --span 邻域三帧 JPEG，输出 anchorTime / targetTime / currentTime", async () => {
    extensionRequests.length = 0;
    const current = await runCli("frame", ["--tab", "42"]);
    const currentFrames = current.frames as Array<{ path: string; anchorTime: number; targetTime: number; currentTime: number; data?: string }>;
    const defaultOut = dirname(currentFrames[0].path);
    try {
      expect(current).toMatchObject({ ok: true, command: "frame", extensionOnline: true, bvid: "BV1test000000" });
      expect(currentFrames).toHaveLength(1);
      expect(currentFrames[0]).toMatchObject({ anchorTime: 12.5, targetTime: 12.5, currentTime: 12.5 });
      expect(currentFrames[0].path).toBe(resolve(currentFrames[0].path));
      expect(currentFrames[0].data).toBeUndefined();
      expect(readFileSync(currentFrames[0].path, "base64")).toBe("/9j/2Q==");
    } finally {
      rmSync(defaultOut, { recursive: true, force: true });
    }

    const outSingle = join(scratch, "frames-single");
    const single = await runCli("frame", ["--bvid", "BV1test000000", "--time", "10", "--out", outSingle]);
    const singleFrames = single.frames as Array<{ path: string; anchorTime: number; targetTime: number; currentTime: number }>;
    expect(singleFrames).toHaveLength(1);
    expect(singleFrames[0]).toMatchObject({ anchorTime: 10, targetTime: 10, currentTime: 10.05 });
    expect(dirname(singleFrames[0].path)).toBe(resolve(outSingle));
    expect(readFileSync(singleFrames[0].path, "base64")).toBe("/9j/2Q==");

    const outSpan = join(scratch, "frames-span");
    const spanned = await runCli("frame", ["--bvid", "BV1test000000", "--time", "10", "--span", "2", "--out", outSpan]);
    const spannedFrames = spanned.frames as Array<{ path: string; anchorTime: number; targetTime: number; currentTime: number }>;
    expect(spannedFrames.map((frame) => frame.anchorTime)).toEqual([10, 10, 10]);
    expect(spannedFrames.map((frame) => frame.targetTime)).toEqual([8, 10, 12]);
    expect(spannedFrames.map((frame) => frame.currentTime)).toEqual([8.05, 10.05, 12.05]);
    expect(spannedFrames.every((frame) => dirname(frame.path) === resolve(outSpan))).toBe(true);
    expect(spannedFrames.every((frame) => readFileSync(frame.path, "base64") === "/9j/2Q==")).toBe(true);

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
      options: { bvid: "BV1test000000", times: [10], targetTime: 10, spanSeconds: 0 }
    });
    expect(extensionRequests).toContainEqual({
      type: "request",
      id: expect.any(String),
      command: "frame",
      options: { bvid: "BV1test000000", times: [10], targetTime: 10, spanSeconds: 2 }
    });
  });

  it("frame 支持 --times 多时间点、重复 --time、--span 展开与超 12 帧参数拒绝", async () => {
    extensionRequests.length = 0;

    const multiOut = join(scratch, "frames-times");
    const multi = await runCli("frame", ["--bvid", "BV1test000000", "--times", "0:15,2:05,10:00", "--out", multiOut]);
    const multiFrames = multi.frames as Array<{ path: string; anchorTime: number; targetTime: number; currentTime: number }>;
    expect(multiFrames.map((frame) => frame.anchorTime)).toEqual([15, 125, 600]);
    expect(multiFrames.map((frame) => frame.targetTime)).toEqual([15, 125, 600]);
    expect(multiFrames.map((frame) => frame.currentTime)).toEqual([15.05, 125.05, 600.05]);
    expect(multiFrames.every((frame) => dirname(frame.path) === resolve(multiOut))).toBe(true);

    const repeatedOut = join(scratch, "frames-repeated-time");
    const repeated = await runCli("frame", [
      "--bvid", "BV1test000000",
      "--time", "12",
      "--time", "48",
      "--out", repeatedOut
    ]);
    const repeatedFrames = repeated.frames as Array<{ path: string; anchorTime: number; targetTime: number; currentTime: number }>;
    expect(repeatedFrames.map((frame) => frame.anchorTime)).toEqual([12, 48]);
    expect(repeatedFrames.map((frame) => frame.targetTime)).toEqual([12, 48]);

    const spanMultiOut = join(scratch, "frames-times-span");
    const spanMulti = await runCli("frame", [
      "--bvid", "BV1test000000",
      "--times", "20,60",
      "--span", "3",
      "--out", spanMultiOut
    ]);
    const spanMultiFrames = spanMulti.frames as Array<{ path: string; anchorTime: number; targetTime: number; currentTime: number }>;
    expect(spanMultiFrames).toHaveLength(6);
    expect(spanMultiFrames.map((frame) => frame.anchorTime)).toEqual([20, 20, 20, 60, 60, 60]);
    expect(spanMultiFrames.map((frame) => frame.targetTime)).toEqual([17, 20, 23, 57, 60, 63]);
    expect(spanMultiFrames.every((frame) => readFileSync(frame.path, "base64") === "/9j/2Q==")).toBe(true);

    expect(extensionRequests).toEqual([
      {
        type: "request",
        id: expect.any(String),
        command: "frame",
        options: { bvid: "BV1test000000", times: [15, 125, 600], targetTime: 15, spanSeconds: 0 }
      },
      {
        type: "request",
        id: expect.any(String),
        command: "frame",
        options: { bvid: "BV1test000000", times: [12, 48], targetTime: 12, spanSeconds: 0 }
      },
      {
        type: "request",
        id: expect.any(String),
        command: "frame",
        options: { bvid: "BV1test000000", times: [20, 60], targetTime: 20, spanSeconds: 3 }
      }
    ]);

    expect(MAX_CLI_FRAMES).toBe(12);
    const overLimit = await runCliFailure("frame", [
      "--bvid", "BV1test000000",
      "--times", "10,30,50,70,90",
      "--span", "3"
    ]);
    expect(overLimit.code).not.toBe(0);
    expect(overLimit.body).toMatchObject({ ok: false, command: "frame" });
    expect(String(overLimit.body.error)).toContain("12");
    expect(String(overLimit.body.error)).toContain("15");
    expect(extensionRequests).toHaveLength(3);

    const invalidSpan = await runCliFailure("frame", ["--bvid", "BV1test000000", "--time", "10", "--span", "9"]);
    expect(invalidSpan.code).not.toBe(0);
    expect(invalidSpan.body).toMatchObject({ ok: false, command: "frame" });

    const spanWithoutTime = await runCliFailure("frame", ["--bvid", "BV1test000000", "--span", "2"]);
    expect(spanWithoutTime.code).not.toBe(0);
    expect(spanWithoutTime.body).toMatchObject({ ok: false, command: "frame" });
    expect(extensionRequests).toHaveLength(3);
  });

  it("frame 兼容未升级旧扩展的三帧返回并在默认单帧模式收敛为最接近帧", async () => {
    const previous = extension?.onMessage;
    const legacyRequests: Array<{ targetTime?: number }> = [];
    if (extension) {
      extension.onMessage = (message: { type?: string; id?: string; command?: string; options?: { targetTime?: number } }) => {
        if (message.type !== "request" || message.command !== "frame") {
          previous?.(message as never);
          return;
        }
        legacyRequests.push({ targetTime: message.options?.targetTime });
        const center = Number(message.options?.targetTime ?? 10);
        extension?.sendJSON({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            bvid: "BV1legacy0000",
            cid: "999",
            frames: [center - 2, center, center + 2].map((time) => ({
              data: "/9j/2Q==",
              targetTime: time,
              currentTime: time + 0.02
            }))
          }
        });
      };
    }
    try {
      const single = await runCli("frame", [
        "--bvid", "BV1legacy0000",
        "--time", "10",
        "--out", join(scratch, "legacy-single")
      ]);
      const singleFrames = single.frames as Array<{ anchorTime: number; targetTime: number; currentTime: number }>;
      expect(singleFrames).toHaveLength(1);
      expect(singleFrames[0]).toMatchObject({ anchorTime: 10, targetTime: 10, currentTime: 10.02 });

      const multi = await runCli("frame", [
        "--bvid", "BV1legacy0000",
        "--times", "20,80",
        "--out", join(scratch, "legacy-multi")
      ]);
      const multiFrames = multi.frames as Array<{ anchorTime: number; targetTime: number; currentTime: number }>;
      expect(multiFrames.map((frame) => frame.anchorTime)).toEqual([20, 80]);
      expect(multiFrames.map((frame) => frame.targetTime)).toEqual([20, 80]);
      expect(legacyRequests).toEqual([{ targetTime: 10 }, { targetTime: 20 }, { targetTime: 80 }]);
    } finally {
      if (extension) extension.onMessage = previous;
    }
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
              frames: [{
                data: "/9j/2Q==",
                anchorTime: 10,
                targetTime: 10,
                currentTime: 10
              }]
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

  it("放行合法的 Firefox moz-extension UUID 来源并拒绝非法格式", async () => {
    const firefoxPeer = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: "moz-extension://550e8400-e29b-41d4-a716-446655440000"
    });
    try {
      firefoxPeer.sendJSON({ type: "hello", role: "extension", version: 1 });
      const status = await runCli("status");
      expect(status).toMatchObject({ ok: true, bridgeOnline: true, extensionOnline: true });
    } finally {
      firefoxPeer.close();
    }

    await expect(connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: "moz-extension://not-a-valid-uuid"
    })).rejects.toThrow("拒绝连接");
  });

  it("普通网页来源不能冒充扩展", async () => {
    await expect(connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: "https://www.bilibili.com"
    })).rejects.toThrow("拒绝连接");
  });

  it("支持 --video 别名并转发 YouTube 视频链接", async () => {
    extensionRequests.length = 0;
    const ytUrl = "https://www.youtube.com/watch?v=abc_def-123";
    const result = await runCli("subtitles", ["--video", ytUrl]);
    expect(result).toMatchObject({ ok: true, command: "subtitles" });
    expect(extensionRequests).toContainEqual({
      type: "request",
      id: expect.any(String),
      command: "subtitles",
      options: { bvid: ytUrl }
    });
  });

  it("空闲超时后自动退出", async () => {
    extension?.close();
    extension = null;
    const idlePort = 28000 + Math.floor(Math.random() * 1000);
    const idleEnv = {
      ...process.env,
      BILISCRIPT_BRIDGE_PORT: String(idlePort),
      BILISCRIPT_BRIDGE_TOKEN_PATH: join(scratch, "idle-token"),
      BILISCRIPT_BRIDGE_IDLE_MS: "200"
    };
    const status = await runCli("status", [], idleEnv);
    const idleDaemonPid = Number(status.daemonPid);
    expect(idleDaemonPid).toBeGreaterThan(0);
    try {
      await vi.waitFor(
        () => {
          expect(() => process.kill(idleDaemonPid, 0)).toThrow();
        },
        { timeout: 3000, interval: 25 }
      );
    } finally {
      try {
        process.kill(idleDaemonPid);
      } catch {}
    }
  });
});
