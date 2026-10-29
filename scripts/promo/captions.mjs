import {OUTRO_TIMELINE} from "./outro-timeline.mjs";

const outroMilliseconds = (frame) => Math.round((OUTRO_TIMELINE.from + frame) / OUTRO_TIMELINE.fps * 1000);

// @ts-check
/** @type {(import("@remotion/captions").Caption & {sceneId: string})[]} */
export const CAPTIONS = [
  {sceneId: "hero", text: "1 小时干货长视频，还在收藏夹吃灰？", startMs: 0, endMs: 1600, timestampMs: null, confidence: null},
  {sceneId: "hero", text: "BiliScript · 在 B 站直接「读」视频", startMs: 1900, endMs: 3450, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "记得 UP 主提过那句话？搜词秒跳那一秒。", startMs: 3600, endMs: 5300, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "04:07 赵老师原声回应：“……也很难避免幻觉。”", startMs: 5600, endMs: 7300, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "48 分钟长视频，3 秒提炼章节脉络。", startMs: 7600, endMs: 9900, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "02:32 金句定格：“如果他不答，一定是零分！”", startMs: 10150, endMs: 11300, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "带着问题追问视频，点按时间戳让 UP 主亲自举证。", startMs: 11700, endMs: 15200, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "04:44 原片举证：“这里有一个研究……”", startMs: 15300, endMs: 17300, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "明暗模式切换：浅色 / 深色夜读。", startMs: 17800, endMs: 19200, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "外观色板：蓝雾玻璃 / 数字刊物。", startMs: 19400, endMs: 20300, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "选择平台，从预设开始。", startMs: 20600, endMs: 21700, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "14 个 AI 平台预设，另支持自定义端点。", startMs: 21900, endMs: 25000, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "双语字幕、字幕导出、语音识别、联网搜索。", startMs: outroMilliseconds(OUTRO_TIMELINE.features[0].at - OUTRO_TIMELINE.featureEnterFrames), endMs: outroMilliseconds(OUTRO_TIMELINE.convergeAt), timestampMs: null, confidence: null},
  {sceneId: "outro", text: "BiliScript", startMs: 28800, endMs: 30850, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "在 B 站，读下一条视频。\nEdge 应用商店｜GitHub 开源", startMs: 30900, endMs: outroMilliseconds(OUTRO_TIMELINE.duration - 15), timestampMs: null, confidence: null}
];
