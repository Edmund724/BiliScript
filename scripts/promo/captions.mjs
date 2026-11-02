import {AUDIO} from "./audio.mjs";
import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {PROMO_FPS} from "./timeline.mjs";

const outroMilliseconds = (frame) => Math.round((OUTRO_TIMELINE.from + frame) / OUTRO_TIMELINE.fps * 1000);
const voiceMilliseconds = (id) => {
  const voice = AUDIO.voices.find((candidate) => candidate.id === id);
  if (!voice) throw new Error(`缺少人声事件：${id}`);
  const frames = voice.durationFrames ?? 40;
  return {startMs: Math.round(voice.frame / PROMO_FPS * 1000), endMs: Math.round((voice.frame + frames) / PROMO_FPS * 1000)};
};

// @ts-check
/** @type {(import("@remotion/captions").Caption & {sceneId: string})[]} */
export const CAPTIONS = [
  {sceneId: "overview", text: "收藏夹里蒙尘的 48 分钟公开课，", startMs: 0, endMs: 1800, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "当成一页文章，3 秒读透脉络。", startMs: 1800, endMs: 3450, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "点章节，直接跳播。", startMs: 3500, endMs: 4700, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "点金句，生成分享卡。", startMs: 4700, endMs: 5850, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "如果他不答，一定是零分！", ...voiceMilliseconds("voice-0232"), timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "记得 UP 主提过那句话？搜词秒跳那一秒。", startMs: 9000, endMs: 11100, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "……也很难避免幻觉。", ...voiceMilliseconds("voice-0407"), timestampMs: null, confidence: null},
  {sceneId: "chat", text: "有疑问直接问视频，", startMs: 13000, endMs: 14500, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "点时间戳直达原话。", startMs: 14500, endMs: 16533, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "这里有一个研究……", ...voiceMilliseconds("voice-0444"), timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "视频没开字幕？", startMs: 18500, endMs: 19900, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "免费转写，一键复制导出。", startMs: 19900, endMs: 22000, timestampMs: null, confidence: null},
  {sceneId: "websearch", text: "视频里提的新概念？", startMs: 22000, endMs: 23400, timestampMs: null, confidence: null},
  {sceneId: "websearch", text: "AI 联网搜背景，附来源链接。", startMs: 23400, endMs: 25500, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "蓝雾玻璃或纸质刊物，四款主题日夜皆宜。", startMs: 25500, endMs: 27500, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "接入你顺手的 AI 大脑", startMs: 27500, endMs: 30000, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "BiliScript", startMs: 30000, endMs: 30550, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "在 B 站，读下一条视频。", startMs: 30550, endMs: 31800, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "字幕转写 · 章节速览 · 溯源追问", startMs: 31800, endMs: outroMilliseconds(OUTRO_TIMELINE.duration), timestampMs: null, confidence: null}
];
