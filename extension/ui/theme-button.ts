// ui/theme-button.ts — header 主题按钮（太阳/月亮）图标与文案的单点。
// 图标映射解析后的明暗（light=太阳、dark=月亮），提示文案同时反映自动跟随模式
//（跟随 B 站 / 跟随系统）与当前解析结果，降低模式切换的认知负担。
import { state } from "../core/state.js";
import { ids } from "../reader/state.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";

const THEME_TITLES: Record<string, string> = {
  light: "浅色",
  dark: "深色"
};

export function themeButtonView(theme: string, mode?: string): { icon: string; title: string } {
  const dark = theme === "dark";
  const resolvedLabel = THEME_TITLES[dark ? "dark" : "light"];
  let title = resolvedLabel;
  if (mode === "bilibili") {
    title = `跟随 B 站（${resolvedLabel}）`;
  } else if (mode === "system") {
    title = `跟随系统（${resolvedLabel}）`;
  }
  return {
    icon: dark ? READING_HEADER_ICONS.themeDark : READING_HEADER_ICONS.theme,
    title
  };
}

let lastApplied: string | null = null;

export function refreshThemeButton(): void {
  const button = document.getElementById(ids.readingThemeSelect);
  if (!button) {
    return;
  }
  const theme = state.reader.readingTheme;
  const mode = state.reader.readingThemeMode;
  const key = `${mode}:${theme}`;
  if (key === lastApplied) {
    return;
  }
  lastApplied = key;
  const view = themeButtonView(theme, mode);
  button.innerHTML = view.icon;
  button.title = `主题：${view.title}`;
  button.setAttribute("aria-label", `主题：${view.title}`);
}
