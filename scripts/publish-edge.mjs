import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE_API_BASE = "https://api.addons.microsoftedge.microsoft.com/v1";
const PARTNER_CENTER_URL = "https://partner.microsoft.com/dashboard/microsoftedge";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 60;

function parseArgs(argv) {
  const opts = { zip: "", notes: "", notesFile: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--zip" && argv[i + 1]) {
      opts.zip = argv[++i];
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

function readVersion() {
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

function extractOperationId(locationHeader) {
  const trimmed = String(locationHeader ?? "").trim();
  if (!trimmed) return "";
  const segments = trimmed.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

async function readResponsePayload(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOperation(url, headers, label) {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const res = await fetch(url, { method: "GET", headers });
    const payload = await readResponsePayload(res);
    if (!res.ok) {
      throw new Error(`${label} status check failed (${res.status}): ${JSON.stringify(payload)}`);
    }
    const status = String(payload?.status ?? "");
    if (status === "Succeeded") {
      return payload;
    }
    if (status === "Failed") {
      throw new Error(`${label} failed: ${JSON.stringify(payload)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const version = readVersion();
  const zipPath = path.resolve(
    opts.zip || path.join(ROOT, "release", `BiliScript-v${version}-Chromium.zip`)
  );

  const productId = (process.env.EDGE_PRODUCT_ID ?? "").trim();
  const clientId = (process.env.EDGE_CLIENT_ID ?? "").trim();
  const apiKey = (process.env.EDGE_API_KEY ?? "").trim();
  const missing = [
    ["EDGE_PRODUCT_ID", productId],
    ["EDGE_CLIENT_ID", clientId],
    ["EDGE_API_KEY", apiKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.log(
      `[publish:edge] 跳过自动提审：缺少环境变量 ${missing.join(", ")}。`
    );
    console.log(
      `[publish:edge] 请手动前往 ${PARTNER_CENTER_URL} 上传 ${zipPath}`
    );
    return;
  }

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Chromium release zip not found: ${zipPath}`);
  }

  const notes = resolveNotes(opts);
  const zipBuffer = fs.readFileSync(zipPath);

  if (opts.dryRun) {
    console.log(
      `[publish:edge] dry-run ok: version=${version}, zip=${zipPath} (${zipBuffer.length} bytes), notesLength=${notes.length}`
    );
    return;
  }

  const authHeaders = {
    Authorization: `ApiKey ${apiKey}`,
    "X-ClientID": clientId,
  };

  console.log(`[publish:edge] Uploading ${path.basename(zipPath)} (${zipBuffer.length} bytes)...`);
  const uploadRes = await fetch(
    `${EDGE_API_BASE}/products/${encodeURIComponent(productId)}/submissions/draft/package`,
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/zip",
      },
      body: zipBuffer,
    }
  );

  if (uploadRes.status !== 202) {
    const payload = await readResponsePayload(uploadRes);
    throw new Error(`Package upload failed (${uploadRes.status}): ${JSON.stringify(payload)}`);
  }

  const uploadOpId = extractOperationId(uploadRes.headers.get("location"));
  if (!uploadOpId) {
    throw new Error("Package upload succeeded (202) but Location header did not contain an operation ID");
  }

  console.log(`[publish:edge] Waiting for package validation (operation ${uploadOpId})...`);
  await pollOperation(
    `${EDGE_API_BASE}/products/${encodeURIComponent(productId)}/submissions/draft/package/operations/${encodeURIComponent(uploadOpId)}`,
    authHeaders,
    "Package upload"
  );

  console.log("[publish:edge] Submitting draft for certification...");
  const publishBody = notes ? { notes } : {};
  const publishRes = await fetch(
    `${EDGE_API_BASE}/products/${encodeURIComponent(productId)}/submissions`,
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(publishBody),
    }
  );

  if (publishRes.status !== 202) {
    const payload = await readResponsePayload(publishRes);
    throw new Error(`Publish submission failed (${publishRes.status}): ${JSON.stringify(payload)}`);
  }

  const publishOpId = extractOperationId(publishRes.headers.get("location"));
  if (publishOpId) {
    console.log(`[publish:edge] Waiting for submission acceptance (operation ${publishOpId})...`);
    await pollOperation(
      `${EDGE_API_BASE}/products/${encodeURIComponent(productId)}/submissions/operations/${encodeURIComponent(publishOpId)}`,
      authHeaders,
      "Publish submission"
    );
  }

  console.log(`[publish:edge] Edge Add-ons v${version} 已提交审核。`);
}

main().catch((err) => {
  console.error(`[publish:edge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
