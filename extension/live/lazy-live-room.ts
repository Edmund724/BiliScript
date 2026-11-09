// 直播间伴看入口的懒加载包装：直播页只在此处下载 live-room 域，视频页永不加载。
import { createLazyLoader } from "../shared/lazy-import.js";

interface LiveRoomDomain {
  startLiveRoomCompanion(): Promise<void>;
}

const loader = createLazyLoader<LiveRoomDomain>(() => import("./live-room-entry.js"));

export function loadLiveRoom(): Promise<LiveRoomDomain> {
  return loader.load();
}
