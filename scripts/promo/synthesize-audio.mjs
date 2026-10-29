import path from "node:path";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {AUDIO, musicVolumeAtFrame} from "./audio.mjs";
import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {HERO_TIMELINE, OVERVIEW_TIMELINE, PROMO_DURATION, PROMO_FPS, SCENES} from "./timeline.mjs";

const SAMPLE_RATE = 48000;
const DURATION = PROMO_DURATION / PROMO_FPS;
const OVERVIEW_SCENE = SCENES.find((scene) => scene.id === "overview");
const OVERVIEW_CHAPTER_FRAMES = Math.round(OVERVIEW_SCENE.duration * OVERVIEW_TIMELINE.chapterRatio);
const QUOTE_FREEZE_FROM = (OVERVIEW_SCENE.from + OVERVIEW_CHAPTER_FRAMES) / PROMO_FPS;
const QUOTE_FREEZE_TO = (OVERVIEW_SCENE.from + OVERVIEW_SCENE.duration) / PROMO_FPS;
const OUTPUT_DIR = path.join(PROMO_DIR, "assets", "audio");
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
  if (seconds < 3.5) return 0.66;
  if (seconds < 7.5) return 0.76;
  if (seconds < 11.5) return 0.86;
  if (seconds < 17.5) return 0.90;
  if (seconds < 20.5) return 1.12;
  if (seconds < 25.5) return 1.16;
  if (seconds < 30.48) return 1.14;
  if (seconds < 30.9) return 0.05;
  if (seconds < 33.1) return 1.06;
  return 0.74;
}

function inVoiceWindow(seconds) {
  return AUDIO.voices.some((voice) => {
    const start = (voice.frame - 2) / PROMO_FPS;
    const end = (voice.frame + (voice.durationFrames ?? 40) + 4) / PROMO_FPS;
    return seconds >= start && seconds <= end;
  });
}

function makeScore() {
  const track = buffer(DURATION);
  const beat = 60 / AUDIO.music.bpm;
  const chords = [
    [50, 54, 57, 62], [55, 59, 62, 67], [50, 54, 57, 62], [57, 61, 64, 69],
    [50, 54, 57, 62], [55, 59, 62, 67], [50, 54, 57, 62], [57, 61, 64, 69],
    [55, 59, 62, 67], [50, 54, 57, 62], [52, 55, 59, 64], [57, 61, 64, 69],
    [55, 59, 62, 67], [50, 54, 57, 62], [55, 59, 62, 67], [50, 54, 57, 62],
    [50, 54, 57, 62]
  ];
  const barCount = Math.ceil(DURATION / (4 * beat));
  for (let bar = 0; bar < barCount; bar += 1) {
    const at = bar * 4 * beat;
    if (at >= 30.0 && at < 30.9) continue;
    const dyn = sectionDynamicsAt(at + 0.1);
    const chord = chords[bar % chords.length];
    const padDuration = at < 30.0 && at + 2.15 > 30.5 ? Math.max(0.4, 30.5 - at) : (bar === barCount - 1 ? 3.2 : 2.15);
    for (let note = 0; note < chord.length; note += 1) {
      add(track, tone(chord[note], padDuration, {type: "pad", gain: 0.038 * dyn}), at, (note - 1.5) * 0.25);
    }
    const arp = [0, 2, 1, 3, 2, 1, 3, 1];
    for (let step = 0; step < 8; step += 1) {
      const stepAt = at + step * beat / 2;
      if (stepAt >= 30.45 && stepAt < 31.08) continue;
      const inVoice = inVoiceWindow(stepAt);
      // 金句单卡定格期间与原片人声段留出清透空间
      if ((stepAt >= QUOTE_FREEZE_FROM && stepAt < QUOTE_FREEZE_TO || inVoice) && step % 2 === 1) continue;
      const stepDyn = sectionDynamicsAt(stepAt) * (inVoice ? 0.55 : 1);
      const note = chord[arp[step]] + (stepAt >= 20.5 && stepAt < 25.5 ? 24 : 12);
      const gain = (bar >= 4 && bar <= 5 ? 0.056 : bar >= 6 && bar <= 8 ? 0.072 : 0.094) * stepDyn;
      add(track, tone(note, stepAt >= 20.5 && stepAt < 25.5 ? 0.19 : 0.28, {type: stepAt >= 7.5 && stepAt < 11.5 ? "bell" : "pluck", gain}), stepAt, step % 2 ? 0.32 : -0.32);
    }
    // 22.23–24.1s 平台矩阵波浪段落：叠加 16 分音符律动木琴底脉冲，托起 14 个连续冒泡音
    if (at >= 20.0 && at < 26.0) {
      for (let sixteenth = 0; sixteenth < 16; sixteenth += 1) {
        const pulseAt = at + sixteenth * (beat / 4);
        if (pulseAt < 22.2 || pulseAt > 24.15) continue;
        const pulseNote = chord[sixteenth % chord.length] + 12;
        add(track, tone(pulseNote, 0.09, {type: "pluck", gain: 0.045}), pulseAt, ((sixteenth % 7) - 3) * 0.14);
      }
    }
  }
  const bassRoots = [47, 43, 50, 45, 47, 43, 50, 45, 43, 50, 40, 45, 43, 50, 43, 47, 50];
  const beatCount = Math.ceil(DURATION / beat);
  for (let index = 0; index < beatCount; index += 1) {
    const at = index * beat;
    if (at >= 30.45 && at < 30.9) continue;
    const dyn = sectionDynamicsAt(at);
    const bar = Math.floor(index / 4) % bassRoots.length;
    const accent = SCENES.some((scene) => Math.abs(scene.from / PROMO_FPS - at) < 0.001);
    // 前 1.7 秒单句痛点与品牌主张停留段保留轻柔心跳低音，2.5s 推镜聚拢后逐步进入完整鼓组；金句单卡定格与原片人声段减轻高频打击乐
    const inQuoteFreezeWindow = at >= QUOTE_FREEZE_FROM && at < QUOTE_FREEZE_TO;
    const inVoice = inVoiceWindow(at);
    const inProviderWave = at >= 20.5 && at < 25.5;
    add(track, kick(at < 1.8 ? dyn * 0.55 : inVoice ? dyn * 0.72 : inProviderWave ? dyn * 1.08 : dyn), at);
    if (index % 2 === 1 && at >= 3.5 && !inQuoteFreezeWindow && !inVoice) {
      add(track, snare(inProviderWave ? dyn * 1.05 : dyn), at);
    }
    if (at >= 2.5 && !inQuoteFreezeWindow) {
      add(track, hat(index % 4 === 3 && !inVoice, inVoice ? dyn * 0.45 : dyn), at + beat / 2, index % 2 ? 0.25 : -0.25);
      if (inProviderWave) {
        add(track, hat(false, dyn * 0.65), at + beat / 4, -0.2);
        add(track, hat(false, dyn * 0.65), at + (beat * 3) / 4, 0.2);
      }
    }
    if (index >= 2 && index < beatCount - 4) {
      add(track, tone(bassRoots[bar], 0.34, {type: "bass", gain: (accent ? 0.24 : 0.18) * dyn * (inVoice ? 0.75 : 1)}), at);
    }
  }

  // 核心切点的 60–90Hz 短 sub-hit 瞬态强调
  const resolveAt = (OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt) / PROMO_FPS;
  const cutHits = [HERO_TIMELINE.hookHoldUntil / PROMO_FPS, HERO_TIMELINE.snapEmphasisAt / PROMO_FPS, 3.5, 7.5, 11.5, 17.5, 20.5, 25.5, resolveAt, 30.9];
  for (const cutAt of cutHits) {
    add(track, subHit(cutAt >= 17.5 ? 0.62 : 0.52), cutAt);
  }

  // 四拍能力落点递进强调（峰值严格非递减）
  const featureBuild = [
    {at: (OUTRO_TIMELINE.from + OUTRO_TIMELINE.features[0].at) / PROMO_FPS, notes: [62, 69], gain: 0.14, sub: 0.36},
    {at: (OUTRO_TIMELINE.from + OUTRO_TIMELINE.features[1].at) / PROMO_FPS, notes: [64, 71], gain: 0.17, sub: 0.42},
    {at: (OUTRO_TIMELINE.from + OUTRO_TIMELINE.features[2].at) / PROMO_FPS, notes: [66, 74], gain: 0.20, sub: 0.48},
    {at: (OUTRO_TIMELINE.from + OUTRO_TIMELINE.features[3].at) / PROMO_FPS, notes: [69, 76, 81], gain: 0.23, sub: 0.55}
  ];
  for (const step of featureBuild) {
    add(track, subHit(step.sub), step.at);
    step.notes.forEach((note, idx) => {
      add(track, tone(note, 0.42, {type: "bell", gain: step.gain}), step.at, (idx - 0.5) * 0.22);
    });
  }

  const melody = [
    [2, 74], [3, 78], [7, 76], [11, 74], [15, 81], [16, 78], [19, 76],
    [23, 74], [27, 78], [31, 81], [35, 78], [39, 76], [43, 74], [47, 78], [51, 76]
  ];
  for (const [index, note] of melody) {
    const at = index * beat;
    add(track, tone(note, 0.7, {type: "bell", gain: 0.1 * sectionDynamicsAt(at)}), at, 0.18);
  }

  // 30.70s 徽章胀开成品牌落定 Resolve；30.52–30.88s 收尾留白呼吸，31.03s 标语落点
  add(track, subHit(0.56), resolveAt);
  add(track, tone(74, 1.8, {type: "bell", gain: 0.18}), resolveAt);
  add(track, tone(78, 1.8, {type: "bell", gain: 0.14}), resolveAt, -0.2);
  add(track, tone(81, 1.8, {type: "bell", gain: 0.14}), resolveAt, 0.2);

  // Soft-clipping & dynamic shaping to hit -14 LUFS (±0.5) and LRA 4–6 in final mix
  normalize(track, 1.0);
  const drive = 2.55;
  const normDrive = Math.tanh(drive);
  for (let ch = 0; ch < 2; ch += 1) {
    for (let i = 0; i < track[ch].length; i += 1) {
      const time = i / SAMPLE_RATE;
      const boost = time >= 17.5 && time < 30.48 ? 1.12 : 0.96;
      if (time >= 30.52 && time < 30.88) {
        const edge = Math.min(1, Math.max(0, (30.57 - time) / 0.05));
        track[ch][i] *= edge;
      }
      track[ch][i] = (Math.tanh(track[ch][i] * drive * boost) / normDrive) * (time >= 17.5 && time < 30.48 ? 1.04 : 0.94);
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
  let low = 0;
  for (let index = 0; index < track[0].length; index += 1) {
    const time = index / SAMPLE_RATE;
    low = low * 0.86 + noise() * 0.14;
    const band = noise() * 0.25 + low * 1.7;
    const sub = Math.sin(TAU * (68 + 20 * Math.exp(-time * 10)) * time) * Math.exp(-time * 12) * 0.45;
    const envelope = Math.sin(Math.PI * Math.min(1, time / 0.5)) ** 1.5;
    track[0][index] = (band * envelope * 0.38) + sub;
    track[1][index] = (band * envelope * 0.32) + sub;
  }
  return track;
}

// 0:00 痛点气泡弹出音（Pop-Pop）：双段式弹性气泡连弹（预膨胀 Pop + 清脆高八度释压 Pop）
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

// 0:02 切场响指声（Finger Snap）：指腹摩擦预振 + 掌心空腔清脆脆响 + 瞬态切场聚焦余韵
function makeFingerSnap() {
  const seconds = 0.22;
  const track = buffer(seconds);
  let cavityPhase = 0;
  let prev = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    const w = noise();
    const hp = w - prev * 0.88;
    prev = w;
    // 1. 0–9ms 指腹高速滑脱摩擦预振
    const slideEnv = t < 0.009 ? Math.sin((t / 0.009) * Math.PI) * 0.32 : 0;
    const slide = hp * slideEnv;

    // 2. 9ms 处指尖击打掌根空腔（1.9kHz + 3.1kHz 双峰掌腔共鸣 + 瞬态脆裂）
    const ts = Math.max(0, t - 0.0085);
    const cavityFreq = 2180 * Math.exp(-ts * 42) + 860;
    cavityPhase += (TAU * cavityFreq) / SAMPLE_RATE;
    const snapCrack =
      ts > 0
        ? (Math.sin(cavityPhase) * 0.78 +
            Math.sin(TAU * 3280 * ts) * 0.52 * Math.exp(-ts * 145) +
            Math.sin(TAU * 1420 * ts) * 0.44 * Math.exp(-ts * 75) +
            hp * 0.68 * Math.exp(-ts * 190)) *
          Math.exp(-ts * 54) *
          Math.min(1, ts / 0.00035)
        : 0;
    const bodyPop =
      ts > 0
        ? Math.sin(TAU * (165 + 140 * Math.exp(-ts * 70)) * ts) *
          Math.exp(-ts * 38) *
          Math.min(1, ts / 0.0008) *
          0.52
        : 0;
    const sample = Math.tanh((slide + snapCrack + bodyPop) * 1.48);
    track[0][i] = sample * 0.98;
    track[1][i] = sample * 1.02;
  }
  return track;
}

// 0:08 原声淡出过渡音（Voice Fade Transition）：温润空气感收束 + 泛音微光桥接
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

// 0:10 金句保存快门声（Polaroid Shutter + Pop-up）：拍立得双叶机械快门 + 闪光灯电容微鸣 + 实体相纸弹起共鸣
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

// 0:03 定制清脆机械键盘敲击音效（段落轴簧片 Click + PBT 键帽触底 Thock，回车键叠加平衡杆共鸣）
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

// 0:05 磁吸吸附音效（Snap）：微吸附预收束 + 钕磁铁清脆咬合瞬态 + 瞬移锁定泛音
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
    // 前 18ms 极速磁力牵引上扬（480Hz -> 2100Hz）
    const preEnv = t < 0.018 ? Math.sin((t / 0.018) * (Math.PI / 2)) * 0.45 : Math.exp(-(t - 0.018) * 180) * 0.45;
    const preFreq = 480 + 1620 * Math.min(1, t / 0.018) ** 2;
    sweepPhase += (TAU * preFreq) / SAMPLE_RATE;
    const suction = Math.sin(sweepPhase) * preEnv;

    // 18ms 处磁极瞬时吸合（清脆金属玻璃质感咬合 + 紧实 82Hz 瞬移低频锚点）
    const tl = Math.max(0, t - 0.016);
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

// 0:09 切换金句卡片配色：成音阶递进的清脆水滴声 + 胶片快门声（咔嚓）
function makeShutterDrop(noteMidi, stepIndex = 0) {
  const seconds = 0.28;
  const track = buffer(seconds);
  const baseFreq = midi(noteMidi);
  const fifthFreq = midi(noteMidi + 7);
  let dropPhase = 0;
  let prev = 0;
  for (let i = 0; i < track[0].length; i += 1) {
    const t = i / SAMPLE_RATE;
    const w = noise();
    const hp = w - prev * 0.89;
    prev = w;
    // 1. 胶片相机双帘机械快门“咔-嚓”（0ms 前帘释放 + 15ms 后帘咬合）
    const blade1 =
      (hp * 0.65 + Math.sin(TAU * 2950 * t) * 0.42 + Math.sin(TAU * 920 * t) * 0.35) *
      Math.exp(-t * 175) *
      Math.min(1, t / 0.0004);
    const t2 = Math.max(0, t - 0.015);
    const blade2 =
      t2 > 0
        ? (hp * 0.52 + Math.sin(TAU * 3480 * t2) * 0.48 + Math.sin(TAU * 1380 * t2) * 0.32) *
          Math.exp(-t2 * 150) *
          Math.min(1, t2 / 0.0004)
        : 0;
    // 2. 成音阶递进的清脆水滴声（流体空化特征：基频从 0.58x 指数上扬至 1.32x，叠清透泛音）
    const td = Math.max(0, t - 0.006);
    const dropInstFreq = baseFreq * (0.58 + 0.74 * (1 - Math.exp(-td * 58)));
    dropPhase += (TAU * dropInstFreq) / SAMPLE_RATE;
    const waterDrop =
      td > 0
        ? (Math.sin(dropPhase) * 0.76 +
            Math.sin(TAU * baseFreq * 2.0 * td) * 0.28 * Math.exp(-td * 28) +
            Math.sin(TAU * fifthFreq * td) * (0.18 + stepIndex * 0.06) * Math.exp(-td * 18)) *
          Math.exp(-td * 16.5) *
          Math.min(1, td / 0.0015)
        : 0;
    const pan = (stepIndex - 1) * 0.16;
    const leftGain = Math.cos((pan + 1) * Math.PI / 4);
    const rightGain = Math.sin((pan + 1) * Math.PI / 4);
    const sample = Math.tanh((blade1 * 0.68 + blade2 * 0.72 + waterDrop * 0.92) * 1.32);
    track[0][i] = sample * leftGain;
    track[1][i] = sample * rightGain;
  }
  return track;
}

// 0:21 14 个 AI 平台图标矩阵波浪：密集、舒适的成音阶立体声冒泡音效（Pop / Bubble）
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
  toggle: [sweep(1450, 820, 0.12, 0.68), sweep(880, 540, 0.1, 0.4)],
  click: [sweep(1050, 460, 0.12, 0.68)],
  chord: [tone(74, 0.85, {type: "bell", gain: 0.42}), tone(78, 0.85, {type: "bell", gain: 0.36}), tone(81, 0.85, {type: "bell", gain: 0.32})],
  resolve: [tone(74, 0.85, {type: "bell", gain: 0.65}), tone(81, 0.85, {type: "bell", gain: 0.5})]
};
const sfxEvidence = [];
const sfxBySrc = new Map();
for (const [name, layers] of Object.entries(effects)) {
  const track = buffer(name === "resolve" || name === "chord" ? 0.9 : 0.2);
  layers.forEach((layer, index) => add(track, layer, name === "toggle" ? index * 0.055 : 0, index ? 0.15 : -0.1));
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
  {name: "finger-snap", track: makeFingerSnap(), peak: 0.84},
  {name: "voice-fade", track: makeVoiceFadeTransition(), peak: 0.68},
  {name: "polaroid-shutter", track: makePolaroidShutter(), peak: 0.86},
  {name: "mech-key-1", track: makeMechKey({pitchScale: 0.98, isEnter: false}), peak: 0.78},
  {name: "mech-key-2", track: makeMechKey({pitchScale: 1.04, isEnter: false}), peak: 0.8},
  {name: "mech-enter", track: makeMechKey({pitchScale: 0.92, isEnter: true}), peak: 0.84},
  {name: "snap", track: makeMagneticSnap(), peak: 0.86},
  {name: "shutter-1", track: makeShutterDrop(74, 0), peak: 0.8},
  {name: "shutter-2", track: makeShutterDrop(78, 1), peak: 0.82},
  {name: "shutter-3", track: makeShutterDrop(81, 2), peak: 0.84},
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
  {name: "voice-0444", sourceFile: path.join(REPO_ROOT, "scripts", "promo", "assets", "voice", "voice-0444.wav"), excerpt: "04:44 这里有一个研究", fadeOutSeconds: 0.06}
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
    source: "bilibili-BV1mAam6tEL8-excerpt",
    excerpt: item.excerpt,
    license: "Fair-use demonstration excerpt from BV1mAam6tEL8",
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
  const startSample = Math.round((cue.frame / PROMO_FPS) * SAMPLE_RATE);
  for (let ch = 0; ch < 2; ch += 1) {
    for (let j = 0; j < sfxTrack[ch].length && startSample + j < sfxStem[ch].length; j += 1) {
      sfxStem[ch][startSample + j] += sfxTrack[ch][j] * cue.gain;
    }
  }
  if (cue.id === "chapters-quote-cut") {
    const pageFlipShutter = sfxBySrc.get("media/sfx/shutter-1.wav");
    if (pageFlipShutter) {
      for (let ch = 0; ch < 2; ch += 1) {
        for (let j = 0; j < pageFlipShutter[ch].length && startSample + j < sfxStem[ch].length; j += 1) {
          sfxStem[ch][startSample + j] += pageFlipShutter[ch][j] * 0.52;
        }
      }
    }
  }
}

const samplesPerFrame = SAMPLE_RATE / PROMO_FPS;
const ceiling = 0.75;
const fullMix = buffer(DURATION);
for (let i = 0; i < score[0].length; i += 1) {
  const frame = Math.min(PROMO_DURATION - 1, Math.floor(i / samplesPerFrame));
  const vol = musicVolumeAtFrame(frame);
  for (let ch = 0; ch < 2; ch += 1) {
    if (vol <= 0.0001) {
      fullMix[ch][i] = Math.tanh((sfxStem[ch][i] * 1.12) / ceiling) * ceiling;
      continue;
    }
    const scaledScore = score[ch][i] * 1.42;
    const rawCombined = scaledScore * vol + sfxStem[ch][i] * 1.12;
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
await writeFile(path.join(PROMO_DIR, "evidence", "audio-selection.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(`原创配乐与 ${sfxEvidence.length} 类音效已生成：${OUTPUT_DIR}`);
