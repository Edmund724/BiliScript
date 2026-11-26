import { closeProviderEditor } from "../../extension/ui/provider-editor.js";
import { resetUiState } from "./reset-ui-state.js";

export { flushMicrotasks, waitForFast } from "./reset-ui-state.js";

export function resetProviderEditorState(): void {
  closeProviderEditor(true);
  resetUiState();
}
