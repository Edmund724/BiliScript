import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { DEFAULT_AI_SYSTEM_PROMPT, DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../../extension/core/default-prompts.js";

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

type SentMessage = { type: string; settings?: Record<string, unknown>; [key: string]: unknown };
type MessageResponder = (message: SentMessage) => Record<string, unknown>;
type SendMessageMock = Mock<(message: SentMessage, callback?: (response?: unknown) => void) => undefined>;

let sendMessageMock: SendMessageMock | null = null;

function installMessageBus(overrides: Record<string, MessageResponder> = {}): SentMessage[] {
  const host = installSettingsPanelBus<SentMessage>({
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  sendMessageMock = host.sendMessage as SendMessageMock;
  return host.sent;
}

async function mountPanel(): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="biliscript-reading-view"><div id="biliscript-reading-settings-host"></div></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(sendMessageMock!.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return host;
}

function messageTypes(sent: SentMessage[]): string[] {
  return sent.map((message) => message.type);
}

function lastStatus(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#biliscriptSettingsStatus")!;
}

function fireClick(node: Element): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetModuleState();
});

describe("设置分区渲染隔离与外点关闭委托（M15 INP）", () => {
  it("自定义下拉展开时按需挂载 document capture click 监听，外点收起下拉并立即卸载监听", async () => {
    installMessageBus();
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const host = await mountPanel();
    expect(addSpy.mock.calls.filter(([type]) => type === "click")).toHaveLength(0);

    const wrapper = host.querySelector("#downloadFormat")!.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector(".custom-select-trigger")!;
    fireClick(trigger);

    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    expect(dropdown.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const clickAddCalls = addSpy.mock.calls.filter(([type, , options]) => type === "click" && options === true);
    expect(clickAddCalls).toHaveLength(1);

    fireClick(document.body);
    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const clickRemoveCalls = removeSpy.mock.calls.filter(
      ([type, listener, options]) => type === "click" && listener === clickAddCalls[0][1] && options === true
    );
    expect(clickRemoveCalls).toHaveLength(1);
  });

  it("分区挂载即套 containment：contain: layout style（无 paint——弹层溢出分区边界不可裁）", async () => {
    installMessageBus();
    const host = await mountPanel();

    const groups = host.querySelectorAll<HTMLElement>(".biliscript-set-group");
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((group) => {
      expect(group.style.contain).toBe("layout style");
      expect(group.style.contentVisibility).toBe("");
    });
  });

  it("分区含展开中的下拉时整区抬升（:has 配对 layout containment 的堆叠上下文）", () => {
    const css = readFileSync(
      join(process.cwd(), "extension/entry/styles/reader-settings-rows.css"),
      "utf8"
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selector: match[1].replace(/\s+/g, " ").trim(),
      body: match[2]
    }));
    const lifting = rules.filter((rule) => rule.selector.includes(":has(.custom-select-dropdown:not([hidden]))"));

    expect(lifting.length, "缺少「分区含展开中的下拉即抬升」规则").toBeGreaterThan(0);
    lifting.forEach((rule) => {
      expect(rule.selector).toContain("#biliscript-reading-view");
      expect(rule.selector).toContain(".biliscript-reading-settings-host");
      expect(rule.selector).toContain(".biliscript-set-group");
      expect(rule.body).toMatch(/position:\s*relative/);
      expect(rule.body).toMatch(/z-index:\s*\d+/);
    });
  });

  it("常态全关时 document 零 click 监听；宿主 bubble stopPropagation 下仍由 capture 监听收起下拉", async () => {
    installMessageBus();
    const addSpy = vi.spyOn(document, "addEventListener");
    const host = await mountPanel();

    expect(
      document.querySelector(
        '.ai-provider-model-dropdown:not([hidden]), .custom-select-dropdown:not([hidden])'
      )
    ).toBeNull();
    expect(addSpy.mock.calls.filter(([type]) => type === "click")).toHaveLength(0);

    host.addEventListener("click", (e) => e.stopPropagation());
    const wrapper = host.querySelector("#downloadFormat")!.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;

    fireClick(trigger);
    expect(dropdown.hidden).toBe(false);

    fireClick(host);
    expect(dropdown.hidden).toBe(true);
  });
});

describe("设置项即时保存与生效", () => {
  it("更改设置项：自动单路落盘，状态条提示已保存且无保存设置按钮", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    expect(host.querySelector("#biliscriptSettingsSaveBtn")).toBeNull();

    const debugLogsInput = host.querySelector<HTMLInputElement>("#enableDebugLogs")!;
    debugLogsInput.checked = true;
    debugLogsInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "save-settings")).toBe(true);
    });

    const types = messageTypes(sent);
    expect(types).toContain("save-settings");
    expect(types).not.toContain("request-provider-origins");
    expect(types).not.toContain("ai-providers-save");
    expect(types).not.toContain("asr-providers-save");

    const saveMessage = sent.find((message) => message.type === "save-settings" && message.settings?.enableDebugLogs !== undefined)!;
    expect(saveMessage.settings).toMatchObject({
      enableDebugLogs: true
    });

    const status = lastStatus(host);
    expect(status.textContent).toBe("已保存");
    expect(status.dataset.error).toBe("false");
  });

  it("各设置项改动落盘载荷键面 ⊆ DEFAULT_SETTINGS 键面", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    const formatSelect = host.querySelector<HTMLSelectElement>("#downloadFormat")!;
    formatSelect.value = "txt";
    formatSelect.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "save-settings")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "save-settings")!;
    expect(saveMessage.settings).toBeTruthy();
    const keyFace = new Set(Object.keys(DEFAULT_SETTINGS));
    const stray = Object.keys(saveMessage.settings!).filter((key) => !keyFace.has(key));
    expect(stray, `保存载荷含键面外键：${stray.join(", ")}`).toEqual([]);
  });

  it("save-settings 失败：状态条报错", async () => {
    installMessageBus({ "save-settings": () => ({ ok: false, error: "写入失败" }) });
    const host = await mountPanel();

    const debugLogsInput = host.querySelector<HTMLInputElement>("#enableDebugLogs")!;
    debugLogsInput.checked = true;
    debugLogsInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("写入失败");
    });

    expect(lastStatus(host).dataset.error).toBe("true");
  });

  it("storage.onChanged 单键部分变更时只同步在场键，不因 asrAutoFallback 缺席而抛错", async () => {
    const addListenerCalls: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
    vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((fn) => {
      addListenerCalls.push(fn);
    });
    installMessageBus();
    const host = await mountPanel();

    const asrToggle = host.querySelector<HTMLInputElement>("#asrAutoFallback")!;
    const paidToggle = host.querySelector<HTMLInputElement>("#allowPaidSearchProviders")!;
    const maxCallsSlider = host.querySelector<HTMLInputElement>("#webSearchMaxToolCalls")!;
    expect(asrToggle.checked).toBe(true);
    expect(paidToggle.checked).toBe(false);

    expect(() => {
      for (const listener of addListenerCalls) {
        listener(
          {
            allowPaidSearchProviders: { oldValue: false, newValue: true },
            webSearchMaxToolCalls: { oldValue: 2, newValue: 5 }
          },
          "sync"
        );
      }
    }).not.toThrow();

    expect(asrToggle.checked).toBe(true);
    expect(paidToggle.checked).toBe(true);
    expect(maxCallsSlider.value).toBe("5");
  });
});

describe("设置抽屉模板：笔记导出区块已删除", () => {
  it("不含三个笔记属性区块，对应的 id 与行控点全部消失", async () => {
    installMessageBus();
    const host = await mountPanel();

    for (const label of ["笔记属性", "自定义属性", "正文附加段落"]) {
      expect(host.textContent, `仍渲染「${label}」区块`).not.toContain(label);
    }
    for (const id of [
      "tags",
      "includeHotCommentsInNote",
      "includePlayerEmbedInNote",
      "fixedPropertiesList",
      "fixedPropertiesEmpty",
      "addFixedPropertyBtn",
      "noteSectionsList",
      "noteSectionsEmpty",
      "addNoteSectionBtn"
    ]) {
      expect(host.querySelector(`#${id}`), `#${id} 应随笔记导出一并删除`).toBeNull();
    }
    expect(host.querySelectorAll('input[name="frontmatterField"]')).toHaveLength(0);
    expect(host.querySelector(".fixed-properties-list")).toBeNull();
    expect(host.querySelector(".note-sections-list")).toBeNull();
  });

  it("导出区保留下载格式 / 文件名日期 / 保留时间戳 / 调试日志四项", async () => {
    installMessageBus();
    const host = await mountPanel();

    for (const id of ["downloadFormat", "includeDateInFilename", "includeTimestampInBody", "enableDebugLogs"]) {
      expect(host.querySelector(`#${id}`), `#${id} 应保留`).toBeTruthy();
    }
    expect(host.textContent).toContain("下载格式");
    expect(host.textContent).toContain("导出文件名包含日期");
    expect(host.textContent).toContain("在字幕正文中保留时间戳");
  });
});

describe("对话与伴看偏好同源读写", () => {
  it("外观与实时伴看区按既有默认值渲染七项，音频开关只有帮助提示", async () => {
    installMessageBus();
    const host = await mountPanel();

    for (const key of [
      "chatLineHeight",
      "chatParagraphSpacing",
      "speechVoiceVolume",
      "liveVoiceVolume",
      "liveVoiceSpeed"
    ] as const) {
      expect(host.querySelector<HTMLInputElement>(`#${key}`)?.value).toBe(String(DEFAULT_SETTINGS[key]));
      expect(host.querySelector<HTMLButtonElement>(`#${key}ResetBtn`)?.disabled).toBe(true);
    }
    expect(host.querySelector<HTMLInputElement>("#liveShareVideoAudio")?.checked).toBe(false);
    expect(host.querySelector<HTMLInputElement>("#liveVoicePriority")?.checked).toBe(true);
    expect(host.querySelector('label[for="speechVoiceVolume"]')?.textContent).toBe("对话朗读音量");
    expect(host.querySelector('label[for="liveVoiceVolume"]')?.textContent).toBe("伴看音量");
    const liveSubpage = host.querySelector("#biliscriptSettingsSubpageLive");
    for (const id of ["liveVoiceVolume", "liveVoiceSpeed", "liveShareVideoAudio", "liveVoicePriority"]) {
      expect(liveSubpage?.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(host.querySelector('[data-settings-subgroup="chat"] #speechVoiceVolume')).not.toBeNull();
    for (const id of ["liveShareVideoAudio", "liveVoicePriority"]) {
      const row = host.querySelector(`#${id}`)?.closest(".biliscript-toggle-row");
      expect(row?.querySelector(".biliscript-set-hint, .biliscript-set-row-sub")).toBeNull();
      expect(row?.getAttribute("title")).toBeTruthy();
    }
  });

  it("五个滑块即时预览、提交原键并能单项恢复默认，两个开关立即保存", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();
    const { state } = await import("../../extension/core/state.js");
    const cases = [
      ["chatLineHeight", 185],
      ["chatParagraphSpacing", 18],
      ["speechVoiceVolume", 45],
      ["liveVoiceVolume", 65],
      ["liveVoiceSpeed", 1.25]
    ] as const;

    for (const [key, value] of cases) {
      const input = host.querySelector<HTMLInputElement>(`#${key}`)!;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.value).toBe(String(value));
      expect(state.settings?.[key]).toBe(value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => {
        expect(sent.some((message) => message.type === "save-settings" && message.settings?.[key] === value)).toBe(true);
      });

      host.querySelector<HTMLButtonElement>(`#${key}ResetBtn`)!.click();
      expect(input.value).toBe(String(DEFAULT_SETTINGS[key]));
      expect(state.settings?.[key]).toBe(DEFAULT_SETTINGS[key]);
      await vi.waitFor(() => {
        expect(sent.some((message) => message.type === "save-settings" && message.settings?.[key] === DEFAULT_SETTINGS[key])).toBe(true);
      });
    }

    for (const [key, value] of [["liveShareVideoAudio", true], ["liveVoicePriority", false]] as const) {
      const input = host.querySelector<HTMLInputElement>(`#${key}`)!;
      input.checked = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(state.settings?.[key]).toBe(value);
      await vi.waitFor(() => {
        expect(sent.some((message) => message.type === "save-settings" && message.settings?.[key] === value)).toBe(true);
      });
    }
  });

  it("跨标签页外部变更即时刷新七项控件", async () => {
    const listeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
    vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((listener) => {
      listeners.push(listener);
    });
    installMessageBus();
    const host = await mountPanel();
    const changes = {
      chatLineHeight: { oldValue: 160, newValue: 200 },
      chatParagraphSpacing: { oldValue: 12, newValue: 20 },
      speechVoiceVolume: { oldValue: 100, newValue: 30 },
      liveVoiceVolume: { oldValue: 100, newValue: 150 },
      liveVoiceSpeed: { oldValue: 1, newValue: 0.75 },
      liveShareVideoAudio: { oldValue: false, newValue: true },
      liveVoicePriority: { oldValue: true, newValue: false }
    };

    for (const listener of listeners) listener(changes, "sync");

    for (const [key, change] of Object.entries(changes)) {
      const input = host.querySelector<HTMLInputElement>(`#${key}`)!;
      if (input.type === "checkbox") expect(input.checked).toBe(change.newValue);
      else expect(input.value).toBe(String(change.newValue));
    }
  });
});

describe("恢复默认偏好按钮", () => {
  async function openResetDialog() {
    const button = await vi.waitFor(() => {
      const node = document.querySelector(".confirm-dialog-confirm");
      if (!node) throw new Error("确认弹层未打开");
      return node;
    });
    return button;
  }

  it("面板内确认弹层：点「恢复默认」后把偏好键面写回默认值，平台域键不参与", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();
    const { state } = await import("../../extension/core/state.js");
    const preferenceKeys = [
      "chatLineHeight",
      "chatParagraphSpacing",
      "speechVoiceVolume",
      "liveVoiceVolume",
      "liveVoiceSpeed",
      "liveShareVideoAudio",
      "liveVoicePriority"
    ] as const;
    state.patchSettings({
      chatLineHeight: 190,
      chatParagraphSpacing: 20,
      speechVoiceVolume: 45,
      liveVoiceVolume: 65,
      liveVoiceSpeed: 1.25,
      liveShareVideoAudio: true,
      liveVoicePriority: false
    });

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    const confirmBtn = await openResetDialog();
    expect(document.querySelector(".confirm-dialog-confirm-danger")).toBeTruthy();
    fireClick(confirmBtn);

    await vi.waitFor(() => {
      const payloads = sent
        .filter((message) => message.type === "save-settings")
        .map((message) => message.settings);
      expect(payloads.some((settings) => settings?.aiSystemPrompt === DEFAULT_AI_SYSTEM_PROMPT)).toBe(true);
    });
    const payloads = sent
      .filter((message) => message.type === "save-settings")
      .map((message) => message.settings);
    const resetPayload = payloads.find((settings) => settings?.aiSystemPrompt === DEFAULT_AI_SYSTEM_PROMPT)!;
    expect(resetPayload).toBeDefined();
    expect(resetPayload.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(resetPayload.enablePlayerAiQuickAction).toBe(DEFAULT_SETTINGS.enablePlayerAiQuickAction);
    for (const key of preferenceKeys) {
      expect(resetPayload[key]).toBe(DEFAULT_SETTINGS[key]);
    }
    expect(resetPayload.readerTheme).toBe(DEFAULT_SETTINGS.readerTheme);
    expect(resetPayload).not.toHaveProperty("liveLowBandwidth");
    expect(resetPayload).not.toHaveProperty("defaultModel");
    expect(resetPayload).not.toHaveProperty("activeAsrProviderId");
    expect(resetPayload).not.toHaveProperty("asrAutoFallback");
    expect(resetPayload).not.toHaveProperty("liveGeminiNativeSearch");
    expect(resetPayload).not.toHaveProperty("asrLanguage");
    expect(resetPayload).not.toHaveProperty("aiBtnDefaultOnMigrated");
    for (const key of [
      "tags",
      "includeHotCommentsInNote",
      "includePlayerEmbedInNote",
      "frontmatterFields",
      "fixedFrontmatterProperties",
      "notePlaceholderSections"
    ]) {
      expect(resetPayload, `${key} 不应出现在重置载荷里`).not.toHaveProperty(key);
    }
    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toContain("已恢复默认设置");
    });
    for (const key of preferenceKeys) {
      expect(state.settings?.[key]).toBe(DEFAULT_SETTINGS[key]);
    }
  });

  it("重置载荷键面 ⊆ DEFAULT_SETTINGS 键面（readerTheme 在内）", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    const confirmBtn = await openResetDialog();
    fireClick(confirmBtn);

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "save-settings")).toBe(true);
    });
    const payload = sent
      .filter((message) => message.type === "save-settings")
      .map((message) => message.settings)
      .find((settings) => settings?.readerTheme !== undefined)!;
    expect(payload).toBeTruthy();
    const keyFace = new Set(Object.keys(DEFAULT_SETTINGS));
    const stray = Object.keys(payload).filter((key) => !keyFace.has(key));
    expect(stray, `重置载荷含键面外键：${stray.join(", ")}`).toEqual([]);
    expect(keyFace.has("readerTheme")).toBe(true);
  });

  it("确认弹层点「取消」时不发任何保存消息", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    const cancelBtn = await vi.waitFor(() => {
      const node = document.querySelector(".confirm-dialog-cancel");
      if (!node) throw new Error("确认弹层未打开");
      return node;
    });
    fireClick(cancelBtn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
    expect(lastStatus(host).textContent).not.toContain("已恢复默认设置");
  });
});

describe("设置抽屉保存行：末行贴底 + 状态提示同排", () => {
  it("保存行是 host 内最后一个内容块，其下不得再有节点", async () => {
    installMessageBus();
    const host = await mountPanel();

    const actions = host.querySelector(".biliscript-set-actions");
    expect(actions).toBeTruthy();
    expect(host.lastElementChild).toBe(actions);
  });

  it("状态提示挂在保存行内（与按钮同排），提示在左、动作按钮在右", async () => {
    installMessageBus();
    const host = await mountPanel();

    const status = lastStatus(host);
    expect(status.closest(".biliscript-set-actions")).toBe(host.querySelector(".biliscript-set-actions"));
    expect(status.nextElementSibling?.id).toBe("biliscriptSettingsResetBtn");
    expect(host.querySelector("#biliscriptSettingsSaveBtn")).toBeNull();
  });
});
