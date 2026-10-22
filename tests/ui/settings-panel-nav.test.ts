import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

async function mountPanel(): Promise<HTMLElement> {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <section class="biliscript-reading-settings-group biliscript-reading-settings-extension">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </section>
    </div>
  `;
  installSettingsPanelBus();
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(host.dataset.biliscriptSettingsRendered).toBe("1");
  });
  return host;
}

describe("设置抽屉顶部快速跳转导航条", () => {
  it("渲染 6 个预期标签与对应 section 映射", async () => {
    const host = await mountPanel();
    const nav = host.querySelector<HTMLElement>("#biliscriptSettingsNav");
    expect(nav).not.toBeNull();

    const items = Array.from(nav!.querySelectorAll<HTMLButtonElement>(".biliscript-settings-nav-item"));
    expect(items).toHaveLength(6);

    const labels = items.map((item) => ({
      section: item.dataset.section,
      text: item.textContent?.trim()
    }));

    expect(labels).toEqual([
      { section: "llm", text: "语言模型" },
      { section: "asr", text: "语音转写" },
      { section: "search", text: "搜索" },
      { section: "prompt", text: "提示词" },
      { section: "appearance", text: "外观" },
      { section: "export", text: "导出" }
    ]);

    // 默认首项处于激活态
    expect(items[0].classList.contains("is-active")).toBe(true);

    // 校验每个 section 均在宿主中存在
    for (const key of ["llm", "asr", "search", "prompt", "appearance", "export"]) {
      const target = host.querySelector(`.biliscript-set-group[data-settings-section="${key}"]`);
      expect(target).not.toBeNull();
    }
  });

  it("点击导航项触发目标 section 的 scrollIntoView 并更新激活态", async () => {
    const host = await mountPanel();
    const nav = host.querySelector<HTMLElement>("#biliscriptSettingsNav")!;
    const searchBtn = nav.querySelector<HTMLButtonElement>('.biliscript-settings-nav-item[data-section="search"]')!;
    const targetSection = host.querySelector<HTMLElement>('.biliscript-set-group[data-settings-section="search"]')!;

    const scrollSpy = vi.fn();
    targetSection.scrollIntoView = scrollSpy;

    searchBtn.click();

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(searchBtn.classList.contains("is-active")).toBe(true);

    const llmBtn = nav.querySelector<HTMLButtonElement>('.biliscript-settings-nav-item[data-section="llm"]')!;
    expect(llmBtn.classList.contains("is-active")).toBe(false);
  });
});
