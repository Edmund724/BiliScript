import { ids } from "../shared/dom-ids.js";
import { getActiveReaderDocument } from "../shared/active-host.js";
import { READER_READY_ATTR } from "./presentation-fields.js";

export function isReaderShellIntact(): boolean {
  const activeDoc = getActiveReaderDocument();
  const shell = activeDoc.getElementById(ids.readingView);
  return Boolean(
    shell?.isConnected &&
      !shell.hidden &&
      shell.classList.contains("open") &&
      shell.getAttribute(READER_READY_ATTR) !== "0" &&
      activeDoc.body?.getAttribute("data-biliscript-reader-mode") === "1" &&
      activeDoc.documentElement?.getAttribute("data-biliscript-reader-mode") === "1"
  );
}
