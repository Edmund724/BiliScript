import { logWarn } from "../shared/logging.js";
import { ensureReaderDomain, type ReaderDomain } from "../reader/lazy-reader.js";

export async function whenReaderReady(fn: (reader: ReaderDomain) => unknown): Promise<unknown> {
  const reader = await ensureReaderDomain();
  return fn(reader);
}

export function withReader(label: string | null, fn: (reader: ReaderDomain) => unknown): void {
  whenReaderReady(fn).catch((error) => {
    if (label) logWarn(`[BILISCRIPT] ${label} failed`, error);
  });
}
