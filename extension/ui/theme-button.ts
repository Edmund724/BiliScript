// ui/theme-button.ts — header 主题按钮（太阳/月亮/Flyme 圆环水滴）图标与文案的单点。
// 图标与文案按 readingTheme 三档映射：light=太阳、dark=月亮、flyme=圆环水滴
//（Flyme 浅色档；纸色档已退役，归一化只产出这三值，未知存量值回落 light）。
// 两个消费方：ui-renderer 建壳时取初值；
// reader/presentation.ts 的 applyReadingViewPresentation 尾部经 refreshThemeButton
// 刷新——所有改主题路径（点击循环、进入阅读模式、storage 跨页同步 watcher）
// 都收敛到该函数，按钮不另接。
// 依赖全为轻叶子（core/state、reader/state 的 ids 表、本目录图标表）；
// 按钮节点缺失时静默跳过（测试骨架不搭该按钮，见 tests/helpers/reader-skeleton.ts）。
import { state } from "../core/state.js";
import { ids } from "../reader/state.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";

const THEME_TITLES: Record<string, string> = {
  light: "浅色",
  dark: "深色",
  flyme: "Flyme"
};

// 图标与文案同键一一对应：扩档时两处同时加，判断不再是 dark 二元分支。
const THEME_ICONS: Record<string, string> = {
  light: READING_HEADER_ICONS.theme,
  dark: READING_HEADER_ICONS.themeDark,
  flyme: READING_HEADER_ICONS.themeFlyme
};

export function themeButtonView(theme: string): { icon: string; title: string } {
  // 归一化只产出 light/dark/flyme；未知（如退役的 paper）仍回落 light。
  const key = theme === "dark" || theme === "flyme" ? theme : "light";
  return {
    icon: THEME_ICONS[key],
    title: THEME_TITLES[key]
  };
}

let lastApplied: string | null = null;

export function refreshThemeButton(): void {
  const button = document.getElementById(ids.readingThemeSelect);
  if (!button) {
    return;
  }
  const theme = state.reader.readingTheme;
  if (theme === lastApplied) {
    return;
  }
  lastApplied = theme;
  const view = themeButtonView(theme);
  button.innerHTML = view.icon;
  button.title = `主题：${view.title}`;
  button.setAttribute("aria-label", `主题：${view.title}`);
}