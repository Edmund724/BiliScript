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
      expect(normalizeCustomPanelWidth(380)).toBe(380);
      expect(normalizeCustomPanelWidth(450)).toBe(450);
      expect(normalizeCustomPanelWidth("420")).toBe(420);
      // 范围钳制在 300 到 600
      expect(normalizeCustomPanelWidth(200)).toBe(300);
      expect(normalizeCustomPanelWidth(800)).toBe(600);
      // 非法值回落默认 380
      expect(normalizeCustomPanelWidth("invalid")).toBe(380);
      expect(normalizeCustomPanelWidth(null)).toBe(380);
    });

    it("normalizeAutoOpenReader", () => {
      expect(normalizeAutoOpenReader(true)).toBe(true);
      expect(normalizeAutoOpenReader(false)).toBe(false);
      expect(normalizeAutoOpenReader("true")).toBe(false);
    });
  });

  describe("script-host 布局宽度集成", () => {
    it("直接使用 customPanelWidth 自定义宽度", () => {
      document.body.innerHTML = `
        <div id="biliscript-reading-view"></div>
        <div class="right-container-inner" style="width: 320px;"></div>
      `;

      state.patchSettings({
        customPanelWidth: 460
      });

      relayoutScriptHost();

      state.patchSettings({
        customPanelWidth: 500
      });

      relayoutScriptHost();
      // 不抛异常且正常调度合帧重算
      expect(state.settings.customPanelWidth).toBe(500);
    });

    it("文摘面板宽度在 300 到 500 之间调整时实际生效（不被右栏锚点位置锁死在 500px）", async () => {
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

      // 默认 380px：实际面板宽应为 380px，left = 1920 - 380 = 1540px
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("380px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1540px");

      // 调整到 300px：面板宽应缩小到 300px，不被 500px 锁死
      state.patchSettings({ customPanelWidth: 300 });
      relayoutScriptHost();
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("300px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1620px");

      // 调整到 450px：面板宽应为 450px
      state.patchSettings({ customPanelWidth: 450 });
      relayoutScriptHost();
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("450px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1470px");

      // 调整到 550px：面板宽应为 550px
      state.patchSettings({ customPanelWidth: 550 });
      relayoutScriptHost();
      expect(view.style.getPropertyValue("--biliscript-script-width")).toBe("550px");
      expect(view.style.getPropertyValue("--biliscript-script-left")).toBe("1370px");

      closeScriptHost();
      vi.restoreAllMocks();
    });
  });
});
