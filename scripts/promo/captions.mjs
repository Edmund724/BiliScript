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
  {sceneId: "hero", text: "1 小时干货长视频，还在收藏夹吃灰？", startMs: 0, endMs: 1600, timestampMs: null, confidence: null},
  {sceneId: "hero", text: "BiliScript · 在 B 站直接「读」视频", startMs: 1900, endMs: 3450, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "记得 UP 主提过那句话？搜词秒跳那一秒。", startMs: 3600, endMs: 5300, timestampMs: null, confidence: null},
  {sceneId: "subtitle", text: "04:07 赵老师原声回应：“……也很难避免幻觉。”", ...voiceMilliseconds("voice-0407"), timestampMs: null, confidence: null},
  {sceneId: "overview", text: "48 分钟长视频，3 秒提炼章节脉络与金句。", startMs: 7600, endMs: 10200, timestampMs: null, confidence: null},
  {sceneId: "overview", text: "02:32 赵老师原声：“如果他不答，一定是零分！”", ...voiceMilliseconds("voice-0232"), timestampMs: null, confidence: null},
  {sceneId: "chat", text: "带着问题追问视频，点按时间戳让 UP 主亲自举证。", startMs: 13200, endMs: 16700, timestampMs: null, confidence: null},
  {sceneId: "chat", text: "04:44 原片举证：“这里有一个研究……”", ...voiceMilliseconds("voice-0444"), timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "没有字幕的视频？调用硅基流动免费 API 做语音转写。", startMs: 19150, endMs: 20250, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "视频本身就有中英两轨时，双语对照逐句并排。", startMs: 20250, endMs: 21200, timestampMs: null, confidence: null},
  {sceneId: "subtools", text: "一键复制字幕，或导出 SRT / TXT。", startMs: 21200, endMs: 22350, timestampMs: null, confidence: null},
  {sceneId: "websearch", text: "UP 主说得对不对？AI 联网检索辅助核对，超纲概念背景补充。", startMs: 22650, endMs: 24850, timestampMs: null, confidence: null},
  {sceneId: "appearance", text: "蓝雾玻璃与数字刊物日夜四主题，字号放大与杂志排版随心切换。", startMs: 25150, endMs: 27850, timestampMs: null, confidence: null},
  {sceneId: "providers", text: "接入你顺手的 AI 大脑：支持切换 DeepSeek、Kimi、Qwen 等 14+ 平台，亦支持本地模型。", startMs: 28150, endMs: 30850, timestampMs: null, confidence: null},
  {sceneId: "outro", text: "BiliScript", startMs: outroMilliseconds(OUTRO_TIMELINE.brandResolveAt), endMs: outroMilliseconds(OUTRO_TIMELINE.taglineAt), timestampMs: null, confidence: null},
  {sceneId: "outro", text: "在 B 站，读下一条视频。\nEdge 应用商店｜GitHub 开源", startMs: outroMilliseconds(OUTRO_TIMELINE.taglineAt), endMs: outroMilliseconds(OUTRO_TIMELINE.duration - 15), timestampMs: null, confidence: null}
];
