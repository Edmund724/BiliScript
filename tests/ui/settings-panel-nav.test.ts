import { beforeEach, describe, expect, it } from "vitest";
import { installSettingsPanelBus, type BusResponder } from "../helpers/settings-panel-bus.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { resetSettingsPanelState, waitForFast } from "../helpers/reset-settings-panel-state.js";

beforeEach(() => {
  resetSettingsPanelState();
});

async function mountPanel(overrides: Record<string, BusResponder> = {}): Promise<HTMLElement> {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <section class="biliscript-reading-settings-group biliscript-reading-settings-extension">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </section>
    </div>
  `;
  installSettingsPanelBus(overrides);
  await renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  expect(host.dataset.biliscriptSettingsRendered).toBe("1");
  return host;
}

const SUBPAGE_CASES = [
  { entryId: "openAiProvidersBtn", subpageId: "biliscriptSettingsSubpageAiProviders", title: "AI 模型平台" },
  { entryId: "openLiveSettingsBtn", subpageId: "biliscriptSettingsSubpageLive", title: "实时伴看" },
  { entryId: "openAsrSettingsBtn", subpageId: "biliscriptSettingsSubpageAsr", title: "语音转写" },
  { entryId: "openSearchSettingsBtn", subpageId: "biliscriptSettingsSubpageSearch", title: "联网搜索" },
  { entryId: "openAiPromptBtn", subpageId: "biliscriptSettingsSubpageAiPrompt", title: "AI 对话与快捷动作" },
  { entryId: "openSubtitleSettingsBtn", subpageId: "biliscriptSettingsSubpageSubtitle", title: "字幕翻译与导出" },
  { entryId: "openAppearanceBtn", subpageId: "biliscriptSettingsSubpageAppearance", title: "阅读器与播放器" },
  { entryId: "openAgentSettingsBtn", subpageId: "biliscriptSettingsSubpageAgent", title: "本地 Agent 连接" },
  { entryId: "openAdvancedSettingsBtn", subpageId: "biliscriptSettingsSubpageAdvanced", title: "高级设置" }
] as const;

describe("设置抽屉三级总览与子页导航", () => {
  it("首次渲染默认停在设置总览，4 张总览卡片与 9 个子页入口完整且子页隐藏", async () => {
    const host = await mountPanel();
    const title = host.querySelector<HTMLElement>("#biliscriptSettingsTitle")!;
    const rootView = host.querySelector<HTMLElement>("#biliscriptSettingsRootView")!;
    const resetBtn = host.querySelector<HTMLButtonElement>("#biliscriptSettingsResetBtn")!;

    expect(title.textContent?.trim()).toBe("设置");
    expect(rootView.hidden).toBe(false);
    expect(rootView.querySelectorAll("[data-settings-root-card]")).toHaveLength(4);
    expect(rootView.querySelectorAll(".biliscript-entry-row")).toHaveLength(9);
    expect(resetBtn.hidden).toBe(false);
    expect(host.querySelector("#agentBridgeAddressView")?.hasAttribute("hidden")).toBe(true);

    for (const item of SUBPAGE_CASES) {
      const subpage = host.querySelector<HTMLElement>(`#${item.subpageId}`);
      expect(subpage, `${item.subpageId} 应存在`).not.toBeNull();
      expect(subpage!.hidden, `${item.subpageId} 默认应隐藏`).toBe(true);
    }
  });

  it("点击全部 9 个入口逐一进入对应子页，返回总览后恢复滚动与来源入口焦点", async () => {
    const host = await mountPanel();
    const panelEl = document.getElementById("biliscript-reading-settings-panel")!;
    const title = host.querySelector<HTMLElement>("#biliscriptSettingsTitle")!;
    const rootView = host.querySelector<HTMLElement>("#biliscriptSettingsRootView")!;
    const backBtn = host.querySelector<HTMLButtonElement>("#biliscript-reading-settings-back-btn")!;
    const resetBtn = host.querySelector<HTMLButtonElement>("#biliscriptSettingsResetBtn")!;
    const status = host.querySelector<HTMLElement>("#biliscriptSettingsStatus")!;

    for (const item of SUBPAGE_CASES) {
      panelEl.scrollTop = 72;
      const entryBtn = host.querySelector<HTMLButtonElement>(`#${item.entryId}`)!;
      entryBtn.click();

      const subpage = host.querySelector<HTMLElement>(`#${item.subpageId}`)!;
      expect(rootView.hidden).toBe(true);
      expect(subpage.hidden).toBe(false);
      expect(title.textContent?.trim()).toBe(item.title);
      expect(resetBtn.hidden).toBe(true);
      expect(status.closest(".biliscript-set-actions")).not.toBeNull();
      expect(status.hidden).toBe(false);
      expect(panelEl.scrollTop).toBe(0);

      backBtn.click();

      expect(subpage.hidden).toBe(true);
      expect(rootView.hidden).toBe(false);
      expect(title.textContent?.trim()).toBe("设置");
      expect(resetBtn.hidden).toBe(false);
      expect(panelEl.scrollTop).toBe(72);
      expect(document.activeElement).toBe(entryBtn);
    }
  });

  it("本地 Agent 三级地址页复用顶部返回键逐级回退并归还焦点", async () => {
    const host = await mountPanel();
    const title = host.querySelector<HTMLElement>("#biliscriptSettingsTitle")!;
    const rootView = host.querySelector<HTMLElement>("#biliscriptSettingsRootView")!;
    const agentView = host.querySelector<HTMLElement>("#biliscriptSettingsSubpageAgent")!;
    const addressView = host.querySelector<HTMLElement>("#agentBridgeAddressView")!;
    const openAgentBtn = host.querySelector<HTMLButtonElement>("#openAgentSettingsBtn")!;
    const addressBtn = host.querySelector<HTMLButtonElement>("#agentBridgeAddressBtn")!;
    const backBtn = host.querySelector<HTMLButtonElement>("#biliscript-reading-settings-back-btn")!;

    openAgentBtn.click();
    expect(agentView.hidden).toBe(false);
    expect(title.textContent?.trim()).toBe("本地 Agent 连接");

    addressBtn.click();
    expect(agentView.hidden).toBe(true);
    expect(addressView.hidden).toBe(false);
    expect(title.textContent?.trim()).toBe("连接地址");

    backBtn.click();
    expect(addressView.hidden).toBe(true);
    expect(agentView.hidden).toBe(false);
    expect(title.textContent?.trim()).toBe("本地 Agent 连接");
    expect(document.activeElement).toBe(addressBtn);

    backBtn.click();
    expect(agentView.hidden).toBe(true);
    expect(rootView.hidden).toBe(false);
    expect(title.textContent?.trim()).toBe("设置");
    expect(document.activeElement).toBe(openAgentBtn);
  });

  it("点击设置总览中的「新手引导 / 快速上手」发送 open-onboarding 消息", async () => {
    const sentMessages: unknown[] = [];
    const host = await mountPanel({
      "open-onboarding": (message) => {
        sentMessages.push(message);
        return { ok: true };
      }
    });
    const btn = host.querySelector<HTMLButtonElement>("#openOnboardingBtn")!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("新手引导 / 快速上手");
    btn.click();
    await waitForFast(() => {
      expect(sentMessages).toContainEqual({ type: "open-onboarding" });
    });
  });

  it("伴看语音与混音在实时伴看子页内直接平铺展示，无折叠触发器", async () => {
    const host = await mountPanel();
    host.querySelector<HTMLButtonElement>("#openLiveSettingsBtn")!.click();

    expect(host.querySelector("#toggleLiveAudioBtn")).toBeNull();
    expect(host.querySelector("#liveAudioContainer")).toBeNull();
    expect(host.querySelector("#liveAudioSummary")).toBeNull();

    const audioSection = host.querySelector<HTMLElement>('[data-settings-section="live-audio"]')!;
    expect(audioSection).not.toBeNull();
    expect(audioSection.querySelector(".biliscript-set-h")?.textContent?.trim()).toBe("伴看语音与混音");
    for (const id of ["liveVoiceVolume", "liveVoiceSpeed", "liveShareVideoAudio", "liveVoicePriority"]) {
      const el = audioSection.querySelector<HTMLElement>(`#${id}`)!;
      expect(el).not.toBeNull();
      expect(el.closest("[hidden]")).toBeNull();
    }
  });

  it("播放器 AI 快捷按钮关闭时隐藏提示词输入框，开启时显示", async () => {
    const host = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { enablePlayerAiQuickAction: false } })
    });
    const toggle = host.querySelector<HTMLInputElement>("#enablePlayerAiQuickAction")!;
    const prompt = host.querySelector<HTMLTextAreaElement>("#playerAiQuickPrompt")!;

    expect(toggle.checked).toBe(false);
    expect(prompt.hidden).toBe(true);

    toggle.click();
    expect(toggle.checked).toBe(true);
    expect(prompt.hidden).toBe(false);

    toggle.click();
    expect(toggle.checked).toBe(false);
    expect(prompt.hidden).toBe(true);
  });

  it("数字刊物色板下禁用输入框光晕开关但不篡改存储值，切回蓝雾玻璃恢复可用", async () => {
    const sentMessages: unknown[] = [];
    const host = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { readerPalette: "editorial", chatInputGlow: true } }),
      "save-settings": (message) => {
        sentMessages.push(message);
        return { ok: true };
      }
    });

    const palette = host.querySelector<HTMLSelectElement>("#readerPalette")!;
    const glow = host.querySelector<HTMLInputElement>("#chatInputGlow")!;
    const glowRow = glow.closest<HTMLElement>(".biliscript-toggle-row")!;

    expect(glow.checked).toBe(true);
    expect(glow.disabled).toBe(true);
    expect(glowRow.classList.contains("is-disabled")).toBe(true);

    palette.value = "flyme";
    palette.dispatchEvent(new Event("change", { bubbles: true }));

    expect(glow.disabled).toBe(false);
    expect(glowRow.classList.contains("is-disabled")).toBe(false);
    expect(glow.checked).toBe(true);
    await waitForFast(() => {
      expect(sentMessages).toContainEqual({ type: "save-settings", settings: { readerPalette: "flyme" } });
    });
  });

  it("openLiveSettings 定位到实时伴看子页，关闭设置抽屉后自动复位回总览", async () => {
    const host = await mountPanel();
    const { closeReaderSettingsMode, openReaderSettingsMode } = await import("../../extension/reader/settings-mode.js");
    const panel = await import("../../extension/ui/settings-panel.js");
    const title = host.querySelector<HTMLElement>("#biliscriptSettingsTitle")!;
    const liveView = host.querySelector<HTMLElement>("#biliscriptSettingsSubpageLive")!;
    const rootView = host.querySelector<HTMLElement>("#biliscriptSettingsRootView")!;

    openReaderSettingsMode();
    await panel.openLiveSettings("live");

    expect(liveView.hidden).toBe(false);
    expect(rootView.hidden).toBe(true);
    expect(title.textContent?.trim()).toBe("实时伴看");
    const heading = liveView.querySelector<HTMLElement>(".biliscript-set-h")!;
    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);

    closeReaderSettingsMode();
    expect(liveView.hidden).toBe(true);
    expect(rootView.hidden).toBe(false);
    expect(title.textContent?.trim()).toBe("设置");
  });

  it("首次渲染完成前调用 openLiveSettings 仍会切到实时伴看子页", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </div>`;
    installSettingsPanelBus();
    const panel = await import("../../extension/ui/settings-panel.js");
    await panel.openLiveSettings("live");

    const host = document.getElementById("biliscript-reading-settings-host")!;
    await waitForFast(() => {
      expect(host.dataset.biliscriptSettingsRendered).toBe("1");
      expect(host.querySelector<HTMLElement>("#biliscriptSettingsSubpageLive")?.hidden).toBe(false);
    });
    expect(host.querySelector<HTMLElement>("#biliscriptSettingsTitle")?.textContent?.trim()).toBe("实时伴看");
  });
});
