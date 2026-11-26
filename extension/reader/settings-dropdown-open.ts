import { getActiveReaderDocument } from "../shared/active-host.js";

export function hasReaderSettingsDropdownOpen(): boolean {
  return getActiveReaderDocument().querySelector(
    '.custom-select-dropdown:not([hidden]):not([data-inline="true"]), .ai-provider-model-dropdown:not([hidden])'
  ) !== null;
}
