import { state } from "../core/state.js";
import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";

export function isSubtitleInHandOrInFlight(): boolean {
  const sameClipAsPage = Boolean(state.clip.bvid) &&
    state.clip.bvid === extractBvid(location.href) &&
    state.clip.pageIndex === extractPageIndex(location.href);
  if (!sameClipAsPage) {
    return false;
  }
  return (
    state.clip.subtitleBody.length > 0 ||
    state.clip.subtitleFetchState === "loading" ||
    state.clip.subtitleFetchState === "ready"
  );
}
