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
  {sceneId: "hero", text: "点一下播放器，", startMs: 0, endMs: 1000, timestampMs: null, confidence: null},
  {sceneId: "hero", text: "整期视频自动读完。", startMs: 1000, endMs: 2100, timestampMs: null, confidence: null},
  {sceneId: "hero", text: "TL;DR · 分节要点 · 时间戳", startMs: 2100, endMs: 5000, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "记得 UP 主提过那句话？搜词秒跳那一秒。", startMs: 5000, endMs: 7100, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "……也很难避免幻觉。", ...voiceMilliseconds("voice-0407"), timestampMs: null, confidence: null},
  {sceneId: "overview", text: "48 分钟长视频，", startMs: 9000, endMs: 10200, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "3 秒提炼章节脉络与金句。", startMs: 10200, endMs: 11867, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "如果他不答，一定是零分！", ...voiceMilliseconds("voice-0232"), timestampMs: null, confidence: null},
  {sceneId: "chat", text: "带着问题追问视频，", startMs: 14500, endMs: 16000, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "点按时间戳让 UP 主亲自举证。", startMs: 16000, endMs: 18033, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "这里有一个研究……", ...voiceMilliseconds("voice-0444"), timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "没字幕的视频，", startMs: 20000, endMs: 21200, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "整段转成文字。", startMs: 21200, endMs: 22200, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "中英双轨，", startMs: 22200, endMs: 23000, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "逐句对照着看。", startMs: 23000, endMs: 24500, timestampMs: null, confidence: null},
  {sceneId: "websearch", text: "UP 主说得对不对？", startMs: 24500, endMs: 25500, timestampMs: null, confidence: null},
  {sceneId: "websearch", text: "AI 联网检索辅助核对。", startMs: 25500, endMs: 27000, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "蓝雾玻璃或纸质刊物，四款主题日夜皆宜。", startMs: 27000, endMs: 29000, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "接入你顺手的 AI 大脑", startMs: 29000, endMs: 31000, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "BiliScript", startMs: 31000, endMs: 31600, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "在 B 站，读下一条视频。", startMs: 31600, endMs: 33300, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "搜原话 · 读章节 · 问依据", startMs: 33300, endMs: outroMilliseconds(OUTRO_TIMELINE.duration), timestampMs: null, confidence: null}
];
