import {OUTRO_TIMELINE} from "./outro-timeline.mjs";

const outroMilliseconds = (frame) => Math.round((OUTRO_TIMELINE.from + frame) / OUTRO_TIMELINE.fps * 1000);

// @ts-check
/** @type {(import("@remotion/captions").Caption & {sceneId: string})[]} */
export const CAPTIONS = [
  {sceneId: "hero", text: "1 小时公开课，在收藏夹吃灰多久了？\n记得 UP 主说过那句话，死活拖不到那一秒？\n看视频卡在半路，想追问细节没人答？", startMs: 0, endMs: 1400, timestampMs: null, confidence: null},
  {sceneId: "hero", text: "BiliScript｜不用等课代表，在 B 站直接「读」视频。", startMs: 1400, endMs: 3450, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "搜「幻觉」秒跳 04:07——赵老师原声回应：“也很难避免幻觉。”", startMs: 3700, endMs: 7300, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "3 秒提炼章节与金句——“如果他不答，一定是零分。”", startMs: 7700, endMs: 11300, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "追问为何适配才是关键，点时间戳听原片实证：“这里有一个研究……”", startMs: 11800, endMs: 17300, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "浅色与深色模式，搭配蓝雾玻璃与数字刊物色板。", startMs: 17800, endMs: 20300, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "14 个 AI 平台预设，另支持自定义端点。", startMs: 20900, endMs: 24900, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "01/04 双语字幕｜02/04 字幕导出｜03/04 语音识别｜04/04 联网搜索", startMs: outroMilliseconds(OUTRO_TIMELINE.features[0].at - OUTRO_TIMELINE.featureEnterFrames), endMs: outroMilliseconds(OUTRO_TIMELINE.convergeAt), timestampMs: null, confidence: null},
  {sceneId: "outro", text: "BiliScript｜在 B 站，读下一条视频。", startMs: outroMilliseconds(OUTRO_TIMELINE.brandNameAt), endMs: outroMilliseconds(OUTRO_TIMELINE.taglineAt), timestampMs: null, confidence: null},
  {sceneId: "outro", text: "Edge 应用商店｜GitHub 开源", startMs: outroMilliseconds(OUTRO_TIMELINE.ctaAt), endMs: outroMilliseconds(OUTRO_TIMELINE.duration - 15), timestampMs: null, confidence: null}
];
