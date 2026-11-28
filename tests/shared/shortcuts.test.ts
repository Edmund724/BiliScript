import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  areShortcutCombosEquivalent,
  countCustomizedShortcuts,
  eventToShortcutCombo,
  findShortcutConflict,
  formatShortcutLabel,
  formatShortcutTokens,
  matchShortcutEvent,
  normalizeShortcutCombo,
  normalizeShortcuts,
  toShortcutOverrides
} from "../../extension/shared/shortcuts.js";

function keyEvent(overrides: Partial<KeyboardEvent> = {}): Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode"> {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    ...overrides
  };
}

describe("shortcuts 规范化与冲突检测", () => {
  it("规范化合法修饰键组合与 F1-F12，拒绝裸单键与纯 Shift 组合", () => {
    expect(normalizeShortcutCombo("ctrl+shift+k")).toBe("Ctrl+Shift+K");
    expect(normalizeShortcutCombo("alt+b")).toBe("Alt+B");
    expect(normalizeShortcutCombo("mod+f")).toBe("Mod+F");
    expect(normalizeShortcutCombo("f2")).toBe("F2");
    expect(normalizeShortcutCombo("shift+f8")).toBe("Shift+F8");
    expect(normalizeShortcutCombo("")).toBe("");
    expect(normalizeShortcutCombo("k")).toBeNull();
    expect(normalizeShortcutCombo("Shift+O")).toBeNull();
    expect(normalizeShortcutCombo("Ctrl+Alt")).toBeNull();
  });

  it("normalizeShortcuts 保留有效覆写与空字符串禁用，非法值回退默认", () => {
    const bindings = normalizeShortcuts({
      toggleReader: "Alt+S",
      generateOverview: "",
      commandPalette: "bad-single-key",
      openSettings: "Mod+Shift+,"
    });
    expect(bindings.toggleReader).toBe("Alt+S");
    expect(bindings.generateOverview).toBe("");
    expect(bindings.commandPalette).toBe(DEFAULT_SHORTCUTS.commandPalette);
    expect(bindings.openSettings).toBe("Mod+Shift+,");
    expect(countCustomizedShortcuts(bindings)).toBe(3);
    expect(toShortcutOverrides(bindings)).toEqual({
      toggleReader: "Alt+S",
      generateOverview: "",
      openSettings: "Mod+Shift+,"
    });
  });

  it("跨平台等价比较与冲突检测识别 Mod 与 Ctrl/Meta 对应关系", () => {
    expect(areShortcutCombosEquivalent("Ctrl+K", "Mod+K", false)).toBe(true);
    expect(areShortcutCombosEquivalent("Meta+K", "Mod+K", true)).toBe(true);
    expect(areShortcutCombosEquivalent("Ctrl+K", "Mod+K", true)).toBe(false);

    const bindings = normalizeShortcuts({});
    expect(findShortcutConflict(bindings, "toggleReader", "Alt+G", false)).toBe("generateOverview");
    expect(findShortcutConflict(bindings, "openSettings", "Ctrl+K", false)).toBe("commandPalette");
    expect(findShortcutConflict(bindings, "commandPalette", "Mod+K", false)).toBeNull();
    expect(findShortcutConflict(bindings, "toggleReader", "", false)).toBeNull();
  });
});

describe("shortcuts 事件匹配与录制解析", () => {
  it("matchShortcutEvent 支持物理 code（含 macOS Option 字符）与无 code 合成事件", () => {
    const macAltB = keyEvent({ key: "∫", code: "KeyB", altKey: true });
    expect(matchShortcutEvent(macAltB, "Alt+B")).toBe(true);

    const shiftDigit = keyEvent({ key: "!", code: "Digit1", altKey: true, shiftKey: true });
    expect(matchShortcutEvent(shiftDigit, "Alt+Shift+1")).toBe(true);

    const syntheticCtrlK = keyEvent({ key: "k", ctrlKey: true });
    const syntheticMetaK = keyEvent({ key: "k", metaKey: true });
    expect(matchShortcutEvent(syntheticCtrlK, "Mod+K")).toBe(true);
    expect(matchShortcutEvent(syntheticMetaK, "Mod+K")).toBe(true);
    expect(matchShortcutEvent(keyEvent({ key: "k", ctrlKey: true, metaKey: true }), "Mod+K")).toBe(false);

    const composing = keyEvent({ key: "k", code: "KeyK", ctrlKey: true, isComposing: true });
    expect(matchShortcutEvent(composing, "Mod+K")).toBe(false);
  });

  it("eventToShortcutCombo 区分取消、清空、忽略修饰键、拒绝裸单键与合法组合", () => {
    expect(eventToShortcutCombo(keyEvent({ key: "Control", ctrlKey: true }), false)).toEqual({ status: "ignore" });
    expect(eventToShortcutCombo(keyEvent({ key: "Escape" }), false)).toEqual({ status: "cancel" });
    expect(eventToShortcutCombo(keyEvent({ key: "Backspace" }), false)).toEqual({ status: "clear" });
    expect(eventToShortcutCombo(keyEvent({ key: "Delete" }), false)).toEqual({ status: "clear" });
    expect(eventToShortcutCombo(keyEvent({ key: "o", code: "KeyO" }), false).status).toBe("invalid");
    expect(eventToShortcutCombo(keyEvent({ key: "O", code: "KeyO", shiftKey: true }), false).status).toBe("invalid");
    expect(eventToShortcutCombo(keyEvent({ key: "Tab" }), false).status).toBe("invalid");
    expect(eventToShortcutCombo(keyEvent({ key: "F4", code: "F4" }), false)).toEqual({ status: "ok", combo: "F4" });
    expect(eventToShortcutCombo(keyEvent({ key: "s", code: "KeyS", ctrlKey: true, shiftKey: true }), false)).toEqual({
      status: "ok",
      combo: "Mod+Shift+S"
    });
    expect(eventToShortcutCombo(keyEvent({ key: "s", code: "KeyS", metaKey: true, altKey: true }), true)).toEqual({
      status: "ok",
      combo: "Mod+Alt+S"
    });
  });

  it("formatShortcutTokens 与 formatShortcutLabel 按平台渲染展示符号", () => {
    expect(formatShortcutTokens("Mod+Shift+K", false)).toEqual(["Ctrl", "Shift", "K"]);
    expect(formatShortcutLabel("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
    expect(formatShortcutTokens("Mod+Alt+B", true)).toEqual(["⌥", "⌘", "B"]);
    expect(formatShortcutLabel("Alt+G", true)).toBe("⌥G");
    expect(formatShortcutLabel("", false)).toBe("未设置");
  });
});
