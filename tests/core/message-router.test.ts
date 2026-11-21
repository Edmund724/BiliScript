import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ASR_OFFSCREEN_REJECTION_MESSAGE } from "../../extension/asr/protocol.js";
import { createMessageRouter, type MessageRouterOptions } from "../../extension/core/message-router.js";
import {
  BACKGROUND_MESSAGE_REGISTRY,
  OFFSCREEN_ONLY_MESSAGE_TYPES,
  type BackgroundMessageHandlers,
  type HandlerForType,
  type MessageSender,
  type SendResponse
} from "../../extension/shared/messaging-protocol.js";

const ROUTER_SOURCE = readFileSync(join(process.cwd(), "extension/core/message-router.ts"), "utf8");

const OFFSCREEN_DOCUMENT_URL = "chrome-extension://test/entry/offscreen.html";
const OFFSCREEN_SENDER: MessageSender = { url: OFFSCREEN_DOCUMENT_URL };
const tabSender = (id = 7): MessageSender => ({
  tab: { id },
  url: "https://www.bilibili.com/video/BV1/"
});
const isOffscreenLike = (sender: MessageSender): boolean =>
  !sender?.tab && sender?.url === OFFSCREEN_DOCUMENT_URL;

type TestHandler = (message: unknown, sender: MessageSender, sendResponse: SendResponse) => unknown;

function swRouter(handlers: Record<string, TestHandler>) {
  return createMessageRouter({
    handlers,
    senders: { offscreen: isOffscreenLike },
    rejectionMessage: ASR_OFFSCREEN_REJECTION_MESSAGE
  });
}

describe("消息 router：载荷与类型入口", () => {
  it("非对象载荷：不收、不回包", () => {
    const handler = vi.fn();
    const router = swRouter({ "get-settings": handler });
    const sendResponse = vi.fn();

    expect(router(null, tabSender(), sendResponse)).toBe(false);
    expect(router("str", tabSender(), sendResponse)).toBe(false);
    expect(router(42, tabSender(), sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("未知消息类型（含 Object.prototype 上的同名键）：不收、不回包", () => {
    const router = swRouter({ "get-settings": vi.fn() });
    const sendResponse = vi.fn();

    expect(router({ type: "no-such-message" }, tabSender(), sendResponse)).toBe(false);
    expect(router({ type: "constructor" }, tabSender(), sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("type 不是字符串 / 缺失：不收、不回包", () => {
    const handler = vi.fn();
    const router = swRouter({ "get-settings": handler });
    const sendResponse = vi.fn();

    expect(router({ type: 7 }, tabSender(), sendResponse)).toBe(false);
    expect(router({}, tabSender(), sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("消息 router：来源守卫（注册表标签 + 注入判据）", () => {
  it("登记来源标签的消息 + 判据拒绝：同步回 { ok:false, error }、返回 false、handler 零调用", () => {
    const handler = vi.fn();
    const router = swRouter({ "segment-cache": handler });
    const sendResponse = vi.fn();

    const keepOpen = router(
      { type: "segment-cache", op: "save-raw", context: { bvid: "BV1" }, segments: [1] },
      tabSender(),
      sendResponse
    );

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: ASR_OFFSCREEN_REJECTION_MESSAGE });
    expect(handler).not.toHaveBeenCalled();
  });

  it("登记来源标签的消息 + 判据放行：进入 handler（回包口径照注册表）", () => {
    const handler = vi.fn();
    const router = swRouter({ "segment-cache": handler });
    const sendResponse = vi.fn();

    const keepOpen = router({ type: "segment-cache", op: "load-summary" }, OFFSCREEN_SENDER, sendResponse);

    expect(keepOpen).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("未登记来源标签的消息：即使注入的判据会拒绝也放行（默认放行）", () => {
    const handler = vi.fn();
    const router = createMessageRouter({
      handlers: { "resolve-ai-provider": handler },
      senders: { offscreen: () => false },
      rejectionMessage: ASR_OFFSCREEN_REJECTION_MESSAGE
    });
    const sendResponse = vi.fn();

    expect(router({ type: "resolve-ai-provider" }, tabSender(), sendResponse)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("登记了标签但注入的 senders 无该标签判据：放行（fail-open）", () => {
    const handler = vi.fn();
    const router = createMessageRouter({
      handlers: { "segment-cache": handler },
      senders: {},
      rejectionMessage: ASR_OFFSCREEN_REJECTION_MESSAGE
    });
    const sendResponse = vi.fn();

    expect(router({ type: "segment-cache", op: "load-summary" }, tabSender(), sendResponse)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("未注入 senders：不判来源（来源守卫轴的关态）", () => {
    const handler = vi.fn();
    const router = createMessageRouter({ handlers: { "segment-cache": handler } });
    const sendResponse = vi.fn();

    expect(router({ type: "segment-cache", op: "load-summary" }, tabSender(), sendResponse)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("拒绝文案由注入决定：换一个文案，回包就是那一个", () => {
    const router = createMessageRouter({
      handlers: { "segment-cache": vi.fn() },
      senders: { offscreen: () => false },
      rejectionMessage: "测试注入的拒绝文案"
    });
    const sendResponse = vi.fn();

    expect(router({ type: "segment-cache" }, tabSender(), sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "测试注入的拒绝文案" });
  });
});

describe("消息 router：payload 形状守卫（注册表 shape 判据）", () => {
  it("登记 shape 的消息 + 形状非法：同步回「消息载荷不合法」、返回 false、handler 零调用", () => {
    const handler = vi.fn();
    const router = swRouter({ "save-settings": handler });
    const sendResponse = vi.fn();

    const keepOpen = router({ type: "save-settings", settings: "junk" }, tabSender(), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "消息载荷不合法" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("形状合法：进入 handler", () => {
    const handler = vi.fn();
    const router = swRouter({ "save-settings": handler });
    const sendResponse = vi.fn();

    expect(router({ type: "save-settings", settings: { enableDebugLogs: true } }, tabSender(), sendResponse)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("消息 router：回包口径（注册表 reply 派生）", () => {
  it("async（get-settings）：恒持有通道，handler 返回值不参与判定", () => {
    const handler = vi.fn(() => "answered");
    const router = swRouter({ "get-settings": handler });
    const sendResponse = vi.fn();

    expect(router({ type: "get-settings" }, tabSender(), sendResponse)).toBe(true);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("sync（ai-presets-list）：恒已答，返回 false", () => {
    const handler = vi.fn((_message: unknown, _sender: MessageSender, respond: SendResponse) => {
      respond({ ok: true });
    });
    const router = swRouter({ "ai-presets-list": handler });
    const sendResponse = vi.fn();

    const keepOpen = router({ type: "ai-presets-list" }, tabSender(), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("branch（request-provider-origins 的同步分支）：单次同步回包 + 返回 false", () => {
    const handler = vi.fn((_message: unknown, _sender: MessageSender, respond: SendResponse) => {
      respond({ ok: true });
      return "answered";
    });
    const router = swRouter({ "request-provider-origins": handler });
    const sendResponse = vi.fn();

    const keepOpen = router({ type: "request-provider-origins", baseUrls: [] }, tabSender(), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("branch（转异步分支）：handler 返回 \"hold\" 即持有通道", () => {
    const handler = vi.fn(() => "hold");
    const router = swRouter({ "request-provider-origins": handler });
    const sendResponse = vi.fn();

    expect(router({ type: "request-provider-origins", baseUrls: [] }, tabSender(), sendResponse)).toBe(true);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("branch 的 handler 未返回判定：与已答同义（通道不持有）", () => {
    const handler = vi.fn();
    const router = swRouter({ "request-provider-origins": handler });
    const sendResponse = vi.fn();

    expect(router({ type: "request-provider-origins" }, tabSender(), sendResponse)).toBe(false);
  });
});

describe("消息 router：注册表外类型的回包口径", () => {
  it("类型不在注册表：无形状判据、无来源标签，照常三参派发", () => {
    const handler = vi.fn();
    const router = createMessageRouter({ handlers: { "reader-restore": handler } });

    expect(router({ type: "reader-restore", readerUrl: "x" }, undefined, vi.fn())).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    const sendResponse = vi.fn();
    router({ type: "reader-restore", readerUrl: "x" }, tabSender(), sendResponse);
    expect(handler.mock.calls[1]).toHaveLength(3);
    expect(handler.mock.calls[1][2]).toBe(sendResponse);
  });

  it("无登记 = handler 返回值即通道口径（返回 true 即持有通道）", () => {
    const router = createMessageRouter({ handlers: { "reader-close": vi.fn(() => true) } });

    expect(router({ type: "reader-close" }, undefined, vi.fn())).toBe(true);
  });
});

describe("消息 router：来源名单单源（注册表 sender 标签派生）", () => {
  it("OFFSCREEN_ONLY_MESSAGE_TYPES 导出且恰为协议约定的两项", () => {
    expect([...OFFSCREEN_ONLY_MESSAGE_TYPES]).toEqual(["segment-cache", "offscreen-request-close"]);
  });

  it("名单每一项从 tab 来源都被拒：守卫拒绝集与派生名单一致", () => {
    for (const type of OFFSCREEN_ONLY_MESSAGE_TYPES) {
      const handler = vi.fn();
      const router = swRouter({ [type]: handler });
      const sendResponse = vi.fn();

      expect(router({ type }, tabSender(), sendResponse), `${type} 应被来源守卫拒绝`).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: ASR_OFFSCREEN_REJECTION_MESSAGE });
      expect(handler).not.toHaveBeenCalled();
    }
  });
});

describe("消息 router：结构锁（源码文本级）", () => {
  it("正文不得出现任何消息类型字面量（键集是注册表的事实）", () => {
    for (const type of Object.keys(BACKGROUND_MESSAGE_REGISTRY)) {
      expect(ROUTER_SOURCE, `${type} 的 type 字面量回抄进了 router 正文`).not.toContain(`"${type}"`);
    }
  });

  it("正文不得出现 message.type === 式按键分派", () => {
    expect(ROUTER_SOURCE).not.toMatch(/message\.type\s*===/);
  });

  it("来源判据只经注册表 sender 标签 + 注入的 senders（不得自带域判据）", () => {
    expect(ROUTER_SOURCE).toContain("senders");
    expect(ROUTER_SOURCE).toMatch(/\.sender\b/);
    expect(ROUTER_SOURCE).not.toContain("isOffscreenDocumentSender");
  });

  it("零 chrome API 触碰（判据本体与 handler 本体都住各自域）", () => {
    expect(ROUTER_SOURCE).not.toMatch(/\bchrome\s*\./);
  });

  it("不得 import 任何域 handler 模块（handler 表留组合根）", () => {
    const importSpecs = [...ROUTER_SOURCE.matchAll(/from\s*"(\.[^"]+)"/g)].map((match) => match[1]);
    expect(importSpecs.length).toBeGreaterThan(0);
    for (const spec of importSpecs) {
      expect(spec, `router 只允许指向 shared 的相对依赖边，实得 ${spec}`).toMatch(/^\.\.\/shared\//);
    }
    expect(ROUTER_SOURCE).not.toMatch(/from\s*"\.\.\/(entry|ai|asr|chat|search|bilibili|notes|reader|subtitle|ui)\//);
  });

  it("拒绝文案由组合根注入：router 不持文案本身（单源常量住 asr/protocol）", () => {
    expect(ROUTER_SOURCE).not.toContain(ASR_OFFSCREEN_REJECTION_MESSAGE);
  });
});
