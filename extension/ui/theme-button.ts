import { state } from "../core/state.js";
import { ids } from "../reader/state.js";
import { activeById } from "../shared/active-host.js";
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
    title = `跟随当前站点（${resolvedLabel}）`;
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
  const button = activeById(ids.readingThemeSelect);
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
