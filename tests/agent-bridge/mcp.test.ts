import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FRAME_TIMEOUT_MS,
  MCP_SUBTITLE_INLINE_MAX_BYTES,
  MCP_SUBTITLE_PREVIEW_MAX_BYTES,
  MCP_SUBTITLE_RANGE_MAX_BYTES,
  connectWebSocket,
  expandFrameTargets,
  formatMcpFrameContent,
  formatMcpSubtitlePayload,
  parseTimestampSeconds
} from "../../skills/biliscript/scripts/biliscript.mjs";

interface ReadablePipe {
  setEncoding(encoding: string): void;
  on(event: "data", listener: (chunk: string) => void): void;
}

interface WritablePipe {
  write(chunk: string): boolean;
  end(): void;
}

interface SpawnedProcess {
  stdin: WritablePipe;
  stdout: ReadablePipe;
  stderr: ReadablePipe;
  once(event: "exit", listener: (code: number | null) => void): void;
  kill(): boolean;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; stdio: ["pipe", "pipe", "pipe"] }
) => SpawnedProcess;

const spawnProcess = (childProcess as unknown as { spawn: SpawnFn }).spawn;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const SCRIPT = resolve("skills/biliscript/scripts/biliscript.mjs");
const VALID_JPEG_BASE64 = "/9j/2Q==";
mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
const scratch = mkdtempSync(join(process.cwd(), ".scratch", "agent-bridge-mcp-test-"));
const spawnedPids = new Set<number>();
const openChildren = new Set<SpawnedProcess>();
const openPeers = new Set<Awaited<ReturnType<typeof connectWebSocket>>>();

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class McpStdioClient {
  readonly child: SpawnedProcess;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number | string, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: Error) => void;
  }>();
  readonly unsolicited: JsonRpcResponse[] = [];
  readonly stderrChunks: string[] = [];
  readonly exitPromise: Promise<number | null>;

  constructor(args: string[], env: Record<string, string | undefined>) {
    this.child = spawnProcess(process.execPath, [SCRIPT, "mcp", ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    openChildren.add(this.child);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
    });
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      while (true) {
        const idx = this.buffer.indexOf("\n");
        if (idx < 0) break;
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as JsonRpcResponse;
        const waiter = parsed.id !== null ? this.pending.get(parsed.id) : undefined;
        if (waiter) {
          this.pending.delete(parsed.id as number | string);
          waiter.resolve(parsed);
        } else {
          this.unsolicited.push(parsed);
        }
      }
    });
    this.exitPromise = new Promise((resolveExit) => {
      this.child.once("exit", (code) => {
        openChildren.delete(this.child);
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error(`MCP 进程提前退出（code=${code}）：${this.stderrChunks.join("")}`));
        }
        this.pending.clear();
        resolveExit(code);
      });
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload = params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exitPromise;
  }
}

function makeEnv(port: number, tokenName: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    BILISCRIPT_BRIDGE_PORT: String(port),
    BILISCRIPT_BRIDGE_TOKEN_PATH: join(scratch, tokenName),
    BILISCRIPT_BRIDGE_IDLE_MS: "15000",
    BILISCRIPT_BRIDGE_GRACE_MS: "0",
    ...extra
  };
}

function buildSubtitleItems(count: number, stepSeconds: number, filler: string) {
  return Array.from({ length: count }, (_, index) => ({
    from: index * stepSeconds,
    to: index * stepSeconds + Math.max(1, stepSeconds - 1),
    content: `第${index + 1}条${filler}`
  }));
}

function parseToolText(response: JsonRpcResponse): Record<string, unknown> {
  const content = response.result?.content as Array<{ type: string; text?: string }>;
  return JSON.parse(String(content[0]?.text || "{}")) as Record<string, unknown>;
}

afterAll(() => {
  for (const peer of openPeers) {
    try {
      peer.close();
    } catch {}
  }
  for (const child of openChildren) {
    try {
      child.kill();
    } catch {}
  }
  for (const pid of spawnedPids) {
    try {
      process.kill(pid);
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("MCP 辅助纯函数与默认超时", () => {
  it("Daemon 默认 frameTimeoutMs 上调至 95_000", () => {
    expect(DEFAULT_FRAME_TIMEOUT_MS).toBe(95000);
  });

  it("parseTimestampSeconds 解析非负秒数与 mm:ss / hh:mm:ss 并拒绝非法值", () => {
    expect(parseTimestampSeconds(0)).toBe(0);
    expect(parseTimestampSeconds(15.5)).toBe(15.5);
    expect(parseTimestampSeconds("42")).toBe(42);
    expect(parseTimestampSeconds("02:05")).toBe(125);
    expect(parseTimestampSeconds("2:05.5")).toBe(125.5);
    expect(parseTimestampSeconds("1:02:05")).toBe(3725);
    expect(parseTimestampSeconds(-1)).toBeNull();
    expect(parseTimestampSeconds("-5")).toBeNull();
    expect(parseTimestampSeconds("02:65")).toBeNull();
    expect(parseTimestampSeconds("02:5")).toBeNull();
    expect(parseTimestampSeconds("abc")).toBeNull();
    expect(parseTimestampSeconds("")).toBeNull();
    expect(parseTimestampSeconds(Number.NaN)).toBeNull();
  });

  it("expandFrameTargets 支持默认单帧、邻域展开与 0.25s 锚点优先去重", () => {
    expect(expandFrameTargets([15, 125, 420])).toEqual([
      { anchorTime: 15, targetTime: 15 },
      { anchorTime: 125, targetTime: 125 },
      { anchorTime: 420, targetTime: 420 }
    ]);
    expect(expandFrameTargets([0], { spanSeconds: 2 })).toEqual([
      { anchorTime: 0, targetTime: 0 },
      { anchorTime: 0, targetTime: 2 }
    ]);
    expect(expandFrameTargets([10, 12], { spanSeconds: 2 })).toEqual([
      { anchorTime: 10, targetTime: 8 },
      { anchorTime: 10, targetTime: 10 },
      { anchorTime: 12, targetTime: 12 },
      { anchorTime: 12, targetTime: 14 }
    ]);
    expect(expandFrameTargets([10, 10.1])).toEqual([
      { anchorTime: 10, targetTime: 10 }
    ]);
  });

  it("formatMcpSubtitlePayload 在短字幕与长字幕导览模式下纯内存处理", () => {
    const shortResult = formatMcpSubtitlePayload({
      video: { bvid: "BV1short00000", duration: 120 },
      chapters: [],
      subtitle: {
        source: "bilibili",
        trackId: "t1",
        language: "中文",
        items: [
          { from: 5, to: 10, content: "开场白" },
          { from: 65, to: 70, content: "正文内容" }
        ]
      }
    });
    expect(shortResult.subtitle).toMatchObject({
      mode: "inline",
      text: "0:05 开场白\n1:05 正文内容",
      count: 2,
      from: 5,
      to: 70
    });
    expect((shortResult.subtitle as Record<string, unknown>).path).toBeUndefined();
    expect((shortResult.subtitle as Record<string, unknown>).items).toBeUndefined();
  });

  it("formatMcpFrameContent 兼容旧扩展三帧返回并在单点默认模式筛选最接近帧", () => {
    const content = formatMcpFrameContent(
      {
        site: "bilibili",
        bvid: "BV1legacy0000",
        cid: "999",
        frames: [
          { data: VALID_JPEG_BASE64, targetTime: 28, currentTime: 28.1 },
          { data: VALID_JPEG_BASE64, targetTime: 30, currentTime: 30.04 },
          { data: VALID_JPEG_BASE64, targetTime: 32, currentTime: 32.1 }
        ]
      },
      { requestedTimes: [30], spanSeconds: 0 }
    );
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text as string)).toEqual({
      site: "bilibili",
      bvid: "BV1legacy0000",
      cid: "999",
      frames: [{ index: 1, anchorTime: 30, targetTime: 30, currentTime: 30.04 }]
    });
    expect(content[1]).toEqual({
      type: "image",
      data: VALID_JPEG_BASE64,
      mimeType: "image/jpeg"
    });
  });
});

describe("MCP stdio 协议栈端到端", () => {
  const port = 25000 + Math.floor(Math.random() * 1000);
  const env = makeEnv(port, "mcp-main.token");
  let client: McpStdioClient;
  let extension: Awaited<ReturnType<typeof connectWebSocket>>;
  const receivedRequests: Array<{ command?: string; options?: Record<string, unknown> }> = [];

  it("initialize 多版本协商、通知零回包、ping、tools/list 5 工具与 JSON-RPC 错误码", async () => {
    client = new McpStdioClient(["--port", String(port)], env);

    const initLatest = await client.request("initialize", { protocolVersion: "2025-06-18" });
    expect(initLatest.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "biliscript" }
    });
    expect(String(initLatest.result?.instructions || "")).toContain("biliscript_subtitles");

    const initMid = await client.request("initialize", { protocolVersion: "2025-03-26" });
    expect(initMid.result?.protocolVersion).toBe("2025-03-26");

    const initLegacy = await client.request("initialize", { protocolVersion: "2024-11-05" });
    expect(initLegacy.result?.protocolVersion).toBe("2024-11-05");

    client.notify("notifications/initialized");
    client.notify("notifications/cancelled", { requestId: 999 });
    const ping = await client.request("ping");
    expect(ping.result).toEqual({});
    expect(client.unsolicited).toEqual([]);

    const toolsList = await client.request("tools/list");
    const tools = toolsList.result?.tools as Array<{
      name: string;
      inputSchema: { additionalProperties?: boolean };
      annotations: Record<string, unknown>;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "biliscript_status",
      "biliscript_tabs",
      "biliscript_fetch",
      "biliscript_subtitles",
      "biliscript_frame"
    ]);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(tools.every((tool) => (
      tool.annotations.readOnlyHint === true
      && tool.annotations.destructiveHint === false
      && tool.annotations.openWorldHint === false
    ))).toBe(true);

    const unknownMethod = await client.request("resources/list");
    expect(unknownMethod.error?.code).toBe(-32601);

    const unknownTool = await client.request("tools/call", { name: "biliscript_unknown", arguments: {} });
    expect(unknownTool.error?.code).toBe(-32602);

    const conflictArgs = await client.request("tools/call", {
      name: "biliscript_fetch",
      arguments: { video: "BV1test000000", tabId: 1 }
    });
    expect(conflictArgs.error?.code).toBe(-32602);

    const extraPropArgs = await client.request("tools/call", {
      name: "biliscript_tabs",
      arguments: { unexpected: true }
    });
    expect(extraPropArgs.error?.code).toBe(-32602);

    const badClockArgs = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { times: ["02:99"] }
    });
    expect(badClockArgs.error?.code).toBe(-32602);

    const tooManyFrames = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { times: [10, 30, 60], spanSeconds: 2 }
    });
    expect(tooManyFrames.error?.code).toBe(-32602);

    const offlineStatus = await client.request("tools/call", {
      name: "biliscript_status",
      arguments: {}
    });
    const statusPayload = parseToolText(offlineStatus);
    expect(statusPayload).toMatchObject({ ok: true, bridgeOnline: true, extensionOnline: false });
    spawnedPids.add(Number(statusPayload.daemonPid));

    const offlineTabs = await client.request("tools/call", {
      name: "biliscript_tabs",
      arguments: {}
    });
    expect(offlineTabs.result?.isError).toBe(true);
    expect((offlineTabs.result?.content as Array<{ text: string }>)[0].text).toContain("扩展未连接");

    const pingAfterError = await client.request("ping");
    expect(pingAfterError.result).toEqual({});
  });

  it("字幕短文本直出、超 24 KiB 有章节与无章节 300s 桶导览及 48 KiB 区间 nextFrom 续读", async () => {
    extension = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"b".repeat(32)}`
    });
    openPeers.add(extension);
    extension.sendJSON({ type: "hello", role: "extension", version: 1 });

    const longItems = buildSubtitleItems(420, 4, "超长视频测试字幕内容用于触发二十四千字节导览阈值以及四十八千字节区间分页游标");
    expect(utf8Bytes(longItems.map((item) => `0:00 ${item.content}`).join("\n"))).toBeGreaterThan(MCP_SUBTITLE_RANGE_MAX_BYTES);
    const shortItems = buildSubtitleItems(3, 10, "短字幕");
    const chapters = [
      { title: "开场介绍", from: 0, to: 600, source: "player-view-points" },
      { title: "核心原理", from: 600, to: 1200, source: "player-view-points" },
      { title: "总结问答", from: 1200, to: 1800, source: "player-view-points" }
    ];

    extension.onMessage = (message: { type?: string; id?: string; command?: string; options?: Record<string, unknown> }) => {
      if (message.type !== "request") return;
      receivedRequests.push({ command: message.command, options: message.options });
      const bvid = String(message.options?.bvid || "");
      const from = Number(message.options?.from ?? 0);
      const to = Number(message.options?.to ?? Number.POSITIVE_INFINITY);
      if (message.command === "fetch" || message.command === "subtitles") {
        const items = bvid === "BV1short00000"
          ? shortItems
          : longItems.filter((item) => item.to >= from && item.from <= to);
        const chapterList = bvid === "BV1chapters00" ? chapters : [];
        extension.sendJSON({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            video: { bvid: bvid || "BV1long000000", cid: "101", title: "MCP 字幕测试", duration: 1800, page: 1, pageCount: 1 },
            pages: [{ cid: "101", page: 1, part: "正片", duration: 1800 }],
            chapters: chapterList,
            subtitle: { source: "player-wbi-v2", trackId: "tr-1", language: "中文", items },
            ...(message.command === "fetch" ? { comments: [{ uname: "观众", like: 88, message: "很清晰" }] } : {})
          }
        });
      }
    };

    const shortResp = await client.request("tools/call", {
      name: "biliscript_fetch",
      arguments: { video: "BV1short00000" }
    });
    const shortData = parseToolText(shortResp);
    expect(shortData.comments).toEqual([{ uname: "观众", like: 88, message: "很清晰" }]);
    expect(shortData.subtitle).toMatchObject({
      mode: "inline",
      count: 3,
      from: 0,
      to: 29
    });
    expect(utf8Bytes(String((shortData.subtitle as { text: string }).text))).toBeLessThanOrEqual(MCP_SUBTITLE_INLINE_MAX_BYTES);
    expect((shortData.subtitle as Record<string, unknown>).path).toBeUndefined();

    const chapterResp = await client.request("tools/call", {
      name: "biliscript_fetch",
      arguments: { video: "BV1chapters00" }
    });
    const chapterData = parseToolText(chapterResp);
    const chapterSub = chapterData.subtitle as {
      mode: string;
      outlineSource: string;
      outline: Array<{ title: string; from: number; to: number; count: number; preview: string }>;
      previewText: string;
      path?: string;
    };
    expect(chapterData.comments).toEqual([{ uname: "观众", like: 88, message: "很清晰" }]);
    expect(chapterSub.mode).toBe("windowed");
    expect(chapterSub.outlineSource).toBe("chapters");
    expect(chapterSub.outline.map((entry) => entry.title)).toEqual(["开场介绍", "核心原理", "总结问答"]);
    expect(chapterSub.path).toBeUndefined();
    expect(utf8Bytes(chapterSub.previewText)).toBeLessThanOrEqual(MCP_SUBTITLE_PREVIEW_MAX_BYTES);
    expect(chapterSub.previewText).toContain("第1条");

    const bucketResp = await client.request("tools/call", {
      name: "biliscript_fetch",
      arguments: { video: "BV1nobuckets0" }
    });
    const bucketSub = parseToolText(bucketResp).subtitle as {
      mode: string;
      outlineSource: string;
      outline: Array<{ from: number; to: number; count: number; preview: string }>;
      previewText: string;
      path?: string;
    };
    expect(bucketSub.mode).toBe("windowed");
    expect(bucketSub.outlineSource).toBe("buckets");
    expect(bucketSub.outline[0]).toMatchObject({ from: 0, to: 300 });
    expect(bucketSub.outline[1]).toMatchObject({ from: 300, to: 600 });
    expect(bucketSub.outline[0].count).toBeGreaterThan(0);
    expect(bucketSub.outline[0].preview.length).toBeGreaterThan(0);
    expect(bucketSub.path).toBeUndefined();

    const page1Resp = await client.request("tools/call", {
      name: "biliscript_subtitles",
      arguments: { video: "BV1nobuckets0", from: 0, to: 1800 }
    });
    const page1 = parseToolText(page1Resp).subtitle as {
      mode: string;
      text: string;
      count: number;
      truncated: boolean;
      nextFrom: number;
    };
    expect(page1.mode).toBe("inline");
    expect(page1.truncated).toBe(true);
    expect(utf8Bytes(page1.text)).toBeLessThanOrEqual(MCP_SUBTITLE_RANGE_MAX_BYTES);
    expect(page1.nextFrom).toBe(longItems[page1.count].from);

    const page2Resp = await client.request("tools/call", {
      name: "biliscript_subtitles",
      arguments: { video: "BV1nobuckets0", from: page1.nextFrom, to: 1800 }
    });
    const page2 = parseToolText(page2Resp).subtitle as {
      mode: string;
      text: string;
      count: number;
      truncated?: boolean;
    };
    expect(page2.mode).toBe("inline");
    expect(page2.truncated).toBeUndefined();
    expect(page1.count + page2.count).toBe(longItems.length);
    expect(page2.text.split("\n")[0]).toContain(`第${page1.count + 1}条`);
  });

  it("biliscript_frame 返回原生 ImageContent：支持 times 多点、time 单帧、spanSeconds 展开与旧扩展三帧兜底", async () => {
    receivedRequests.length = 0;
    extension.onMessage = (message: { type?: string; id?: string; command?: string; options?: Record<string, unknown> }) => {
      if (message.type !== "request" || message.command !== "frame") return;
      receivedRequests.push({ command: message.command, options: message.options });
      const bvid = String(message.options?.bvid || "BV1frame00000");
      const rawTimes = message.options?.times as number[] | undefined;
      const targetTime = message.options?.targetTime as number | undefined;
      const spanSeconds = Number(message.options?.spanSeconds ?? 0);

      if (bvid === "BV1legacy3frm") {
        const center = Number(targetTime ?? 30);
        extension.sendJSON({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            site: "bilibili",
            bvid,
            cid: "301",
            frames: [center - 2, center, center + 2].map((time) => ({
              data: VALID_JPEG_BASE64,
              targetTime: time,
              currentTime: time + 0.02
            }))
          }
        });
        return;
      }

      if (!rawTimes) {
        extension.sendJSON({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            site: "youtube",
            bvid,
            cid: "yt-1",
            frames: [{ data: VALID_JPEG_BASE64, targetTime: 45.2, currentTime: 45.2 }]
          }
        });
        return;
      }

      const targets = expandFrameTargets(rawTimes, { spanSeconds });
      extension.sendJSON({
        type: "response",
        id: message.id,
        ok: true,
        result: {
          site: "bilibili",
          bvid,
          cid: "302",
          frames: targets.map((target) => ({
            data: VALID_JPEG_BASE64,
            anchorTime: target.anchorTime,
            targetTime: target.targetTime,
            currentTime: target.targetTime + 0.03
          }))
        }
      });
    };

    const currentResp = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { tabId: 42 }
    });
    const currentContent = currentResp.result?.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(currentContent).toHaveLength(2);
    expect(JSON.parse(currentContent[0].text as string)).toEqual({
      site: "youtube",
      bvid: "BV1frame00000",
      cid: "yt-1",
      frames: [{ index: 1, anchorTime: 45.2, targetTime: 45.2, currentTime: 45.2 }]
    });
    expect(currentContent[1]).toEqual({ type: "image", data: VALID_JPEG_BASE64, mimeType: "image/jpeg" });

    const multiResp = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { video: "BV1multi00000", times: [15, "02:05", 420] }
    });
    const multiContent = multiResp.result?.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(multiContent).toHaveLength(4);
    expect(JSON.parse(multiContent[0].text as string)).toEqual({
      site: "bilibili",
      bvid: "BV1multi00000",
      cid: "302",
      frames: [
        { index: 1, anchorTime: 15, targetTime: 15, currentTime: 15.03 },
        { index: 2, anchorTime: 125, targetTime: 125, currentTime: 125.03 },
        { index: 3, anchorTime: 420, targetTime: 420, currentTime: 420.03 }
      ]
    });
    expect(multiContent.slice(1).every((block) => block.type === "image" && block.mimeType === "image/jpeg")).toBe(true);
    expect(receivedRequests[1]?.options).toEqual({
      bvid: "BV1multi00000",
      times: [15, 125, 420],
      targetTime: 15,
      spanSeconds: 0
    });

    const singleResp = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { video: "BV1single0000", time: 30 }
    });
    const singleContent = singleResp.result?.content as Array<{ type: string; text?: string }>;
    expect(singleContent).toHaveLength(2);
    expect(JSON.parse(singleContent[0].text as string).frames).toEqual([
      { index: 1, anchorTime: 30, targetTime: 30, currentTime: 30.03 }
    ]);

    const spanResp = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { video: "BV1span000000", times: [60], spanSeconds: 3 }
    });
    const spanContent = spanResp.result?.content as Array<{ type: string; text?: string }>;
    expect(spanContent).toHaveLength(4);
    expect(JSON.parse(spanContent[0].text as string).frames.map((frame: { targetTime: number }) => frame.targetTime)).toEqual([57, 60, 63]);

    const legacySingleResp = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { video: "BV1legacy3frm", time: 30 }
    });
    const legacySingleContent = legacySingleResp.result?.content as Array<{ type: string; text?: string }>;
    expect(legacySingleContent).toHaveLength(2);
    expect(JSON.parse(legacySingleContent[0].text as string).frames).toEqual([
      { index: 1, anchorTime: 30, targetTime: 30, currentTime: 30.02 }
    ]);

    const legacyMultiResp = await client.request("tools/call", {
      name: "biliscript_frame",
      arguments: { video: "BV1legacy3frm", times: [20, 80] }
    });
    const legacyMultiContent = legacyMultiResp.result?.content as Array<{ type: string; text?: string }>;
    expect(legacyMultiContent).toHaveLength(3);
    expect(JSON.parse(legacyMultiContent[0].text as string).frames).toEqual([
      { index: 1, anchorTime: 20, targetTime: 20, currentTime: 20.02 },
      { index: 2, anchorTime: 80, targetTime: 80, currentTime: 80.02 }
    ]);

    const exitCode = await client.close();
    expect(exitCode).toBe(0);
  });

  it("MCP 进程空闲不保活：Daemon 到期自退后再次 tools/call 自动唤醒，stdin EOF 干净退出", async () => {
    const idlePort = 26000 + Math.floor(Math.random() * 1000);
    const idleClient = new McpStdioClient(
      [],
      makeEnv(idlePort, "mcp-idle.token", { BILISCRIPT_BRIDGE_IDLE_MS: "250" })
    );

    const firstResp = await idleClient.request("tools/call", {
      name: "biliscript_status",
      arguments: {}
    });
    const firstPid = Number(parseToolText(firstResp).daemonPid);
    expect(firstPid).toBeGreaterThan(0);
    spawnedPids.add(firstPid);

    await vi.waitFor(
      () => {
        expect(() => process.kill(firstPid, 0)).toThrow();
      },
      { timeout: 3000, interval: 30 }
    );

    const secondResp = await idleClient.request("tools/call", {
      name: "biliscript_status",
      arguments: {}
    });
    const secondPid = Number(parseToolText(secondResp).daemonPid);
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);
    spawnedPids.add(secondPid);

    const exitCode = await idleClient.close();
    expect(exitCode).toBe(0);
  });
});
