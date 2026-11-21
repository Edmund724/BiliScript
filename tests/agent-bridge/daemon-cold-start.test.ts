import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectWebSocket,
  requestDaemon,
  startDaemon
} from "../../skills/biliscript/scripts/biliscript.mjs";

const script = resolve("skills/biliscript/scripts/biliscript.mjs");

function randomPort() {
  return 26000 + Math.floor(Math.random() * 2000);
}

function attachMockExtensionHandler(extension: Awaited<ReturnType<typeof connectWebSocket>>) {
  const received: Array<{ command?: string; options?: unknown }> = [];
  extension.onMessage = (message: { type?: string; id?: string; command?: string; options?: unknown }) => {
    if (message.type !== "request") return;
    received.push({ command: message.command, options: message.options });
    const result = message.command === "tabs"
      ? {
          tabs: [{
            tabId: 7,
            bvid: "BV1grace000001",
            cid: "999",
            title: "冷启动宽限测试视频",
            currentTime: 3,
            duration: 90,
            subtitlesReady: true
          }]
        }
      : message.command === "subtitles"
        ? { video: { bvid: "BV1grace000001" }, subtitle: { items: [{ from: 0, to: 3, content: "宽限重连成功" }] } }
        : message.command === "comments"
          ? { video: { bvid: "BV1grace000001" }, comments: [{ uname: "测试观众", like: 5, message: "热评" }] }
          : { bvid: "BV1grace000001", cid: "999", frames: [{ data: "/9j/2Q==", targetTime: 5, currentTime: 5 }] };
    extension.sendJSON({ type: "response", id: message.id, ok: true, result });
  };
  return received;
}

function runCliRaw(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ code: number; stdout: string; json: Record<string, unknown> }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, [script, ...args], { env }, (error, stdout) => {
      try {
        const json = JSON.parse(stdout) as Record<string, unknown>;
        const exitCode = (error as { code?: unknown } | null)?.code;
        resolveRun({
          code: typeof exitCode === "number" ? exitCode : 0,
          stdout,
          json
        });
      } catch (parseError) {
        rejectRun(parseError);
      }
    });
  });
}

async function connectExtensionWithRetry(
  port: number,
  attemptsLeft = 40
): Promise<Awaited<ReturnType<typeof connectWebSocket>>> {
  try {
    return await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"b".repeat(32)}`,
      timeoutMs: 300
    });
  } catch (error) {
    if (attemptsLeft <= 1) throw error;
    await new Promise((r) => setTimeout(r, 40));
    return connectExtensionWithRetry(port, attemptsLeft - 1);
  }
}

let cleanup = async () => {};

afterEach(async () => {
  await cleanup();
  cleanup = async () => {};
});

describe("Agent Bridge Daemon 冷启动宽限重连", () => {
  it("冷启动后在宽限窗口内等待扩展延迟接入，接入后立即派发 tabs/subtitles/comments/frame 与 status --wait", async () => {
    const port = randomPort();
    const server = await startDaemon({ port, extensionGraceMs: 2000 });
    let extension: Awaited<ReturnType<typeof connectWebSocket>> | null = null;
    cleanup = async () => {
      extension?.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    };

    const allWaiting = new Promise<void>((resolveWait) => {
      let count = 0;
      server.on("waiting-for-extension", () => {
        count += 1;
        if (count === 5) resolveWait();
      });
    });

    const pendingStatusWait = requestDaemon("status", { port, options: { wait: true }, timeoutMs: 0 });
    const pendingTabs = requestDaemon("tabs", { port, timeoutMs: 0 });
    const pendingSubtitles = requestDaemon("subtitles", { port, options: { bvid: "BV1grace000001" }, timeoutMs: 0 });
    const pendingComments = requestDaemon("comments", { port, options: { bvid: "BV1grace000001" }, timeoutMs: 0 });
    const pendingFrame = requestDaemon("frame", { port, options: { bvid: "BV1grace000001", targetTime: 5 }, timeoutMs: 0 });

    await allWaiting;

    const immediateStatus = await requestDaemon("status", { port, timeoutMs: 1000 });
    expect(immediateStatus).toMatchObject({
      ok: true,
      command: "status",
      bridgeOnline: true,
      extensionOnline: false
    });

    extension = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"a".repeat(32)}`
    });
    const received = attachMockExtensionHandler(extension);

    const [statusWait, tabs, subtitles, comments, frame] = await Promise.all([
      pendingStatusWait,
      pendingTabs,
      pendingSubtitles,
      pendingComments,
      pendingFrame
    ]);

    expect(statusWait).toMatchObject({ ok: true, command: "status", bridgeOnline: true, extensionOnline: true });
    expect(tabs).toMatchObject({ ok: true, command: "tabs", extensionOnline: true, tabs: [{ tabId: 7 }] });
    expect(subtitles).toMatchObject({ ok: true, command: "subtitles", subtitle: { items: [{ content: "宽限重连成功" }] } });
    expect(comments).toMatchObject({ ok: true, command: "comments", comments: [{ message: "热评" }] });
    expect(frame).toMatchObject({ ok: true, command: "frame", bvid: "BV1grace000001" });
    expect(received.map((item) => item.command)).toEqual(["tabs", "subtitles", "comments", "frame"]);
  });

  it("超过宽限窗口仍无扩展接入时返回明确错误与指引；宽限过期及断线后不再挂起", async () => {
    const port = randomPort();
    const server = await startDaemon({ port, extensionGraceMs: 120 });
    let extension: Awaited<ReturnType<typeof connectWebSocket>> | null = null;
    cleanup = async () => {
      extension?.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    };

    await expect(requestDaemon("tabs", { port, timeoutMs: 0 })).rejects.toThrow(/扩展未连接.*设置 → 本地 Agent.*去连接/);
    await expect(requestDaemon("status", { port, options: { wait: true }, timeoutMs: 0 })).rejects.toThrow(/扩展未连接/);

    extension = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"a".repeat(32)}`
    });
    const disconnected = new Promise<void>((resolveDisconnect) => server.once("extension-disconnected", resolveDisconnect));
    extension.close();
    extension = null;
    await disconnected;
    await expect(requestDaemon("subtitles", { port, timeoutMs: 0 })).rejects.toThrow(/扩展未连接/);
  });

  it("CLI 冷启动拉起 Daemon：宽限内接通成功、超时返回非零状态与指引", async () => {
    mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
    const scratch = mkdtempSync(join(process.cwd(), ".scratch", "agent-bridge-cold-"));
    const portSuccess = randomPort();
    const portTimeout = randomPort();
    const spawnedPids: number[] = [];
    let extension: Awaited<ReturnType<typeof connectWebSocket>> | null = null;

    cleanup = async () => {
      extension?.close();
      for (const pid of spawnedPids) {
        try { process.kill(pid); } catch {}
      }
      rmSync(scratch, { recursive: true, force: true });
    };

    const envSuccess = {
      ...process.env,
      BILISCRIPT_BRIDGE_PORT: String(portSuccess),
      BILISCRIPT_BRIDGE_TOKEN_PATH: join(scratch, "token-success"),
      BILISCRIPT_BRIDGE_IDLE_MS: "5000",
      BILISCRIPT_BRIDGE_GRACE_MS: "3000"
    };

    const cliTabsPromise = runCliRaw(["tabs"], envSuccess);
    extension = await connectExtensionWithRetry(portSuccess);
    attachMockExtensionHandler(extension);
    const tabsResult = await cliTabsPromise;
    expect(tabsResult.code).toBe(0);
    expect(tabsResult.json).toMatchObject({
      ok: true,
      command: "tabs",
      bridgeOnline: true,
      extensionOnline: true,
      tabs: [{ bvid: "BV1grace000001" }]
    });
    spawnedPids.push(Number(tabsResult.json.daemonPid));

    const envTimeout = {
      ...process.env,
      BILISCRIPT_BRIDGE_PORT: String(portTimeout),
      BILISCRIPT_BRIDGE_TOKEN_PATH: join(scratch, "token-timeout"),
      BILISCRIPT_BRIDGE_IDLE_MS: "5000",
      BILISCRIPT_BRIDGE_GRACE_MS: "180"
    };
    const timeoutResult = await runCliRaw(["status", "--wait"], envTimeout);
    expect(timeoutResult.code).toBe(1);
    expect(timeoutResult.json).toMatchObject({
      ok: false,
      command: "status",
      bridgeOnline: true,
      extensionOnline: false
    });
    expect(String(timeoutResult.json.error)).toMatch(/扩展未连接.*设置 → 本地 Agent.*去连接/);
    const postStatus = await runCliRaw(["status"], envTimeout);
    spawnedPids.push(Number(postStatus.json.daemonPid));
  });
});
