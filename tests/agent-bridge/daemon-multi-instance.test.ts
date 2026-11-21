import { afterEach, describe, expect, it } from "vitest";
import { parseAgentBridgeUrl } from "../../extension/core/validators.js";
import {
  connectWebSocket,
  requestDaemon,
  startDaemon
} from "../../skills/biliscript/scripts/biliscript.mjs";

type Peer = Awaited<ReturnType<typeof connectWebSocket>>;

interface MockTab {
  tabId: number;
  bvid: string;
  cid: string;
  title: string;
  currentTime: number;
  duration: number;
  subtitlesReady: boolean;
  active?: boolean;
}

interface RecordedRequest {
  command?: string;
  options?: Record<string, unknown>;
}

function randomPort(): number {
  return 28000 + Math.floor(Math.random() * 2000);
}

function attachExtensionMock(
  peer: Peer,
  {
    tabs,
    activeError = "当前活动标签页不是 B 站视频页，请使用 --tab 或 --bvid 指定目标",
    subtitleText = "默认字幕"
  }: {
    tabs: MockTab[];
    activeError?: string;
    subtitleText?: string;
  }
) {
  const requests: RecordedRequest[] = [];
  let closed = false;
  peer.onClose = () => {
    closed = true;
  };
  peer.onMessage = (message: { type?: string; id?: string; command?: string; options?: Record<string, unknown> }) => {
    if (message.type !== "request") return;
    requests.push({ command: message.command, options: message.options });

    if (message.command === "tabs") {
      peer.sendJSON({ type: "response", id: message.id, ok: true, result: { tabs } });
      return;
    }

    const opts = message.options || {};
    const matchedTab = typeof opts.tabId === "number"
      ? tabs.find((tab) => tab.tabId === opts.tabId)
      : opts.bvid
        ? tabs.find((tab) => String(opts.bvid).includes(tab.bvid))
        : tabs.find((tab) => tab.active === true);

    if (typeof opts.tabId === "number" && !matchedTab) {
      peer.sendJSON({ type: "response", id: message.id, ok: false, error: `No tab with id: ${opts.tabId}` });
      return;
    }

    if (!opts.tabId && !opts.bvid && !matchedTab) {
      peer.sendJSON({ type: "response", id: message.id, ok: false, error: activeError });
      return;
    }

    const bvid = matchedTab?.bvid || String(opts.bvid || "BV1fallback001");
    if (message.command === "subtitles") {
      peer.sendJSON({
        type: "response",
        id: message.id,
        ok: true,
        result: {
          video: { bvid, cid: matchedTab?.cid || "100" },
          subtitle: { items: [{ from: 0, to: 3, content: subtitleText }] }
        }
      });
      return;
    }

    if (message.command === "comments") {
      peer.sendJSON({
        type: "response",
        id: message.id,
        ok: true,
        result: {
          video: { bvid, cid: matchedTab?.cid || "100" },
          comments: [{ uname: "观众", like: 10, message: `${bvid} 热评` }]
        }
      });
      return;
    }

    if (message.command === "frame") {
      peer.sendJSON({
        type: "response",
        id: message.id,
        ok: true,
        result: {
          bvid,
          cid: matchedTab?.cid || "100",
          frames: [{ data: "/9j/2Q==", targetTime: 5, currentTime: 5 }]
        }
      });
    }
  };
  return {
    requests,
    isClosed: () => closed
  };
}

let cleanup = async () => {};

afterEach(async () => {
  await cleanup();
  cleanup = async () => {};
});

describe("回环地址归一与多浏览器实例共存", () => {
  it("localhost 与 [::1] 归一至 127.0.0.1 后可真实连通本地 Daemon", async () => {
    const port = randomPort();
    const server = await startDaemon({ port, extensionGraceMs: 500 });
    const sockets: Peer[] = [];
    cleanup = async () => {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    const fromLocalhost = new URL(parseAgentBridgeUrl(`ws://localhost:${port}`)!);
    const fromIpv6 = new URL(parseAgentBridgeUrl(`ws://[::1]:${port}`)!);
    expect(fromLocalhost.toString()).toBe(`ws://127.0.0.1:${port}/`);
    expect(fromIpv6.toString()).toBe(`ws://127.0.0.1:${port}/`);

    const extLocalhost = await connectWebSocket({
      port: Number(fromLocalhost.port),
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"a".repeat(32)}`
    });
    sockets.push(extLocalhost);
    attachExtensionMock(extLocalhost, {
      tabs: [{
        tabId: 11,
        bvid: "BV1loopback01",
        cid: "111",
        title: "回环测试",
        currentTime: 1,
        duration: 60,
        subtitlesReady: true,
        active: true
      }]
    });

    const tabs = await requestDaemon("tabs", { port: Number(fromIpv6.port) }) as {
      extensionOnline: boolean;
      tabs: MockTab[];
    };
    expect(tabs.extensionOnline).toBe(true);
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs[0].bvid).toBe("BV1loopback01");
  });

  it("双扩展实例并发接入不互踢，tabs 聚合并生成不冲突的路由 tabId，精准路由 --tab / --bvid / 当前活动视频", async () => {
    const port = randomPort();
    const server = await startDaemon({ port, extensionGraceMs: 500 });
    const origin = `chrome-extension://${"c".repeat(32)}`;
    const ext1 = await connectWebSocket({ port, protocol: "biliscript-extension-v1", origin });
    const ext2 = await connectWebSocket({ port, protocol: "biliscript-extension-v1", origin });
    cleanup = async () => {
      ext1.close();
      ext2.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    const mock1 = attachExtensionMock(ext1, {
      subtitleText: "来自实例一",
      tabs: [
        {
          tabId: 42,
          bvid: "BV1alpha00001",
          cid: "101",
          title: "实例一视频A",
          currentTime: 5,
          duration: 120,
          subtitlesReady: true
        },
        {
          tabId: 43,
          bvid: "BV1alpha00002",
          cid: "102",
          title: "实例一视频B",
          currentTime: 8,
          duration: 120,
          subtitlesReady: true
        }
      ]
    });
    const mock2 = attachExtensionMock(ext2, {
      subtitleText: "来自实例二",
      tabs: [
        {
          tabId: 42,
          bvid: "BV1beta000001",
          cid: "201",
          title: "实例二视频C",
          currentTime: 12,
          duration: 180,
          subtitlesReady: true,
          active: true
        },
        {
          tabId: 99,
          bvid: "BV1beta000002",
          cid: "202",
          title: "实例二视频D",
          currentTime: 20,
          duration: 240,
          subtitlesReady: true
        }
      ]
    });

    const status = await requestDaemon("status", { port }) as { extensionOnline: boolean };
    expect(status.extensionOnline).toBe(true);
    expect(mock1.isClosed()).toBe(false);
    expect(mock2.isClosed()).toBe(false);

    const tabsFirst = await requestDaemon("tabs", { port }) as { tabs: MockTab[] };
    const tabsSecond = await requestDaemon("tabs", { port }) as { tabs: MockTab[] };
    expect(tabsFirst.tabs).toHaveLength(4);
    expect(tabsFirst.tabs.map((tab) => tab.bvid)).toEqual([
      "BV1alpha00001",
      "BV1alpha00002",
      "BV1beta000001",
      "BV1beta000002"
    ]);
    const publicIds = tabsFirst.tabs.map((tab) => tab.tabId);
    expect(new Set(publicIds).size).toBe(4);
    expect(publicIds.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
    expect(tabsSecond.tabs.map((tab) => tab.tabId)).toEqual(publicIds);

    const ext1Tab42Id = tabsFirst.tabs[0].tabId;
    const ext2Tab42Id = tabsFirst.tabs[2].tabId;
    expect(ext1Tab42Id).not.toBe(ext2Tab42Id);

    mock1.requests.length = 0;
    mock2.requests.length = 0;
    const sub1 = await requestDaemon("subtitles", { port, options: { tabId: ext1Tab42Id } }) as {
      subtitle: { items: Array<{ content: string }> };
    };
    expect(sub1.subtitle.items[0].content).toBe("来自实例一");
    expect(mock1.requests).toEqual([{ command: "subtitles", options: { tabId: 42 } }]);
    expect(mock2.requests).toEqual([]);

    mock1.requests.length = 0;
    mock2.requests.length = 0;
    const sub2 = await requestDaemon("subtitles", { port, options: { tabId: ext2Tab42Id } }) as {
      subtitle: { items: Array<{ content: string }> };
    };
    expect(sub2.subtitle.items[0].content).toBe("来自实例二");
    expect(mock2.requests).toEqual([{ command: "subtitles", options: { tabId: 42 } }]);
    expect(mock1.requests).toEqual([]);

    mock1.requests.length = 0;
    mock2.requests.length = 0;
    const commentsByUrl = await requestDaemon("comments", {
      port,
      options: { bvid: "https://www.bilibili.com/video/BV1beta000002/?p=2" }
    }) as { comments: Array<{ message: string }> };
    expect(commentsByUrl.comments[0].message).toBe("BV1beta000002 热评");
    expect(mock2.requests.some((req) => req.command === "comments")).toBe(true);
    expect(mock1.requests.some((req) => req.command === "comments")).toBe(false);

    const unopened = await requestDaemon("subtitles", {
      port,
      options: { bvid: "BV1unopened99" }
    }) as { video: { bvid: string } };
    expect(unopened.video.bvid).toBe("BV1unopened99");

    mock1.requests.length = 0;
    mock2.requests.length = 0;
    const activeDefault = await requestDaemon("frame", { port }) as { bvid: string };
    expect(activeDefault.bvid).toBe("BV1beta000001");
    expect(mock2.requests.some((req) => req.command === "frame")).toBe(true);
    expect(mock1.requests.some((req) => req.command === "frame")).toBe(false);
  });

  it("未标记 active 字段时，默认目标遇到无活动视频的实例会自动回退到另一个在线实例", async () => {
    const port = randomPort();
    const server = await startDaemon({ port, extensionGraceMs: 500 });
    const ext1 = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"d".repeat(32)}`
    });
    const ext2 = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"e".repeat(32)}`
    });
    cleanup = async () => {
      ext1.close();
      ext2.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    attachExtensionMock(ext1, {
      tabs: [{
        tabId: 10,
        bvid: "BV1bg0000001",
        cid: "10",
        title: "后台视频",
        currentTime: 0,
        duration: 60,
        subtitlesReady: true
      }]
    });
    attachExtensionMock(ext2, {
      subtitleText: "实例二活动视频字幕",
      tabs: [{
        tabId: 20,
        bvid: "BV1active0002",
        cid: "20",
        title: "前台活动视频",
        currentTime: 3,
        duration: 90,
        subtitlesReady: true,
        active: true
      }]
    });

    const result = await requestDaemon("subtitles", { port }) as {
      video: { bvid: string };
      subtitle: { items: Array<{ content: string }> };
    };
    expect(result.video.bvid).toBe("BV1active0002");
    expect(result.subtitle.items[0].content).toBe("实例二活动视频字幕");
  });

  it("任一扩展实例断开（含 tabs 期间断开）不影响其余在线实例，且已失效标签页不误路由", async () => {
    const port = randomPort();
    const server = await startDaemon({ port, extensionGraceMs: 500 });
    const ext1 = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"f".repeat(32)}`
    });
    const ext2 = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"g".repeat(32)}`
    });
    cleanup = async () => {
      ext1.close();
      ext2.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    attachExtensionMock(ext1, {
      subtitleText: "实例一",
      tabs: [{
        tabId: 42,
        bvid: "BV1drop000001",
        cid: "1",
        title: "将断开的实例",
        currentTime: 1,
        duration: 60,
        subtitlesReady: true
      }]
    });
    const mock2 = attachExtensionMock(ext2, {
      subtitleText: "幸存实例",
      tabs: [{
        tabId: 42,
        bvid: "BV1alive00002",
        cid: "2",
        title: "持续在线实例",
        currentTime: 2,
        duration: 120,
        subtitlesReady: true,
        active: true
      }]
    });

    const initialTabs = await requestDaemon("tabs", { port }) as { tabs: MockTab[] };
    const ext1PublicTabId = initialTabs.tabs[0].tabId;
    const ext2PublicTabId = initialTabs.tabs[1].tabId;

    ext1.onMessage = (message: { type?: string; command?: string }) => {
      if (message.type === "request" && message.command === "tabs") ext1.close();
    };
    const partialTabs = await requestDaemon("tabs", { port }) as {
      extensionOnline: boolean;
      tabs: MockTab[];
    };
    expect(partialTabs.extensionOnline).toBe(true);
    expect(partialTabs.tabs).toHaveLength(1);
    expect(partialTabs.tabs[0]).toMatchObject({ tabId: ext2PublicTabId, bvid: "BV1alive00002" });
    expect(mock2.isClosed()).toBe(false);

    const okResult = await requestDaemon("subtitles", { port, options: { tabId: ext2PublicTabId } }) as {
      subtitle: { items: Array<{ content: string }> };
    };
    expect(okResult.subtitle.items[0].content).toBe("幸存实例");
    await expect(requestDaemon("comments", { port, options: { tabId: ext1PublicTabId } }))
      .rejects.toThrow("目标标签页所在扩展实例已断开连接");

    const statusAfter = await requestDaemon("status", { port }) as { extensionOnline: boolean };
    expect(statusAfter.extensionOnline).toBe(true);
  });
});
