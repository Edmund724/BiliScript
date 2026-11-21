// BILISCRIPT_DUAL_INSTANCE_STATEFUL
interface DebugGateSlot {
  gate: () => boolean;
}

const DEBUG_GATE_SLOT_KEY = "__BILISCRIPT_LOG_GATE__";

const sharedGateSlot = ((globalThis as unknown as Record<string, DebugGateSlot | undefined>)[DEBUG_GATE_SLOT_KEY] ??= {
  gate: () => false
});

export function registerDebugGate(gate: () => boolean): void {
  sharedGateSlot.gate = gate;
}

export function shouldDebugLog(): boolean {
  return sharedGateSlot.gate();
}

export function logInfo(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.info(...args);
  }
}

export function logWarn(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.warn(...args);
  }
}

export function logError(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.error(...args);
  }
}

export function logWarnAlways(...args: unknown[]): void {
  console.warn(...args);
}

export function logInfoAlways(...args: unknown[]): void {
  console.info(...args);
}
