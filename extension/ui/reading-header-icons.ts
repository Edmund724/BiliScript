import { renderUiIcon } from "./icon-registry.js";

export const READING_HEADER_ICONS: Record<"detach" | "redock" | "theme" | "themeDark" | "settings" | "close" | "back", string> = {
  detach: renderUiIcon("externalLink"),
  redock: renderUiIcon("redock"),
  theme: renderUiIcon("sun"),
  themeDark: renderUiIcon("moon"),
  settings: renderUiIcon("settings"),
  close: renderUiIcon("close"),
  back: renderUiIcon("arrowLeft")
};
