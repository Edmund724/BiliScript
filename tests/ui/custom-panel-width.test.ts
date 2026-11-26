import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  normalizeCustomPanelWidthEnabled,
  normalizeCustomPanelWidth,
  normalizeAutoOpenReader
} from "../../extension/core/validators.js";
import { state } from "../../extension/core/state.js";
import { relayoutScriptHost, closeScriptHost } from "../../extension/reader/script-host.js";

describe("自定义文摘面板宽度与自动展开配置", () => {
  beforeEach(() => {
    resetModuleState();
    closeScriptHost();
  });

  afterEach(() => {
    closeScriptHost();
    vi.restoreAllMocks();
  });

  describe("归一化函数 (Normalizers)", () => {
    it("normalizeCustomPanelWidthEnabled", () => {
      expect(normalizeCustomPanelWidthEnabled(true)).toBe(true);
      expect(normalizeCustomPanelWidthEnabled(false)).toBe(false);
      expect(normalizeCustomPanelWidthEnabled("true")).toBe(false);
      expect(normalizeCustomPanelWidthEnabled(undefined)).toBe(false);
    });

    it("normalizeCustomPanelWidth", () => {
      expect(normalizeCustomPanelWidth(520)).toBe(520);
      expect(normalizeCustomPanelWidth(450)).toBe(450);
      expect(normalizeCustomPanelWidth("420")).toBe(420);
      expect(normalizeCustomPanelWidth(200)).toBe(400);
      expect(normalizeCustomPanelWidth(800)).toBe(800);
      expect(normalizeCustomPanelWidth(1200)).toBe(960);
      expect(normalizeCustomPanelWidth("invalid")).toBe(540);
      expect(normalizeCustomPanelWidth(null)).toBe(540);
    });

    it("normalizeAutoOpenReader", () => {
      expect(normalizeAutoOpenReader(true)).toBe(true);
      expect(normalizeAutoOpenReader(false)).toBe(false);
      expect(normalizeAutoOpenReader("true")).toBe(false);
    });
  });

  describe("script-host 布局宽度集成", () => {
    it("直接使用 customPanelWidth 自定义宽度（需显式自定义标记）", () => {
      document.body.innerHTML = `
        <div id="biliscript-reading-view"></div>
        <div class="right-container-inner" style="width: 320px;"></div>
      `;

      state.patchSettings({
        customPanelWidthEnabled: true,
        customPanelWidth: 460
      });

      relayoutScriptHost();

      state.patchSettings({
        customPanelWidth: 500
      });

      relayoutScriptHost();
      expect(state.settings.customPanelWidth).toBe(500);
    });

    it("未置显式自定义标记时宽度改动不生效：贴栏默认填满右侧（锚点左缘至视口右缘）", async () => {
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        cb(0);
        return 0;
      });
      window.innerWidth = 1920;
      document.body.innerHTML = `
        <div id="biliscript-reading-view"></div>
        <div class="right-container-inner"></div>
      `;
      const view = document.getElementById("biliscript-reading-view")!;
      const anchor = document.querySelector(".right-container-inner") as HTMLElement;
      anchor.getBoundingClientRect = () => ({
        x: 1420,
        y: 80,
        left: 1420,
        top: 80,
        right: 1770,
        bottom: 2080,
        width: 350,
        height: 2000,
        toJSON: () => ({})
      } as DOMRect);

      const { openScriptHost, closeScriptHost } = await import("../../extension/reader/script-host.js");
      state.patchSettings({ customPanelWidthEnabled: false, customPanelWidth: 460 });
      openScriptHost();
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1420px");
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("500px");
      closeScriptHost();
      vi.restoreAllMocks();
    });

    it("文摘面板宽度在 400 到 960 之间调整时实际生效（默认填满右侧）", async () => {
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        cb(0);
        return 0;
      });
      window.innerWidth = 1920;
      document.body.innerHTML = `
        <div id="biliscript-reading-view"></div>
        <div class="right-container-inner"></div>
      `;
      const view = document.getElementById("biliscript-reading-view")!;
      const anchor = document.querySelector(".right-container-inner") as HTMLElement;
      anchor.getBoundingClientRect = () => ({
        x: 1420,
        y: 80,
        left: 1420,
        top: 80,
        right: 1770,
        bottom: 2080,
        width: 350,
        height: 2000,
        toJSON: () => ({})
      } as DOMRect);

      const { openScriptHost, closeScriptHost } = await import("../../extension/reader/script-host.js");
      openScriptHost();

      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("500px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1420px");

      state.patchSettings({ customPanelWidthEnabled: true });

      state.patchSettings({ customPanelWidth: 400 });
      relayoutScriptHost();
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("400px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1520px");

      state.patchSettings({ customPanelWidth: 450 });
      relayoutScriptHost();
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("450px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1470px");

      state.patchSettings({ customPanelWidth: 960 });
      relayoutScriptHost();
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("960px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("960px");

      closeScriptHost();
      vi.restoreAllMocks();
    });
  });
});
