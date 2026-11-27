import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import {
  flushMicrotasks,
  resetSettingsPanelState
} from "../helpers/reset-settings-panel-state.js";
import { createDetachedRealm } from "../helpers/detached-realm.js";
import { resetActiveReaderHost, setActiveReaderHost } from "../../extension/shared/active-host.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { DOWNLOADS_PERMISSION_DENIED_STATUS } from "../../extension/ui/settings/setup-flows.js";
import { state } from "../../extension/core/state.js";

async function mountPanel(
  overrides: Record<string, (message: Record<string, unknown>) => unknown> = {},
  targetDoc: Document = document
) {
  targetDoc.body.innerHTML = '<div id="biliscript-reading-settings-host"></div>';
  const host = targetDoc.getElementById("biliscript-reading-settings-host")!;
  const bus = installSettingsPanelBus({
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "live-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "search-providers-list": () => ({ ok: true, providers: [] }),
    ...overrides
  });
  await renderReaderSettingsPanel();
  return { host, bus };
}

beforeEach(() => {
  resetSettingsPanelState();
});

afterEach(() => {
  resetActiveReaderHost();
  vi.restoreAllMocks();
});

describe("设置抽屉：视频笔记 7 项控件读写、联动与摘要", () => {
  it("回显与保存全部 7 项视频笔记设置，并联动隐藏/禁用依赖项与摘要", async () => {
    const savedPatches: Record<string, unknown>[] = [];
    const { host } = await mountPanel({
      "get-settings": () => ({
        ok: true,
        settings: {
          enablePlayerAiQuickAction: true,
          playerAiActionMode: "summary",
          playerAiAutoExportNote: false,
          noteExportTarget: "download",
          noteDownloadSubdir: "",
          notePromptPreset: "general",
          noteCustomPrompt: "",
          noteIncludeKeyframes: false
        }
      }),
      "save-settings": (msg) => {
        savedPatches.push(msg.settings as Record<string, unknown>);
        return { ok: true };
      },
      "request-optional-permission": () => ({ ok: true })
    });

    const quickActionToggle = host.querySelector<HTMLInputElement>("#enablePlayerAiQuickAction")!;
    const actionMode = host.querySelector<HTMLSelectElement>("#playerAiActionMode")!;
    const actionModeRow = actionMode.closest<HTMLElement>(".biliscript-set-row")!;
    const quickPrompt = host.querySelector<HTMLTextAreaElement>("#playerAiQuickPrompt")!;
    const autoExport = host.querySelector<HTMLInputElement>("#playerAiAutoExportNote")!;
    const exportTarget = host.querySelector<HTMLSelectElement>("#noteExportTarget")!;
    const subdir = host.querySelector<HTMLInputElement>("#noteDownloadSubdir")!;
    const subdirRow = subdir.closest<HTMLElement>(".biliscript-set-row")!;
    const obsidianVault = host.querySelector<HTMLInputElement>("#obsidianVaultName")!;
    const obsidianVaultRow = obsidianVault.closest<HTMLElement>(".biliscript-set-row")!;
    const obsidianFolder = host.querySelector<HTMLInputElement>("#obsidianFolder")!;
    const obsidianFolderRow = obsidianFolder.closest<HTMLElement>(".biliscript-set-row")!;
    const preset = host.querySelector<HTMLSelectElement>("#notePromptPreset")!;
    const customPrompt = host.querySelector<HTMLTextAreaElement>("#noteCustomPrompt")!;
    const customPromptRow = customPrompt.closest<HTMLElement>(".biliscript-set-row")!;
    const keyframes = host.querySelector<HTMLInputElement>("#noteIncludeKeyframes")!;

    expect(host.querySelector("#noteExportCopyBtn")).toBeNull();
    expect(host.querySelector("#noteExportObsidianBtn")).toBeNull();
    expect(actionModeRow.hidden).toBe(false);
    expect(actionMode.disabled).toBe(false);
    expect(quickPrompt.hidden).toBe(false);
    expect(customPromptRow.hidden).toBe(true);
    expect(subdir.disabled).toBe(false);
    expect(subdirRow.hidden).toBe(false);
    expect(obsidianVault.disabled).toBe(true);
    expect(obsidianVaultRow.hidden).toBe(true);
    expect(obsidianFolder.disabled).toBe(true);
    expect(obsidianFolderRow.hidden).toBe(true);

    quickActionToggle.click();
    expect(actionModeRow.hidden).toBe(true);
    expect(actionMode.disabled).toBe(true);
    expect(quickPrompt.hidden).toBe(true);
    quickActionToggle.click();
    expect(actionModeRow.hidden).toBe(false);
    expect(actionMode.disabled).toBe(false);

    actionMode.value = "note";
    actionMode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(quickPrompt.hidden).toBe(true);
    expect(host.querySelector("#aiPromptSummary")?.textContent).toContain("播放器快捷·笔记");

    autoExport.click();
    await flushMicrotasks();
    expect(host.querySelector("#notesSettingsSummary")?.textContent).toContain("自动导出");
    expect(host.querySelector("#aiPromptSummary")?.textContent).not.toContain("自动导出");

    preset.value = "custom";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
    expect(customPromptRow.hidden).toBe(false);

    customPrompt.value = "按大纲与例子整理";
    customPrompt.dispatchEvent(new Event("change", { bubbles: true }));

    keyframes.click();

    exportTarget.value = "obsidian";
    exportTarget.dispatchEvent(new Event("change", { bubbles: true }));
    expect(subdir.disabled).toBe(true);
    expect(subdirRow.hidden).toBe(true);
    expect(obsidianVault.disabled).toBe(false);
    expect(obsidianVaultRow.hidden).toBe(false);
    expect(obsidianFolder.disabled).toBe(false);
    expect(obsidianFolderRow.hidden).toBe(false);
    expect(host.querySelector("#notesSettingsSummary")?.textContent).toBe("自定义 · Obsidian · 自动导出 · 含截图");
    expect(host.querySelector("#subtitleSettingsSummary")?.textContent).not.toContain("Obsidian");

    await flushMicrotasks();

    expect(savedPatches).toContainEqual({ playerAiActionMode: "note" });
    expect(savedPatches).toContainEqual({ playerAiAutoExportNote: true });
    expect(savedPatches).toContainEqual({ notePromptPreset: "custom" });
    expect(savedPatches).toContainEqual({ noteCustomPrompt: "按大纲与例子整理" });
    expect(savedPatches).toContainEqual({ noteIncludeKeyframes: true });
    expect(savedPatches).toContainEqual({ noteExportTarget: "obsidian" });
    expect(state.settings.noteIncludeKeyframes).toBe(true);
  });

  it("填写非空下载子目录或开启自动导出时在用户手势内同步直发权限申请且拒绝提示不被已保存覆盖", async () => {
    const requestedPermissions: string[] = [];
    const checkedPermissions: string[] = [];
    const { host } = await mountPanel({
      "get-settings": () => ({
        ok: true,
        settings: {
          noteExportTarget: "download",
          noteDownloadSubdir: "",
          playerAiAutoExportNote: false
        }
      }),
      "save-settings": () => ({ ok: true }),
      "check-optional-permission": (msg) => {
        checkedPermissions.push(String(msg.permission || ""));
        return { ok: true, granted: false };
      },
      "request-optional-permission": (msg) => {
        requestedPermissions.push(String(msg.permission || ""));
        return { ok: false, error: "用户拒绝授权" };
      }
    });

    const subdir = host.querySelector<HTMLInputElement>("#noteDownloadSubdir")!;
    const status = host.querySelector<HTMLElement>("#biliscriptSettingsStatus")!;

    subdir.value = "BiliScript-Notes";
    subdir.dispatchEvent(new Event("change", { bubbles: true }));
    expect(requestedPermissions).toEqual(["downloads"]);
    expect(checkedPermissions).toEqual([]);
    await flushMicrotasks();
    expect(status.textContent).toBe(DOWNLOADS_PERMISSION_DENIED_STATUS);
    expect(status.dataset.error).toBe("true");

    const autoExport = host.querySelector<HTMLInputElement>("#playerAiAutoExportNote")!;
    autoExport.click();
    expect(requestedPermissions).toEqual(["downloads", "downloads"]);
    expect(checkedPermissions).toEqual([]);
    await flushMicrotasks();
    expect(status.textContent).toBe(DOWNLOADS_PERMISSION_DENIED_STATUS);
    expect(status.dataset.error).toBe("true");
  });

  it("独立窗口跨文档 Realm 下可渲染全部新控件并完成预设切换与持久化", async () => {
    const realm = createDetachedRealm();
    try {
      setActiveReaderHost(realm.doc, realm.win);
      const savedPatches: Record<string, unknown>[] = [];
      const { host } = await mountPanel(
        {
          "get-settings": () => ({
            ok: true,
            settings: {
              notePromptPreset: "general",
              noteExportTarget: "download"
            }
          }),
          "save-settings": (msg) => {
            savedPatches.push(msg.settings as Record<string, unknown>);
            return { ok: true };
          }
        },
        realm.doc
      );

      const preset = host.querySelector<HTMLSelectElement>("#notePromptPreset")!;
      const customPromptRow = host
        .querySelector<HTMLTextAreaElement>("#noteCustomPrompt")!
        .closest<HTMLElement>(".biliscript-set-row")!;
      expect(preset.ownerDocument).toBe(realm.doc);
      expect(customPromptRow.hidden).toBe(true);

      const realmWin = realm.win as unknown as typeof window;
      preset.value = "custom";
      preset.dispatchEvent(new realmWin.Event("change", { bubbles: true }));
      await flushMicrotasks();

      expect(customPromptRow.hidden).toBe(false);
      expect(savedPatches).toContainEqual({ notePromptPreset: "custom" });
    } finally {
      resetActiveReaderHost();
      realm.close();
    }
  });
});
