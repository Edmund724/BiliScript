import { state } from "../core/state.js";
import {
  activeById,
  getActiveReaderDocument,
  onActiveHostChange,
} from "../shared/active-host.js";
import { resolveNodeDocument, safeRemoveListener } from "../shared/cross-doc.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { formatClock } from "../shared/clock-text.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import { shouldShowHoursInNote } from "../notes/section-lines.js";
import {
  copyCurrentVideoNote,
  downloadCurrentVideoNote,
  openCurrentVideoInObsidian
} from "../notes/export-actions.js";
import {
  normalizeThinkingLevel,
  type ThinkingLevelValue
} from "../ai/thinking-levels.js";
import { ids, isReaderViewOpen } from "./state.js";
import { activateScriptTab } from "./script-tab-activation.js";
import { requestUiCommand } from "./reader-bus.js";
import { jumpReadingTarget } from "./sync.js";
import { ensureReaderShell } from "./lazy-shell.js";
import { ensureReaderDomain } from "./lazy-reader.js";
import { isReaderChatTabLoaded } from "./lazy-chat-tab.js";

const THINKING_LEVEL_LOCAL_KEY = "biliscript_ai_thinking_level";
const COMMAND_PALETTE_ID = "biliscript-command-palette";
const MAX_SUBTITLE_MATCHES = 8;

export interface CommandPaletteItem {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  kbd?: string[];
  badge?: string;
  run: () => void | Promise<void | string>;
}

const THINKING_CHOICES: ReadonlyArray<{
  level: ThinkingLevelValue;
  label: string;
  keywords: string;
}> = [
  { level: "default", label: "默认（由平台决定）", keywords: "default thinking auto 思考 强度 默认" },
  { level: "off", label: "关闭思考", keywords: "off none disable thinking 思考 关闭" },
  { level: "low", label: "低强度思考", keywords: "low thinking 思考 强度 低" },
  { level: "medium", label: "中强度思考", keywords: "medium thinking 思考 强度 中" },
  { level: "high", label: "高强度思考", keywords: "high thinking 思考 强度 高" },
  { level: "max", label: "最高强度思考", keywords: "max xhigh ultra thinking 思考 强度 最高" }
];

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function parseTimestampQuery(raw: string): number | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return null;
  }
  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colonMatch) {
    if (colonMatch[3] !== undefined) {
      const h = Number(colonMatch[1]);
      const m = Number(colonMatch[2]);
      const s = Number(colonMatch[3]);
      if (m < 60 && s < 60) {
        return h * 3600 + m * 60 + s;
      }
      return null;
    }
    const m = Number(colonMatch[1]);
    const s = Number(colonMatch[2]);
    if (s < 60) {
      return m * 60 + s;
    }
    return null;
  }
  const secMatch = trimmed.match(/^(\d{1,5})(?:s|S|秒)$/);
  if (secMatch) {
    return Number(secMatch[1]);
  }
  return null;
}

export function scoreFuzzyMatch(query: string, ...fields: Array<string | undefined>): number {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return 1;
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const haystack = fields
    .map((f) => String(f || "").toLowerCase())
    .join(" ");
  if (!haystack) {
    return 0;
  }

  let totalScore = 0;
  for (const token of tokens) {
    const directIdx = haystack.indexOf(token);
    if (directIdx !== -1) {
      totalScore += 100 - Math.min(directIdx, 80);
      continue;
    }
    let hi = 0;
    let matched = 0;
    let streak = 0;
    let bonus = 0;
    for (let ti = 0; ti < token.length; ti += 1) {
      const ch = token[ti];
      const found = haystack.indexOf(ch, hi);
      if (found === -1) {
        return 0;
      }
      if (found === hi) {
        streak += 1;
        bonus += streak * 3;
      } else {
        streak = 0;
      }
      hi = found + 1;
      matched += 1;
    }
    if (matched === token.length) {
      totalScore += 20 + bonus;
    }
  }
  return totalScore;
}

async function applyThinkingLevel(level: ThinkingLevelValue): Promise<string> {
  const normalized = normalizeThinkingLevel(level);
  state.patchSettings({ aiThinkingLevel: normalized });
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    await chrome.storage.local.set({ [THINKING_LEVEL_LOCAL_KEY]: normalized }).catch(() => {});
  }
  await sendRuntimeMessage({
    type: "save-settings",
    settings: { aiThinkingLevel: normalized }
  }).catch(() => null);
  if (isReaderChatTabLoaded()) {
    const chatStateMod = await import("../chat/chat-state.js").catch(() => null);
    chatStateMod?.setAiThinkingLevel(normalized);
  }
  const choice = THINKING_CHOICES.find((c) => c.level === normalized);
  return `思考强度已切换为：${choice?.label ?? normalized}`;
}

async function jumpToSubtitleTime(seconds: number): Promise<void> {
  await activateScriptTab("subtitle", { consumeIntent: false });
  jumpReadingTarget(seconds);
}

function buildStaticCommands(): CommandPaletteItem[] {
  const mod = modKeyLabel();
  const currentThinking = normalizeThinkingLevel(state.settings?.aiThinkingLevel);
  const currentTheme = state.reader.readingTheme === "dark" ? "dark" : "light";

  const commands: CommandPaletteItem[] = [
    {
      id: "overview-generate",
      group: "AI 与摘要",
      title: "生成章节摘要",
      subtitle: "切换到概览并生成视频章节与金句摘要",
      keywords: "overview summary chapter 概览 章节 摘要 总结",
      kbd: ["O"],
      run: async () => {
        await activateScriptTab("overview", { consumeIntent: false });
        const reader = await ensureReaderDomain();
        void reader.triggerReaderOverviewGeneration({ forceRefresh: false });
      }
    },
    {
      id: "overview-refresh",
      group: "AI 与摘要",
      title: "重新生成章节摘要",
      subtitle: "忽略缓存，重新生成当前视频章节摘要",
      keywords: "overview refresh regenerate 重新 生成 章节 摘要",
      run: async () => {
        await activateScriptTab("overview", { consumeIntent: false });
        const reader = await ensureReaderDomain();
        void reader.triggerReaderOverviewGeneration({ forceRefresh: true });
      }
    },
    {
      id: "subtitle-focus-search",
      group: "字幕跳转",
      title: "搜索并跳转字幕",
      subtitle: "聚焦字幕搜索框，或直接在此输入关键词 / 时间戳",
      keywords: "subtitle search jump seek 字幕 搜索 跳转",
      kbd: [mod, "F"],
      run: async () => {
        await activateScriptTab("subtitle", { consumeIntent: false });
        const input = activeById<HTMLInputElement>(ids.readingSearchInput);
        input?.focus({ preventScroll: true });
        input?.select();
      }
    },
    {
      id: "note-copy",
      group: "笔记导出",
      title: "复制模板笔记（Markdown）",
      subtitle: "按自定义模板渲染并复制当前视频笔记",
      keywords: "export note markdown copy 导出 笔记 复制 模板",
      kbd: ["M"],
      run: async () => {
        const ok = await copyCurrentVideoNote();
        return ok ? "已复制模板笔记" : "复制失败：请检查剪贴板权限";
      }
    },
    {
      id: "note-download",
      group: "笔记导出",
      title: "下载 Markdown 笔记（.md）",
      subtitle: "按自定义模板导出当前视频为 .md 文件",
      keywords: "export note markdown download file 下载 导出 笔记",
      run: async () => {
        const ok = await downloadCurrentVideoNote();
        return ok ? "已导出 Markdown 文件" : "导出失败：当前暂无内容";
      }
    },
    {
      id: "note-obsidian",
      group: "笔记导出",
      title: "写入 Obsidian 笔记",
      subtitle: "通过 obsidian:// URI 创建笔记（超长自动走剪贴板回退）",
      keywords: "obsidian uri clipper vault 导出 写入 笔记",
      kbd: ["Shift", "O"],
      run: async () => {
        const res = await openCurrentVideoInObsidian();
        if (!res.ok) {
          return res.error || "唤起 Obsidian 失败";
        }
        return res.usedClipboardFallback
          ? "笔记较长，已复制并唤起 Obsidian"
          : "已唤起 Obsidian 写入笔记";
      }
    },
    {
      id: "note-template-settings",
      group: "笔记导出",
      title: "编辑笔记导出模板与 Obsidian 配置",
      subtitle: "打开设置页中的 Markdown 模板编辑器",
      keywords: "template obsidian settings 模板 设置 笔记 导出",
      run: () => {
        requestUiCommand("open-settings", { target: "note-export" });
      }
    },
    ...THINKING_CHOICES.map((choice): CommandPaletteItem => ({
      id: `thinking-${choice.level}`,
      group: "思考强度",
      title: `切换思考强度：${choice.label}`,
      keywords: choice.keywords,
      badge: currentThinking === choice.level ? "当前" : undefined,
      kbd: [choice.level],
      run: () => applyThinkingLevel(choice.level)
    })),
    {
      id: "open-settings",
      group: "界面与设置",
      title: "打开设置",
      subtitle: "配置模型平台、字幕翻译、导出模板与外观",
      keywords: "settings preferences options config 设置 偏好 配置",
      kbd: [","],
      run: () => {
        requestUiCommand("open-settings");
      }
    },
    {
      id: "toggle-theme",
      group: "界面与设置",
      title: currentTheme === "dark" ? "切换为浅色主题" : "切换为深色主题",
      keywords: "theme dark light 主题 深色 浅色 外观",
      run: async () => {
        const next = currentTheme === "dark" ? "light" : "dark";
        const reader = await ensureReaderDomain();
        reader.updateReaderPreferences({ readerTheme: next }, { persist: true });
      }
    },
    {
      id: "toggle-reader",
      group: "界面与设置",
      title: "收起文摘侧边栏",
      keywords: "close exit hide reader sidebar 关闭 收起 退出 侧边栏",
      kbd: ["Alt", "B"],
      run: async () => {
        const shell = await ensureReaderShell();
        await shell.exitReaderShell();
      }
    }
  ];

  return commands;
}

function buildDynamicJumpCommands(query: string): CommandPaletteItem[] {
  const results: CommandPaletteItem[] = [];
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  const chapters = normalizeChapters(state.clip.chapters || []);
  const hours = shouldShowHoursInNote(state.clip, body) ? "always" : "never";
  const trimmed = String(query || "").trim();

  const parsedSec = parseTimestampQuery(trimmed);
  if (parsedSec !== null) {
    const stamp = formatClock(parsedSec, { hours });
    results.push({
      id: `jump-time-${parsedSec}`,
      group: "跳转指定时间",
      title: `跳转到 ${stamp}`,
      subtitle: "切换至字幕并跳转播放器进度",
      kbd: [stamp],
      run: () => jumpToSubtitleTime(parsedSec)
    });
  }

  if (!trimmed) {
    chapters.slice(0, 3).forEach((ch, idx) => {
      const stamp = formatClock(ch.from, { hours });
      results.push({
        id: `jump-chapter-${idx}`,
        group: "章节直达",
        title: ch.title,
        subtitle: "跳转到该章节起始字幕",
        kbd: [stamp],
        run: () => jumpToSubtitleTime(ch.from)
      });
    });
    return results;
  }

  for (let i = 0; i < chapters.length; i += 1) {
    const ch = chapters[i];
    const score = scoreFuzzyMatch(trimmed, ch.title);
    if (score > 0) {
      const stamp = formatClock(ch.from, { hours });
      results.push({
        id: `jump-chapter-match-${i}`,
        group: "跳转章节 / 字幕",
        title: ch.title,
        subtitle: "章节",
        kbd: [stamp],
        run: () => jumpToSubtitleTime(ch.from)
      });
    }
  }

  if (body.length > 0 && trimmed.length >= 1) {
    const matchedSubtitles: Array<{ idx: number; from: number; text: string; score: number }> = [];
    for (let i = 0; i < body.length; i += 1) {
      const text = String(body[i]?.content || "").trim();
      if (!text) continue;
      const score = scoreFuzzyMatch(trimmed, text);
      if (score > 0) {
        matchedSubtitles.push({
          idx: i,
          from: Number(body[i]?.from) || 0,
          text,
          score
        });
      }
    }
    matchedSubtitles.sort((a, b) => b.score - a.score || a.idx - b.idx);
    for (const item of matchedSubtitles.slice(0, MAX_SUBTITLE_MATCHES)) {
      const stamp = formatClock(item.from, { hours });
      results.push({
        id: `jump-sub-${item.idx}`,
        group: "跳转字幕",
        title: item.text,
        kbd: [stamp],
        run: () => jumpToSubtitleTime(item.from)
      });
    }
  }

  return results;
}

export function resolveCommandPaletteItems(query: string): CommandPaletteItem[] {
  const trimmed = String(query || "").trim();
  const staticItems = buildStaticCommands();
  const dynamicItems = buildDynamicJumpCommands(trimmed);

  if (!trimmed) {
    return [...staticItems, ...dynamicItems];
  }

  const scoredStatic = staticItems
    .map((item) => ({
      item,
      score: scoreFuzzyMatch(trimmed, item.title, item.subtitle, item.keywords, item.group)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);

  return [...dynamicItems, ...scoredStatic];
}

interface PaletteRuntime {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  list: HTMLElement;
  statusEl: HTMLElement;
  items: CommandPaletteItem[];
  activeIndex: number;
  statusTimer: ReturnType<typeof setTimeout> | null;
}

let runtime: PaletteRuntime | null = null;
let fallbackEscBound = false;

function isNativeModalDialog(dialog: HTMLDialogElement): boolean {
  return typeof dialog.showModal === "function";
}

function isDialogOpen(dialog: HTMLDialogElement | null | undefined): boolean {
  if (!dialog) {
    return false;
  }
  try {
    return Boolean(dialog.open || dialog.hasAttribute("open"));
  } catch {
    return false;
  }
}

function onFallbackEscKeyDown(event: KeyboardEvent): void {
  if (!runtime || !isDialogOpen(runtime.dialog)) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeCommandPalette();
  }
}

function renderList(rt: PaletteRuntime): void {
  const { list, items, activeIndex } = rt;
  if (items.length === 0) {
    list.innerHTML = `<div class="biliscript-cmd-empty">未找到匹配的命令或字幕</div>`;
    rt.input.removeAttribute("aria-activedescendant");
    return;
  }

  const parts: string[] = [];
  let lastGroup = "";
  items.forEach((item, idx) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      parts.push(`<div class="biliscript-cmd-group" role="presentation">${escapeHtml(item.group)}</div>`);
    }
    const isActive = idx === activeIndex;
    const optionId = `${COMMAND_PALETTE_ID}-opt-${idx}`;
    const kbdHtml =
      item.kbd && item.kbd.length > 0
        ? `<span class="biliscript-cmd-kbds" aria-hidden="true">${item.kbd
            .map((key) => `<kbd class="biliscript-cmd-kbd">${escapeHtml(key)}</kbd>`)
            .join("")}</span>`
        : "";
    const badgeHtml = item.badge
      ? `<span class="biliscript-cmd-badge">${escapeHtml(item.badge)}</span>`
      : "";
    const subHtml = item.subtitle
      ? `<span class="biliscript-cmd-item-sub">${escapeHtml(item.subtitle)}</span>`
      : "";
    parts.push(
      `<button id="${optionId}" type="button" role="option" aria-selected="${isActive ? "true" : "false"}"` +
        ` class="biliscript-cmd-item${isActive ? " is-active" : ""}" data-cmd-index="${idx}">` +
        `<span class="biliscript-cmd-item-copy">` +
        `<span class="biliscript-cmd-item-title">${escapeHtml(item.title)}</span>` +
        subHtml +
        `</span>` +
        `<span class="biliscript-cmd-item-meta">${badgeHtml}${kbdHtml}</span>` +
        `</button>`
    );
  });

  list.innerHTML = parts.join("");
  const activeOptionId = `${COMMAND_PALETTE_ID}-opt-${activeIndex}`;
  rt.input.setAttribute("aria-activedescendant", activeOptionId);
}

function setActiveIndex(rt: PaletteRuntime, nextIndex: number): void {
  if (rt.items.length === 0) {
    rt.activeIndex = -1;
    rt.input.removeAttribute("aria-activedescendant");
    return;
  }
  const len = rt.items.length;
  const wrapped = ((nextIndex % len) + len) % len;
  rt.activeIndex = wrapped;

  const buttons = rt.list.querySelectorAll<HTMLButtonElement>(".biliscript-cmd-item");
  buttons.forEach((btn, idx) => {
    const active = idx === wrapped;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    if (active) {
      rt.input.setAttribute("aria-activedescendant", btn.id);
      btn.scrollIntoView?.({ block: "nearest" });
    }
  });
}

function showPaletteStatus(rt: PaletteRuntime, message: string): void {
  if (rt.statusTimer !== null) {
    clearTimeout(rt.statusTimer);
    rt.statusTimer = null;
  }
  rt.statusEl.textContent = message;
  rt.statusEl.hidden = !message;
}

async function executeActiveItem(rt: PaletteRuntime, index: number): Promise<void> {
  const item = rt.items[index];
  if (!item) {
    return;
  }
  try {
    const feedback = await item.run();
    if (typeof feedback === "string" && feedback.trim()) {
      showPaletteStatus(rt, feedback.trim());
      rt.statusTimer = setTimeout(() => {
        rt.statusTimer = null;
        closeCommandPalette();
      }, 650);
      return;
    }
  } catch {
    showPaletteStatus(rt, "执行失败，请重试");
    return;
  }
  closeCommandPalette();
}

function ensurePaletteDom(): PaletteRuntime {
  const activeDoc = getActiveReaderDocument();
  if (runtime && runtime.dialog.isConnected && runtime.dialog.ownerDocument === activeDoc) {
    return runtime;
  }
  const existing = activeById(COMMAND_PALETTE_ID);
  existing?.remove();

  const host = activeById(ids.readingView) || activeDoc.body;
  const hostDoc = resolveNodeDocument(host);
  const dialog = hostDoc.createElement("dialog");
  dialog.id = COMMAND_PALETTE_ID;
  dialog.className = "biliscript-cmd-palette";
  dialog.setAttribute("closedby", "any");
  dialog.setAttribute("aria-label", "命令面板");

  const listId = `${COMMAND_PALETTE_ID}-list`;
  dialog.innerHTML = `
    <div class="biliscript-cmd-surface">
      <div class="biliscript-cmd-header">
        <input
          type="text"
          class="biliscript-cmd-input"
          placeholder="搜索动作、切换思考强度、输入时间戳或字幕关键词…"
          aria-label="搜索命令或字幕"
          role="combobox"
          aria-expanded="true"
          aria-controls="${listId}"
          aria-autocomplete="list"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="biliscript-cmd-close" aria-label="关闭命令面板" title="关闭（Esc）">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="biliscript-cmd-status" role="status" aria-live="polite" hidden></div>
      <div id="${listId}" class="biliscript-cmd-list" role="listbox" aria-label="可用命令"></div>
      <footer class="biliscript-cmd-footer">
        <span class="biliscript-cmd-foot-hint"><kbd class="biliscript-cmd-kbd">↑</kbd><kbd class="biliscript-cmd-kbd">↓</kbd> 选择</span>
        <span class="biliscript-cmd-foot-hint"><kbd class="biliscript-cmd-kbd">↵</kbd> 执行</span>
        <span class="biliscript-cmd-foot-hint"><kbd class="biliscript-cmd-kbd">Esc</kbd> 关闭</span>
      </footer>
    </div>
  `;

  host.appendChild(dialog);

  const input = dialog.querySelector<HTMLInputElement>(".biliscript-cmd-input")!;
  const list = dialog.querySelector<HTMLElement>(".biliscript-cmd-list")!;
  const statusEl = dialog.querySelector<HTMLElement>(".biliscript-cmd-status")!;
  const closeBtn = dialog.querySelector<HTMLButtonElement>(".biliscript-cmd-close")!;

  const rt: PaletteRuntime = {
    dialog,
    input,
    list,
    statusEl,
    items: [],
    activeIndex: 0,
    statusTimer: null
  };

  const isOutsideDialog = (event: PointerEvent): boolean => {
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOutside = isOutsideDialog(event);
  });
  dialog.addEventListener("pointerup", (event) => {
    if (pressedOutside && isOutsideDialog(event)) {
      closeCommandPalette();
    }
    pressedOutside = false;
  });

  dialog.addEventListener("close", () => {
    if (rt.statusTimer !== null) {
      clearTimeout(rt.statusTimer);
      rt.statusTimer = null;
    }
    dialog.returnValue = "";
  });

  closeBtn.addEventListener("click", () => {
    closeCommandPalette();
  });

  input.addEventListener("input", () => {
    showPaletteStatus(rt, "");
    rt.items = resolveCommandPaletteItems(input.value);
    rt.activeIndex = rt.items.length > 0 ? 0 : -1;
    renderList(rt);
  });

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(rt, rt.activeIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(rt, rt.activeIndex - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(rt, 0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(rt, rt.items.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (rt.activeIndex >= 0) {
        void executeActiveItem(rt, rt.activeIndex);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCommandPalette();
    }
  });

  list.addEventListener("mousemove", (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".biliscript-cmd-item");
    if (!btn) {
      return;
    }
    const idx = Number(btn.dataset.cmdIndex);
    if (Number.isInteger(idx) && idx !== rt.activeIndex) {
      setActiveIndex(rt, idx);
    }
  });

  list.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".biliscript-cmd-item");
    if (!btn) {
      return;
    }
    const idx = Number(btn.dataset.cmdIndex);
    if (Number.isInteger(idx) && idx >= 0) {
      void executeActiveItem(rt, idx);
    }
  });

  runtime = rt;
  return rt;
}

export function isCommandPaletteOpen(): boolean {
  return isDialogOpen(runtime?.dialog);
}

let fallbackEscDoc: Document | null = null;
let stopPaletteHostWatch: (() => void) | null = null;

function unbindFallbackEsc(): void {
  if (!fallbackEscBound) {
    return;
  }
  safeRemoveListener(fallbackEscDoc, "keydown", onFallbackEscKeyDown, true);
  fallbackEscDoc = null;
  fallbackEscBound = false;
}

function ensurePaletteHostWatch(): void {
  if (stopPaletteHostWatch) {
    return;
  }
  stopPaletteHostWatch = onActiveHostChange((ctx) => {
    closeCommandPalette();
    if (!runtime) {
      return;
    }
    let keepRuntime = false;
    try {
      const readingView = activeById(ids.readingView);
      keepRuntime =
        runtime.dialog.isConnected &&
        runtime.dialog.ownerDocument === ctx.doc &&
        Boolean(readingView && readingView.contains(runtime.dialog));
    } catch {
      keepRuntime = false;
    }
    if (!keepRuntime) {
      try {
        runtime.dialog.remove();
      } catch {
      }
      runtime = null;
    }
  });
}

export function openCommandPalette(): void {
  if (!isReaderViewOpen()) {
    return;
  }
  const rt = ensurePaletteDom();
  ensurePaletteHostWatch();
  if (rt.statusTimer !== null) {
    clearTimeout(rt.statusTimer);
    rt.statusTimer = null;
  }
  showPaletteStatus(rt, "");
  rt.input.value = "";
  rt.items = resolveCommandPaletteItems("");
  rt.activeIndex = rt.items.length > 0 ? 0 : -1;
  renderList(rt);

  if (!isDialogOpen(rt.dialog)) {
    if (isNativeModalDialog(rt.dialog)) {
      rt.dialog.showModal();
    } else {
      rt.dialog.setAttribute("open", "");
      if (!fallbackEscBound) {
        fallbackEscDoc = resolveNodeDocument(rt.dialog);
        fallbackEscDoc.addEventListener("keydown", onFallbackEscKeyDown, true);
        fallbackEscBound = true;
      }
    }
  }
  rt.input.focus({ preventScroll: true });
}

export function closeCommandPalette(): void {
  if (!runtime) {
    return;
  }
  if (runtime.statusTimer !== null) {
    clearTimeout(runtime.statusTimer);
    runtime.statusTimer = null;
  }
  unbindFallbackEsc();
  try {
    if (isDialogOpen(runtime.dialog)) {
      if (typeof runtime.dialog.close === "function") {
        runtime.dialog.close();
      } else {
        runtime.dialog.removeAttribute("open");
      }
    }
  } catch {
    try {
      runtime.dialog.removeAttribute("open");
    } catch {
    }
  }
}

export function toggleCommandPalette(): void {
  if (isCommandPaletteOpen()) {
    closeCommandPalette();
  } else {
    openCommandPalette();
  }
}

export function disposeCommandPalette(): void {
  closeCommandPalette();
  stopPaletteHostWatch?.();
  stopPaletteHostWatch = null;
  if (runtime) {
    try {
      runtime.dialog.remove();
    } catch {
    }
    runtime = null;
  }
}
