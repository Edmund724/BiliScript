import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lucideIconsDir = path.join(rootDir, "node_modules", "lucide-static", "icons");
const outPath = path.join(rootDir, "extension", "ui", "ui-icons.generated.ts");

const ICON_SOURCE_MAP = {
  copy: "copy",
  check: "check",
  download: "download",
  play: "play",
  speaker: "volume-2",
  speakerOff: "volume-x",
  stop: "square",
  reset: "rotate-ccw",
  share: "share-2",
  close: "x",
  chevronDown: "chevron-down",
  chevronLeft: "chevron-left",
  chevronRight: "chevron-right",
  arrowLeft: "arrow-left",
  arrowUp: "arrow-up",
  externalLink: "external-link",
  redock: "minimize-2",
  sun: "sun",
  moon: "moon",
  settings: "settings",
  moreVertical: "ellipsis-vertical",
  gripVertical: "grip-vertical",
  newChat: "message-square-plus",
  history: "history",
  mic: "mic",
  micOff: "mic-off",
  minimize: "minus",
  trash: "trash-2",
  expand: "maximize-2",
  lock: "lock",
  bridge: "arrow-left-right",
  sparkle: "sparkle"
};

function extractInnerSvg(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (!match) {
    throw new Error(`Invalid SVG file: ${filePath}`);
  }
  return match[1]
    .replace(/\s*\r?\n\s*/g, "")
    .replace(/>\s+</g, "><")
    .replace(/<([a-zA-Z0-9-]+)([^>]*?)\s*\/>/g, "<$1$2></$1>")
    .trim();
}

function buildGeneratedSource() {
  const entries = Object.entries(ICON_SOURCE_MAP).map(([key, lucideName]) => {
    const svgPath = path.join(lucideIconsDir, `${lucideName}.svg`);
    if (!fs.existsSync(svgPath)) {
      throw new Error(`Missing Lucide icon "${lucideName}" at ${svgPath}`);
    }
    const inner = extractInnerSvg(svgPath);
    return `  ${key}: ${JSON.stringify(inner)}`;
  });

  return [
    "export const UI_ICON_PATHS = {",
    entries.join(",\n"),
    "} as const;",
    "",
    "export type UiIconName = keyof typeof UI_ICON_PATHS;",
    ""
  ].join("\n");
}

const checkOnly = process.argv.includes("--check");
const expected = buildGeneratedSource();

if (checkOnly) {
  if (!fs.existsSync(outPath)) {
    console.error("Missing extension/ui/ui-icons.generated.ts. Run pnpm icons:sync.");
    process.exit(1);
  }
  const actual = fs.readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
  if (actual !== expected) {
    console.error("extension/ui/ui-icons.generated.ts is out of sync. Run pnpm icons:sync.");
    process.exit(1);
  }
  console.log("UI icons are in sync.");
} else {
  fs.writeFileSync(outPath, expected, "utf8");
  console.log(`Synced ${Object.keys(ICON_SOURCE_MAP).length} icons to extension/ui/ui-icons.generated.ts.`);
}
