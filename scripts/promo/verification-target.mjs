import path from "node:path";
import {stat} from "node:fs/promises";
import {PROMO_DIR} from "./lib.mjs";
import {PROMO_HEIGHT, PROMO_WIDTH} from "./timeline.mjs";

const USAGE = "用法：pnpm promo:verify -- --kind=draft|final <视频路径>";

export async function resolveVerificationTarget(argv = process.argv.slice(2)) {
  let kind;
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--kind") {
      kind = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--kind=")) {
      kind = arg.slice("--kind=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`未知验收参数：${arg}\n${USAGE}`);
    } else {
      files.push(arg);
    }
  }
  if (!["draft", "final"].includes(kind) || files.length !== 1) throw new Error(USAGE);

  const input = path.resolve(files[0]);
  let inputInfo;
  try {
    inputInfo = await stat(input);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`视频不存在：${input}`);
    throw error;
  }
  if (!inputInfo.isFile()) throw new Error(`视频不是文件：${input}`);

  const scale = kind === "draft" ? 0.5 : 1;
  return {
    kind,
    input,
    inputInfo,
    width: PROMO_WIDTH * scale,
    height: PROMO_HEIGHT * scale,
    evidenceRoot: path.join(PROMO_DIR, "evidence")
  };
}
