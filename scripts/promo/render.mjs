import path from "node:path";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { REPO_ROOT } from "../browser-harness/harness.mjs";
import { PROMO_DIR, ffmpegPath } from "./lib.mjs";

const RELEASE_DIR = path.join(REPO_ROOT, "release");
const scenes = [
  { name: "01-intro", duration: 5 },
  { name: "02-subtitle", duration: 10 },
  { name: "03-overview", duration: 12 },
  { name: "04-chat", duration: 15 },
  { name: "05-appearance", duration: 8 }
];
const captions = [
  [0.35, 4.65, "BiliScript｜B 站视频文摘\\N不离开视频页，读懂整条视频"],
  [5.35, 9.7, "逐句字幕 · 句内搜索 · 时间戳跳播"],
  [15.35, 20.5, "AI 概览：章节、金句与分享卡片"],
  [27.35, 34.5, "围绕视频追问，回答也能跳回原片"],
  [42.35, 46.5, "浅色 / 深色 · 蓝雾玻璃 / 数字刊物"],
  [46.4, 49.65, "双语字幕｜字幕导出｜语音识别｜联网搜索"]
];

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} 失败 (${code})\n${stderr.slice(-5000)}`)));
  });
}

function assTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
}

function srtTime(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

async function writeSubtitles() {
  const header = `[Script Info]
Title: BiliScript Promo
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Microsoft YaHei,40,&H00FFFFFF,&H000000FF,&H00122133,&H8C101722,-1,0,0,0,100,100,0,0,3,12,0,1,60,60,48,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ass = header + captions.map(([start, end, text]) => `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`).join("\n") + "\n";
  const srt = captions.map(([start, end, text], index) => `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text.replace("\\N", "\n")}\n`).join("\n");
  const assPath = path.join(PROMO_DIR, "assets", "captions.ass");
  await writeFile(assPath, ass, "utf8");
  await writeFile(path.join(RELEASE_DIR, "BiliScript-promo-zh-CN.srt"), srt, "utf8");
  return assPath;
}

await mkdir(RELEASE_DIR, { recursive: true });
const ffmpeg = ffmpegPath();
const clips = [];
for (const scene of scenes) {
  const frameDirectory = path.join(PROMO_DIR, "frames", scene.name);
  const metadata = JSON.parse(await readFile(path.join(frameDirectory, "frames.json"), "utf8"));
  const output = path.join(PROMO_DIR, "clips", `${scene.name}.mp4`);
  const ratio = scene.duration / metadata.duration;
  await run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", path.join(frameDirectory, "frames.ffconcat"), "-vf", `setpts=${ratio.toFixed(8)}*PTS,fps=30,scale=1920:1080:flags=lanczos,format=yuv420p`, "-t", String(scene.duration), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", output]);
  clips.push(output);
  console.log(`已合成 ${scene.name}`);
}
const endClip = path.join(PROMO_DIR, "clips", "06-end.mp4");
await run(ffmpeg, ["-y", "-loop", "1", "-i", path.join(PROMO_DIR, "assets", "end.png"), "-t", "5", "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", endClip]);
clips.push(endClip);
const concatPath = path.join(PROMO_DIR, "clips", "all.ffconcat");
await writeFile(concatPath, "ffconcat version 1.0\n" + clips.map((file) => `file '${file.replaceAll("\\", "/")}'`).join("\n") + "\n", "utf8");
const joined = path.join(PROMO_DIR, "clips", "joined.mp4");
await run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", joined]);
const assPath = await writeSubtitles();
const finalPath = path.join(RELEASE_DIR, "BiliScript-promo-1080p.mp4");
const subtitleFilter = `subtitles='${assPath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'")}',fade=t=in:st=0:d=0.3,fade=t=out:st=54.7:d=0.3`;
await run(ffmpeg, ["-y", "-i", joined, "-i", path.join(PROMO_DIR, "assets", "Wholesome.mp3"), "-vf", subtitleFilter, "-af", "volume=0.13,afade=t=in:st=0:d=1,afade=t=out:st=53:d=2", "-t", "55", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-metadata", "title=BiliScript｜B 站视频文摘", finalPath]);
await copyFile(path.join(PROMO_DIR, "assets", "cover.png"), path.join(RELEASE_DIR, "BiliScript-promo-cover.png"));
const credits = `演示视频：复旦赵斌《AI并非越强越好，适配才是关键》\nhttps://www.bilibili.com/video/BV1mAam6tEL8/\n\n音乐：“Wholesome” Kevin MacLeod (incompetech.com)\nhttps://incompetech.com/music/royalty-free/index.html?isrc=USUAN1900022\nLicensed under Creative Commons: By Attribution 4.0 License\nhttps://creativecommons.org/licenses/by/4.0/\n\nBiliScript\nhttps://github.com/Edmund724/BiliScript\n`;
await writeFile(path.join(RELEASE_DIR, "BiliScript-promo-credits.txt"), credits, "utf8");
console.log(`宣传片已输出：${finalPath}`);
