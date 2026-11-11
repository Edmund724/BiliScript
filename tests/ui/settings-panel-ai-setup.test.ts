// 概览「去设置」直达入口（票 provider-onboarding-consistency/01，settings-panel 侧）：
// - 无记录（no-provider）：直接打开新增 AI 平台编辑器，保存钮「保存并继续」（首配模式）；
// - 缺 Key（missing-key）：定位缺 Key 的启用记录（defaultModel 精确 → 首个启用回落），
//   直接编辑该记录并聚焦 Key 输入框；
// - 找不到缺 Key 记录（列表在报错后被改动）：只打开设置抽屉，不弹编辑器；
// - 无字幕空态「前往设置」：打开设置抽屉（语音转写分区）。
//
// 手法：对齐 tests/ui/provider-editor-save.test.ts——真实 settings-panel + 消息总线桩。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

function chromeStub(): { runtime: { sendMessage: ReturnType<typeof vi.fn> } } {
  return chrome as unknown as { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
}

function installMessageBus(overrides: Record<string, MessageResponder> = {}): SentMessage[] {
  const host = installSettingsPanelBus<SentMessage>({
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  return host.sent;
}

async function mountPanel(busOverrides: Record<string, MessageResponder> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const sent = installMessageBus(busOverrides);
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  await vi.waitFor(() => {
    expect(
      chromeStub().runtime.sendMessage.mock.calls.some(([m]) => m.type === "asr-providers-list")
    ).toBe(true);
  });
  return { sent, panel };
}

const SESSION = {
  onAfterSave: () => {},
  onSessionEnd: () => {}
};

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("openReaderAiSetup：无记录 → 新增 AI 平台流程", () => {
  it("打开设置抽屉 + 新增编辑器（保存并继续），不聚焦 Key", async () => {
    const { panel } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [] })
    });
    await panel.openReaderAiSetup("no-provider", SESSION);
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    expect(dialog?.querySelector(".provider-editor-save")?.textContent).toBe("保存并继续");
    // 新增流程不聚焦 Key（聚焦在对话框本体）
    expect(document.activeElement).not.toBe(
      dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey")
    );
    // 设置抽屉随入口打开
    const { state } = await import("../../extension/core/state.js");
    expect(state.reader.readingSettingsExpanded).toBe(true);
    expect(document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(false);
  });
});

describe("openReaderAiSetup：缺 Key → 编辑该记录并聚焦 Key", () => {
  const MISSING_KEY_PROVIDER = {
    id: "prov-1",
    presetId: "custom",
    name: "测试平台",
    baseUrl: "https://api.test/v1",
    models: ["test-model"],
    requiresKey: true,
    enabled: true,
    hasSavedKey: false
  };

  it("defaultModel 指向的缺 Key 记录：直接编辑", async () => {
    const { panel } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [MISSING_KEY_PROVIDER] }),
      "get-settings": () => ({ ok: true, settings: { defaultModel: "prov-1" } })
    });
    await panel.openReaderAiSetup("missing-key", SESSION);
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".provider-editor-title")?.textContent).toBe("编辑AI 平台");
    expect(dialog?.querySelector(".provider-editor-save")?.textContent).toBe("保存并继续");
    // 聚焦 Key 输入框
    expect(document.activeElement).toBe(
      dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey")
    );
  });

  it("defaultModel 未指向缺 Key 记录 → 回落首个启用的缺 Key 记录", async () => {
    const other = { ...MISSING_KEY_PROVIDER, id: "prov-2", hasSavedKey: true };
    const { panel, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [other, MISSING_KEY_PROVIDER] }),
      "get-settings": () => ({ ok: true, settings: { defaultModel: "prov-2" } })
    });
    await panel.openReaderAiSetup("missing-key", SESSION);
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".provider-editor-title")?.textContent).toBe("编辑AI 平台");
    expect(document.activeElement).toBe(
      dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey")
    );
    // 编辑保存按原 id 替换非追加（落盘事务现查合并，此处只验证走到了编辑链路）
    expect(sent.some((m) => m.type === "ai-providers-list")).toBe(true);
  });

  it("找不到缺 Key 记录：只打开设置抽屉，不弹编辑器", async () => {
    const saved = { ...MISSING_KEY_PROVIDER, id: "prov-3", hasSavedKey: true };
    const { panel } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [saved] }),
      "get-settings": () => ({ ok: true, settings: { defaultModel: "prov-3" } })
    });
    await panel.openReaderAiSetup("missing-key", SESSION);
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    const { state } = await import("../../extension/core/state.js");
    expect(state.reader.readingSettingsExpanded).toBe(true);
  });
});

describe("openReaderTranscribeSettings：空态「前往设置」", () => {
  it("打开设置抽屉（语音转写分区），不弹平台编辑器", async () => {
    const { panel } = await mountPanel();
    await panel.openReaderTranscribeSettings();
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    const { state } = await import("../../extension/core/state.js");
    expect(state.reader.readingSettingsExpanded).toBe(true);
    expect(document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(false);
  });
});
