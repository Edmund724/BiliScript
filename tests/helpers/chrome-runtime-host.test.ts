// tests/helpers/chrome-runtime-host.ts 的契约用例：两种回包风格 + 最小宿主的装配与
// onConnect 登记。这些契约原先在各用例的私有桩里各写一份（「未登记 type 回 { ok: true }」
// 这条兜底就散在近二十处）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { callbackStyleSendMessage, installMinimalChromeHost } from "./chrome-runtime-host.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runtime 回包表：分发与未登记 type", () => {
  it("登记过的 type 回登记值，未登记的抛错并点出 type", async () => {
    const host = installMinimalChromeHost({ replies: { "get-settings": { ok: true, settings: { a: 1 } } } });
    await expect(host.sendMessage({ type: "get-settings" })).resolves.toEqual({ ok: true, settings: { a: 1 } });
    await expect(host.sendMessage({ type: "not-registered" })).rejects.toThrow(
      "未登记的 runtime 消息类型：not-registered"
    );
  });

  it("函数值回包收到原消息（可 async）；fallback 可显式覆盖（含 undefined）", async () => {
    const host = installMinimalChromeHost({
      replies: { "provider-http": async (message: unknown) => ({ echo: (message as { url?: string }).url }) },
      fallback: undefined
    });
    await expect(host.sendMessage({ type: "provider-http", url: "https://x/y" })).resolves.toEqual({ echo: "https://x/y" });
    await expect(host.sendMessage({ type: "not-registered" })).resolves.toBeUndefined();
  });

  it("callback 风格：回包只经 callback、返回值恒 undefined", () => {
    const send = callbackStyleSendMessage({ "get-settings": { ok: true } });
    const callback = vi.fn();
    expect(send({ type: "get-settings" }, callback)).toBeUndefined();
    expect(callback).toHaveBeenCalledWith({ ok: true });

    expect(() => send({ type: "not-registered" }, vi.fn())).toThrow("未登记的 runtime 消息类型：not-registered");

    const lenient = callbackStyleSendMessage({}, { fallback: undefined });
    const lenientCallback = vi.fn();
    lenient({ type: "not-registered" }, lenientCallback);
    expect(lenientCallback).toHaveBeenCalledWith(undefined);
  });

  it("replyStyle: both 同时答 callback 与 promise（同一链上两种发送方式都要回包）", async () => {
    const host = installMinimalChromeHost({ replies: { "get-debug-log-gate": { ok: true } }, replyStyle: "both" });
    const callback = vi.fn();
    const returned = host.sendMessage({ type: "get-debug-log-gate" }, callback);
    expect(callback).toHaveBeenCalledWith({ ok: true });
    await expect(returned).resolves.toEqual({ ok: true });
  });
});

describe("installMinimalChromeHost：最小面装配", () => {
  it("缺省只装 runtime（无 storage / offscreen），sendMessage 是同一份分发", async () => {
    const host = installMinimalChromeHost({ replies: { "resolve-ai-provider": { ok: true, apiKey: "k" } } });
    const chrome = globalThis.chrome as unknown as Record<string, unknown>;
    expect(Object.keys(chrome)).toEqual(["runtime"]);
    expect("storage" in chrome).toBe(false);
    expect("offscreen" in chrome).toBe(false);
    expect((chrome.runtime as { sendMessage: unknown }).sendMessage).toBe(host.sendMessage);
    await expect(host.sendMessage({ type: "resolve-ai-provider" })).resolves.toEqual({ ok: true, apiKey: "k" });
    expect(host.storage).toBeNull();
  });

  it("onConnect 登记收进本台宿主的监听器数组（用例手驱，不用自持数组）", () => {
    const host = installMinimalChromeHost({ onConnect: true });
    expect(host.onConnectListeners).toEqual([]);
    const listener = vi.fn();
    (globalThis.chrome.runtime.onConnect.addListener as (fn: unknown) => void)(listener);
    expect(host.onConnectListeners).toEqual([listener]);
  });

  it("storage: true 装内存面（三形状读可用）；offscreen: true 装 closeDocument", async () => {
    const host = installMinimalChromeHost({ storage: true, offscreen: true });
    await host.storage?.set({ a: 1 });
    await expect(host.storage?.get(null)).resolves.toEqual({ a: 1 });
    expect(
      (globalThis.chrome as unknown as { offscreen: { closeDocument: () => Promise<void> } }).offscreen.closeDocument
    ).toBeTypeOf("function");
  });

  it("preserveExisting: true 沿用既有 chrome 的其余成员（其余成员不被最小面抹掉）", () => {
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://t/${path}` } });
    installMinimalChromeHost({ preserveExisting: true });
    const chrome = globalThis.chrome as unknown as { runtime: { getURL: (p: string) => string } };
    expect(chrome.runtime.getURL("x.css")).toBe("chrome-extension://t/x.css");
  });
});
