// 直播间伴看设置宿主（extension/ui/live-provider-settings.ts）的凭据同层往返
//（票 provider-onboarding-consistency/07）：伴看 Gemini 编辑器内联凭据动作 →
// 同层 AI 族编辑器 → 保存成功（提示仍需显式保存伴看记录 + onSaved 回调）或取消
// 都恢复伴看草稿；dispose 在飞往返编辑器不恢复、不泄漏。
//
// 手法：真实 createLiveProviderSettings + provider-editor，消息走
// installSettingsPanelBus 总线（同 tests/ui/gemini-credential-link.test.ts）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";
import type { LiveProviderSettings } from "../../extension/ui/live-provider-settings.js";

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
  panel: LiveProviderSettings;
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
  const { createLiveProviderSettings } = await import("../../extension/ui/live-provider-settings.js");
  const view = document.getElementById("biliscript-reading-view")!;
  const statusLog: MountedPanel["statusLog"] = [];
  const savedLog: MountedPanel["savedLog"] = [];
  const panel = createLiveProviderSettings({
    host: view,
    getEditorMountHost: () => view,
    onStatus: (message, isError) => statusLog.push({ message, isError }),
    onSaved: (kind, providerId) => savedLog.push({ kind, providerId })
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
    // 伴看草稿留未保存改动
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    expect(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save")!.textContent)
      .toBe("保存并返回伴看平台");
    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "AIza-live-host");
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save"));

    // 保存成功后：伴看编辑器按原草稿恢复 + 提示 + onSaved("ai")
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    expect(dialog()!.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
    expect(dialog()!.querySelector(".provider-editor-status")!.textContent).toContain("请继续保存伴看平台记录");
    expect(mounted.savedLog.some((entry) => entry.kind === "ai")).toBe(true);
    // 伴看行状态随新引用刷新
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
    // 恢复路径带 dispose 守卫：不重建编辑器
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dialog()).toBeNull();
    expect(mounted.view.querySelector(".provider-editor-host")).toBeNull();
  });
});
