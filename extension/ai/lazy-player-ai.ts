// BILISCRIPT_DUAL_INSTANCE_STATEFUL
interface PlayerAiDomain {
  startPlayerAiQuickAction(): void;
  stopPlayerAiQuickAction(): void;
  removePlayerAiQuickActionButton(): void;
  resetPlayerAiQuickActionRetryCount(): void;
  schedulePlayerAiQuickActionSync(delayMs?: number): void;
}

import { createLazyLoader } from "../shared/lazy-import.js";

const loader = createLazyLoader<PlayerAiDomain>(() => import("./player-ai.js"));

export function loadPlayerAi(): Promise<PlayerAiDomain> {
  return loader.load();
}

export function isPlayerAiLoaded(): boolean {
  return loader.isLoaded();
}
