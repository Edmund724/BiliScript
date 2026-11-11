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
  it("渲染 11 个预期标签与对应 section 映射", async () => {
    const host = await mountPanel();
    const nav = host.querySelector<HTMLElement>("#biliscriptSettingsNav");
    expect(nav).not.toBeNull();

    const items = Array.from(nav!.querySelectorAll<HTMLButtonElement>(".biliscript-settings-nav-item"));
    expect(items).toHaveLength(11);

    const labels = items.map((item) => ({
      section: item.dataset.section,
      text: item.textContent?.trim()
    }));

    expect(labels).toEqual([
      { section: "llm", text: "语言模型" },
      { section: "live", text: "实时伴看" },
      { section: "subtitle", text: "字幕翻译" },
      { section: "asr", text: "语音转写" },
      { section: "search", text: "搜索" },
      { section: "ai-button", text: "AI 按钮" },
      { section: "system-prompt", text: "系统提示词" },
      { section: "initial-prompt", text: "初始问题" },
      { section: "appearance", text: "外观" },
      { section: "export", text: "导出" },
      { section: "agent", text: "本地 Agent" }
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

  it("横向可滚时滚动或指针进入才显形滚动条", async () => {
    const host = await mountPanel();
    const nav = host.querySelector<HTMLElement>("#biliscriptSettingsNav")!;

    // 活动态只靠字重与字色，不再渲染滑动下划线
    expect(nav.querySelector(".biliscript-settings-nav-indicator")).toBeNull();

    const setMetrics = (scrollWidth: number, clientWidth: number) => {
      Object.defineProperty(nav, "scrollWidth", { value: scrollWidth, configurable: true });
      Object.defineProperty(nav, "clientWidth", { value: clientWidth, configurable: true });
    };

    // 静止态不占视觉：没有横向溢出就没有拇指
    setMetrics(300, 300);
    expect(nav.classList.contains("is-scrollbar-visible")).toBe(false);

    setMetrics(600, 300);
    nav.dispatchEvent(new Event("scroll"));
    expect(nav.classList.contains("is-scrollbar-visible")).toBe(true);

    nav.dispatchEvent(new Event("pointerenter"));
    expect(nav.classList.contains("is-scrollbar-visible")).toBe(true);

    // 面板变宽放得下后拇指收起
    setMetrics(300, 300);
    nav.dispatchEvent(new Event("scroll"));
    expect(nav.classList.contains("is-scrollbar-visible")).toBe(false);
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
});
