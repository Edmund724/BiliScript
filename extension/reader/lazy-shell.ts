// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { createLazyLoader } from "../shared/lazy-import.js";
import type {
  EnterReaderShellOptions,
  EnterReaderShellOnUrlNavigationOptions,
  ReaderShellIntent
} from "./shell.js";

export type { ReaderShellIntent };

interface ReaderShellDomain {
  enterReaderShell(options: EnterReaderShellOptions): Promise<void>;
  enterReaderShellOnUrlNavigation(options: EnterReaderShellOnUrlNavigationOptions): Promise<void>;
  exitReaderShell(): Promise<void>;
}

const loader = createLazyLoader<ReaderShellDomain>(() => import("./shell.js"));

export function ensureReaderShell(): Promise<ReaderShellDomain> {
  return loader.load();
}
