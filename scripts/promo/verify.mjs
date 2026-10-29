import path from "node:path";
import {execFileSync} from "node:child_process";
import {REPO_ROOT} from "../browser-harness/harness.mjs";
import {resolveVerificationTarget} from "./verification-target.mjs";

const target = await resolveVerificationTarget();
console.log(`验收产物（${target.kind}）：${target.input}`);
console.log(`期望画面：${target.width}×${target.height}`);

for (const script of ["verify-video.mjs", "verify-audio.mjs", "capture-evidence.mjs"]) {
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "promo", script), `--kind=${target.kind}`, target.input],
    {cwd: REPO_ROOT, stdio: "inherit"}
  );
}
