import { disposeReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { resetProviderEditorState } from "./reset-provider-editor-state.js";

export { flushMicrotasks, waitForFast } from "./reset-ui-state.js";

export function resetSettingsPanelState(): void {
  disposeReaderSettingsPanel();
  resetProviderEditorState();
}
