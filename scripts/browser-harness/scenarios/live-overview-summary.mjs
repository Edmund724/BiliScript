#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import {
  REPO_ROOT,
  artifactDir,
  attachPage,
  launchBrowser,
  log,
  teardown,
  writeEvidence
} from "../harness.mjs";

const NAME = "live-overview-summary";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

function encodeWsFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function sendWsJson(socket, obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  socket.write(encodeWsFrame(0x01, buf));
}

function startMockMossServer() {
  const state = {
    receivedResults: [],
    activeSockets: new Set()
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  server.on("upgrade", (req, socket) => {
    state.activeSockets.add(socket);
    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n"
      ].join("\r\n")
    );

    let rxBuf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 2) {
        const b0 = rxBuf[0];
        const b1 = rxBuf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (rxBuf.length < 4) return;
          payloadLen = rxBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (rxBuf.length < 10) return;
          payloadLen = Number(rxBuf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (rxBuf.length < offset + maskLen + payloadLen) return;
        const maskKey = masked ? rxBuf.subarray(offset, offset + 4) : null;
        offset += maskLen;
        const payload = Buffer.from(rxBuf.subarray(offset, offset + payloadLen));
        rxBuf = rxBuf.subarray(offset + payloadLen);

        if (masked && maskKey) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i & 3];
          }
        }

        if (opcode === 0x08) {
          socket.end();
          return;
        }
        if (opcode === 0x01) {
          try {
            const parsed = JSON.parse(payload.toString("utf8"));
            if (parsed.action === "attach_session") {
              sendWsJson(socket, { action: "session_attached", session_id: "test-sess-1" });
            } else if (parsed.action === "session.update") {
              sendWsJson(socket, { action: "session.updated", error: "" });
            } else if (parsed.action === "tool.result") {
              state.receivedResults.push(parsed);
            }
          } catch {}
        }
      }
    });

    socket.on("close", () => {
      state.activeSockets.delete(socket);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        state,
        wsUrl: `ws://127.0.0.1:${port}/v1/realtime?model=moss-live-1.0`,
        close: () =>
          new Promise((r) => {
            for (const s of state.activeSockets) s.destroy();
            server.close(r);
          })
      });
    });
  });
}

const bundledBridge = await build({
  entryPoints: [path.join(REPO_ROOT, "extension/live/live-tools-bridge.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "LiveTools",
  platform: "browser"
});
const bridgeSource = bundledBridge.outputFiles[0].text;

const bundledMoss = await build({
  entryPoints: [path.join(REPO_ROOT, "extension/live/offscreen-moss-client.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "MossLiveModule",
  platform: "browser"
});
const mossSource = bundledMoss.outputFiles[0].text;

const mockServer = await startMockMossServer();
const browser = await launchBrowser({ autoplay: true });
const page = await attachPage(browser);

try {
  await page.cdp.send("Page.setDocumentContent", {
    frameId: page.target.id,
    html: `<!doctype html><html><body><div class="bpx-player-video-wrap"><video preload="auto"></video></div></body></html>`
  });
  await page.cdp.evaluate(bridgeSource);
  await page.cdp.evaluate(mossSource);
  await page.cdp.evaluate(`(() => {
    const clip = {
      bvid: 'BV1live000000',
      cid: '987',
      title: '实时伴看按需概览验证',
      pageIndex: 1,
      pageCount: 1,
      pageTitle: '',
      subtitleFetchState: 'ready',
      subtitleBody: [
        { from: 0, to: 4, content: '开场介绍本期主题' },
        { from: 10, to: 20, content: '详细剖析核心脉络' },
        { from: 30, to: 40, content: '最后总结核心观点' }
      ],
      chapters: []
    };

    let generatorCallCount = 0;
    let overviewState = { phase: 'idle', analysis: null, errorText: '' };
    let declineCostGuard = false;

    const testBridge = LiveTools.createLiveToolsBridge({
      getClip: () => clip,
      getUrl: () => 'https://www.bilibili.com/video/BV1live000000/',
      getOverview: () => overviewState,
      ensureOverview: async () => {
        generatorCallCount++;
        if (declineCostGuard) {
          overviewState = {
            phase: 'cancelled',
            analysis: null,
            errorText: '费用确认已取消，未生成全片概览'
          };
          return overviewState;
        }
        overviewState = {
          phase: 'ready',
          analysis: {
            summary: '全片深入讲解了实时伴看的按需概览生成机制。',
            chapters: [
              { from: 0, to: 10, title: '开场', summary: '介绍背景' },
              { from: 10, to: 30, title: '核心分析', summary: '剖析脉络' }
            ],
            quotes: [{ from: 30, content: '核心观点总结' }]
          },
          errorText: ''
        };
        return overviewState;
      }
    });

    window.testBridge = testBridge;
    window.getGeneratorCallCount = () => generatorCallCount;
    window.setOverviewState = (s) => { overviewState = s; };
    window.setDeclineCostGuard = (val) => { declineCostGuard = val; };
    window.testCall = (name, args, stampedVideo = { bvid: 'BV1live000000', cid: '987', pageIndex: 1 }) =>
      testBridge.executeTool({ callId: Math.random().toString(36), name, arguments: args, video: stampedVideo });
  })()`);

  const results = await page.cdp.evaluate(`(async () => {
    const output = {};
    // 1. 首次生成：概览未就绪时触发 ensureOverview
    output.firstGen = await testCall('summarize_video', {});
    output.firstGenCalls = getGeneratorCallCount();

    // 2. 缓存命中：第二次调用直接复用已有概览，不再触发生成
    output.cacheHit = await testCall('summarize_video', {});
    output.cacheHitCalls = getGeneratorCallCount();

    // 3. 部分覆盖：覆盖不完整时明确返回 partial 与 failedRanges
    setOverviewState({
      phase: 'partial',
      analysis: {
        summary: '部分内容生成概览',
        chapters: [{ from: 0, to: 10, title: '片段', summary: '局部' }],
        quotes: [],
        failedRanges: [{ from: 20, to: 40 }]
      },
      errorText: ''
    });
    output.partial = await testCall('summarize_video', {});

    // 4. 费用确认取消
    setOverviewState({ phase: 'idle', analysis: null, errorText: '' });
    setDeclineCostGuard(true);
    output.cancelled = await testCall('summarize_video', {});

    return output;
  })()`);

  check(
    "first-generation",
    results.firstGen.ok === true &&
      results.firstGen.coverage === "complete" &&
      results.firstGen.summary.includes("实时伴看") &&
      results.firstGenCalls === 1,
    results.firstGen
  );

  check(
    "cache-hit",
    results.cacheHit.ok === true &&
      results.cacheHit.coverage === "complete" &&
      results.cacheHitCalls === 1, // 调用计数依然为 1，说明未发起二次生成
    { cacheHit: results.cacheHit, calls: results.cacheHitCalls }
  );

  check(
    "partial-coverage",
    results.partial.ok === true &&
      results.partial.coverage === "partial" &&
      Array.isArray(results.partial.failedRanges) &&
      results.partial.failedRanges.length === 1,
    results.partial
  );

  check(
    "cost-guard-cancelled",
    results.cancelled.ok === false &&
      results.cancelled.error.includes("取消"),
    results.cancelled
  );

  // 5. MOSS-LIVE 真机 WebSocket 会话全双工端到端验证
  await page.cdp.evaluate(`(() => {
    setDeclineCostGuard(false);
    setOverviewState({ phase: 'idle', analysis: null, errorText: '' });

    const client = new MossLiveModule.OffscreenMossLiveClient({
      wsUrl: ${JSON.stringify(mockServer.wsUrl)},
      videoContext: {
        url: 'https://www.bilibili.com/video/BV1live000000/',
        bvid: 'BV1live000000',
        cid: '987',
        title: '实时伴看按需概览验证',
        pageIndex: 1,
        pageCount: 1,
        pageTitle: '',
        chapters: []
      },
      onToolCall: (call) => {
        window.testBridge.executeTool(call).then((res) => {
          client.sendToolResult(call.callId, res);
        });
      }
    });

    window.mossClient = client;
    client.connect();
  })()`);

  // 等待 WebSocket 连接并附着
  const getConnected = () => page.cdp.evaluate("window.mossClient.getState() === 'connected'");
  for (let i = 0; i < 40; i++) {
    if (await getConnected()) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const isConnected = await getConnected();
  check("moss-live-ws-connected", isConnected, { wsUrl: mockServer.wsUrl });

  // 由服务端下发 summarize_video 工具调用
  const socket = [...mockServer.state.activeSockets][0];
  sendWsJson(socket, {
    action: "tool.call",
    data: {
      call_id: "moss-ws-call-1",
      name: "summarize_video",
      arguments: {}
    }
  });

  // 等待服务端收到 tool.result
  const waitForResult = () => mockServer.state.receivedResults.find((r) => r.call_id === "moss-ws-call-1");
  for (let i = 0; i < 60; i++) {
    if (waitForResult()) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const toolResult = waitForResult();

  check(
    "moss-live-tool-roundtrip",
    toolResult &&
      toolResult.result &&
      toolResult.result.ok === true &&
      toolResult.result.coverage === "complete" &&
      toolResult.result.summary.includes("实时伴看") &&
      toolResult.result.video.bvid === "BV1live000000",
    toolResult
  );

  await writeEvidence(OUT_DIR, {
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks,
    results,
    mossToolResult: toolResult
  });

  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
} finally {
  await mockServer.close();
  await teardown({ browser, cdps: [page.cdp] });
}
