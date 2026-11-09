import crypto from "node:crypto";
import path from "node:path";
import {mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {AUDIO, VOICE_DUCK_PRE_SECONDS, cueMixStartFrame, musicVolumeAtFrame} from "./audio.mjs";
import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {
  OVERVIEW_TIMELINE,
  PROMO_DURATION,
  PROMO_FPS,
  PROVIDER_TIMELINE,
  SCENES,
  SUBTOOLS_TIMELINE,
  WEBSEARCH_TIMELINE
} from "./timeline.mjs";

const SAMPLE_RATE = 48000;
const DURATION = PROMO_DURATION / PROMO_FPS;
const OVERVIEW_SCENE = SCENES.find((scene) => scene.id === "overview");
const QUOTE_FREEZE_FROM = (OVERVIEW_SCENE.from + OVERVIEW_TIMELINE.quoteStartAt) / PROMO_FPS;
const QUOTE_FREEZE_TO = (OVERVIEW_SCENE.from + OVERVIEW_SCENE.duration) / PROMO_FPS;
const sceneFrame = (id) => SCENES.find((scene) => scene.id === id).from;
const sceneSeconds = (id, frame = 0) => (sceneFrame(id) + frame) / PROMO_FPS;
const SUBTOOLS_FROM = sceneSeconds("subtools");
const WEBSEARCH_FROM = sceneSeconds("websearch");
const SUBTITLE_FROM = sceneSeconds("subtitle");
const CHAT_FROM = sceneSeconds("chat");
const LIVE_FROM = sceneSeconds("live");
const PROVIDERS_SCENE = SCENES.find((scene) => scene.id === "providers");
const PROVIDERS_FROM = PROVIDERS_SCENE.from / PROMO_FPS;
const PROVIDER_PULSE_FROM = (PROVIDERS_SCENE.from + PROVIDER_TIMELINE.orbitAt) / PROMO_FPS;
const PROVIDER_PULSE_TO = (PROVIDERS_SCENE.from + PROVIDER_TIMELINE.exitAt) / PROMO_FPS;
const OUTRO_AT = OUTRO_TIMELINE.from / PROMO_FPS;
const OUTPUT_DIR = path.join(PROMO_DIR, "assets", "audio");
const CACHE_HASH_FILE = path.join(OUTPUT_DIR, ".cache-hash");
const AUDIO_SELECTION_FILE = path.join(PROMO_DIR, "evidence", "audio-selection.json");

async function computeAudioInputsHash() {
  const hash = crypto.createHash("sha256");
  for (const rel of [
    "synthesize-audio.mjs",
    "audio.mjs",
    "timeline.mjs",
    "outro-timeline.mjs",
    "subtitle-timeline.mjs",
    "provider-logos.mjs"
  ]) {
    hash.update(rel);
    hash.update(await readFile(path.join(REPO_ROOT, "scripts", "promo", rel)));
  }
  // 原片人声片段直接参与配乐合成，内容变化必须让缓存失效。
  const voiceDir = path.join(REPO_ROOT, "scripts", "promo", "assets", "voice");
  for (const name of (await readdir(voiceDir)).sort()) {
    hash.update(name);
    hash.update(await readFile(path.join(voiceDir, name)));
  }
  return hash.digest("hex");
}

const currentAudioHash = await computeAudioInputsHash();
if (!process.argv.includes("--force")) {
  const cachedHash = await readFile(CACHE_HASH_FILE, "utf8").catch(() => "");
  const selectionRaw = await readFile(AUDIO_SELECTION_FILE, "utf8").catch(() => "");
  if (cachedHash.trim() === currentAudioHash && selectionRaw) {
    try {
      const cachedSelection = JSON.parse(selectionRaw);
      const requiredFiles = [
        path.join(OUTPUT_DIR, "promo-score.wav"),
        path.join(OUTPUT_DIR, "remotion-mix.wav"),
        ...(cachedSelection.sfx ?? []).map((item) => path.join(OUTPUT_DIR, "sfx", `${item.name}.wav`))
      ];
      const checks = await Promise.all(requiredFiles.map((file) => stat(file).catch(() => null)));
      if (checks.every((info) => info?.isFile() && info.size > 100)) {
        console.log(`原创配乐与 ${cachedSelection.sfx.length} 类音效已命中缓存：${OUTPUT_DIR}`);
        process.exit(0);
      }
    } catch {
      // Cache metadata invalid, fall through to full synthesis
    }
  }
}
const TAU = Math.PI * 2;
let randomState = 0x42b1115c;

function random() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 4294967296;
}

function noise() {
  return random() * 2 - 1;
}

function midi(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function buffer(seconds) {
  return [new Float32Array(Math.ceil(seconds * SAMPLE_RATE)), new Float32Array(Math.ceil(seconds * SAMPLE_RATE))];
}

function add(track, signal, at, pan = 0) {
  const start = Math.round(at * SAMPLE_RATE);
  const left = Math.cos((pan + 1) * Math.PI / 4);
  const right = Math.sin((pan + 1) * Math.PI / 4);
  for (let index = 0; index < signal.length && start + index < track[0].length; index += 1) {
    if (start + index < 0) continue;
    track[0][start + index] += signal[index] * left;
    track[1][start + index] += signal[index] * right;
  }
}

function tone(note, seconds, {type = "pluck", gain = 0.2} = {}) {
  const output = new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
  const frequency = midi(note);
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const attack = Math.min(1, time / 0.008);
    const release = Math.min(1, (seconds - time) / 0.045);
    let envelope;
    let sample;
    if (type === "pad") {
      envelope = Math.min(1, time / 0.22) * Math.min(1, (seconds - time) / 0.4);
      sample = Math.sin(TAU * frequency * time) + 0.32 * Math.sin(TAU * frequency * 2 * time) + 0.12 * Math.sin(TAU * frequency * 3 * time);
    } else if (type === "rhodes") {
      envelope = Math.min(1, time / 0.012) * Math.exp(-time * 2.2) * Math.min(1, (seconds - time) / 0.18);
      const tine = Math.sin(TAU * frequency * 4 * time) * Math.exp(-time * 18) * 0.16;
      sample = Math.sin(TAU * frequency * time) + 0.26 * Math.sin(TAU * frequency * 2 * time) * Math.exp(-time * 3.5) + tine;
    } else if (type === "bass") {
      envelope = attack * Math.exp(-time * 3.8) * release;
      sample = Math.sin(TAU * frequency * time) + 0.22 * Math.sin(TAU * frequency * 2 * time);
    } else if (type === "bell") {
      envelope = attack * Math.exp(-time * 5.5) * release;
      sample = Math.sin(TAU * frequency * time) + 0.35 * Math.sin(TAU * frequency * 2.01 * time) * Math.exp(-time * 8);
    } else {
      envelope = attack * Math.exp(-time * 9) * release;
      sample = Math.sin(TAU * frequency * time) + 0.28 * Math.sin(TAU * frequency * 2 * time) + 0.1 * Math.sin(TAU * frequency * 3 * time);
    }
    output[index] = sample * envelope * gain;
  }
  return output;
}

function kick(gainScale = 1) {
  const output = new Float32Array(Math.round(0.24 * SAMPLE_RATE));
  let phase = 0;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const frequency = 44 + 108 * Math.exp(-time * 32);
    phase += TAU * frequency / SAMPLE_RATE;
    output[index] = Math.sin(phase) * Math.exp(-time * 17) * Math.min(1, time / 0.002) * 0.68 * gainScale;
  }
  return output;
}

function subHit(gain = 0.58) {
  const seconds = 0.28;
  const output = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let phase = 0;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const frequency = 62 + 28 * Math.exp(-time * 18);
    phase += TAU * frequency / SAMPLE_RATE;
    const click = Math.sin(TAU * 180 * time) * Math.exp(-time * 65) * 0.28;
    const body = (Math.sin(phase) + 0.24 * Math.sin(phase * 2)) * Math.exp(-time * 11);
    const attack = Math.min(1, time / 0.0025);
    const release = Math.min(1, (seconds - time) / 0.03);
    output[index] = (body + click) * attack * release * gain;
  }
  return output;
}

function hat(open = false, gainScale = 1) {
  const seconds = open ? 0.16 : 0.055;
  const output = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let previous = 0;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const white = noise();
    const high = white - previous * 0.92;
    previous = white;
    output[index] = high * Math.exp(-time * (open ? 24 : 75)) * Math.min(1, time / 0.001) * 0.13 * gainScale;
  }
  return output;
}

function snare(gainScale = 1) {
  const output = new Float32Array(Math.round(0.18 * SAMPLE_RATE));
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    output[index] = (noise() * 0.27 + Math.sin(TAU * 185 * time) * 0.14) * Math.exp(-time * 24) * Math.min(1, time / 0.002) * gainScale;
  }
  return output;
}

function sectionDynamicsAt(seconds) {
  if (seconds < QUOTE_FREEZE_FROM) return 0.66;
  if (seconds < SUBTOOLS_FROM) return 0.72;
  if (seconds < SUBTITLE_FROM) return 0.84;
  if (seconds < CHAT_FROM) return 0.80;
  if (seconds < WEBSEARCH_FROM) return 0.86;
  if (seconds < LIVE_FROM) return 0.90;
  if (seconds < PROVIDERS_FROM) return 0.88;
  if (seconds < OUTRO_AT - 0.52) return 1.14;
  if (seconds < OUTRO_AT - 0.1) return 0.05;
  if (seconds < OUTRO_AT + 1.9) return 1.06;
  return 0.74;
}

function inProviderWave(seconds) {
  return seconds >= PROVIDER_PULSE_FROM && seconds < PROVIDER_PULSE_TO;
}

function inVoiceWindow(seconds) {
  return AUDIO.voices.some((voice) => {
    const start = voice.frame / PROMO_FPS - VOICE_DUCK_PRE_SECONDS;
    const end = (voice.frame + (voice.durationFrames ?? 40) + 6) / PROMO_FPS;
    return seconds >= start && seconds <= end;
  });
}

function makeScore() {
  const track = buffer(DURATION);
  const beat = 60 / AUDIO.music.bpm;
  // 四幕递进和声进行（避免同一段两小节旋律循环 38 秒）：
  // Act 1 (0–11s): 晨读概览 Dmaj7 -> Gmaj7 -> Bm7 -> A6 -> Em7 -> A7
  // Act 2 (11–18.5s): 字幕转写与秒跳 Gmaj7 -> A7 -> F#m7 -> Bm7
  // Act 3 (18.5–32s): 溯源追问与实时伴看 Em9 -> F#m7 -> Gmaj7 -> A13 -> Bm7 -> Gmaj7 -> Em7 -> Asus4
  // Act 4 (32–35.5s): 平台矩阵高潮 Gmaj7 -> A6 -> Dmaj9 (00:36 片尾定版收尾和弦)
  const chords = [
    [50, 54, 57, 61], [55, 59, 62, 66], [47, 54, 57, 62], [57, 61, 64, 66],
    [52, 55, 59, 62], [57, 61, 64, 67], [55, 59, 62, 66], [57, 61, 64, 69],
    [54, 57, 61, 64], [47, 54, 57, 62], [52, 55, 59, 64], [54, 57, 61, 64],
    [55, 59, 62, 66], [57, 61, 64, 66], [47, 54, 57, 62], [55, 59, 62, 66],
    [52, 55, 59, 62], [57, 62, 64, 69], [50, 54, 57, 61], [50, 54, 57, 62]
  ];
  const arpPatterns = [
    [0, 2, 1, 3, 2, 3, 1, 2],
    [0, 1, 2, 3, 1, 2, 3, 1],
    [1, 3, 2, 0, 3, 2, 1, 0],
    [0, 2, 3, 1, 2, 0, 3, 2],
    [2, 0, 1, 3, 0, 2, 3, 1],
    [0, 3, 1, 2, 3, 1, 2, 0]
  ];
  const barCount = Math.ceil(DURATION / (4 * beat));
  for (let bar = 0; bar < barCount; bar += 1) {
    const at = bar * 4 * beat;
    // 片尾定版后（>= OUTRO_AT）停下循环伴奏分解，完全交给 00:36 收尾和弦
    if (at >= OUTRO_AT - 0.1) continue;
    const dyn = sectionDynamicsAt(at + 0.1);
    const chord = chords[bar % chords.length];
    const padDuration = at <= OUTRO_AT - 1.5 && at + 2.15 > OUTRO_AT - 0.5 ? Math.max(0.4, OUTRO_AT - 0.5 - at) : 2.15;
    for (let note = 0; note < chord.length; note += 1) {
      add(track, tone(chord[note], padDuration, {type: "pad", gain: 0.038 * dyn}), at, (note - 1.5) * 0.25);
    }
    // 第三幕（Chat / WebSearch / Live）加入温润 Rhodes 电钢双音和弦呼吸，打破单一音色
    if (at >= CHAT_FROM && at < PROVIDERS_FROM && !inVoiceWindow(at + beat)) {
      add(track, tone(chord[1] + 12, 0.65, {type: "rhodes", gain: 0.048 * dyn}), at + beat, -0.22);
      add(track, tone(chord[3] + 12, 0.65, {type: "rhodes", gain: 0.044 * dyn}), at + beat, 0.22);
    }
    const arp = arpPatterns[bar % arpPatterns.length];
    for (let step = 0; step < 8; step += 1) {
      const stepAt = at + step * beat / 2;
      if (stepAt >= OUTRO_AT - 0.55) continue;
      const inVoice = inVoiceWindow(stepAt);
      // 金句单卡定格期间与原片/AI 人声前 0.2s 起留出清透中高频空间
      if ((stepAt >= QUOTE_FREEZE_FROM && stepAt < QUOTE_FREEZE_TO || inVoice) && step % 2 === 1) continue;
      const stepDyn = sectionDynamicsAt(stepAt) * (inVoice ? 0.42 : 1);
      const stepInProviderWave = inProviderWave(stepAt);
      const octaveShift = stepInProviderWave ? 24 : (bar % 4 === 2 && step >= 4 ? 24 : 12);
      const note = chord[arp[step]] + octaveShift;
      const gain = (bar >= 4 && bar <= 5 ? 0.054 : bar >= 6 && bar <= 8 ? 0.072 : 0.09) * stepDyn;
      const synthType = stepAt < SUBTOOLS_FROM ? "bell" : (bar >= 10 && bar <= 14 && step % 3 === 0 ? "rhodes" : "pluck");
      add(track, tone(note, stepInProviderWave ? 0.19 : 0.28, {type: synthType, gain}), stepAt, step % 2 ? 0.32 : -0.32);
    }
    // 平台矩阵波浪段落：叠加 16 分音符律动木琴底脉冲，托起 14 个连续冒泡音
    if (at >= PROVIDER_PULSE_FROM - 1 && at < PROVIDER_PULSE_TO) {
      for (let sixteenth = 0; sixteenth < 16; sixteenth += 1) {
        const pulseAt = at + sixteenth * (beat / 4);
        if (pulseAt < PROVIDER_PULSE_FROM || pulseAt >= PROVIDER_PULSE_TO) continue;
        const pulseNote = chord[sixteenth % chord.length] + 12;
        add(track, tone(pulseNote, 0.09, {type: "pluck", gain: 0.045}), pulseAt, ((sixteenth % 7) - 3) * 0.14);
      }
    }
  }
  const bassRoots = [50, 43, 47, 45, 40, 45, 43, 45, 42, 47, 40, 42, 43, 45, 47, 43, 40, 45, 50, 50];
  const beatCount = Math.ceil(DURATION / beat);
  for (let index = 0; index < beatCount; index += 1) {
    const at = index * beat;
    // 片尾定版后停止鼓组循环，由收尾和弦自然延音收束
    if (at >= OUTRO_AT - 0.55) continue;
    const dyn = sectionDynamicsAt(at);
    const bar = Math.floor(index / 4) % bassRoots.length;
    const accent = SCENES.some((scene) => Math.abs(scene.from / PROMO_FPS - at) < 0.001);
    // 前 1.8 秒保留轻柔心跳低音，2.5s 后逐步进入完整鼓组；金句单卡定格与原片人声段减轻高频打击乐
    const inQuoteFreezeWindow = at >= QUOTE_FREEZE_FROM && at < QUOTE_FREEZE_TO;
    const inVoice = inVoiceWindow(at);
    const inProvider = inProviderWave(at);
    add(track, kick(at < 1.8 ? dyn * 0.55 : inVoice ? dyn * 0.65 : inProvider ? dyn * 1.08 : dyn), at);
    if (index % 2 === 1 && at >= 2.5 && !inQuoteFreezeWindow && !inVoice) {
      add(track, snare(inProvider ? dyn * 1.05 : dyn), at);
    }
    if (at >= 2.5 && !inQuoteFreezeWindow) {
      add(track, hat(index % 4 === 3 && !inVoice, inVoice ? dyn * 0.38 : dyn), at + beat / 2, index % 2 ? 0.25 : -0.25);
      if (inProvider) {
        add(track, hat(false, dyn * 0.65), at + beat / 4, -0.2);
        add(track, hat(false, dyn * 0.65), at + (beat * 3) / 4, 0.2);
      }
    }
    if (index >= 2) {
      add(track, tone(bassRoots[bar], 0.34, {type: "bass", gain: (accent ? 0.24 : 0.18) * dyn * (inVoice ? 0.68 : 1)}), at);
    }
  }

  // 核心切点的 60–90Hz 短 sub-hit 瞬态强调：章节跳播与金句卡落点 + 除片头片尾外的每个镜头切点 + 品牌落定
  const resolveAt = (OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt) / PROMO_FPS;
  const sceneCutHits = SCENES.filter((scene) => scene.from > 0 && scene.id !== "outro").map((scene) => scene.from / PROMO_FPS);
  const cutHits = [OVERVIEW_TIMELINE.chapterClickAt / PROMO_FPS, OVERVIEW_TIMELINE.quoteStartAt / PROMO_FPS, ...sceneCutHits, resolveAt];
  for (const cutAt of cutHits) {
    add(track, subHit(cutAt >= SUBTOOLS_FROM ? 0.62 : 0.52), cutAt);
  }

  // 能力落点递进强调（峰值严格非递减）：转写、导出字幕、联网补充
  const featureBuild = [
    {at: SUBTOOLS_FROM + 0.33, notes: [62, 69], gain: 0.14, sub: 0.36},
    {at: sceneSeconds("subtools", SUBTOOLS_TIMELINE.exportAt), notes: [64, 71], gain: 0.17, sub: 0.42},
    {at: sceneSeconds("websearch", WEBSEARCH_TIMELINE.verifyCardAt), notes: [66, 74], gain: 0.20, sub: 0.48}
  ];
  for (const step of featureBuild) {
    add(track, subHit(step.sub), step.at);
    step.notes.forEach((note, idx) => {
      add(track, tone(note, 0.42, {type: "bell", gain: step.gain}), step.at, (idx - 0.5) * 0.22);
    });
  }

  // 贯穿四幕的叙事主题旋律线（避开原声窗口，随章节推进发展而不再两小节机械重复）
  const melody = [
    // Act 1: 晨读开启 -> 章节浏览
    [2, 74], [3, 78], [6, 81], [7.5, 76], [10, 74], [11.5, 78], [13, 81], [14, 86],
    // Act 2: 转写与搜词前导
    [22, 79], [23.5, 81], [25, 83], [27, 78], [29, 76], [30.5, 74],
    // Act 3: AI 追问与联网检索、伴看连接
    [37, 74], [38.5, 78], [40, 81], [41.5, 85], [47, 83], [48.5, 78], [50, 76], [53, 74], [54.5, 81],
    // Act 4: 平台矩阵高潮上扬
    [64, 74], [65.5, 78], [67, 81], [68.5, 86], [70, 88]
  ];
  for (const [index, note] of melody) {
    const at = index * beat;
    if (inVoiceWindow(at)) continue;
    add(track, tone(note, 0.68, {type: at >= CHAT_FROM && at < PROVIDERS_FROM ? "rhodes" : "bell", gain: 0.095 * sectionDynamicsAt(at)}), at, (index % 2 === 0 ? 0.18 : -0.18));
  }

  // 00:36 片尾定版收尾和弦（Finale Resolving Cadence in Dmaj9）：
  // 在品牌落定（35.77s）至标语展开（36.0s）奏响温暖醇厚的 Dmaj9 解决和弦，自然延展至片尾 39.0s 淡出
  const finaleHoldDuration = DURATION - resolveAt;
  add(track, subHit(0.58), resolveAt);
  add(track, tone(38, finaleHoldDuration, {type: "pad", gain: 0.042}), resolveAt, 0);
  add(track, tone(45, finaleHoldDuration, {type: "pad", gain: 0.032}), resolveAt + 0.02, 0);
  const finalePadVoicing = [
    {note: 50, gain: 0.036, pan: -0.35},
    {note: 54, gain: 0.034, pan: 0.28},
    {note: 57, gain: 0.032, pan: -0.18},
    {note: 61, gain: 0.028, pan: 0.22},
    {note: 64, gain: 0.026, pan: -0.12},
    {note: 66, gain: 0.028, pan: 0.32}
  ];
  for (const voice of finalePadVoicing) {
    add(track, tone(voice.note, finaleHoldDuration, {type: "pad", gain: voice.gain}), resolveAt, voice.pan);
    add(track, tone(voice.note + 12, 2.2, {type: "rhodes", gain: voice.gain * 1.45}), resolveAt + 0.04, -voice.pan * 0.8);
  }
  const finaleArpStrum = [62, 66, 69, 73, 76, 78, 81, 86];
  finaleArpStrum.forEach((note, idx) => {
    const strumAt = resolveAt + idx * 0.032;
    const pan = ((idx / (finaleArpStrum.length - 1)) - 0.5) * 0.68;
    add(track, tone(note, 2.2 - idx * 0.08, {type: "bell", gain: 0.115 - idx * 0.005}), strumAt, pan);
  });
  // 00:36.1 标语落定时的温暖泛音回应
  const taglineAt = (OUTRO_TIMELINE.from + OUTRO_TIMELINE.taglineAt) / PROMO_FPS;
  add(track, tone(74, 2.1, {type: "bell", gain: 0.12}), taglineAt, -0.16);
  add(track, tone(81, 2.1, {type: "bell", gain: 0.11}), taglineAt + 0.03, 0.16);
  add(track, tone(86, 2.0, {type: "bell", gain: 0.10}), taglineAt + 0.06, 0);

  // Soft-clipping & dynamic shaping to hit -14 LUFS (±0.5) and LRA 4–6 in final mix
  normalize(track, 1.0);
  const drive = 2.55;
  const normDrive = Math.tanh(drive);
  for (let ch = 0; ch < 2; ch += 1) {
    for (let i = 0; i < track[ch].length; i += 1) {
      const time = i / SAMPLE_RATE;
      const boost = time >= SUBTOOLS_FROM && time < OUTRO_AT - 0.52 ? 1.12 : 0.96;
      if (time >= OUTRO_AT - 0.48 && time < OUTRO_AT - 0.12) {
        const edge = Math.min(1, Math.max(0, (OUTRO_AT - 0.43 - time) / 0.05));
        track[ch][i] *= edge;
      }
      track[ch][i] = (Math.tanh(track[ch][i] * drive * boost) / normDrive) * (time >= SUBTOOLS_FROM && time < OUTRO_AT - 0.52 ? 1.04 : 0.94);
    }
  }
  return track;
}

function sweep(start, end, seconds, gain) {
  const output = new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
  let phase = 0;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const frequency = start + (end - start) * time / seconds;
    phase += TAU * frequency / SAMPLE_RATE;
    const envelope = Math.min(1, time / 0.002) * Math.exp(-time * 16) * Math.min(1, (seconds - time) / 0.02);
    output[index] = Math.tanh((Math.sin(phase) + 0.32 * Math.sin(phase * 2.01) + 0.14 * Math.sin(phase * 0.5)) * 1.35) * envelope * gain;
  }
  return output;
}

function makeWhoosh() {
  const track = buffer(0.5);
  const peakTime = 0.10; // 3 frames at 30fps so cueMixStartFrame (-3f) lands the peak on cue.frame
  let low = 0;
  for (let index = 0; index < track[0].length; index += 1) {
    const time = index / SAMPLE_RATE;
    low = low * 0.86 + noise() * 0.14;
    const band = noise() * 0.25 + low * 1.7;
    const subTime = Math.max(0, time - peakTime);
    const sub =
      time >= peakTime
        ? Math.sin(TAU * (68 + 20 * Math.exp(-subTime * 10)) * subTime) * Math.exp(-subTime * 12) * 0.45
        : 0;
    const envelope =
      time < peakTime
        ? Math.sin((Math.PI / 2) * (time / peakTime)) ** 1.35
        : Math.cos((Math.PI / 2) * Math.min(1, (time - peakTime) / (0.5 - peakTime))) ** 1.6;
    track[0][index] = (band * envelope * 0.38) + sub;
    track[1][index] = (band * envelope * 0.32) + sub;
  }
  return track;
}

// 气泡弹出音（Pop-Pop）：双段式弹性气泡连弹（预膨胀 Pop + 清脆高八度释压 Pop）
function makePopPop() {
  const seconds = 0.2;
  const track = buffer(seconds);
  let phase1 = 0;
  let phase2 = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    // 第一声 Pop（0ms–52ms）：圆润低频气泡鼓起 (360Hz -> 760Hz)
    const f1 = 360 + 420 * Math.min(1, (t / 0.036) ** 1.4);
    phase1 += (TAU * f1) / SAMPLE_RATE;
    const env1 = Math.min(1, t / 0.0018) * Math.exp(-t * 42);
    const pop1 = (Math.sin(phase1) * 0.78 + Math.sin(phase1 * 1.95) * 0.24) * env1;

    // 第二声 Pop（38ms 起）：清脆高五度气泡弹开 (540Hz -> 1280Hz)
    const t2 = Math.max(0, t - 0.038);
    const f2 = 540 + 740 * Math.min(1, (t2 / 0.042) ** 1.35);
    phase2 += (TAU * f2) / SAMPLE_RATE;
    const env2 = t2 > 0 ? Math.min(1, t2 / 0.0015) * Math.exp(-t2 * 30) : 0;
    const pop2 =
      t2 > 0
        ? (Math.sin(phase2) * 0.88 +
            Math.sin(phase2 * 2.02) * 0.28 * Math.exp(-t2 * 45) +
            Math.sin(TAU * 2350 * t2) * 0.18 * Math.exp(-t2 * 130)) *
          env2
        : 0;

    const sample = Math.tanh((pop1 + pop2) * 1.35);
    track[0][i] = sample * 0.96 + pop2 * 0.08;
    track[1][i] = sample * 0.94 + pop1 * 0.08;
  }
  return track;
}

// 原声淡出过渡音（Voice Fade Transition）：温润空气感收束 + 泛音微光桥接
function makeVoiceFadeTransition() {
  const seconds = 0.36;
  const track = buffer(seconds);
  let low = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    low = low * 0.91 + noise() * 0.09;
    const env = Math.sin(Math.PI * Math.min(1, t / seconds)) ** 1.4;
    const shimmer =
      (Math.sin(TAU * midi(69) * t) * 0.28 +
        Math.sin(TAU * midi(74) * t) * 0.34 +
        Math.sin(TAU * midi(81) * t) * 0.22 * Math.exp(-t * 5.5)) *
      env;
    const softAir = low * 0.46 * env * Math.exp(-t * 3.2);
    const sweepDown = Math.sin(TAU * (520 - 240 * (t / seconds)) * t) * 0.22 * env;
    track[0][i] = Math.tanh((shimmer * 1.06 + softAir + sweepDown) * 1.2);
    track[1][i] = Math.tanh((shimmer * 0.94 + softAir * 0.92 + sweepDown) * 1.2);
  }
  return track;
}

// 金句保存快门声（Polaroid Shutter + Pop-up）：拍立得双叶机械快门 + 闪光灯电容微鸣 + 实体相纸弹起共鸣
function makePolaroidShutter() {
  const seconds = 0.32;
  const track = buffer(seconds);
  let ejectPhase = 0;
  let prev = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    const w = noise();
    const hp = w - prev * 0.88;
    prev = w;
    // 1. 0ms 快门前帘清脆释放 + 18ms 快门后帘机械咬合
    const shutter1 =
      (hp * 0.72 + Math.sin(TAU * 3120 * t) * 0.48 + Math.sin(TAU * 1140 * t) * 0.38) *
      Math.exp(-t * 170) *
      Math.min(1, t / 0.00035);
    const t2 = Math.max(0, t - 0.018);
    const shutter2 =
      t2 > 0
        ? (hp * 0.64 + Math.sin(TAU * 3680 * t2) * 0.52 + Math.sin(TAU * 1580 * t2) * 0.36) *
          Math.exp(-t2 * 145) *
          Math.min(1, t2 / 0.00035)
        : 0;
    // 2. 32ms 拍立得相纸 3D 视差弹起（温润纸卡立体弹出低频 + D 大调晶莹定格泛音）
    const te = Math.max(0, t - 0.032);
    const ejectFreq = 160 + 280 * Math.min(1, (te / 0.055) ** 1.25);
    ejectPhase += (TAU * ejectFreq) / SAMPLE_RATE;
    const cardPop =
      te > 0
        ? (Math.sin(ejectPhase) * 0.62 + hp * 0.22 * Math.exp(-te * 55)) *
          Math.exp(-te * 24) *
          Math.min(1, te / 0.0015)
        : 0;
    const crystalLock =
      te > 0
        ? (Math.sin(TAU * midi(74) * te) * 0.28 +
            Math.sin(TAU * midi(81) * te) * 0.24 +
            Math.sin(TAU * midi(86) * te) * 0.20) *
          Math.exp(-te * 14) *
          Math.min(1, te / 0.002)
        : 0;
    const mono = Math.tanh((shutter1 * 0.82 + shutter2 * 0.88 + cardPop * 0.9) * 1.38);
    track[0][i] = mono * 0.98 + crystalLock * 1.06;
    track[1][i] = mono * 1.02 + crystalLock * 0.94;
  }
  return track;
}

// 定制清脆机械键盘敲击音效（段落轴簧片 Click + PBT 键帽触底 Thock，回车键叠加平衡杆共鸣）
function makeMechKey({pitchScale = 1, isEnter = false} = {}) {
  const seconds = isEnter ? 0.14 : 0.105;
  const track = buffer(seconds);
  let prevNoise = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    const w = noise();
    const hp = w - prevNoise * 0.88;
    prevNoise = w;
    // 1. 段落轴金属簧片瞬态清脆 Click (~3.6kHz + ~2.2kHz)
    const leafClick =
      (Math.sin(TAU * 3650 * pitchScale * t) * 0.58 +
        Math.sin(TAU * 2240 * pitchScale * t) * 0.42 +
        hp * 0.55) *
      Math.exp(-t * 155) *
      Math.min(1, t / 0.0005);
    // 2. 约 4.5ms 后键帽触底壳体共鸣 Thock (~1.25kHz -> 420Hz + 低频桌面扎实震感)
    const bottomDelay = isEnter ? 0.0048 : 0.0036;
    const tb = Math.max(0, t - bottomDelay);
    const housingFreq = (isEnter ? 1080 : 1320) * pitchScale * Math.exp(-tb * 35) + (isEnter ? 195 : 250);
    const thock =
      tb > 0
        ? (Math.sin(TAU * housingFreq * tb) * 0.68 +
            Math.sin(TAU * (isEnter ? 168 : 215) * tb) * 0.52 +
            hp * 0.25 * Math.exp(-tb * 95)) *
          Math.exp(-tb * (isEnter ? 44 : 58)) *
          Math.min(1, tb / 0.0008)
        : 0;
    // 3. 回车键独有的金属平衡杆清脆咬合泛音
    const stabRing =
      isEnter && tb > 0
        ? (Math.sin(TAU * 2880 * tb) * 0.34 + Math.sin(TAU * 1560 * tb) * 0.28) *
          Math.exp(-tb * 48)
        : 0;
    const sample = Math.tanh((leafClick + thock + stabRing) * 1.45);
    const pan = isEnter ? 0.06 : pitchScale > 1 ? 0.04 : -0.05;
    const lGain = Math.cos((pan + 1) * Math.PI / 4);
    const rGain = Math.sin((pan + 1) * Math.PI / 4);
    track[0][i] = sample * lGain;
    track[1][i] = sample * rGain;
  }
  return track;
}

// 磁吸吸附音效（Snap）：微吸附预收束 + 钕磁铁清脆咬合瞬态 + 瞬移锁定泛音
function makeMagneticSnap() {
  const seconds = 0.22;
  const track = buffer(seconds);
  let sweepPhase = 0;
  let lockPhase = 0;
  let prev = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    const w = noise();
    const hp = w - prev * 0.9;
    prev = w;
    // 前 8ms 极速磁力牵引上扬（480Hz -> 2100Hz），使咬合瞬态落在 < 0.3 帧内
    const preEnv = t < 0.008 ? Math.sin((t / 0.008) * (Math.PI / 2)) * 0.45 : Math.exp(-(t - 0.008) * 180) * 0.45;
    const preFreq = 480 + 1620 * Math.min(1, t / 0.008) ** 2;
    sweepPhase += (TAU * preFreq) / SAMPLE_RATE;
    const suction = Math.sin(sweepPhase) * preEnv;

    // 8ms 处磁极瞬时吸合（清脆金属玻璃质感咬合 + 紧实 82Hz 瞬移低频锚点）
    const tl = Math.max(0, t - 0.007);
    const lockFreq = 2650 * Math.exp(-tl * 85) + 1110;
    lockPhase += (TAU * lockFreq) / SAMPLE_RATE;
    const snapClick =
      tl > 0
        ? (Math.sin(lockPhase) * 0.72 +
            Math.sin(TAU * 3920 * tl) * 0.44 * Math.exp(-tl * 160) +
            hp * 0.48 * Math.exp(-tl * 210)) *
          Math.exp(-tl * 68) *
          Math.min(1, tl / 0.0004)
        : 0;
    const subLock =
      tl > 0
        ? Math.sin(TAU * (84 + 90 * Math.exp(-tl * 55)) * tl) *
          Math.exp(-tl * 32) *
          Math.min(1, tl / 0.001) *
          0.62
        : 0;
    // 晶莹的 D 大调高八度锁定余韵 (A5 + D6)
    const chime =
      tl > 0
        ? (Math.sin(TAU * midi(81) * tl) * 0.22 + Math.sin(TAU * midi(86) * tl) * 0.18) *
          Math.exp(-tl * 18) *
          Math.min(1, tl / 0.002)
        : 0;
    const mono = Math.tanh((suction + snapClick + subLock) * 1.4);
    track[0][i] = mono * 0.96 + chime * 1.08;
    track[1][i] = mono * 1.02 + chime * 0.92;
  }
  return track;
}

// 14 个 AI 平台图标矩阵波浪：密集、舒适的成音阶立体声冒泡音效（Pop / Bubble）
function makeBubblePop(noteMidi, index = 0) {
  const seconds = 0.19;
  const track = buffer(seconds);
  const f0 = midi(noteMidi);
  const col = index % 7;
  const pan = ((col - 3) / 3) * 0.52;
  const leftGain = Math.cos((pan + 1) * Math.PI / 4);
  const rightGain = Math.sin((pan + 1) * Math.PI / 4);
  let phase = 0;
  let harmonicPhase = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    // 经典圆润气泡物理包络：圆滑正弦起音 + 0.54f0 -> 1.42f0 快速上扬频率扫掠 + 温润木琴余韵
    const instFreq = f0 * (0.54 + 0.88 * Math.min(1, (t / 0.044) ** 1.35));
    phase += (TAU * instFreq) / SAMPLE_RATE;
    harmonicPhase += (TAU * f0 * 2.0) / SAMPLE_RATE;
    const attack = Math.min(1, t / 0.0022);
    const popBody = Math.sin(phase) * Math.exp(-t * 24);
    const warmWood = Math.sin(TAU * f0 * t) * 0.42 * Math.exp(-t * 15);
    const glassyShimmer = Math.sin(harmonicPhase) * 0.22 * Math.exp(-t * 36);
    const lipTick = Math.sin(TAU * (f0 * 3.1) * t) * Math.exp(-t * 140) * 0.18;
    const sample = Math.tanh((popBody + warmWood + glassyShimmer + lipTick) * attack * 1.25);
    track[0][i] = sample * leftGain;
    track[1][i] = sample * rightGain;
  }
  return track;
}

function normalize(track, peak = 0.86) {
  let maximum = 0;
  for (const channel of track) for (const sample of channel) maximum = Math.max(maximum, Math.abs(sample));
  const scale = maximum > 0 ? peak / maximum : 1;
  for (const channel of track) for (let index = 0; index < channel.length; index += 1) channel[index] *= scale;
  return {peak};
}

function wav(track) {
  const frames = track[0].length;
  const output = Buffer.alloc(44 + frames * 4);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(2, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * 4, 28);
  output.writeUInt16LE(4, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(frames * 4, 40);
  for (let index = 0; index < frames; index += 1) {
    output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, track[0][index])) * 32767), 44 + index * 4);
    output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, track[1][index])) * 32767), 46 + index * 4);
  }
  return output;
}

function decodePcm16Wav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("无效 WAV 文件");
  }
  let formatOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= buf.length;) {
    const size = buf.readUInt32LE(offset + 4);
    const id = buf.toString("ascii", offset, offset + 4);
    if (id === "fmt ") formatOffset = offset + 8;
    if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (formatOffset < 0 || dataOffset < 0) throw new Error("WAV 缺少 fmt/data 块");
  const channels = buf.readUInt16LE(formatOffset + 2);
  const frames = Math.floor(Math.min(dataSize, buf.length - dataOffset) / (channels * 2));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const l = buf.readInt16LE(dataOffset + i * channels * 2) / 32768;
    const r = channels > 1 ? buf.readInt16LE(dataOffset + (i * channels + 1) * 2) / 32768 : l;
    left[i] = l;
    right[i] = r;
  }
  let peak = 0;
  for (let i = 0; i < frames; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  return {track: [left, right], frames, peak};
}

await mkdir(path.join(OUTPUT_DIR, "sfx"), {recursive: true});

const effects = {
  key: [sweep(2100, 1150, 0.09, 0.65)],
  click: [sweep(1680, 520, 0.085, 0.62), sweep(3200, 1180, 0.032, 0.36)],
  chord: [tone(74, 0.85, {type: "bell", gain: 0.42}), tone(78, 0.85, {type: "bell", gain: 0.36}), tone(81, 0.85, {type: "bell", gain: 0.32})],
  resolve: [
    tone(62, 1.35, {type: "pad", gain: 0.34}),
    tone(66, 1.35, {type: "rhodes", gain: 0.42}),
    tone(69, 1.35, {type: "rhodes", gain: 0.38}),
    tone(73, 1.35, {type: "bell", gain: 0.44}),
    tone(76, 1.35, {type: "bell", gain: 0.42}),
    tone(81, 1.35, {type: "bell", gain: 0.48}),
    tone(86, 1.35, {type: "bell", gain: 0.46})
  ]
};
const sfxEvidence = [];
const sfxBySrc = new Map();
for (const [name, layers] of Object.entries(effects)) {
  const track = buffer(name === "resolve" ? 1.4 : name === "chord" ? 0.9 : 0.2);
  layers.forEach((layer, index) => {
    const offset = name === "resolve" ? index * 0.018 : 0;
    const pan = ((index % 3) - 1) * 0.18;
    add(track, layer, offset, pan);
  });
  const level = normalize(track, 0.74);
  const file = path.join(OUTPUT_DIR, "sfx", `${name}.wav`);
  await writeFile(file, wav(track));
  sfxBySrc.set(`media/sfx/${name}.wav`, track);
  sfxEvidence.push({name, source: "code-original", license: "MIT License", file: path.relative(REPO_ROOT, file), durationInSeconds: track[0].length / SAMPLE_RATE, peak: level.peak});
}
const whoosh = makeWhoosh();
const whooshLevel = normalize(whoosh, 0.64);
const whooshFile = path.join(OUTPUT_DIR, "sfx", "whoosh.wav");
await writeFile(whooshFile, wav(whoosh));
sfxBySrc.set("media/sfx/whoosh.wav", whoosh);
sfxEvidence.push({name: "whoosh", source: "code-original", license: "MIT License", file: path.relative(REPO_ROOT, whooshFile), durationInSeconds: 0.5, peak: whooshLevel.peak});

const customSfxEntries = [
  {name: "pop", track: makePopPop(), peak: 0.78},
  {name: "voice-fade", track: makeVoiceFadeTransition(), peak: 0.68},
  {name: "polaroid-shutter", track: makePolaroidShutter(), peak: 0.86},
  {name: "mech-key-1", track: makeMechKey({pitchScale: 0.98, isEnter: false}), peak: 0.78},
  {name: "mech-key-2", track: makeMechKey({pitchScale: 1.04, isEnter: false}), peak: 0.8},
  {name: "mech-enter", track: makeMechKey({pitchScale: 0.92, isEnter: true}), peak: 0.84},
  {name: "snap", track: makeMagneticSnap(), peak: 0.86},
  ...[62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86, 88, 90, 93].map((noteMidi, idx) => ({
    name: `bubble-${String(idx + 1).padStart(2, "0")}`,
    track: makeBubblePop(noteMidi, idx),
    peak: Number((0.68 + idx * 0.01).toFixed(3))
  }))
];

for (const item of customSfxEntries) {
  const level = normalize(item.track, item.peak);
  const file = path.join(OUTPUT_DIR, "sfx", `${item.name}.wav`);
  await writeFile(file, wav(item.track));
  sfxBySrc.set(`media/sfx/${item.name}.wav`, item.track);
  sfxEvidence.push({
    name: item.name,
    source: "code-original",
    license: "MIT License",
    file: path.relative(REPO_ROOT, file),
    durationInSeconds: Number((item.track[0].length / SAMPLE_RATE).toFixed(3)),
    peak: level.peak
  });
}

const voiceExcerpts = [
  {name: "voice-0232", sourceFile: path.join(REPO_ROOT, "scripts", "promo", "assets", "voice", "voice-0232.wav"), excerpt: "02:32 但是它如果不答一定是零分", fadeOutSeconds: 0.15},
  {name: "voice-0407", sourceFile: path.join(REPO_ROOT, "scripts", "promo", "assets", "voice", "voice-0407.wav"), excerpt: "04:07 也很难避免幻觉", fadeOutSeconds: 0.06},
  {name: "voice-0444", sourceFile: path.join(REPO_ROOT, "scripts", "promo", "assets", "voice", "voice-0444.wav"), excerpt: "04:44 这里有一个研究", fadeOutSeconds: 0.06},
  {name: "voice-live-ai", sourceFile: path.join(REPO_ROOT, "scripts", "promo", "assets", "voice", "voice-live-ai.wav"), excerpt: "实时伴看 MOSS Live 回复：把检索和拆解交给 AI，你来掌舵判断。", fadeOutSeconds: 0.08, source: "moss-live-1.0-realtime", license: "Recorded from MOSS Live API for BiliScript demonstration"}
];
for (const item of voiceExcerpts) {
  const rawWav = await readFile(item.sourceFile);
  const decoded = decodePcm16Wav(rawWav);
  normalize(decoded.track, 1.0);
  const voiceDrive = 1.85;
  const normVoiceDrive = Math.tanh(voiceDrive);
  const fadeInSamples = Math.round(0.02 * SAMPLE_RATE);
  const fadeOutSamples = Math.round((item.fadeOutSeconds ?? 0.05) * SAMPLE_RATE);
  for (let ch = 0; ch < 2; ch += 1) {
    for (let i = 0; i < decoded.frames; i += 1) {
      const fadeIn = Math.min(1, i / fadeInSamples);
      const fadeOutT = Math.min(1, (decoded.frames - 1 - i) / fadeOutSamples);
      const fadeOut = 0.5 * (1 - Math.cos(Math.PI * fadeOutT));
      const compressed = Math.tanh(decoded.track[ch][i] * voiceDrive) / normVoiceDrive;
      decoded.track[ch][i] = compressed * fadeIn * fadeOut;
    }
  }
  const voiceLevel = normalize(decoded.track, 0.88);
  const outPath = path.join(OUTPUT_DIR, "sfx", `${item.name}.wav`);
  await writeFile(outPath, wav(decoded.track));
  sfxBySrc.set(`media/sfx/${item.name}.wav`, decoded.track);
  sfxEvidence.push({
    name: item.name,
    source: item.source ?? "bilibili-BV1mAam6tEL8-excerpt",
    excerpt: item.excerpt,
    license: item.license ?? "Fair-use demonstration excerpt from BV1mAam6tEL8",
    file: path.relative(REPO_ROOT, outPath),
    durationInSeconds: Number((decoded.frames / SAMPLE_RATE).toFixed(3)),
    peak: Number(voiceLevel.peak.toFixed(3))
  });
}

const score = makeScore();
const scoreLevel = normalize(score, 0.96);
const sfxStem = buffer(DURATION);
for (const cue of [...AUDIO.cues, ...AUDIO.voices]) {
  const sfxTrack = sfxBySrc.get(cue.src);
  if (!sfxTrack) continue;
  const mixStartFrame = cueMixStartFrame(cue);
  const startSample = Math.round((mixStartFrame / PROMO_FPS) * SAMPLE_RATE);
  for (let ch = 0; ch < 2; ch += 1) {
    for (let j = 0; j < sfxTrack[ch].length && startSample + j < sfxStem[ch].length; j += 1) {
      sfxStem[ch][startSample + j] += sfxTrack[ch][j] * cue.gain;
    }
  }
}

const samplesPerFrame = SAMPLE_RATE / PROMO_FPS;
const ceiling = 0.695;
const fullMix = buffer(DURATION);
for (let i = 0; i < score[0].length; i += 1) {
  const frame = Math.min(PROMO_DURATION - 1, Math.floor(i / samplesPerFrame));
  const vol = musicVolumeAtFrame(frame);
  for (let ch = 0; ch < 2; ch += 1) {
    if (vol <= 0.0001) {
      fullMix[ch][i] = Math.tanh((sfxStem[ch][i] * 1.08) / ceiling) * ceiling;
      continue;
    }
    const scaledScore = score[ch][i] * 1.34;
    const rawCombined = scaledScore * vol + sfxStem[ch][i] * 1.08;
    const limitedCombined = Math.tanh(rawCombined / ceiling) * ceiling;
    score[ch][i] = Math.max(-0.98, Math.min(0.98, (limitedCombined - sfxStem[ch][i]) / vol));
    fullMix[ch][i] = limitedCombined;
  }
}
await writeFile(path.join(OUTPUT_DIR, "promo-score.wav"), wav(score));
await writeFile(path.join(OUTPUT_DIR, "remotion-mix.wav"), wav(fullMix));

const evidence = {
  music: {
    title: "BiliScript Pulse",
    source: "code-original",
    generator: "scripts/promo/synthesize-audio.mjs",
    license: "MIT License",
    style: AUDIO.music.style,
    bpm: AUDIO.music.bpm,
    key: "B minor / D major",
    durationInSeconds: DURATION,
    randomSeed: "0x42b1115c",
    sceneAccents: SCENES.map((scene) => ({id: scene.id, at: scene.from / PROMO_FPS})),
    peak: scoreLevel.peak
  },
  sfx: sfxEvidence,
  cues: AUDIO.cues
};
await mkdir(path.join(PROMO_DIR, "evidence"), {recursive: true});
await writeFile(AUDIO_SELECTION_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
await writeFile(CACHE_HASH_FILE, currentAudioHash + "\n", "utf8");
console.log(`原创配乐与 ${sfxEvidence.length} 类音效已生成：${OUTPUT_DIR}`);
