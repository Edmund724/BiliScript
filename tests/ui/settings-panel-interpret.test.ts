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
});
