import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {AUDIO} from "./audio.mjs";
import {PROMO_DURATION, PROMO_FPS} from "./timeline.mjs";

const execFileAsync = promisify(execFile);
const input = path.resolve(process.argv[2] || path.join(REPO_ROOT, "release", "BiliScript-promo-1080p.mp4"));
const output = path.join(PROMO_DIR, "evidence", process.argv[2] ? "draft-audio" : "final-audio");
await mkdir(output, {recursive: true});
const pcmPath = path.join(output, "encoded-audio.wav");
const loudness = await execFileAsync("ffmpeg", ["-hide_banner", "-i", input, "-af", "loudnorm=I=-16:TP=-1.5:LRA=8:print_format=json", "-f", "null", "-"], {maxBuffer: 4 * 1024 * 1024}).catch((error) => {
  if (error.code) throw error;
  return error;
});
const jsonMatches = [...loudness.stderr.matchAll(/\{[^{}]+\}/g)];
if (!jsonMatches.length) throw new Error("未测到成片响度");
const measured = JSON.parse(jsonMatches.at(-1)[0]);
await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map", "0:a:0", "-c:a", "pcm_s16le", pcmPath]);

const file = await readFile(pcmPath);
if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw new Error("音频解码失败");
let formatOffset = -1;
let dataOffset = -1;
for (let offset = 12; offset + 8 <= file.length;) {
  const size = file.readUInt32LE(offset + 4);
  if (file.toString("ascii", offset, offset + 4) === "fmt ") formatOffset = offset + 8;
  if (file.toString("ascii", offset, offset + 4) === "data") {
    dataOffset = offset + 8;
    break;
  }
  offset += 8 + size + size % 2;
}
const format = formatOffset >= 0 ? file.readUInt16LE(formatOffset) : 0;
if (formatOffset < 0 || dataOffset < 0 || ![1, 65534].includes(format) || file.readUInt16LE(formatOffset + 14) !== 16) {
  throw new Error("音频测量需要 PCM16 WAV");
}
const channels = file.readUInt16LE(formatOffset + 2);
const sampleRate = file.readUInt32LE(formatOffset + 4);
const samples = new Int16Array(file.buffer, file.byteOffset + dataOffset, (file.length - dataOffset) / 2);

function rms(from, to) {
  const start = Math.max(0, Math.round(from * sampleRate));
  const end = Math.min(samples.length / channels, Math.round(to * sampleRate));
  let energy = 0;
  let count = 0;
  for (let frame = start; frame < end; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = samples[frame * channels + channel] / 32768;
      energy += value * value;
      count += 1;
    }
  }
  return count ? 20 * Math.log10(Math.sqrt(energy / count)) : -Infinity;
}

let samplePeak = 0;
for (const sample of samples) samplePeak = Math.max(samplePeak, Math.abs(sample) / 32768);
const duration = samples.length / channels / sampleRate;
const fadeOutEnd = AUDIO.music.fadeOutEndFrame / PROMO_FPS;
const report = {
  video: path.relative(REPO_ROOT, input).replaceAll("\\", "/"),
  durationInSeconds: duration,
  sampleRate,
  channels,
  loudness: measured,
  samplePeakDbfs: 20 * Math.log10(samplePeak),
  fadeIn: {first100MsRmsDb: rms(0, 0.1), next400MsRmsDb: rms(0.1, 0.5)},
  fadeOut: {last100MsRmsDb: rms(fadeOutEnd - 0.1, fadeOutEnd), previous400MsRmsDb: rms(fadeOutEnd - 0.5, fadeOutEnd - 0.1), tailRmsDb: rms(fadeOutEnd, duration)},
  cues: AUDIO.cues.map((cue) => ({
    id: cue.id,
    actionFrame: cue.frame,
    actionSeconds: cue.frame / PROMO_FPS,
    actionWindowRmsDb: rms(cue.frame / PROMO_FPS, cue.frame / PROMO_FPS + 0.12)
  }))
};
if (Math.abs(duration - PROMO_DURATION / PROMO_FPS) > 0.05) throw new Error(`音轨时长不符：${duration}`);
const inputI = Number(measured.input_i);
const inputLra = Number(measured.input_lra);
const inputTp = Number(measured.input_tp);
if (!Number.isFinite(inputI) || inputTp > -1) throw new Error(`成片 true peak 过高：${measured.input_tp}`);
if (inputI < -14.5 || inputI > -13.5) throw new Error(`成片综合响度超出 -14±0.5 LUFS：${measured.input_i}`);
if (inputLra < 4.0 || inputLra > 6.0) throw new Error(`成片 LRA 超出 4–6 范围：${measured.input_lra}`);
if (samplePeak >= 0.99) throw new Error(`成片存在削波风险：${report.samplePeakDbfs} dBFS`);
if (!(report.fadeIn.first100MsRmsDb < report.fadeIn.next400MsRmsDb)) throw new Error("片头未检测到自然淡入");
if (!(report.fadeOut.last100MsRmsDb < report.fadeOut.previous400MsRmsDb)) throw new Error("片尾未检测到自然淡出");
if (report.fadeOut.tailRmsDb > -60) throw new Error(`配乐未在 ${PROMO_DURATION / PROMO_FPS} 秒完成淡出：${report.fadeOut.tailRmsDb} dBFS`);
await writeFile(path.join(output, "audio-measurements.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`音频测量工件：${output}`);
