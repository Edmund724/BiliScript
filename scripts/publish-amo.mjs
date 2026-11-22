import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AMO_DEV_HUB_URL = "https://addons.mozilla.org/developers/";
const DEFAULT_APPROVAL_NOTES =
  "See BUILD_AMO.md inside the uploaded source archive for deterministic build reproduction (Node 22+, pnpm 12.x: pnpm install --frozen-lockfile && pnpm build:firefox).";

function parseArgs(argv) {
  const opts = {
    sourceDir: "",
    sourceZip: "",
    notes: "",
    notesFile: "",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--source-dir" && argv[i + 1]) {
      opts.sourceDir = argv[++i];
    } else if (arg === "--source-zip" && argv[i + 1]) {
      opts.sourceZip = argv[++i];
    } else if (arg === "--notes" && argv[i + 1]) {
      opts.notes = argv[++i];
    } else if (arg === "--notes-file" && argv[i + 1]) {
      opts.notesFile = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

function readPackageVersion() {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const version = String(pkg.version ?? "").trim();
  if (!version) throw new Error("package.json is missing version");
  return version;
}

function resolveNotes(opts) {
  if (opts.notesFile) {
    return fs.readFileSync(path.resolve(opts.notesFile), "utf8").trim();
  }
  return opts.notes.trim();
}

function validateArtifacts(sourceDir, sourceZip, expectedVersion) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Firefox build manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const actualVersion = String(manifest.version ?? "").trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Version mismatch in ${manifestPath}: found ${actualVersion}, expected ${expectedVersion}`
    );
  }
  if (!fs.existsSync(sourceZip)) {
    throw new Error(`AMO source archive not found: ${sourceZip}`);
  }
}

function buildMetadata(notes) {
  const versionMeta = {
    approval_notes: DEFAULT_APPROVAL_NOTES,
  };
  if (notes) {
    versionMeta.release_notes = { "zh-CN": notes };
  }
  return { version: versionMeta };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const version = readPackageVersion();
  const sourceDir = path.resolve(opts.sourceDir || path.join(ROOT, "dist-firefox"));
  const sourceZip = path.resolve(
    opts.sourceZip || path.join(ROOT, "release", `BiliScript-v${version}-Source.zip`)
  );
  const firefoxZip = path.join(ROOT, "release", `BiliScript-v${version}-Firefox.zip`);

  const apiKey = (process.env.WEB_EXT_API_KEY ?? "").trim();
  const apiSecret = (process.env.WEB_EXT_API_SECRET ?? "").trim();
  const missing = [
    ["WEB_EXT_API_KEY", apiKey],
    ["WEB_EXT_API_SECRET", apiSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.log(`[publish:amo] 跳过自动提审：缺少环境变量 ${missing.join(", ")}。`);
    console.log(
      `[publish:amo] 请手动前往 ${AMO_DEV_HUB_URL} 上传 ${firefoxZip} 与 ${sourceZip}`
    );
    return;
  }

  validateArtifacts(sourceDir, sourceZip, version);
  const notes = resolveNotes(opts);

  if (opts.dryRun) {
    console.log(
      `[publish:amo] dry-run ok: version=${version}, sourceDir=${sourceDir}, sourceZip=${sourceZip}, notesLength=${notes.length}`
    );
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "biliscript-amo-"));
  const metadataPath = path.join(tmpDir, "amo-metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(buildMetadata(notes), null, 2), "utf8");

  try {
    const args = [
      "dlx",
      "web-ext",
      "sign",
      "--no-input",
      "--channel=listed",
      "--source-dir",
      sourceDir,
      "--artifacts-dir",
      tmpDir,
      "--ignore-files",
      "**/*.map",
      "--upload-source-code",
      sourceZip,
      "--amo-metadata",
      metadataPath,
      "--approval-timeout",
      "0",
    ];
    console.log(`[publish:amo] Submitting Firefox v${version} + Source archive to AMO...`);
    const result = spawnSync("pnpm", args, {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    console.log(`[publish:amo] Firefox AMO v${version} 已提交审核。`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`[publish:amo] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
