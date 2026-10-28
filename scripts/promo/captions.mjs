import {OUTRO_TIMELINE} from "./outro-timeline.mjs";

const outroMilliseconds = (frame) => Math.round((OUTRO_TIMELINE.from + frame) / OUTRO_TIMELINE.fps * 1000);

// @ts-check
/** @type {(import("@remotion/captions").Caption & {sceneId: string})[]} */
export const CAPTIONS = [
  {sceneId: "hero", text: "1 小时公开课，在收藏夹吃灰多久了？\n记得 UP 主说过那句话，死活拖不到那一秒？\n看视频卡在半路，想追问细节没人答？", startMs: 0, endMs: 1800, timestampMs: null, confidence: null},
  {sceneId: "hero", text: "BiliScript｜别光看，试试在 B 站「读」视频。", startMs: 1800, endMs: 2900, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "搜索字幕，点击时间戳跳播。", startMs: 3200, endMs: 6800, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "AI 概览：章节、金句与分享卡片。", startMs: 7200, endMs: 10800, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "围绕视频追问，点击回答中的时间戳回到原片。", startMs: 11300, endMs: 16800, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "浅色、深色与多种阅读色板。", startMs: 17300, endMs: 19800, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "14 个 AI 平台预设，另支持自定义端点。", startMs: 20400, endMs: 24400, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "双语字幕｜字幕导出｜语音识别｜联网搜索", startMs: outroMilliseconds(OUTRO_TIMELINE.features[0].at - 6), endMs: outroMilliseconds(OUTRO_TIMELINE.convergeAt + 25), timestampMs: null, confidence: null},
  {sceneId: "outro", text: "Edge 应用商店｜GitHub 开源", startMs: outroMilliseconds(OUTRO_TIMELINE.brandResolveAt + 24), endMs: outroMilliseconds(OUTRO_TIMELINE.duration - 15), timestampMs: null, confidence: null}
];
