import { uiState } from "./state.js";

export function setStatus(text: string): void {
  uiState.setStatusText(String(text || ""));
}
