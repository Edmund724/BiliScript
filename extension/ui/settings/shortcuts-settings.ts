import type { Settings } from "../../core/defaults.js";
import { state } from "../../core/state.js";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTION_IDS,
  countCustomizedShortcuts,
  eventToShortcutCombo,
  findShortcutConflict,
  formatShortcutLabel,
  formatShortcutTokens,
  normalizeShortcuts,
  setShortcutRecordingActive,
  toShortcutOverrides,
  type ShortcutActionId,
  type ShortcutBindings
} from "../../shared/shortcuts.js";
import { escapeHtml } from "../../shared/string-utils.js";
import { renderUiIcon } from "../icon-registry.js";
import { READING_RESET_ICON } from "../reading-icons.js";
import { SETTINGS_PANEL_DOM_IDS } from "./dom-ids.js";
import { setStatus, type SettingsElements } from "./elements.js";

export interface ShortcutGroupSpec {
  readonly id: string;
  readonly title: string;
  readonly showResetAll?: boolean;
  readonly items: ReadonlyArray<{ readonly id: ShortcutActionId; readonly label: string }>;
}

export const SHORTCUT_GROUPS: readonly ShortcutGroupSpec[] = Object.freeze([
  {
    id: "shortcuts-global",
    title: "全局入口",
    showResetAll: true,
    items: [
      { id: "toggleReader", label: "展开或收起文摘侧边栏" },
      { id: "generateOverview", label: "展开并生成视频概览" }
    ]
  },
  {
    id: "shortcuts-reader",
    title: "阅读器导航",
    items: [
      { id: "commandPalette", label: "打开或关闭命令面板" },
      { id: "subtitleSearch", label: "聚焦字幕搜索框" },
      { id: "openSettings", label: "打开或关闭设置" },
      { id: "toggleTheme", label: "切换浅色/深色主题" },
      { id: "toggleDetachedWindow", label: "切换独立窗口/停靠" }
    ]
  },
  {
    id: "shortcuts-notes",
    title: "笔记与摘要",
    items: [
      { id: "generateVideoNote", label: "生成视频笔记" },
      { id: "copyNote", label: "复制模板笔记（Markdown）" },
      { id: "downloadNote", label: "下载 Markdown 笔记" },
      { id: "exportObsidian", label: "写入 Obsidian 笔记" }
    ]
  }
]);

const ACTION_LABEL_MAP: Readonly<Record<ShortcutActionId, string>> = Object.freeze(
  Object.fromEntries(
    SHORTCUT_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label]))
  ) as Record<ShortcutActionId, string>
);

const CLEAR_ICON_SVG = renderUiIcon("close", { size: 14 });

export function buildShortcutsSubpageHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  const groupsHtml = SHORTCUT_GROUPS.map((group) => {
    const headerHtml = group.showResetAll
      ? `        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">${escapeHtml(group.title)}</div>
          <button id="${ids.shortcutsResetAllBtn}" class="add-property-btn" type="button" hidden>全部恢复默认</button>
        </div>`
      : `        <div class="biliscript-set-h">${escapeHtml(group.title)}</div>`;
    const rowsHtml = group.items
      .map(
        (item) => `          <div class="biliscript-set-row biliscript-shortcut-row" data-shortcut-action="${item.id}">
            <span class="biliscript-set-label">${escapeHtml(item.label)}</span>
            <div class="biliscript-shortcut-controls">
              <button
                type="button"
                class="biliscript-shortcut-key-btn"
                data-shortcut-record="${item.id}"
                aria-pressed="false"
                aria-label="${escapeHtml(item.label)}快捷键：未设置"
              ></button>
              <button
                type="button"
                class="biliscript-shortcut-action-btn"
                data-shortcut-clear="${item.id}"
                title="清空快捷键"
                aria-label="清空${escapeHtml(item.label)}快捷键"
                hidden
              >${CLEAR_ICON_SVG}</button>
              <button
                type="button"
                class="biliscript-shortcut-action-btn"
                data-shortcut-reset="${item.id}"
                title="恢复默认"
                aria-label="恢复${escapeHtml(item.label)}默认快捷键"
                hidden
              >${READING_RESET_ICON}</button>
            </div>
          </div>`
      )
      .join("\n");
    return `      <section class="biliscript-set-group" data-settings-section="${group.id}">
${headerHtml}
        <div class="biliscript-set-card">
${rowsHtml}
        </div>
      </section>`;
  }).join("\n\n");

  return `    <div id="${ids.subpageShortcuts}" class="biliscript-settings-view" hidden>
${groupsHtml}
    </div>`;
}

export interface ShortcutsSettingsController {
  sync(settings: Settings): void;
  applyStorageChanges(changes: Record<string, chrome.storage.StorageChange>): void;
  getBindings(): ShortcutBindings;
  cancelRecording(options?: { restoreFocus?: boolean }): void;
  dispose(): void;
}

export interface ShortcutsSettingsDeps {
  savePatch: (elements: SettingsElements, patch: Record<string, unknown>) => Promise<boolean>;
  syncSummaries: () => void;
}

function renderKeyButtonContent(
  button: HTMLButtonElement,
  actionId: ShortcutActionId,
  combo: string,
  recording: boolean
): void {
  const label = ACTION_LABEL_MAP[actionId];
  button.setAttribute("aria-pressed", recording ? "true" : "false");
  if (recording) {
    button.dataset.recording = "1";
    button.dataset.empty = "0";
    button.textContent = "按下快捷键…";
    button.setAttribute("aria-label", `正在录制${label}快捷键，按 Esc 取消，按 Backspace 清空`);
    return;
  }
  delete button.dataset.recording;
  const tokens = formatShortcutTokens(combo);
  if (tokens.length === 0) {
    button.dataset.empty = "1";
    button.textContent = "未设置";
    button.setAttribute("aria-label", `${label}快捷键：未设置`);
    return;
  }
  button.dataset.empty = "0";
  button.innerHTML = tokens
    .map((token) => `<kbd class="biliscript-shortcut-kbd">${escapeHtml(token)}</kbd>`)
    .join("");
  button.setAttribute("aria-label", `${label}快捷键：${formatShortcutLabel(combo)}`);
}

export function bindShortcutsSettings(
  host: HTMLElement,
  elements: SettingsElements,
  deps: ShortcutsSettingsDeps
): ShortcutsSettingsController {
  let bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
  let recordingAction: ShortcutActionId | null = null;
  let boundDoc: Document | null = null;
  let boundWin: Window | null = null;

  const keyButtons = new Map<ShortcutActionId, HTMLButtonElement>();
  const clearButtons = new Map<ShortcutActionId, HTMLButtonElement>();
  const resetButtons = new Map<ShortcutActionId, HTMLButtonElement>();

  for (const id of SHORTCUT_ACTION_IDS) {
    const keyBtn = elements.subpageShortcuts.querySelector<HTMLButtonElement>(`[data-shortcut-record="${id}"]`);
    const clearBtn = elements.subpageShortcuts.querySelector<HTMLButtonElement>(`[data-shortcut-clear="${id}"]`);
    const resetBtn = elements.subpageShortcuts.querySelector<HTMLButtonElement>(`[data-shortcut-reset="${id}"]`);
    if (keyBtn) keyButtons.set(id, keyBtn);
    if (clearBtn) clearButtons.set(id, clearBtn);
    if (resetBtn) resetButtons.set(id, resetBtn);
  }

  function syncOverviewHint(): void {
    const combo = bindings.generateOverview;
    if (!combo) {
      elements.overviewShortcutHint.hidden = true;
      return;
    }
    elements.overviewShortcutHint.hidden = false;
    elements.overviewShortcutHint.textContent = `快捷键 ${formatShortcutLabel(combo)} 可随时展开并生成当前视频概览，可在设置「快捷键」中修改。`;
  }

  function renderAllRows(): void {
    for (const id of SHORTCUT_ACTION_IDS) {
      const combo = bindings[id];
      const keyBtn = keyButtons.get(id);
      if (keyBtn) {
        renderKeyButtonContent(keyBtn, id, combo, recordingAction === id);
      }
      const clearBtn = clearButtons.get(id);
      if (clearBtn) {
        clearBtn.hidden = !combo;
      }
      const resetBtn = resetButtons.get(id);
      if (resetBtn) {
        resetBtn.hidden = combo === DEFAULT_SHORTCUTS[id];
      }
    }
    elements.shortcutsResetAllBtn.hidden = countCustomizedShortcuts(bindings) === 0;
    syncOverviewHint();
  }

  function detachRecordingListeners(): void {
    if (boundDoc) {
      try {
        boundDoc.removeEventListener("keydown", onRecordingKeyDown, true);
        boundDoc.removeEventListener("pointerdown", onRecordingPointerDown, true);
      } catch {}
    }
    if (boundWin) {
      try {
        boundWin.removeEventListener("blur", onRecordingBlur);
      } catch {}
    }
    boundDoc = null;
    boundWin = null;
  }

  function stopRecording(options: { restoreFocus?: boolean } = {}): void {
    const prevAction = recordingAction;
    if (!prevAction) {
      return;
    }
    recordingAction = null;
    setShortcutRecordingActive(false);
    detachRecordingListeners();
    renderAllRows();
    if (options.restoreFocus) {
      keyButtons.get(prevAction)?.focus({ preventScroll: true });
    }
  }

  async function commitBindings(next: ShortcutBindings): Promise<boolean> {
    const normalized = normalizeShortcuts(next);
    const overrides = toShortcutOverrides(normalized);
    const prev = bindings;
    bindings = normalized;
    state.patchSettings({ shortcuts: { ...overrides } });
    renderAllRows();
    deps.syncSummaries();
    const ok = await deps.savePatch(elements, { shortcuts: { ...overrides } });
    if (!ok) {
      bindings = prev;
      state.patchSettings({ shortcuts: { ...toShortcutOverrides(prev) } });
      renderAllRows();
      deps.syncSummaries();
    }
    return ok;
  }

  function onRecordingKeyDown(event: KeyboardEvent): void {
    const actionId = recordingAction;
    if (!actionId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const captured = eventToShortcutCombo(event);
    if (captured.status === "ignore") {
      return;
    }
    if (captured.status === "cancel") {
      stopRecording({ restoreFocus: true });
      return;
    }
    if (captured.status === "clear") {
      stopRecording({ restoreFocus: true });
      if (bindings[actionId] !== "") {
        void commitBindings({ ...bindings, [actionId]: "" });
      }
      return;
    }
    if (captured.status === "invalid") {
      setStatus(elements, captured.reason, true);
      return;
    }
    const conflictId = findShortcutConflict(bindings, actionId, captured.combo);
    if (conflictId) {
      setStatus(elements, `与「${ACTION_LABEL_MAP[conflictId]}」冲突，请更换按键`, true);
      return;
    }
    stopRecording({ restoreFocus: true });
    if (bindings[actionId] !== captured.combo) {
      void commitBindings({ ...bindings, [actionId]: captured.combo });
    }
  }

  function onRecordingPointerDown(event: PointerEvent): void {
    const actionId = recordingAction;
    if (!actionId) {
      return;
    }
    const keyBtn = keyButtons.get(actionId);
    if (keyBtn && keyBtn.contains(event.target as Node | null)) {
      return;
    }
    stopRecording({ restoreFocus: false });
  }

  function onRecordingBlur(): void {
    stopRecording({ restoreFocus: false });
  }

  function startRecording(actionId: ShortcutActionId): void {
    if (recordingAction === actionId) {
      stopRecording({ restoreFocus: true });
      return;
    }
    stopRecording({ restoreFocus: false });
    recordingAction = actionId;
    setShortcutRecordingActive(true);
    boundDoc = host.ownerDocument;
    boundWin = boundDoc.defaultView;
    boundDoc.addEventListener("keydown", onRecordingKeyDown, true);
    boundDoc.addEventListener("pointerdown", onRecordingPointerDown, true);
    boundWin?.addEventListener("blur", onRecordingBlur);
    renderAllRows();
    keyButtons.get(actionId)?.focus({ preventScroll: true });
  }

  const onSubpageClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    const recordBtn = target.closest<HTMLButtonElement>("[data-shortcut-record]");
    if (recordBtn) {
      const actionId = recordBtn.dataset.shortcutRecord as ShortcutActionId | undefined;
      if (actionId && SHORTCUT_ACTION_IDS.includes(actionId)) {
        startRecording(actionId);
      }
      return;
    }
    const clearBtn = target.closest<HTMLButtonElement>("[data-shortcut-clear]");
    if (clearBtn) {
      const actionId = clearBtn.dataset.shortcutClear as ShortcutActionId | undefined;
      if (actionId && SHORTCUT_ACTION_IDS.includes(actionId)) {
        stopRecording({ restoreFocus: false });
        if (bindings[actionId] !== "") {
          void commitBindings({ ...bindings, [actionId]: "" });
        }
        keyButtons.get(actionId)?.focus({ preventScroll: true });
      }
      return;
    }
    const resetBtn = target.closest<HTMLButtonElement>("[data-shortcut-reset]");
    if (resetBtn) {
      const actionId = resetBtn.dataset.shortcutReset as ShortcutActionId | undefined;
      if (actionId && SHORTCUT_ACTION_IDS.includes(actionId)) {
        stopRecording({ restoreFocus: false });
        const defaultCombo = DEFAULT_SHORTCUTS[actionId];
        const conflictId = findShortcutConflict(bindings, actionId, defaultCombo);
        if (conflictId) {
          setStatus(elements, `默认按键与「${ACTION_LABEL_MAP[conflictId]}」冲突，请先修改该项`, true);
          return;
        }
        if (bindings[actionId] !== defaultCombo) {
          void commitBindings({ ...bindings, [actionId]: defaultCombo });
        }
        keyButtons.get(actionId)?.focus({ preventScroll: true });
      }
    }
  };

  const onResetAllClick = (): void => {
    stopRecording({ restoreFocus: false });
    if (countCustomizedShortcuts(bindings) === 0) {
      return;
    }
    void commitBindings({ ...DEFAULT_SHORTCUTS });
  };

  elements.subpageShortcuts.addEventListener("click", onSubpageClick);
  elements.shortcutsResetAllBtn.addEventListener("click", onResetAllClick);
  renderAllRows();

  return {
    sync(settings: Settings): void {
      bindings = normalizeShortcuts(settings.shortcuts);
      renderAllRows();
    },
    applyStorageChanges(changes: Record<string, chrome.storage.StorageChange>): void {
      if (!changes.shortcuts) {
        return;
      }
      bindings = normalizeShortcuts(changes.shortcuts.newValue);
      renderAllRows();
    },
    getBindings(): ShortcutBindings {
      return { ...bindings };
    },
    cancelRecording(options?: { restoreFocus?: boolean }): void {
      stopRecording(options);
    },
    dispose(): void {
      stopRecording({ restoreFocus: false });
      elements.subpageShortcuts.removeEventListener("click", onSubpageClick);
      elements.shortcutsResetAllBtn.removeEventListener("click", onResetAllClick);
    }
  };
}
