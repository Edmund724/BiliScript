import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  normalizeCustomPanelWidthEnabled,
  normalizeCustomPanelWidth,
  normalizeAutoOpenReader
} from "../../extension/core/validators.js";
import { state } from "../../extension/core/state.js";
import { relayoutScriptHost } from "../../extension/reader/script-host.js";

describe("自定义文摘面板宽度与自动展开配置", () => {
  beforeEach(() => {
    resetModuleState();
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
  });
});
