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
  {sceneId: "overview", text: "48 分钟公开课，", startMs: 0, endMs: 1500, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "3 秒提炼脉络与结论。", startMs: 1500, endMs: 3400, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "点章节，直接跳播。", startMs: 3500, endMs: 4700, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "点金句，生成分享卡。", startMs: 4700, endMs: 5850, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "如果他不答，一定是零分！", ...voiceMilliseconds("voice-0232"), timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "记得 UP 主提过那句话？搜词秒跳那一秒。", startMs: 9000, endMs: 11100, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "……也很难避免幻觉。", ...voiceMilliseconds("voice-0407"), timestampMs: null, confidence: null},
  {sceneId: "chat", text: "有疑问直接问视频，", startMs: 13000, endMs: 14500, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "点时间戳直达原话。", startMs: 14500, endMs: 16533, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "这里有一个研究……", ...voiceMilliseconds("voice-0444"), timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "没字幕的视频，", startMs: 18500, endMs: 19700, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "整段转成文字。", startMs: 19700, endMs: 20700, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "中英双轨，", startMs: 20700, endMs: 21500, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "逐句对照着看。", startMs: 21500, endMs: 23000, timestampMs: null, confidence: null},
  {sceneId: "websearch", text: "UP 主说得对不对？", startMs: 23000, endMs: 24000, timestampMs: null, confidence: null},
  {sceneId: "websearch", text: "AI 联网检索辅助核对。", startMs: 24000, endMs: 25500, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "蓝雾玻璃或纸质刊物，四款主题日夜皆宜。", startMs: 25500, endMs: 27500, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "接入你顺手的 AI 大脑", startMs: 27500, endMs: 30000, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "BiliScript", startMs: 30000, endMs: 30550, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "在 B 站，读下一条视频。", startMs: 30550, endMs: 32000, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "搜原话 · 读章节 · 问依据", startMs: 32000, endMs: outroMilliseconds(OUTRO_TIMELINE.duration), timestampMs: null, confidence: null}
];
