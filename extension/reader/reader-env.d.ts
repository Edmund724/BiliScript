// Local ambient type augmentation for globals used inside reader/.

declare global {
  // Bilibili page globals used by page-context resolution.
  interface Window {
    __INITIAL_STATE__?: Record<string, unknown>;
    __PLAYER_STATE__?: Record<string, unknown>;
    __BILI_PLAYER__?: Record<string, unknown>;
    // 播放器 AI 按钮的帧内快车道句柄（ai/player-ai.ts 调度器），跨模块注册表
    // 可见以便取消上一实例排的帧（测试隔离用）。
    __biliscriptPlayerAiSyncRaf?: number;
  }

  // Debug helpers registered by init-essentials.js.
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
