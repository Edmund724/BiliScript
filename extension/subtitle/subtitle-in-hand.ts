import { state } from "../core/state.js";
import { detectSiteFromUrl } from "../shared/site.js";
import { extractPageIndex, extractVideoId } from "../bilibili/video-id-shared.js";

export function isSubtitleInHandOrInFlight(): boolean {
  const href = location.href;
  const pageSite = detectSiteFromUrl(href);
  const pageVideoId = extractVideoId(href);
  const sameSite = state.clip.site === pageSite;
  const samePage = pageSite === "youtube" || state.clip.pageIndex === extractPageIndex(href);
  const sameClipAsPage = Boolean(state.clip.bvid) && sameSite && state.clip.bvid === pageVideoId && samePage;
  if (!sameClipAsPage) {
    return false;
  }
  return (
    state.clip.subtitleBody.length > 0 ||
    state.clip.subtitleFetchState === "loading" ||
    state.clip.subtitleFetchState === "ready"
  );
}
