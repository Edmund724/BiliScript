import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CONTENT_STYLE_PATHS,
  createContentStyleHandlers,
  resolveSenderFrameTarget,
  validateContentStyleFiles
} from "../../extension/core/content-style-handlers.js";
import { createMessageRouter, type MessageHandlerLike } from "../../extension/core/message-router.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

describe("content-style-handlers 安全白名单与发起方锁定", () => {
  it("静态白名单与 style-injector 声明样式完全一致、全部存在且不包含扩展页专用表", () => {
    const injectorText = readFileSync(join(process.cwd(), "extension/shared/style-injector.ts"), "utf8");
    const declared = [...new Set([...injectorText.matchAll(/"(entry\/styles\/[a-z-]+\.css)"/g)].map((m) => m[1]))];

    expect([...ALLOWED_CONTENT_STYLE_PATHS].sort()).toEqual([...declared].sort());
    for (const rel of ALLOWED_CONTENT_STYLE_PATHS) {
      expect(existsSync(join(process.cwd(), "extension", rel)), `${rel} 缺失`).toBe(true);
    }
    expect(ALLOWED_CONTENT_STYLE_PATHS).not.toContain("entry/styles/onboarding.css");
    expect(ALLOWED_CONTENT_STYLE_PATHS).not.toContain("entry/styles/permission-grant.css");
  });

  it("严格校验静态白名单：拦截路径穿越、前导斜杠、查询串、非内容表与混合非法批量", () => {
    expect(
      validateContentStyleFiles([
        "entry/styles/tokens-primitive.css",
        "entry/styles/reader.css",
        "entry/styles/reader.css"
      ])
    ).toEqual(["entry/styles/tokens-primitive.css", "entry/styles/reader.css"]);

    const invalidInputs: unknown[] = [
      null,
      undefined,
      "entry/styles/reader.css",
      [],
      [123],
      ["../manifest.json"],
      ["entry/styles/../manifest.json"],
      ["/entry/styles/reader.css"],
      ["entry/styles/reader.css?v=1"],
      ["entry/styles/reader.css#hash"],
      ["entry/styles/onboarding.css"],
      ["entry/styles/permission-grant.css"],
      ["__proto__"],
      ["constructor"],
      ["entry/styles/reader.css", "../manifest.json"],
      Array.from({ length: 40 }, () => "entry/styles/reader.css")
    ];
    for (const input of invalidInputs) {
      expect(validateContentStyleFiles(input), JSON.stringify(input)).toBeNull();
    }
  });

  it("发起方目标严格取自 sender.tab.id 与 sender.frameId", () => {
    expect(resolveSenderFrameTarget(undefined)).toBeNull();
    expect(resolveSenderFrameTarget({})).toBeNull();
    expect(resolveSenderFrameTarget({ tab: {} })).toBeNull();
    expect(resolveSenderFrameTarget({ tab: { id: 0 } })).toBeNull();
    expect(resolveSenderFrameTarget({ tab: { id: -1 } })).toBeNull();
    expect(resolveSenderFrameTarget({ tab: { id: 1.5 } })).toBeNull();
    expect(resolveSenderFrameTarget({ tab: { id: 12 }, frameId: -1 })).toBeNull();
    expect(resolveSenderFrameTarget({ tab: { id: 12 }, frameId: 1.2 })).toBeNull();

    expect(resolveSenderFrameTarget({ tab: { id: 12 } })).toEqual({ tabId: 12, frameIds: [0] });
    expect(resolveSenderFrameTarget({ tab: { id: 12 }, frameId: 0 })).toEqual({ tabId: 12, frameIds: [0] });
    expect(resolveSenderFrameTarget({ tab: { id: 12 }, frameId: 42 })).toEqual({ tabId: 12, frameIds: [42] });
  });

  it("insert/remove 锁定 sender.tab.id 与 frameIds 并忽略消息体伪造字段", async () => {
    const insertCSS = vi.fn(async () => {});
    const removeCSS = vi.fn(async () => {});
    const handlers = createContentStyleHandlers({
      scripting: { insertCSS, removeCSS },
      getRuntimeUrl: (p) => `chrome-extension://ext/${p}`
    });

    const insertReply = vi.fn();
    const spoofedInsert = {
      type: "content-style-insert" as const,
      files: ["entry/styles/tokens-primitive.css", "entry/styles/reader.css"],
      tabId: 999,
      frameId: 0
    };
    const sender: MessageSender = { tab: { id: 17, url: "https://live.bilibili.com/123" }, frameId: 88 };

    expect(handlers.insert(spoofedInsert, sender, insertReply)).toBe("hold");
    await vi.waitFor(() => expect(insertReply).toHaveBeenCalledWith({ ok: true }));
    expect(insertCSS).toHaveBeenCalledWith({
      target: { tabId: 17, frameIds: [88] },
      files: ["entry/styles/tokens-primitive.css", "entry/styles/reader.css"]
    });

    const removeReply = vi.fn();
    const spoofedRemove = {
      type: "content-style-remove" as const,
      files: ["entry/styles/reader.css"],
      tabId: 999,
      frameId: 0
    };
    expect(handlers.remove(spoofedRemove, sender, removeReply)).toBe("hold");
    await vi.waitFor(() => expect(removeReply).toHaveBeenCalledWith({ ok: true }));
    expect(removeCSS).toHaveBeenCalledWith({
      target: { tabId: 17, frameIds: [88] },
      files: ["entry/styles/reader.css"]
    });
  });

  it("缺失 sender.tab.id 或非法路径时同步拒绝，不调用 scripting 或 fetch", () => {
    const insertCSS = vi.fn(async () => {});
    const removeCSS = vi.fn(async () => {});
    const fetchImpl = vi.fn();
    const handlers = createContentStyleHandlers({
      scripting: { insertCSS, removeCSS },
      getRuntimeUrl: (p) => `chrome-extension://ext/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const r1 = vi.fn();
    expect(handlers.insert({ type: "content-style-insert", files: ["entry/styles/reader.css"] }, {}, r1)).toBe("answered");
    expect(r1).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const r2 = vi.fn();
    expect(
      handlers.insert({ type: "content-style-insert", files: ["entry/styles/onboarding.css"] }, { tab: { id: 5 }, frameId: 0 }, r2)
    ).toBe("answered");
    expect(r2).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const r3 = vi.fn();
    expect(
      handlers.remove({ type: "content-style-remove", files: ["../manifest.json"] }, { tab: { id: 5 }, frameId: 0 }, r3)
    ).toBe("answered");
    expect(r3).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const r4 = vi.fn();
    expect(handlers.read({ type: "content-style-read", files: ["entry/styles/reader.css"] }, {}, r4)).toBe("answered");
    expect(r4).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const r5 = vi.fn();
    expect(
      handlers.read({ type: "content-style-read", files: ["entry/styles/permission-grant.css"] }, { tab: { id: 5 }, frameId: 0 }, r5)
    ).toBe("answered");
    expect(r5).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    expect(insertCSS).not.toHaveBeenCalled();
    expect(removeCSS).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("read 运行期从扩展包读取并缓存成功结果，失败时不缓存", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      attempts += 1;
      const str = String(url);
      if (str.endsWith("reader-gate.css") && attempts === 1) {
        return { ok: false, status: 500, text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => `/* ${str} */` };
    });
    const handlers = createContentStyleHandlers({
      getRuntimeUrl: (p) => `chrome-extension://ext/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const sender: MessageSender = { tab: { id: 9 }, frameId: 0 };

    const failReply = vi.fn();
    expect(
      handlers.read({ type: "content-style-read", files: ["entry/styles/reader-gate.css"] }, sender, failReply)
    ).toBe("hold");
    await vi.waitFor(() => expect(failReply).toHaveBeenCalledWith({ ok: false, error: expect.any(String) }));

    const okReply1 = vi.fn();
    expect(
      handlers.read(
        { type: "content-style-read", files: ["entry/styles/reader-gate.css", "entry/styles/reader.css"] },
        sender,
        okReply1
      )
    ).toBe("hold");
    await vi.waitFor(() =>
      expect(okReply1).toHaveBeenCalledWith({
        ok: true,
        styles: {
          "entry/styles/reader-gate.css": "/* chrome-extension://ext/entry/styles/reader-gate.css */",
          "entry/styles/reader.css": "/* chrome-extension://ext/entry/styles/reader.css */"
        }
      })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const okReply2 = vi.fn();
    expect(
      handlers.read({ type: "content-style-read", files: ["entry/styles/reader.css"] }, sender, okReply2)
    ).toBe("hold");
    await vi.waitFor(() =>
      expect(okReply2).toHaveBeenCalledWith({
        ok: true,
        styles: {
          "entry/styles/reader.css": "/* chrome-extension://ext/entry/styles/reader.css */"
        }
      })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("经 message-router 路由时拒绝畸形 files 载荷", () => {
    const insertCSS = vi.fn(async () => {});
    const handlers = createContentStyleHandlers({
      scripting: { insertCSS },
      getRuntimeUrl: (p) => `chrome-extension://ext/${p}`
    });
    const router = createMessageRouter({
      handlers: {
        "content-style-insert": handlers.insert as MessageHandlerLike,
        "content-style-remove": handlers.remove as MessageHandlerLike,
        "content-style-read": handlers.read as MessageHandlerLike
      }
    });
    const reply = vi.fn();
    const keepOpen = router({ type: "content-style-insert", files: [] }, { tab: { id: 3 }, frameId: 0 }, reply);
    expect(keepOpen).toBe(false);
    expect(reply).toHaveBeenCalledWith({ ok: false, error: "消息载荷不合法" });
    expect(insertCSS).not.toHaveBeenCalled();
  });

  it("insert 遇无宿主权限错误（如 live.bilibili.com）自动回落返回白名单样式文本，其它错误保持失败", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      text: async () => `/* ${String(url)} */`
    }));
    const insertCSS = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Cannot access contents of url "https://live.bilibili.com/1001". Extension manifest must request permission to access this host.'
        )
      )
      .mockRejectedValueOnce(new Error("No frame with id 99"));
    const handlers = createContentStyleHandlers({
      scripting: { insertCSS },
      getRuntimeUrl: (p) => `chrome-extension://ext/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const sender: MessageSender = { tab: { id: 21, url: "https://live.bilibili.com/1001" }, frameId: 5 };

    const fallbackReply = vi.fn();
    expect(
      handlers.insert({ type: "content-style-insert", files: ["entry/styles/player-ai.css"] }, sender, fallbackReply)
    ).toBe("hold");
    await vi.waitFor(() =>
      expect(fallbackReply).toHaveBeenCalledWith({
        ok: true,
        styles: {
          "entry/styles/player-ai.css": "/* chrome-extension://ext/entry/styles/player-ai.css */"
        }
      })
    );

    const errReply = vi.fn();
    expect(
      handlers.insert({ type: "content-style-insert", files: ["entry/styles/reader.css"] }, sender, errReply)
    ).toBe("hold");
    await vi.waitFor(() =>
      expect(errReply).toHaveBeenCalledWith({
        ok: false,
        error: "No frame with id 99"
      })
    );
  });
});
