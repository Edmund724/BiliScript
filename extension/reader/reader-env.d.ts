declare global {
  interface Window {
    __INITIAL_STATE__?: Record<string, unknown>;
    __PLAYER_STATE__?: Record<string, unknown>;
    __BILI_PLAYER__?: Record<string, unknown>;
  }

  var __BILISCRIPT_READER_DEBUG_SNAPSHOT__:
    | ((label?: string) => Promise<Record<string, unknown> | null>)
    | undefined;
  var __BILISCRIPT_FORCE_SYNC_PLAYER_AI__: (() => void) | undefined;
  var __BILISCRIPT_DEBUG__: Record<string, unknown> | undefined;

  interface HTMLVideoElement {
    __biliscriptReadingSyncController?: AbortController | undefined;
  }
}

export {};
