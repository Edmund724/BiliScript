import { isSupportedVideoPage } from "../bilibili/video-id-shared.js";
import { sendRuntimeMessage } from "../shared/messaging.js";

export const PANEL_PRELOAD_GROUP_IDS = ["g-shared", "g-app"] as const;

const boundButtons = new WeakSet<HTMLElement>();

type PreloadHostGlobals = {
  __BILISCRIPT_SHARED_READY__?: boolean;
  __BILISCRIPT_CHUNKS__?: Record<string, unknown>;
  __BILISCRIPT_CHUNK_INFLIGHT__?: Record<string, Promise<unknown>>;
};

function getHostGlobals(): PreloadHostGlobals {
  return globalThis as unknown as PreloadHostGlobals;
}

function requestChunkGroupLoad(chunkId: string): Promise<unknown> {
  return sendRuntimeMessage({ type: "content-chunk-load", chunkId }).then((resp) => {
    if (!resp?.ok) {
      throw new Error(resp?.error || `chunk load failed: ${chunkId}`);
    }
  });
}

function ensureGroupPreloaded(
  inflight: Record<string, Promise<unknown>>,
  chunkId: string,
  isAlreadyReady: () => boolean,
  loadFn: () => Promise<unknown>
): Promise<unknown> {
  if (isAlreadyReady()) {
    return Promise.resolve();
  }
  if (!inflight[chunkId]) {
    inflight[chunkId] = loadFn().catch((error) => {
      delete inflight[chunkId];
      throw error;
    });
  }
  return inflight[chunkId];
}

export function preloadReaderPanelChunks(): void {
  if (!isSupportedVideoPage()) {
    return;
  }
  const host = getHostGlobals();
  const chunks = (host.__BILISCRIPT_CHUNKS__ ??= {});
  if (chunks["ui/ui-renderer.ts"]) {
    return;
  }
  const inflight = (host.__BILISCRIPT_CHUNK_INFLIGHT__ ??= {});
  void ensureGroupPreloaded(
    inflight,
    "g-app",
    () => Boolean(chunks["ui/ui-renderer.ts"]),
    async () => {
      await ensureGroupPreloaded(
        inflight,
        "g-shared",
        () => Boolean(host.__BILISCRIPT_SHARED_READY__),
        () => requestChunkGroupLoad("g-shared")
      );
      await requestChunkGroupLoad("g-app");
    }
  ).catch(() => {});
}

export function bindPanelPreloadOnButton(button: HTMLElement): void {
  if (boundButtons.has(button)) {
    return;
  }
  boundButtons.add(button);
  const trigger = () => {
    preloadReaderPanelChunks();
  };
  button.addEventListener("pointerenter", trigger, { once: true, passive: true });
  button.addEventListener("focus", trigger, { once: true, passive: true });
}
