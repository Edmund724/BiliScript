import { ids } from "../shared/dom-ids.js";
import { READER_READY_ATTR } from "./presentation-fields.js";

export function isReaderShellIntact(): boolean {
  const shell = document.getElementById(ids.readingView);
  return Boolean(
    shell?.isConnected &&
      !shell.hidden &&
      shell.classList.contains("open") &&
      shell.getAttribute(READER_READY_ATTR) !== "0" &&
      document.body.getAttribute("data-biliscript-reader-mode") === "1" &&
      document.documentElement.getAttribute("data-biliscript-reader-mode") === "1"
  );
}
