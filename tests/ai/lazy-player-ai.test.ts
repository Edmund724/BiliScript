import { beforeEach, describe, expect, it, vi } from "vitest";

async function importLoader() {
  return import("../../extension/ai/lazy-player-ai.js");
}

beforeEach(() => {
  vi.resetModules();
});

describe("loadPlayerAi", () => {
  it("首次调用触发动态 import，解析出 player-ai 模块命名空间", async () => {
    const playerAiNamespace = { startPlayerAiQuickAction: vi.fn() };
    vi.doMock("../../extension/ai/player-ai.js", () => playerAiNamespace);

    const { loadPlayerAi, isPlayerAiLoaded } = await importLoader();
    expect(isPlayerAiLoaded()).toBe(false);

    const mod = (await loadPlayerAi()) as unknown as typeof import("../../extension/ai/player-ai.js");
    expect(typeof mod.startPlayerAiQuickAction).toBe("function");
    mod.startPlayerAiQuickAction();
    expect(playerAiNamespace.startPlayerAiQuickAction).toHaveBeenCalled();
    expect(isPlayerAiLoaded()).toBe(true);
  });

  it("重复调用共享同一 promise（不重复触发 import）", async () => {
    const playerAiNamespace = { stopPlayerAiQuickAction: vi.fn() };
    vi.doMock("../../extension/ai/player-ai.js", () => playerAiNamespace);

    const { loadPlayerAi } = await importLoader();
    const p1 = loadPlayerAi();
    const p2 = loadPlayerAi();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
  });

  it("加载失败：reject、isPlayerAiLoaded 回落 false、缓存清空允许重试", async () => {
    vi.doMock("../../extension/ai/player-ai.js", () => {
      throw new Error("chunk 404 (player-ai)");
    });
    const first = await importLoader();
    await expect(first.loadPlayerAi()).rejects.toThrow();
    expect(first.isPlayerAiLoaded()).toBe(false);

    vi.resetModules();
    const playerAiNamespace = { startPlayerAiQuickAction: vi.fn() };
    vi.doMock("../../extension/ai/player-ai.js", () => playerAiNamespace);
    const second = await importLoader();
    const mod = (await second.loadPlayerAi()) as unknown as typeof import("../../extension/ai/player-ai.js");
    expect(typeof mod.startPlayerAiQuickAction).toBe("function");
    expect(second.isPlayerAiLoaded()).toBe(true);
  });
});
