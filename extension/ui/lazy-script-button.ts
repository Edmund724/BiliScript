interface ScriptButtonDomain {
  removeScriptButton(): void;
}

import { createLazyLoader } from "../shared/lazy-import.js";

const loader = createLazyLoader<ScriptButtonDomain>(() => import("./script-button.js"));

export function loadScriptButton(): Promise<ScriptButtonDomain> {
  return loader.load();
}
