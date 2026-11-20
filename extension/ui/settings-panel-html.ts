import { SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./settings/dom-ids.js";
import { buildContentPagesHtml } from "./settings/templates/content-pages.js";
import { buildProvidersPagesHtml } from "./settings/templates/providers-pages.js";
import {
  buildSettingsActionsHtml,
  buildSettingsNavBarHtml,
  buildSettingsRootViewHtml
} from "./settings/templates/shell-and-root.js";
import { buildSystemPagesHtml } from "./settings/templates/system-pages.js";

// ui/settings-panel-html.ts — 设置抽屉三级总览+子页 HTML 模板薄出口。
// 内部模板与 DOM ID 词汇表拆分为 extension/ui/settings/dom-ids.ts 与 templates/*.ts，
// 此处保持对外导出（SETTINGS_PANEL_DOM_IDS、SettingsPanelDomId、buildSettingsHtml）逐字节等价。

export { SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId };

export function buildSettingsHtml(): string {
  return (
    "\n" +
    [
      buildSettingsNavBarHtml(),
      buildSettingsRootViewHtml(),
      buildProvidersPagesHtml(),
      buildContentPagesHtml(),
      buildSystemPagesHtml(),
      buildSettingsActionsHtml()
    ].join("\n\n") +
    "\n  "
  );
}
