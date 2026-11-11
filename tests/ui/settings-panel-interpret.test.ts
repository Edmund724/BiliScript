import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage } from "../helpers/settings-panel-bus.js";

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("设置面板同声传译字幕", () => {
  it("提供 14 种目标语言与三态显示模式，保存时不改双语字幕轨偏好", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </div>`;
    const bus = installSettingsPanelBus<BusMessage>({
      "get-settings": () => ({
        ok: true,
        settings: {
          liveInterpretTargetLang: "en",
          liveInterpretDisplayMode: "bilingual",
          bilingualSubtitles: true
        }
      })
    });
    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    const host = document.getElementById("biliscript-reading-settings-host")!;
    await vi.waitFor(() => expect(host.querySelector("#liveInterpretTargetLang")).toBeTruthy());

    const target = host.querySelector<HTMLSelectElement>("#liveInterpretTargetLang")!;
    const mode = host.querySelector<HTMLSelectElement>("#liveInterpretDisplayMode")!;
    expect(Array.from(target.options).map((option) => option.value)).toEqual([
      "zh", "en", "ja", "ko", "de", "fr", "es", "ru", "it", "pt", "tr", "el", "id", "ms"
    ]);
    expect(Array.from(mode.options).map((option) => option.value)).toEqual(["auto", "translation", "bilingual"]);
    expect(target.value).toBe("en");
    expect(mode.value).toBe("bilingual");

    target.value = "ja";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    mode.value = "translation";
    mode.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(bus.sent.filter((message) => message.type === "save-settings")).toHaveLength(2));
    const saves = bus.sent.filter((message) => message.type === "save-settings");
    expect(saves[0]?.settings).toEqual({ liveInterpretTargetLang: "ja" });
    expect(saves[1]?.settings).toEqual({ liveInterpretDisplayMode: "translation" });
  });

  it("提供翻译模型选择下拉框（含跟随默认模型及启用平台选项），即时保存且不改双语副轨偏好", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </div>`;
    const bus = installSettingsPanelBus<BusMessage>({
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
    expect(select.options[0]?.value).toBe("");
    expect(select.options[0]?.textContent).toBe("跟随默认模型");

    const optgroups = Array.from(select.querySelectorAll("optgroup"));
    expect(optgroups).toHaveLength(2);
    expect(optgroups[0]?.label).toBe("DeepSeek 官方");
    expect(optgroups[1]?.label).toBe("OpenAI 代理");

    expect(select.querySelector('optgroup[label="已禁用平台"]')).toBeNull();

    expect(select.value).toBe("provider-1\u0001model-b");

    select.value = "provider-2\u0001gpt-4o-mini";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(bus.sent.filter((message) => message.type === "save-settings")).toHaveLength(2));
    const saves = bus.sent.filter((message) => message.type === "save-settings");
    expect(saves[0]?.settings).toEqual({
      subtitleTranslateProviderId: "provider-2",
      subtitleTranslateModel: "gpt-4o-mini"
    });
    expect(saves[1]?.settings).toEqual({
      subtitleTranslateProviderId: "",
      subtitleTranslateModel: ""
    });
  });
});
