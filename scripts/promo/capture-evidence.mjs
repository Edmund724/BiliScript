import path from "node:path";
import {execFile} from "node:child_process";
import {mkdir, rm, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {AUDIO} from "./audio.mjs";
import {PROMO_DIR} from "./lib.mjs";
import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {EVIDENCE_TIMES, EVIDENCE_TRANSITIONS, PROMO_DURATION, PROMO_FPS, PROVIDER_TIMELINE, SCENES} from "./timeline.mjs";
import {resolveVerificationTarget} from "./verification-target.mjs";

const execFileAsync = promisify(execFile);
const {input, kind, width, height, evidenceRoot} = await resolveVerificationTarget();
const root = path.join(evidenceRoot, `${kind}-visual`);
const sheetsDir = path.join(root, "contact-sheets");
const transitionsDir = path.join(root, "transitions");
const stillsDir = path.join(root, "stills");
const mobileDir = path.join(root, "mobile-360");
const audioDir = path.join(evidenceRoot, `${kind}-audio`);
await rm(root, {recursive: true, force: true});
await Promise.all([sheetsDir, transitionsDir, stillsDir, mobileDir, audioDir].map((dir) => mkdir(dir, {recursive: true})));

async function ffmpeg(args) {
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {maxBuffer: 4 * 1024 * 1024});
}

const duration = PROMO_DURATION / PROMO_FPS;
const contactSheets = [];
for (let start = 0, page = 1; start < duration; start += 8, page += 1) {
  const file = `sheet-${String(page).padStart(2, "0")}.jpg`;
  await ffmpeg(["-ss", String(start), "-t", String(Math.min(8, duration - start)), "-i", input, "-vf", "fps=2,scale=384:216,tile=4x4:padding=4:margin=4:color=white", "-frames:v", "1", "-q:v", "2", path.join(sheetsDir, file)]);
  contactSheets.push({file, from: start, to: Math.min(start + 7.5, duration - 1 / PROMO_FPS)});
}

const PROVIDERS_FROM = SCENES.find((scene) => scene.id === "providers").from;
const providerSeconds = (frame) => (PROVIDERS_FROM + frame) / PROMO_FPS;
const outroSeconds = (frame) => (OUTRO_TIMELINE.from + frame) / PROMO_FPS;
const transitions = EVIDENCE_TRANSITIONS.map((transition) => ({...transition}));
for (const transition of transitions) {
  const start = Math.max(0, transition.at - 0.45);
  const seconds = transition.holdToEnd ? duration - start : 1;
  const tile = transition.holdToEnd ? "6x4" : "5x2";
  const file = `${transition.id}.jpg`;
  await ffmpeg(["-ss", String(start), "-t", String(seconds), "-i", input, "-vf", `fps=10,scale=320:180,tile=${tile}:padding=4:margin=4:color=white`, "-frames:v", "1", "-q:v", "2", path.join(transitionsDir, file)]);
  transition.file = file;
  transition.from = start;
  transition.to = Math.min(duration - 1 / PROMO_FPS, start + seconds - 0.1);
}

const stills = [];
for (const seconds of EVIDENCE_TIMES) {
  const file = `${String(Math.round(seconds * PROMO_FPS)).padStart(4, "0")}.png`;
  await ffmpeg(["-ss", String(seconds), "-i", input, "-frames:v", "1", "-vf", "scale=1920:1080", path.join(stillsDir, file)]);
  stills.push({seconds, file});
}

const mobileShots = [
  {id: "poster", at: 0},
  {id: "search", at: 4.5},
  {id: "chapters", at: 8.2},
  {id: "quote", at: 10.7},
  {id: "chat-verify", at: 15.1},
  {id: "appearance", at: 18.0},
  {id: "provider-plate", at: providerSeconds(PROVIDER_TIMELINE.plateAt + 6)},
  {id: "provider-orbit", at: providerSeconds(PROVIDER_TIMELINE.orbitAt + 56)},
  {id: "features", at: outroSeconds(OUTRO_TIMELINE.features[OUTRO_TIMELINE.features.length - 1].at) + 0.1},
  {id: "cta", at: outroSeconds(OUTRO_TIMELINE.finalHoldAt) + 0.2}
];
for (const shot of mobileShots) {
  const file = `${shot.id}.png`;
  await ffmpeg(["-ss", String(shot.at), "-i", input, "-frames:v", "1", "-vf", "scale=360:202", path.join(mobileDir, file)]);
  shot.file = file;
}

const effectsPath = path.join(audioDir, "sfx-stem.wav");
const publicDir = path.join(PROMO_DIR, "public");
const effectInputs = AUDIO.cues.map((cue) => path.join(publicDir, cue.src));
const filters = AUDIO.cues.map((cue, index) => `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${cue.gain},adelay=${Math.round(cue.frame / PROMO_FPS * 1000)}:all=1[effect${index}]`);
filters.push(`${AUDIO.cues.map((_, index) => `[effect${index}]`).join("")}amix=inputs=${AUDIO.cues.length}:duration=longest:normalize=0,atrim=0:${duration},asetpts=N/SR/TB[out]`);
await ffmpeg([...effectInputs.flatMap((file) => ["-i", file]), "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "pcm_s16le", effectsPath]);
await ffmpeg(["-i", effectsPath, "-lavfi", "showspectrumpic=s=1600x500:scale=log:fscale=log", "-frames:v", "1", path.join(audioDir, "sfx-spectrum.png")]);
const effectsMeasurement = await execFileAsync("ffmpeg", ["-hide_banner", "-i", effectsPath, "-af", "loudnorm=I=-16:TP=-1.5:LRA=8:print_format=json", "-f", "null", "-"]).catch((error) => error.code ? Promise.reject(error) : error);
const effectsJson = [...effectsMeasurement.stderr.matchAll(/\{[^{}]+\}/g)].at(-1);
if (!effectsJson) throw new Error("未测到独立音效轨响度");
await writeFile(path.join(audioDir, "sfx-measurements.json"), JSON.stringify({source: "AUDIO.cues", durationInSeconds: duration, loudness: JSON.parse(effectsJson[0]), listeningReview: "not-verified"}, null, 2) + "\n", "utf8");

const manifest = {
  video: path.relative(REPO_ROOT, input).replaceAll("\\", "/"),
  source: "encoded-video",
  width,
  height,
  fps: PROMO_FPS,
  durationInSeconds: duration,
  contactSheets,
  transitions,
  stills,
  mobile: {equivalentWidth: 360, shots: mobileShots},
  effectsStem: path.relative(REPO_ROOT, effectsPath).replaceAll("\\", "/"),
  listeningReview: {status: "not-verified", reason: "结构、电平与频谱检查不替代实际试听；最终混音和独立音效轨的听感需人工确认。"}
};
await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`${kind} 成片视觉证据与独立音效轨：${root}`);
