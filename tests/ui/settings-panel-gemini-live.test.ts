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

const MOSS_LIVE = {
  id: "live_moss",
  presetId: "moss-live",
  name: "MOSS Live",
  type: "moss-live",
  baseUrl: "https://api.mosi.cn",
  model: "moss-live-1.0",
  enabled: true,
  hasSavedKey: true
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

  it("公开 Gemini 凭据入口直达共享 AI 记录的 Key 字段", async () => {
    await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [GEMINI_AI] })
    });
    const panel = await import("../../extension/ui/settings-panel.js");

    await panel.openLiveSettings("gemini-key");

    await vi.waitFor(() => expect(document.querySelector(".provider-editor-dialog")).toBeTruthy());
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const key = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    expect(dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("gemini");
    expect(key.closest<HTMLElement>(".provider-editor-field")!.hidden).toBe(false);
    expect(document.activeElement).toBe(key);
  });

  it("Gemini 凭据入口使用唯一引用解析，空 baseUrl 按官方默认端点直达且不误选其他记录", async () => {
    const defaultGemini = { ...GEMINI_AI, id: "p_gemini_default", name: "Gemini 默认端点", baseUrl: "" };
    const customGemini = { ...GEMINI_AI, id: "p_gemini_custom", name: "Gemini 自定义代理", baseUrl: "https://proxy.example.com" };
    const nonGemini = { ...GEMINI_AI, id: "p_openai", presetId: "openai", name: "非 Gemini 记录", protocol: "openai" };
    await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [customGemini, nonGemini, defaultGemini] })
    });
    const panel = await import("../../extension/ui/settings-panel.js");

    await panel.openLiveSettings("gemini-key");

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-name")!.value).toBe("Gemini 默认端点");
    expect(document.activeElement).toBe(dialog.querySelector(".provider-editor-apikey"));
  });

  it("没有共享 AI 记录时 Gemini 凭据入口直接打开 Gemini 预设", async () => {
    await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [] })
    });
    const panel = await import("../../extension/ui/settings-panel.js");

    await panel.openLiveSettings("gemini-key");

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    expect(dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("gemini");
    expect(document.activeElement).toBe(dialog.querySelector(".provider-editor-apikey"));
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
    expect(liveSubtitle(host)).toBe("gemini-3.8-live · 尚未配置官方 Gemini AI Key");

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
      expect(liveSubtitle(host)).toBe("gemini-3.8-live · 尚未配置官方 Gemini AI Key");
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

  it("全局区不渲染原生搜索开关，仅在编辑 Gemini Live Modal 中显示并在保存时落盘", async () => {
    const { host, sent } = await mountPanel();
    expect(host.querySelector("#liveGeminiNativeSearch")).toBeNull();

    click(host.querySelector("#liveProvidersList .provider-row-edit"));
    await vi.waitFor(() => expect(document.querySelector(".provider-editor-dialog")).toBeTruthy());
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const searchField = dialog.querySelector<HTMLElement>(".provider-editor-field-gemini-search")!;
    expect(searchField).toBeTruthy();
    expect(searchField.hidden).toBe(false);

    const toggle = searchField.querySelector<HTMLInputElement>(".provider-editor-gemini-search")!;
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    click(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((msg) => msg.type === "live-providers-save")).toBe(true);
    });

    const saveMsg = sent.find((msg) => msg.type === "live-providers-save") as {
      providers?: Array<{ liveGeminiNativeSearch?: boolean }>;
    };
    expect(saveMsg?.providers?.[0]?.liveGeminiNativeSearch).toBe(true);
  });
});

describe("MOSS Live 音色选择器与回退提示", () => {
  it("打开编辑 Modal 时取一次音色列表，选项显示 name（空名回退 id），保存按 provider 落盘", async () => {
    await chrome.storage.local.set({ liveProviderKeys: { live_moss: "sk-moss" } });
    const { host, sent } = await mountPanel({
      "live-providers-list": () => ({ ok: true, providers: [MOSS_LIVE] }),
      "provider-http": () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          data: [
            { id: "voice-1", name: "Alice" },
            { id: "voice-2", name: "" }
          ],
          has_more: false
        })
      })
    });

    click(host.querySelector("#liveProvidersList .provider-row-edit"));
    await vi.waitFor(() => expect(document.querySelector(".provider-editor-dialog")).toBeTruthy());
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const voice = dialog.querySelector<HTMLSelectElement>(".provider-editor-voice")!;
    await vi.waitFor(() => expect(voice.options).toHaveLength(3));

    expect(Array.from(voice.options).map((option) => option.textContent)).toEqual([
      "默认音色",
      "Alice",
      "voice-2"
    ]);
    voice.value = "voice-1";
    voice.dispatchEvent(new Event("change", { bubbles: true }));

    click(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "live-providers-save")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "live-providers-save") as {
      providers?: Array<{ voiceId?: string }>;
    };
    expect(saveMessage.providers?.[0]?.voiceId).toBe("voice-1");
    const requests = sent.filter((message) => message.type === "provider-http");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.mosi.cn/v1/audio/voices?limit=150");
    expect(requests[0]?.headers).toMatchObject({ authorization: "Bearer sk-moss" });
  });

  it("音色回退提示在设置里只出现一次（读取即清除）", async () => {
    await chrome.storage.local.set({
      liveVoiceFallbackNotice: { voiceId: "voice-1" }
    });
    const { host } = await mountPanel({
      "live-providers-list": () => ({ ok: true, providers: [MOSS_LIVE] })
    });

    const hint = host.querySelector<HTMLElement>("#liveVoiceFallbackHint")!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("所选音色已不可用，伴看已回退默认音色。");
    const stored = await chrome.storage.local.get(["liveVoiceFallbackNotice"]);
    expect(stored.liveVoiceFallbackNotice).toBeUndefined();

    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    await vi.waitFor(() => expect(hint.hidden).toBe(true));
    expect(hint.textContent).toBe("");
  });
});
