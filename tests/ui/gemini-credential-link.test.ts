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

const OFFICIAL_AI = {
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

function pressEsc(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".provider-editor-dialog");
}

function linkedRow(): HTMLElement | null {
  return dialog()?.querySelector<HTMLElement>(".provider-editor-linked-credential") ?? null;
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

async function openLiveGeminiEditor(host: HTMLElement): Promise<HTMLElement> {
  click(host.querySelector("#liveProvidersList .provider-row-edit"));
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return dialog()!;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  const panel = document.getElementById("biliscript-reading-settings-panel");
  if (panel) panel.hidden = true;
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("伴看 Gemini 编辑器内联凭据四态", () => {
  it("无记录：状态文案 + 「配置官方 Gemini Key」动作", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("尚未配置官方 Gemini AI Key");
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!.textContent)
      .toBe("配置官方 Gemini Key");
  });

  it("缺 Key：状态文案 + 「填写 AI Key」动作", async () => {
    const missingKey = { ...OFFICIAL_AI, hasSavedKey: false };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [missingKey] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("官方 Gemini AI Key 缺失或引用已失效");
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!.textContent)
      .toBe("填写 AI Key");
  });

  it("非官方地址：状态文案 + 「新建独立官方记录」动作", async () => {
    const relay = { ...OFFICIAL_AI, id: "p_gemini_relay", name: "Gemini 中转", baseUrl: "https://relay.example.com" };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [relay] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("AI 平台配置的并非 Gemini 官方接口地址");
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!.textContent)
      .toBe("新建独立官方记录");
  });

  it("可用：只读状态文案，无动作按钮", async () => {
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [OFFICIAL_AI] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "AIza-live" })
    });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("已复用 AI 平台 Key");
    expect(row.querySelector(".provider-editor-linked-credential-btn")).toBeNull();
  });
});

describe("凭据动作同层进入 AI 族编辑器", () => {
  it("无记录：打开预置官方 Gemini 的 AI 编辑器，保存/取消钮明示返回伴看", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    const aiDialog = dialog()!;
    expect(aiDialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("gemini");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://generativelanguage.googleapis.com");
    expect(aiDialog.querySelector<HTMLButtonElement>(".provider-editor-save")!.textContent)
      .toBe("保存并返回伴看平台");
    expect(aiDialog.querySelector<HTMLButtonElement>(".provider-editor-cancel")!.textContent)
      .toBe("返回伴看平台");
  });

  it("缺 Key：编辑实际引用的 AI 记录并聚焦 Key", async () => {
    const missingKey = { ...OFFICIAL_AI, hasSavedKey: false };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [missingKey] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑AI 平台");
    });
    const aiDialog = dialog()!;
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-name")!.placeholder).toBe("Gemini");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://generativelanguage.googleapis.com");
    expect(document.activeElement).toBe(aiDialog.querySelector(".provider-editor-apikey"));
  });

  it("非官方地址：新建独立官方记录，不打开中转记录也不改写它", async () => {
    const relay = { ...OFFICIAL_AI, id: "p_gemini_relay", name: "Gemini 中转", baseUrl: "https://relay.example.com" };
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [relay] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    const aiDialog = dialog()!;
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-name")!.placeholder).toBe("Gemini");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-name")!.value).toBe("");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://generativelanguage.googleapis.com");
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
  });
});

describe("往返：恢复伴看草稿与保存提示", () => {
  it("取消后恢复原伴看草稿（未保存改动与 dirty 基线都在）", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-cancel"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    const restored = dialog()!;
    expect(restored.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
    expect(restored.querySelector(".provider-editor-status")!.textContent).not.toContain("请继续保存伴看平台记录");
    pressEsc();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
  });

  it("保存成功后恢复草稿、刷新行状态并提示仍需显式保存伴看记录；Key 只落 AI 族", async () => {
    let aiProviders: Record<string, unknown>[] = [];
    const savedAi = { ...OFFICIAL_AI, id: "p_gemini_new" };
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-save": (_message) => {
        aiProviders = [savedAi];
        return { ok: true, providers: aiProviders };
      },
      "get-ai-provider-key": () => ({ ok: true, apiKey: "AIza-roundtrip" })
    });
    expect(host.querySelector("#liveProvidersList .provider-row-model")!.textContent)
      .toContain("尚未配置官方 Gemini AI Key");

    const editor = await openLiveGeminiEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));
    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "AIza-roundtrip");
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    const restored = dialog()!;
    expect(restored.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
    await vi.waitFor(() => {
      expect(restored.querySelector(".provider-editor-status")!.textContent).toContain("请继续保存伴看平台记录");
    });
    await vi.waitFor(() => {
      expect(host.querySelector("#liveProvidersList .provider-row-model")!.textContent)
        .toContain("已复用 AI 平台 Key");
    });

    const aiSave = sent.find((message) => message.type === "ai-providers-save") as {
      providers?: Array<{ apiKey?: string; presetId?: string }>;
    };
    expect(aiSave?.providers?.[0]?.apiKey).toBe("AIza-roundtrip");
    expect(aiSave?.providers?.[0]?.presetId).toBe("gemini");

    click(restored.querySelector<HTMLButtonElement>(".provider-editor-save"));
    await vi.waitFor(() => expect(sent.some((message) => message.type === "live-providers-save")).toBe(true));
    const liveSave = sent.find((message) => message.type === "live-providers-save") as {
      providers?: Array<{ apiKey?: string; hasSavedKey?: boolean; model?: string }>;
    };
    expect(liveSave?.providers?.[0]?.apiKey ?? "").toBe("");
    expect(liveSave?.providers?.[0]?.hasSavedKey).toBe(false);
    expect(liveSave?.providers?.[0]?.model).toBe("gemini-3.9-live");
  });

  it("AI 编辑器的未保存修改被 Esc 拦截：确认放弃后关闭并恢复伴看草稿", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));
    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));

    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "AIza-typed");
    pressEsc();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    expect(dialog()).not.toBeNull();
    click(document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel"));
    expect(document.querySelector(".confirm-dialog")).toBeNull();

    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    click(document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm"));
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    expect(dialog()!.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
  });

  it("抽屉收起的强制关闭不恢复伴看编辑器", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));
    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));

    document.getElementById("biliscript-reading-settings-panel")!.hidden = true;
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(dialog()).toBeNull();
    expect(host.querySelector("#biliscriptSettingsStatus")!.textContent).not.toContain("请继续保存伴看平台记录");
  });
});
