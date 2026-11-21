// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { createLazyLoader } from "../shared/lazy-import.js";

interface UiDomain {
  ensureUiReady(options?: { forceRecreate?: boolean }): void;
}

const loader = createLazyLoader<UiDomain>(() => import("./ui-renderer.js"));

export async function ensureUiReady(options?: { forceRecreate?: boolean }): Promise<void> {
  const ui = await loader.load();
  ui.ensureUiReady(options);
}
