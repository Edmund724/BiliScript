import path from "node:path";
import {mkdir, writeFile} from "node:fs/promises";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {AUDIO} from "./audio.mjs";
import {PROMO_DURATION, PROMO_FPS, SCENES} from "./timeline.mjs";

const SAMPLE_RATE = 48000;
const DURATION = PROMO_DURATION / PROMO_FPS;
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

function kick() {
  const output = new Float32Array(Math.round(0.24 * SAMPLE_RATE));
  let phase = 0;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const frequency = 42 + 105 * Math.exp(-time * 32);
    phase += TAU * frequency / SAMPLE_RATE;
    output[index] = Math.sin(phase) * Math.exp(-time * 18) * Math.min(1, time / 0.002) * 0.65;
  }
  return output;
}

function hat(open = false) {
  const seconds = open ? 0.16 : 0.055;
  const output = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let previous = 0;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const white = noise();
    const high = white - previous * 0.92;
    previous = white;
    output[index] = high * Math.exp(-time * (open ? 24 : 75)) * Math.min(1, time / 0.001) * 0.12;
  }
  return output;
}

function snare() {
  const output = new Float32Array(Math.round(0.18 * SAMPLE_RATE));
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    output[index] = (noise() * 0.26 + Math.sin(TAU * 185 * time) * 0.13) * Math.exp(-time * 25) * Math.min(1, time / 0.002);
  }
  return output;
}

function makeScore() {
  const track = buffer(DURATION);
  const beat = 60 / AUDIO.music.bpm;
  const chords = [
    [50, 54, 57, 62], [55, 59, 62, 67], [50, 54, 57, 62], [57, 61, 64, 69],
    [50, 54, 57, 62], [55, 59, 62, 67], [50, 54, 57, 62], [57, 61, 64, 69],
    [55, 59, 62, 67], [50, 54, 57, 62], [52, 55, 59, 64], [57, 61, 64, 69],
    [55, 59, 62, 67], [50, 54, 57, 62], [55, 59, 62, 67], [50, 54, 57, 62]
  ];
  for (let bar = 0; bar < chords.length; bar += 1) {
    const at = bar * 4 * beat;
    const chord = chords[bar];
    for (let note = 0; note < chord.length; note += 1) {
      add(track, tone(chord[note], bar === chords.length - 1 ? 3.6 : 2.15, {type: "pad", gain: 0.036}), at, (note - 1.5) * 0.25);
    }
    const arp = [0, 2, 1, 3, 2, 1, 3, 1];
    for (let step = 0; step < 8; step += 1) {
      const note = chord[arp[step]] + 12;
      const gain = bar >= 6 && bar <= 8 ? 0.065 : 0.09;
      add(track, tone(note, 0.3, {gain}), at + step * beat / 2, step % 2 ? 0.3 : -0.3);
    }
  }
  const bassRoots = [47, 43, 50, 45, 47, 43, 50, 45, 43, 50, 40, 45, 43, 50, 43, 47];
  for (let index = 0; index < 64; index += 1) {
    const at = index * beat;
    const bar = Math.floor(index / 4);
    const accent = SCENES.some((scene) => Math.abs(scene.from / PROMO_FPS - at) < 0.001);
    add(track, kick(), at);
    if (index % 2 === 1) add(track, snare(), at);
    add(track, hat(index % 4 === 3), at + beat / 2, index % 2 ? 0.25 : -0.25);
    if (index >= 2 && index < 56) add(track, tone(bassRoots[bar], 0.34, {type: "bass", gain: accent ? 0.22 : 0.17}), at);
  }
  const melody = [
    [2, 74], [3, 78], [6, 76], [10, 74], [14, 81], [15, 78], [18, 76],
    [22, 74], [26, 78], [30, 81], [34, 78], [38, 76], [42, 74], [46, 78], [50, 76]
  ];
  for (const [index, note] of melody) add(track, tone(note, 0.7, {type: "bell", gain: 0.1}), index * beat, 0.18);
  add(track, tone(74, 1.8, {type: "bell", gain: 0.14}), 28);
  add(track, tone(78, 1.8, {type: "bell", gain: 0.1}), 28, -0.2);
  add(track, tone(81, 1.8, {type: "bell", gain: 0.1}), 28, 0.2);
  return track;
}

function sweep(start, end, seconds, gain) {
  const output = new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
  let phase = 0;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const frequency = start + (end - start) * time / seconds;
    phase += TAU * frequency / SAMPLE_RATE;
    const envelope = Math.min(1, time / 0.003) * Math.exp(-time * 24) * Math.min(1, (seconds - time) / 0.025);
    output[index] = (Math.sin(phase) + 0.2 * Math.sin(phase * 2.01)) * envelope * gain;
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
    const envelope = Math.sin(Math.PI * Math.min(1, time / 0.5)) ** 1.7;
    track[0][index] = band * envelope * 0.35;
    track[1][index] = band * envelope * 0.28;
  }
  return track;
}

function normalize(track, peak = 0.78) {
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

await mkdir(path.join(OUTPUT_DIR, "sfx"), {recursive: true});
const score = makeScore();
const scoreLevel = normalize(score, 0.82);
await writeFile(path.join(OUTPUT_DIR, "promo-score.wav"), wav(score));

const effects = {
  key: [sweep(2100, 1150, 0.09, 0.65)],
  pop: [sweep(620, 270, 0.18, 0.72)],
  toggle: [sweep(1450, 820, 0.12, 0.68), sweep(880, 540, 0.1, 0.4)],
  click: [sweep(1050, 460, 0.12, 0.68)],
  chord: [tone(74, 0.85, {type: "bell", gain: 0.42}), tone(78, 0.85, {type: "bell", gain: 0.36}), tone(81, 0.85, {type: "bell", gain: 0.32})],
  resolve: [tone(74, 0.85, {type: "bell", gain: 0.65}), tone(81, 0.85, {type: "bell", gain: 0.5})]
};
const sfxEvidence = [];
for (const [name, layers] of Object.entries(effects)) {
  const track = buffer(name === "resolve" || name === "chord" ? 0.9 : 0.2);
  layers.forEach((layer, index) => add(track, layer, name === "toggle" ? index * 0.055 : 0, index ? 0.15 : -0.1));
  const level = normalize(track);
  const file = path.join(OUTPUT_DIR, "sfx", `${name}.wav`);
  await writeFile(file, wav(track));
  sfxEvidence.push({name, source: "code-original", license: "MIT License", file: path.relative(REPO_ROOT, file), durationInSeconds: track[0].length / SAMPLE_RATE, peak: level.peak});
}
const whoosh = makeWhoosh();
const whooshLevel = normalize(whoosh, 0.68);
const whooshFile = path.join(OUTPUT_DIR, "sfx", "whoosh.wav");
await writeFile(whooshFile, wav(whoosh));
sfxEvidence.push({name: "whoosh", source: "code-original", license: "MIT License", file: path.relative(REPO_ROOT, whooshFile), durationInSeconds: 0.5, peak: whooshLevel.peak});

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
