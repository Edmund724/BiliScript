// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { createLazyLoader } from "../shared/lazy-import.js";
import type { DetachedWindowMode } from "../core/defaults.js";
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
  detachReaderShell(): Promise<boolean>;
  redockReaderShell(): Promise<boolean>;
  switchDetachedWindowMode(nextMode: DetachedWindowMode): Promise<boolean>;
}

const loader = createLazyLoader<ReaderShellDomain>(() => import("./shell.js"));

export function ensureReaderShell(): Promise<ReaderShellDomain> {
  return loader.load();
}
