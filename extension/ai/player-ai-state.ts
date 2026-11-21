type PlayerAiBusinessState = {
  playerAiQuickActionObserver: MutationObserver | null;
  playerAiQuickActionLayoutBound: boolean;
  playerAiQuickActionSyncTimer: number;
  playerAiQuickActionCursorHideTimer: number;
  playerAiQuickActionSubmitting: boolean;
  playerAiQuickActionSuppressedUntil: number;
};

type PlayerAiSetters = {
  setObserver(value: MutationObserver | null): void;
  setLayoutBound(value: boolean): void;
  setSyncTimer(value: number): void;
  setCursorHideTimer(value: number): void;
  setSubmitting(value: boolean): void;
  setSuppressedUntil(value: number): void;
};

export type PlayerAiState = Readonly<PlayerAiBusinessState> & PlayerAiSetters;
type PlayerAiStateWritable = PlayerAiBusinessState & PlayerAiSetters;

export const playerAiState: PlayerAiStateWritable = {
  playerAiQuickActionObserver: null,
  playerAiQuickActionLayoutBound: false,
  playerAiQuickActionSyncTimer: 0,
  playerAiQuickActionCursorHideTimer: 0,
  playerAiQuickActionSubmitting: false,
  playerAiQuickActionSuppressedUntil: 0,
  setObserver(value) { this.playerAiQuickActionObserver = value; },
  setLayoutBound(value) { this.playerAiQuickActionLayoutBound = value; },
  setSyncTimer(value) { this.playerAiQuickActionSyncTimer = value; },
  setCursorHideTimer(value) { this.playerAiQuickActionCursorHideTimer = value; },
  setSubmitting(value) { this.playerAiQuickActionSubmitting = value; },
  setSuppressedUntil(value) { this.playerAiQuickActionSuppressedUntil = value; }
};

export function suppressUntil(timestamp: number): void {
  playerAiState.setSuppressedUntil(timestamp);
}
