// 「本视频字幕在手或在飞」判定（面板兜底抓取与页面预抓取共用的去重守卫；
// 入口与元数据等待后各判一次，同一份语义）。
//
// 叶子事实出装配根（ADR-0017 修订，原居 reader/lifecycle.ts）：谓词只读
// core/state 的 state.clip + extractBvid 与 location.href，与 reader 动态域零
// 实质耦合；页面预抓取不该为一次判定装载整个 reader chunk。
//
// 先决是分 P 身份：clip.bvid 非空且与当前地址取出的 bvid、页号一致。稍后再看
// 列表内 SPA 换片若逃逸了 URL 监听（如轮询兜底的一个节拍内点了 Script），state.clip
// 可能还停在上一个分 P——旧分 P 的字幕体非空 / fetchState 为 ready 都不是当前分 P
// 的状态，一律按未抓取处理、重抓（refreshClip 按当前地址写 clip 身份，因此当前分 P
// 在飞/已就绪必然身份一致）。
// 身份成立后，字幕体非空（在手）或 fetchState 为 loading/ready（抓取在飞或已
// 接受）都判「有」：预抓取起跑后打开面板时，面板触发的抓取据此让位，不并发双抓
//（双抓只会让先起的一轮在新一轮自增 runId 后作废）。
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
