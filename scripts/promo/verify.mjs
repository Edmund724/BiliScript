import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {resolveVerificationTarget} from "./verification-target.mjs";

const execFileAsync = promisify(execFile);
const target = await resolveVerificationTarget();
console.log(`验收产物（${target.kind}）：${target.input}`);
console.log(`期望画面：${target.width}×${target.height}`);

// 三个子脚本只读同一个成片、各写各的证据目录，可以同时跑。
const scripts = ["verify-video.mjs", "verify-audio.mjs", "capture-evidence.mjs"];
const results = await Promise.allSettled(
  scripts.map((script) =>
    execFileAsync(process.execPath, [path.join(REPO_ROOT, "scripts", "promo", script), `--kind=${target.kind}`, target.input], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024
    })
  )
);

let failed = false;
for (const [index, result] of results.entries()) {
  if (result.status === "fulfilled") {
    if (result.value.stdout) process.stdout.write(result.value.stdout);
    if (result.value.stderr) process.stderr.write(result.value.stderr);
    continue;
  }
  failed = true;
  console.error(`\n${scripts[index]} 失败：`);
  if (result.reason?.stdout) process.stdout.write(result.reason.stdout);
  if (result.reason?.stderr) process.stderr.write(result.reason.stderr);
  console.error(result.reason?.message ?? String(result.reason));
}
if (failed) process.exitCode = 1;
