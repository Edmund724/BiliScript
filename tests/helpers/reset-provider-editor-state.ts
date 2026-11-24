import { closeProviderEditor } from "../../extension/ui/provider-editor.js";
import { closeFetchDialog } from "../../extension/ui/provider-editor-fetch-dialog.js";
import { resetEditorValidation } from "../../extension/ui/provider-editor-validation.js";
import { resetUiState } from "./reset-ui-state.js";

export { flushMicrotasks, waitForFast } from "./reset-ui-state.js";

export function resetProviderEditorState(): void {
  closeProviderEditor(true);
  closeFetchDialog(false);
  resetEditorValidation();
  resetUiState();
}
