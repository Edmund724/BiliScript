import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage } from "../helpers/settings-panel-bus.js";

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("设置面板字幕翻译", () => {
  it("提供翻译模型选择下拉框（仅启用平台模型，不含跟随默认选项），即时保存且不改双语副轨偏好", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </div>`;
    const bus = installSettingsPanelBus<BusMessage & { settings?: Record<string, unknown> }>({
      "get-settings": () => ({
        ok: true,
        settings: {
          subtitleTranslateProviderId: "provider-1",
          subtitleTranslateModel: "model-b",
          bilingualSubtitles: true,
          secondarySubtitleLang: "en-US"
        }
      }),
      "ai-providers-list": () => ({
        ok: true,
        providers: [
          {
            id: "provider-1",
            name: "DeepSeek 官方",
            enabled: true,
            models: ["model-a", "model-b"]
          },
          {
            id: "provider-disabled",
            name: "已禁用平台",
            enabled: false,
            models: ["disabled-model"]
          },
          {
            id: "provider-2",
            name: "OpenAI 代理",
            enabled: true,
            models: ["gpt-4o-mini"]
          }
        ]
      })
    });
    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    const host = document.getElementById("biliscript-reading-settings-host")!;
    await vi.waitFor(() => expect(host.querySelector("#subtitleTranslateModel")).toBeTruthy());

    const select = host.querySelector<HTMLSelectElement>("#subtitleTranslateModel")!;
    expect(Array.from(select.options).some((opt) => opt.value === "")).toBe(false);
    expect(host.querySelector("#subtitleTranslateFollowHint")).toBeNull();

    const optgroups = Array.from(select.querySelectorAll("optgroup"));
    expect(optgroups).toHaveLength(2);
    expect(optgroups[0]?.label).toBe("DeepSeek 官方");
    expect(optgroups[1]?.label).toBe("OpenAI 代理");

    expect(select.querySelector('optgroup[label="已禁用平台"]')).toBeNull();

    expect(select.value).toBe("provider-1\u0001model-b");

    select.value = "provider-2\u0001gpt-4o-mini";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(bus.sent.filter((message) => message.type === "save-settings")).toHaveLength(1));
    const saves = bus.sent.filter((message) => message.type === "save-settings");
    expect(saves[0]?.settings).toEqual({
      subtitleTranslateProviderId: "provider-2",
      subtitleTranslateModel: "gpt-4o-mini"
    });
  });

  it("提供术语对照表多行文本框，支持水合、失焦保存并更新入口摘要", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </div>`;
    const bus = installSettingsPanelBus<BusMessage & { settings?: Record<string, unknown> }>({
      "get-settings": () => ({
        ok: true,
        settings: {
          subtitleTranslateGlossary: "CUDA = CUDA\nTensor Core ="
        }
      }),
      "ai-providers-list": () => ({ ok: true, providers: [] })
    });
    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    const host = document.getElementById("biliscript-reading-settings-host")!;
    const textarea = await vi.waitFor(() => {
      const el = host.querySelector<HTMLTextAreaElement>("#subtitleTranslateGlossary");
      expect(el).toBeTruthy();
      expect(el!.value).toBe("CUDA = CUDA\nTensor Core =");
      return el!;
    });

    expect(textarea.closest(".biliscript-set-row-stack")).toBeTruthy();
    expect(host.querySelector("#subtitleSettingsSummary")?.textContent).toContain("2 条术语");

    textarea.value = "CUDA = CUDA\nWarp Scheduler = 线程束调度器\nTensor Core =";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("blur", { bubbles: true }));

    await vi.waitFor(() =>
      expect(bus.sent.some((m) => m.type === "save-settings" && m.settings?.subtitleTranslateGlossary !== undefined)).toBe(true)
    );
    const saved = bus.sent.find((m) => m.type === "save-settings" && m.settings?.subtitleTranslateGlossary !== undefined);
    expect(saved?.settings?.subtitleTranslateGlossary).toBe(
      "CUDA = CUDA\nWarp Scheduler = 线程束调度器\nTensor Core ="
    );
    expect(host.querySelector("#subtitleSettingsSummary")?.textContent).toContain("3 条术语");
  });

  it("未配置任何 AI 平台时默认选中免 Key Index-Translate，支持切换 35B-A3B/9B/2B 与自定义来源互切", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </div>`;
    let currentSettings: Record<string, unknown> = {};
    const bus = installSettingsPanelBus<BusMessage & { settings?: Record<string, unknown> }>({
      "get-settings": () => ({ ok: true, settings: currentSettings }),
      "save-settings": (msg: BusMessage & { settings?: Record<string, unknown> }) => {
        currentSettings = { ...currentSettings, ...(msg.settings || {}) };
        return { ok: true };
      },
      "ai-providers-list": () => ({
        ok: true,
        providers: [
          { id: "provider-1", name: "DeepSeek 官方", enabled: true, models: ["deepseek-chat"] }
        ]
      })
    });
    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    const host = document.getElementById("biliscript-reading-settings-host")!;

    await vi.waitFor(() => expect(host.querySelector("#subtitleTranslateSource")).toBeTruthy());
    const sourceSelect = host.querySelector<HTMLSelectElement>("#subtitleTranslateSource")!;
    const modelSelect = host.querySelector<HTMLSelectElement>("#subtitleTranslateModel")!;

    await vi.waitFor(() => expect(modelSelect.disabled).toBe(false));
    expect(sourceSelect.value).toBe("bilibili-index-translate");
    expect(Array.from(modelSelect.options).map((o) => o.textContent)).toEqual([
      "Index-Translate-35B-A3B",
      "Index-Translate-9B",
      "Index-Translate-2B"
    ]);
    expect(modelSelect.value).toBe("bilibili-index-translate\u0001Index-Translate-35B-A3B");
    expect(host.querySelector("#subtitleSettingsSummary")?.textContent).toContain("Index-Translate-35B-A3B");

    // 切换模型档位到 9B
    modelSelect.value = "bilibili-index-translate\u0001Index-Translate-9B";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(bus.sent.some((m) => m.type === "save-settings" && m.settings?.subtitleTranslateModel === "Index-Translate-9B")).toBe(true)
    );
    expect(host.querySelector("#subtitleSettingsSummary")?.textContent).toContain("Index-Translate-9B");

    // 切回自定义 AI 平台
    sourceSelect.value = "custom";
    sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(bus.sent.some((m) => m.type === "save-settings" && m.settings?.subtitleTranslateProviderId === "provider-1")).toBe(true)
    );
    expect(modelSelect.value).toBe("provider-1\u0001deepseek-chat");
    expect(modelSelect.querySelectorAll("optgroup")).toHaveLength(1);

    // 切回内置 Index-Translate
    sourceSelect.value = "bilibili-index-translate";
    sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(
        bus.sent.some(
          (m) =>
            m.type === "save-settings" &&
            m.settings?.subtitleTranslateProviderId === "bilibili-index-translate" &&
            m.settings?.subtitleTranslateModel === "Index-Translate-35B-A3B"
        )
      ).toBe(true)
    );
    expect(modelSelect.value).toBe("bilibili-index-translate\u0001Index-Translate-35B-A3B");
  });
});
