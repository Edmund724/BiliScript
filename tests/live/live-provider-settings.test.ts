import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";
import type { ProviderSettingsHost } from "../../extension/ui/provider-settings-host.js";

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

const SAVED_AI = {
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

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".provider-editor-dialog");
}

interface MountedPanel {
  panel: ProviderSettingsHost;
  view: HTMLElement;
  sent: Array<BusMessage>;
  statusLog: Array<{ message: string; isError?: boolean }>;
  savedLog: Array<{ kind: string; providerId: string }>;
}

async function mountPanel(overrides: Record<string, BusResponder<BusMessage>> = {}): Promise<MountedPanel> {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <div id="liveSettingsHeader"></div>
      <div id="liveProvidersList"></div>
      <p id="liveProvidersEmpty"></p>
      <button id="addLiveProviderBtn" type="button"></button>
    </div>`;
  const bus = installSettingsPanelBus<BusMessage>({
    "live-providers-list": () => ({ ok: true, providers: [GEMINI_LIVE] }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  const { createProviderSettingsHost } = await import("../../extension/ui/provider-settings-host.js");
  const view = document.getElementById("biliscript-reading-view")!;
  const statusLog: MountedPanel["statusLog"] = [];
  const savedLog: MountedPanel["savedLog"] = [];
  const panel = createProviderSettingsHost({
    host: view,
    mountedFamilies: ["live"],
    getEditorMountHost: () => view,
    reportMutationStatus: false,
    onStatus: (message, isError) => statusLog.push({ message, isError }),
    onMutated: ({ kind, providerId }) => savedLog.push({ kind, providerId })
  });
  await panel.load();
  return { panel, view, sent: bus.sent, statusLog, savedLog };
}

async function openLiveGeminiEditor(view: HTMLElement): Promise<HTMLElement> {
  click(view.querySelector("#liveProvidersList .provider-row-edit"));
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return dialog()!;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("live-provider-settings 凭据同层往返", () => {
  it("保存成功后恢复伴看草稿、提示仍需显式保存伴看记录并触发 onSaved", async () => {
    let aiProviders: Record<string, unknown>[] = [];
    const mounted = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-save": (_message) => {
        aiProviders = [SAVED_AI];
        return { ok: true, providers: aiProviders };
      },
      "get-ai-provider-key": () => ({ ok: true, apiKey: "AIza-live-host" })
    });
    const editor = await openLiveGeminiEditor(mounted.view);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    expect(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save")!.textContent)
      .toBe("保存并返回伴看平台");
    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "AIza-live-host");
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    expect(dialog()!.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
    expect(dialog()!.querySelector(".provider-editor-status")!.textContent).toContain("请继续保存伴看平台记录");
    expect(mounted.savedLog.some((entry) => entry.kind === "ai")).toBe(true);
    await vi.waitFor(() => {
      expect(mounted.view.querySelector("#liveProvidersList .provider-row-model")!.textContent)
        .toContain("已复用 AI 平台 Key");
    });
    mounted.panel.dispose();
    expect(dialog()).toBeNull();
  });

  it("取消后恢复伴看草稿且不提示", async () => {
    const mounted = await mountPanel({
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(mounted.view);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-cancel"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    expect(dialog()!.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
    expect(dialog()!.querySelector(".provider-editor-status")!.textContent).not.toContain("请继续保存伴看平台记录");
    mounted.panel.dispose();
    expect(dialog()).toBeNull();
  });

  it("dispose 在飞往返编辑器：强制关闭且不恢复伴看编辑器", async () => {
    const mounted = await mountPanel({
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(mounted.view);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });

    mounted.panel.dispose();

    expect(dialog()).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(dialog()).toBeNull();
    expect(mounted.view.querySelector(".provider-editor-host")).toBeNull();
  });
});
