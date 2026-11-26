import { UI_ICON_PATHS, type UiIconName } from "./ui-icons.generated.js";

export { UI_ICON_PATHS, type UiIconName };

export const UI_ICON_STROKE_WIDTH = 1.75;

export interface RenderUiIconOptions {
  className?: string;
  size?: number;
  strokeWidth?: number;
  fill?: "none" | "currentColor";
}

export function renderUiIcon(name: UiIconName, options: RenderUiIconOptions = {}): string {
  const classAttr = options.className ? ` class="${options.className}"` : "";
  const sizeAttr = typeof options.size === "number" ? ` width="${options.size}" height="${options.size}"` : "";
  const fill = options.fill ?? "none";
  const strokeWidth = options.strokeWidth ?? UI_ICON_STROKE_WIDTH;
  return `<svg${classAttr} viewBox="0 0 24 24"${sizeAttr} fill="${fill}" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${UI_ICON_PATHS[name]}</svg>`;
}
