// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { createLazyLoader } from "../shared/lazy-import.js";

export type ReaderDomain = typeof import("./index.js");

const loader = createLazyLoader<ReaderDomain>(() => import("./index.js"));

export function ensureReaderDomain(): Promise<ReaderDomain> {
  return loader.load();
}
