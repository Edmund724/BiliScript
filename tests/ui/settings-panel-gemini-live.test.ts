import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";

const GEMINI_LIVE = {
  id: "live_gemini",
  presetId: "gemini-live",
  name: "Gemini Live",
  type: "gemini-live",
  baseUrl: "https://generativelanguage.googleapis.com",
  model: "gemini-3.8-live",
  enabled: true,
  hasSavedKey: false
};

const GEMINI_AI = {
  id: "p_gemini",
  presetId: "gemini",
  name: "Gemini",
  type: "gemini",
  protocol: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  models: ["gemini-3.8-live"],
  enabled: true,
  hasSavedKey: true
};

function click(node: Element | null): void {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function input(node: HTMLInputElement, value: string): void {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountPanel(overrides: Record<string, BusResponder<BusMessage>> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const bus = installSettingsPanelBus<BusMessage>({
    "live-providers-list": () => ({ ok: true, providers: [GEMINI_LIVE] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(host.querySelector("#liveProvidersList .live-provider-row")).toBeTruthy();
  });
  return { host, sent: bus.sent };
}

function liveSubtitle(host: HTMLElement): string {
  return host.querySelector("#liveProvidersList .live-provider-row .provider-row-model")?.textContent || "";
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("设置面板 Gemini Live 凭据引用", () => {
  it("行副标题组合模型名与凭据状态", async () => {
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [GEMINI_AI] })
    });
    expect(liveSubtitle(host)).toBe("gemini-3.8-live · 已复用 AI 平台 Key");
  });

  it("AI 平台新增官方 Gemini 记录后同步刷新实时平台行", async () => {
    let aiProviders: Record<string, unknown>[] = [];
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-save": (_message) => {
        aiProviders = [GEMINI_AI];
        return { ok: true, providers: aiProviders };
      }
    });
    expect(liveSubtitle(host)).toBe("gemini-3.8-live · 请先在 AI 平台添加官方 Gemini 记录");

    click(host.querySelector("#addAiProviderBtn"));
    await vi.waitFor(() => expect(document.querySelector(".provider-editor-dialog")).toBeTruthy());
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const preset = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    preset.value = "gemini";
    preset.dispatchEvent(new Event("change"));
    input(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "shared-gemini-key");
    click(dialog.querySelector(".provider-editor-model-add"));
    input(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gemini-3.8-live");
    click(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(liveSubtitle(host)).toBe("gemini-3.8-live · 已复用 AI 平台 Key");
    });
  });

  it("AI 平台删除 Gemini 记录后同步刷新实时平台行", async () => {
    let aiProviders: Record<string, unknown>[] = [GEMINI_AI];
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-delete": () => {
        aiProviders = [];
        return { ok: true, providers: aiProviders };
      }
    });
    expect(liveSubtitle(host)).toBe("gemini-3.8-live · 已复用 AI 平台 Key");

    click(host.querySelector("#aiProvidersList .provider-row-remove"));
    click(document.querySelector(".confirm-dialog-confirm"));

    await vi.waitFor(() => {
      expect(liveSubtitle(host)).toBe("gemini-3.8-live · 请先在 AI 平台添加官方 Gemini 记录");
    });
  });

  it("编辑器隐藏 Key，测试按钮通过引用凭据发探针且不要求手填", async () => {
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [GEMINI_AI] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "shared-gemini-key" }),
      "provider-http": () => ({ ok: true, status: 200, body: JSON.stringify({ models: [] }) })
    });
    click(host.querySelector("#liveProvidersList .provider-row-edit"));
    await vi.waitFor(() => expect(document.querySelector(".provider-editor-dialog")).toBeTruthy());
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const key = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    expect(key.closest<HTMLElement>(".provider-editor-field")!.hidden).toBe(true);
    expect(key.required).toBe(false);

    click(dialog.querySelector(".provider-editor-test"));
    await vi.waitFor(() => {
      expect(dialog.querySelector(".provider-editor-status")!.textContent).toBe("连接成功");
    });
    const request = sent.find((message) => message.type === "provider-http");
    expect(request?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(request?.headers).toMatchObject({ "x-goog-api-key": "shared-gemini-key" });
    expect(sent.some((message) => message.type === "live-providers-save")).toBe(false);
  });

  it("在实时伴看平台分区底部渲染“Gemini 伴看使用原生 Google 搜索”开关、双向同步且不随恢复默认偏好重置", async () => {
    const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
    expect(DEFAULT_SETTINGS.liveGeminiNativeSearch).toBe(false);

    const { host, sent } = await mountPanel();
    const toggle = host.querySelector<HTMLInputElement>("#liveGeminiNativeSearch")!;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);
    expect(toggle.dataset.toggleSwitchInitialized).toBe("1");
    const rowLabel = toggle.closest(".biliscript-toggle-row")?.querySelector(".biliscript-toggle-text");
    expect(rowLabel?.textContent).toBe("Gemini 伴看使用原生 Google 搜索");

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(
      sent.some(
        (msg) =>
          msg.type === "save-settings" &&
          (msg.settings as Record<string, unknown>)?.liveGeminiNativeSearch === true
      )
    ).toBe(true);

    click(host.querySelector("#biliscriptSettingsResetBtn"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-confirm")).toBeTruthy());
    click(document.querySelector(".confirm-dialog-confirm"));

    await vi.waitFor(() => {
      expect(sent.filter((msg) => msg.type === "save-settings").length).toBeGreaterThanOrEqual(2);
    });
    const resetMsg = sent
      .filter((msg) => msg.type === "save-settings")
      .at(-1) as { settings?: Record<string, unknown> } | undefined;
    expect(resetMsg?.settings).toBeTruthy();
    expect(resetMsg?.settings).not.toHaveProperty("liveGeminiNativeSearch");
    expect(toggle.checked).toBe(true);

    const listeners = (
      (globalThis.chrome.storage.onChanged.addListener as unknown as { mock: { calls: Array<[(changes: Record<string, { newValue: unknown }>, areaName: string) => void]> } }).mock.calls
    ).map((call) => call[0]);
    for (const listener of listeners) {
      listener({ liveGeminiNativeSearch: { newValue: false } }, "sync");
    }
    expect(toggle.checked).toBe(false);
  });
});
