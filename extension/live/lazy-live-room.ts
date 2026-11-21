import { createLazyLoader } from "../shared/lazy-import.js";

interface LiveRoomDomain {
  startLiveRoomCompanion(): Promise<void>;
}

const loader = createLazyLoader<LiveRoomDomain>(() => import("./live-room-entry.js"));

export function loadLiveRoom(): Promise<LiveRoomDomain> {
  return loader.load();
}
