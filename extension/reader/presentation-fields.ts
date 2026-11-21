import type { KnownSettingKey } from "../core/defaults.js";
import type { ReaderState } from "../core/state.js";

export type ReaderPresentationFieldKind =
  | "presentation"
  | "enter-flag"
  | "view-flag";

export interface ReaderPresentationTargets {
  html: string | null;
  body: string | null;
  readingView: string | null;
}

export interface ReaderPresentationField {
  id: string;
  kind: ReaderPresentationFieldKind;
  targets: ReaderPresentationTargets;
  datasetKeys: ReaderPresentationTargets;
  storageKey: KnownSettingKey | null;
  legacyStorageKey: KnownSettingKey | null;
  watchedByGuard: boolean;
  clearOnGuard: boolean;
  clearOnClose: boolean;
  clearViewOnClose: boolean;
  writtenByApply: boolean;
  readValue: ((reader: ReaderState) => string) | null;
}

export const READER_PRESENTATION_FIELDS: ReaderPresentationField[] = [
  {
    id: "theme",
    kind: "presentation",
    targets: { html: "data-biliscript-reader-theme", body: "data-biliscript-reader-theme", readingView: "data-theme" },
    datasetKeys: { html: "biliscriptReaderTheme", body: "biliscriptReaderTheme", readingView: "theme" },
    storageKey: "readerTheme",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingTheme
  },
  {
    id: "palette",
    kind: "presentation",
    targets: { html: "data-biliscript-reader-palette", body: "data-biliscript-reader-palette", readingView: "data-palette" },
    datasetKeys: { html: "biliscriptReaderPalette", body: "biliscriptReaderPalette", readingView: "palette" },
    storageKey: "readerPalette",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingPalette
  },
  {
    id: "mode",
    kind: "enter-flag",
    targets: { html: "data-biliscript-reader-mode", body: "data-biliscript-reader-mode", readingView: null },
    datasetKeys: { html: "biliscriptReaderMode", body: "biliscriptReaderMode", readingView: null },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  },
  {
    id: "readingActive",
    kind: "enter-flag",
    targets: { html: null, body: "data-biliscript-reading-active", readingView: null },
    datasetKeys: { html: null, body: "biliscriptReadingActive", readingView: null },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  },
  {
    id: "follow",
    kind: "view-flag",
    targets: { html: null, body: null, readingView: "data-biliscript-reader-follow" },
    datasetKeys: { html: null, body: null, readingView: "biliscriptReaderFollow" },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: false,
    clearOnGuard: false,
    clearOnClose: true,
    clearViewOnClose: true,
    writtenByApply: false,
    readValue: null
  },
  {
    id: "ready",
    kind: "view-flag",
    targets: { html: null, body: null, readingView: "data-biliscript-reader-ready" },
    datasetKeys: { html: null, body: null, readingView: "biliscriptReaderReady" },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: false,
    clearOnGuard: false,
    clearOnClose: false,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  }
];

export const READER_SYNCED_SETTING_KEYS: readonly KnownSettingKey[] = Object.freeze([
  "enablePlayerAiQuickAction",
  "playerAiQuickPrompt",
  "bilingualSubtitles",
  "secondarySubtitleLang",
  "bilingualDisplayOrder",
  "liveInterpretTargetLang",
  "readerFontSizeScale",
  "chatLineHeight",
  "chatParagraphSpacing",
  "speechVoiceVolume",
  "chatInputGlow",
  "reduceTransparency"
]);

export type AttrFlag = "clearOnClose" | "clearOnGuard" | "watchedByGuard";
export type AttrTarget = "html" | "body" | "readingView";

export function collectAttrsByTarget(flag?: AttrFlag): Record<AttrTarget, string[]> {
  const result: Record<AttrTarget, string[]> = { html: [], body: [], readingView: [] };
  for (const field of READER_PRESENTATION_FIELDS) {
    for (const target of ["html", "body", "readingView"] as AttrTarget[]) {
      if (!field.targets[target]) {
        continue;
      }
      if (flag) {
        if (!field[flag]) {
          continue;
        }
        if (target === "readingView" && !field.clearViewOnClose) {
          continue;
        }
      }
      result[target].push(field.targets[target]!);
    }
  }
  return result;
}

export const READER_CLOSE_ATTRS = collectAttrsByTarget("clearOnClose");

export const READER_GUARD_CLEAR_ATTRS = collectAttrsByTarget("clearOnGuard");

export const READER_GUARD_FILTER = collectAttrsByTarget("watchedByGuard");

export const READER_READY_ATTR: string =
  READER_PRESENTATION_FIELDS.find((field) => field.id === "ready")?.targets.readingView ??
  "data-biliscript-reader-ready";

export const READER_APPLY_FIELDS = READER_PRESENTATION_FIELDS.filter(
  (field) => field.writtenByApply
);

export const READER_SETTINGS_WATCH_KEYS: string[] = [
  ...new Set([
    ...READER_PRESENTATION_FIELDS.flatMap(
      (field): (string | null)[] => [field.storageKey, field.legacyStorageKey]
    ).filter((key): key is string => Boolean(key)),
    ...READER_SYNCED_SETTING_KEYS
  ])
];

export const LOCAL_FLAG_ATTRIBUTES = new Set([
  "data-biliscript-reader-hide-sending-bar",
  "data-biliscript-reader-restore"
]);
