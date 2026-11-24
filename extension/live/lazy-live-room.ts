import { createLazyLoader } from "../shared/lazy-import.js";

interface LiveRoomDomain {
  startLiveRoomCompanion(): Promise<void>;
}

let loader: ReturnType<typeof createLazyLoader<LiveRoomDomain>> | null = null;

export function loadLiveRoom(): Promise<LiveRoomDomain> {
  if (!loader) {
    loader = createLazyLoader<LiveRoomDomain>(() => import("./live-room-entry.js"));
  }
  return loader.load();
}
