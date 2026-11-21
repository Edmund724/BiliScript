import { SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./settings/dom-ids.js";
import { buildContentPagesHtml } from "./settings/templates/content-pages.js";
import { buildProvidersPagesHtml } from "./settings/templates/providers-pages.js";
import {
  buildSettingsActionsHtml,
  buildSettingsNavBarHtml,
  buildSettingsRootViewHtml
} from "./settings/templates/shell-and-root.js";
import { buildSystemPagesHtml } from "./settings/templates/system-pages.js";

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
