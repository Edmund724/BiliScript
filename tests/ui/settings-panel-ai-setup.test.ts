import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { state } from "../../extension/core/state.js";
import { registerDebugGate } from "../../extension/shared/logging.js";
import { closeProviderEditor } from "../../extension/ui/provider-editor.js";
import * as settingsPanel from "../../extension/ui/settings-panel.js";
import { resetSettingsPanelState } from "../helpers/reset-settings-panel-state.js";

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
  await settingsPanel.renderReaderSettingsPanel();
  expect(
    chromeStub().runtime.sendMessage.mock.calls.some(([m]) => m.type === "asr-providers-list")
  ).toBe(true);
  return { sent, panel: settingsPanel };
}

const SESSION = {
  onAfterSave: () => {},
  onSessionEnd: () => {}
};

beforeEach(() => {
  resetSettingsPanelState();
});

afterEach(() => {
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
    expect(document.activeElement).not.toBe(
      dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey")
    );
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
    expect(state.reader.readingSettingsExpanded).toBe(true);
  });

  it("调用方给定已选平台记录：直达该记录而不是 defaultModel 指向的那条", async () => {
    const preferred = { ...MISSING_KEY_PROVIDER, id: "prov-2", name: "已选平台" };
    const { panel } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [MISSING_KEY_PROVIDER, preferred] }),
      "get-settings": () => ({ ok: true, settings: { defaultModel: "prov-1" } })
    });
    await panel.openReaderAiSetup("missing-key", SESSION, { providerId: "prov-2" });
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".provider-editor-title")?.textContent).toBe("编辑AI 平台");
    expect(dialog?.querySelector<HTMLInputElement>(".provider-editor-name")?.value).toBe("已选平台");
    expect(document.activeElement).toBe(
      dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey")
    );
  });
});

describe("openReaderAiSetup：缺模型 → 无需 Key 平台（如 Ollama）也能直接进入模型配置", () => {
  const OLLAMA_NO_MODEL = {
    id: "ollama-1",
    presetId: "ollama",
    name: "Ollama 本地",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [] as string[],
    requiresKey: false,
    enabled: true,
    hasSavedKey: false
  };

  it("no-model 直达 requiresKey: false 平台并打开模型编辑且聚焦添加模型控件", async () => {
    const { panel } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [OLLAMA_NO_MODEL] }),
      "get-settings": () => ({ ok: true, settings: { defaultModel: "ollama-1" } })
    });
    await panel.openReaderAiSetup("no-model", SESSION);
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".provider-editor-title")?.textContent).toBe("编辑AI 平台");
    expect(dialog?.querySelector<HTMLInputElement>(".provider-editor-name")?.value).toBe("Ollama 本地");
    expect(dialog?.querySelector(".provider-editor-context-banner")?.textContent).toContain("请至少添加一个可用模型后保存继续");
    expect(document.activeElement).toBe(
      dialog?.querySelector<HTMLElement>(
        '[data-provider-editor-action="add-model"], .provider-editor-model-input, .provider-editor-model'
      )
    );
  });
});

describe("setup-flows：配置拉取异常留痕（经 settings-panel 公开入口，不静默吞错）", () => {
  it("未渲染宿主时 resolveEditableAiProviderId 在通信抛错或返回 !ok 时通过 logWarn 留痕并返回空串", async () => {
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installMessageBus();
      const aiTransportError = new Error("ai channel closed");

      chromeStub().runtime.sendMessage.mockImplementationOnce((_msg, cb) => {
        cb?.({ ok: false, error: "ai list denied" });
      });
      await expect(settingsPanel.resolveEditableAiProviderId()).resolves.toBe("");
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] load ai providers returned invalid response",
        { ok: false, error: "ai list denied" }
      );

      chromeStub().runtime.sendMessage.mockImplementationOnce(() => {
        throw aiTransportError;
      });
      await expect(settingsPanel.resolveEditableAiProviderId()).resolves.toBe("");
      expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] load ai providers failed", aiTransportError);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("openReaderAsrSetup 在未渲染宿主且拉取 ASR 列表异常时通过 logWarn 留痕并回落空列表", async () => {
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      document.body.innerHTML = `
        <div id="biliscript-reading-view">
          <section id="biliscript-reading-settings-panel">
            <div id="biliscript-reading-settings-host"></div>
          </section>
        </div>`;
      installMessageBus();
      const asrTransportError = new Error("asr channel closed");
      chromeStub().runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg?.type === "asr-providers-list") {
          throw asrTransportError;
        }
        if (msg?.type === "get-settings") {
          cb?.({ ok: true, settings: { asrAutoFallback: false } });
          return;
        }
        cb?.({ ok: true, providers: [] });
      });
      const host = document.getElementById("biliscript-reading-settings-host")!;
      host.dataset.biliscriptSettingsRendered = "1";
      const { buildSettingsHtml } = await import("../../extension/ui/settings-panel-html.js");
      host.innerHTML = buildSettingsHtml();

      await settingsPanel.openReaderAsrSetup();
      expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] load asr providers failed", asrTransportError);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
