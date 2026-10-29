import path from "node:path";
import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";

// Remotion 把 Chrome Headless Shell 下载到自己 node_modules/.remotion，每个 worktree 各一份。
// 这里复用主 checkout 的那一份。显式环境变量优先；主缓存不存在时返回 null，
// 让 Remotion 保持默认的自动下载行为。
//
// anchorDir 是执行 git 的工作目录，必须是仓库内路径。不读 import.meta：
// Remotion 把 remotion.config.ts 打包成 CJS 执行，import.meta 在那里是空的。

const ENV_OVERRIDE = "BILISCRIPT_REMOTION_BROWSER_EXECUTABLE";
const HEADLESS_SHELL_DIR = path.join("node_modules", ".remotion", "chrome-headless-shell");

// 与 @remotion/renderer 的 getPlatform() 保持一致
function platformDir(platform) {
  switch (platform) {
    case "darwin":
      return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
    case "linux":
      return process.arch === "arm64" ? "linux-arm64" : "linux64";
    case "win32":
      return "win64";
    default:
      return null;
  }
}

// 与 @remotion/renderer 的 getExecutablePath() 保持一致：Remotion 补丁版优先
function headlessShellPath(checkoutDir) {
  const dir = platformDir(process.platform);
  if (!dir) return null;
  const folder = path.join(checkoutDir, HEADLESS_SHELL_DIR, dir, `chrome-headless-shell-${dir}`);
  const executable = path.join(folder, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
  for (const candidate of [path.join(folder, "headless_shell"), executable]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function mainCheckoutRoot(anchorDir) {
  for (const args of [["--path-format=absolute", "rev-parse", "--git-common-dir"], ["rev-parse", "--git-common-dir"]]) {
    try {
      const output = execFileSync("git", ["-C", anchorDir, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
      const commonDir = path.resolve(anchorDir, output);
      return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
    } catch {}
  }
  return null;
}

export function resolveSharedBrowserExecutable(anchorDir) {
  const override = process.env[ENV_OVERRIDE]?.trim();
  if (override) return override;
  const mainRoot = mainCheckoutRoot(anchorDir);
  return mainRoot ? headlessShellPath(mainRoot) : null;
}
