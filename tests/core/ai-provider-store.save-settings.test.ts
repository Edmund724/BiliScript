// settings-store.js saveSettings 部分保存语义测试：
// saveSettings 只应归一化并写回 payload 中实际存在的 key，
// 缺失的 key 不得被默认值覆盖（否则如 setThinkingLevel 只传
// aiThinkingLevel 时会把 enablePlayerAiQuickAction 冲成 false）。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

let syncSetMock: Mock;

async function loadModule() {
  const module = await import("../../extension/core/settings-store.js");
  return module;
}

function extractSetPayload() {
  expect(syncSetMock).toHaveBeenCalledTimes(1);
  return syncSetMock.mock.calls[0][0];
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  syncSetMock = vi.fn(async () => {});
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: {
      ...globalThis.chrome.storage,
      sync: {
        ...globalThis.chrome.storage.sync,
        set: syncSetMock
      }
    }
  });
});

describe("saveSettings 部分保存", () => {
  it("只传 aiThinkingLevel 时，payload 仅含该 key，其它 key 不出现", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ aiThinkingLevel: "high" });
    const payload = extractSetPayload();
    expect(payload).toEqual({ aiThinkingLevel: "high" });
    expect(payload).not.toHaveProperty("enablePlayerAiQuickAction");
  });

  it("readerTheme 存在而 readerChapterVisible 缺失时，不写入缺失的 key", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ readerTheme: "dark" });
    expect(extractSetPayload()).toEqual({ readerTheme: "dark" });
  });

  it("payload 含 aiSystemPrompt: undefined 时，set 收到的 payload 不含该 key", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ aiSystemPrompt: undefined, defaultModel: "glm-4" });
    const payload = extractSetPayload();
    expect(payload).toEqual({ defaultModel: "glm-4" });
    expect(payload).not.toHaveProperty("aiSystemPrompt");
  });

  it("options 场景回归：只传 { defaultModel } 不写入其它 key", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ defaultModel: "x" });
    expect(extractSetPayload()).toEqual({ defaultModel: "x" });
  });
});

describe("saveSettings 全量保存", () => {
  // C5 收编依据：defaultModel 经 save-settings 落盘时过 normalizeDefaultModel
  //（trim）——原 chat-tab 直写 sync 绕过这一步，带空白的裸平台 id 会原样进存储。
  it("defaultModel 归一化：两侧空白剥掉", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ defaultModel: "  p1  " });
    expect(extractSetPayload()).toEqual({ defaultModel: "p1" });
  });

  it("全量 payload 时所有 key 仍被归一化（options.js 保存路径不受影响）", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({
      enablePlayerAiQuickAction: true,
      readerTheme: "neon", // 非法主题，应回落 "light"
      aiThinkingLevel: "medium" // 非法档位，应回落 "off"
    });
    const payload = extractSetPayload();
    expect(payload.enablePlayerAiQuickAction).toBe(true);
    expect(payload.readerTheme).toBe("light");
    expect(payload.aiThinkingLevel).toBe("off");
  });
});
