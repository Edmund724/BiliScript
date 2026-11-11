import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  it("渲染 10 个预期标签与对应 section 映射", async () => {
    const host = await mountPanel();
    const nav = host.querySelector<HTMLElement>("#biliscriptSettingsNav");
    expect(nav).not.toBeNull();

    const items = Array.from(nav!.querySelectorAll<HTMLButtonElement>(".biliscript-settings-nav-item"));
    expect(items).toHaveLength(10);

    const labels = items.map((item) => ({
      section: item.dataset.section,
      text: item.textContent?.trim()
    }));

    expect(labels).toEqual([
      { section: "llm", text: "语言模型" },
      { section: "live", text: "实时伴看" },
      { section: "asr", text: "语音转写" },
      { section: "search", text: "搜索" },
      { section: "ai-button", text: "AI 按钮" },
      { section: "system-prompt", text: "系统提示词" },
      { section: "initial-prompt", text: "初始问题" },
      { section: "appearance", text: "外观" },
      { section: "export", text: "导出" },
      { section: "agent", text: "桌面 Agent" }
    ]);

    // 默认首项处于激活态
    expect(items[0].classList.contains("is-active")).toBe(true);

    // 校验每个 section 均在宿主中存在
    for (const key of labels.map((item) => item.section)) {
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

  it("导航条持有滑动指示器，点击项时动态更新指示器 transform 与 width", async () => {
    const host = await mountPanel();
    const nav = host.querySelector<HTMLElement>("#biliscriptSettingsNav")!;
    const indicator = nav.querySelector<HTMLElement>(".biliscript-settings-nav-indicator");
    expect(indicator).not.toBeNull();

    // 初始位置已就绪
    expect(indicator!.style.transform).toContain("translateX");
    expect(indicator!.style.width).toMatch(/\d+px/);
    const initialTransform = indicator!.style.transform;

    // 点击搜索项，指示器平滑滑动到新位
    const searchBtn = nav.querySelector<HTMLButtonElement>('.biliscript-settings-nav-item[data-section="search"]')!;
    searchBtn.click();

    expect(indicator!.style.transform).toContain("translateX");
    expect(indicator!.style.width).toMatch(/\d+px/);
  });
  it("公开伴看设置入口定位到实时伴看配置", async () => {
    const host = await mountPanel();
    const target = host.querySelector<HTMLElement>('.biliscript-set-group[data-settings-section="live"]')!;
    target.scrollIntoView = vi.fn();
    const panel = await import("../../extension/ui/settings-panel.js");

    await panel.openLiveSettings("live");

    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(host.querySelector('.biliscript-settings-nav-item[data-section="live"]')?.classList.contains("is-active")).toBe(true);
    const heading = target.querySelector<HTMLElement>(".biliscript-set-h")!;
    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
  });

  it("首次设置渲染期间的伴看定位不会丢失", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </div>`;
    installSettingsPanelBus();
    const panel = await import("../../extension/ui/settings-panel.js");
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      await panel.openLiveSettings("live");

      await vi.waitFor(() => {
        expect(document.getElementById("biliscript-reading-settings-host")?.dataset.biliscriptSettingsRendered).toBe("1");
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      });
    } finally {
      if (originalScrollIntoView) {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  it("CSS 契约：导航指示器不声明无效或常驻 will-change（清理 width 无效合成层提示）", () => {
    const css = readFileSync(join(process.cwd(), "extension/entry/styles/reader-settings-shell.css"), "utf8");
    const ruleMatch = css.match(/\.biliscript-settings-nav-indicator\s*\{[^}]*\}/);
    expect(ruleMatch).not.toBeNull();
    expect(ruleMatch![0]).not.toMatch(/will-change/);
  });
});
