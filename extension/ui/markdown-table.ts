import { onActiveHostChange } from "../shared/active-host.js";
import { isHtmlElement } from "../shared/cross-doc.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit
} from "./trigger-motion.js";

export const TABLE_SHELL_CLASS = "biliscript-md-table";
const TABLE_SCROLL_CLASS = "biliscript-md-table-scroll";
const TABLE_CARDS_CLASS = "biliscript-md-table-cards";
const TABLE_CELL_LABEL_CLASS = "biliscript-md-table-cell-label";
const TABLE_EXPAND_CLASS = "biliscript-md-table-expand";
const TABLE_DIALOG_CLASS = "biliscript-md-table-dialog";
const CARD_LONG_TEXT_CHARS = 40;
const TABLE_CELL_LABEL_WIDE_CLASS = "biliscript-md-table-cell-label-wide";
const CELL_WIDE_TEXT_CHARS = 16;
const EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
let activeDialog: HTMLDialogElement | null = null;

onActiveHostChange(() => {
  if (!activeDialog) {
    return;
  }
  const dialog = activeDialog;
  activeDialog = null;
  cancelTriggerExit(dialog);
  try {
    if (dialog.open && typeof dialog.close === "function") {
      dialog.close();
    }
  } catch {
  }
  try {
    dialog.remove();
  } catch {
  }
});

function cellContentText(cell: HTMLTableCellElement): string {
  let text = "";
  for (const node of Array.from(cell.childNodes)) {
    if (isHtmlElement(node) && node.classList.contains(TABLE_CELL_LABEL_CLASS)) {
      continue;
    }
    text += node.textContent || "";
  }
  return text.trim();
}

function shouldUseCards(table: HTMLTableElement): boolean {
  const columnCount = table.tHead?.rows[0]?.cells.length || 0;
  if (columnCount < 2 || columnCount > 4) {
    return false;
  }
  return Array.from(table.tBodies).some((tbody) =>
    Array.from(tbody.rows).some((row) =>
      Array.from(row.cells).some((cell) => cellContentText(cell).length >= CARD_LONG_TEXT_CHARS)
    )
  );
}

function syncTable(table: HTMLTableElement, shell: HTMLElement): void {
  shell.classList.toggle(TABLE_CARDS_CLASS, shouldUseCards(table));
  const headers = Array.from(table.tHead?.rows[0]?.cells || []).map((cell) => cell.textContent?.trim() || "");
  for (const tbody of Array.from(table.tBodies)) {
    for (const row of Array.from(tbody.rows)) {
      Array.from(row.cells).forEach((cell, index) => {
        let label = Array.from(cell.children).find((child) => child.classList.contains(TABLE_CELL_LABEL_CLASS));
        if (!label) {
          label = cell.ownerDocument.createElement("span");
          label.className = TABLE_CELL_LABEL_CLASS;
          cell.insertBefore(label, cell.firstChild);
        }
        label.textContent = headers[index] || `第 ${index + 1} 列`;
        label.classList.toggle(TABLE_CELL_LABEL_WIDE_CLASS, cellContentText(cell).length >= CELL_WIDE_TEXT_CHARS);
      });
    }
  }
}

function closeTableDialog(
  dialog: HTMLDialogElement,
  trigger?: HTMLElement,
  restoreFocus = true
): void {
  if (dialog.hasAttribute("data-biliscript-closing")) {
    return;
  }
  const isCurrent = activeDialog === dialog;
  if (isCurrent) {
    activeDialog = null;
  }
  animateTriggerExit({
    target: dialog,
    trigger,
    fallbackOrigin: "top right",
    toScale: 0.94,
    durationMs: 140,
    onFinish: () => {
      if (typeof dialog.close === "function") {
        dialog.close();
      }
      dialog.remove();
      if (isCurrent && activeDialog === null && restoreFocus && trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    }
  });
}

function openTableDialog(table: HTMLTableElement, trigger?: HTMLElement): void {
  const previousDialog = activeDialog;
  activeDialog = null;
  if (previousDialog) {
    if (previousDialog.open && typeof previousDialog.close === "function") {
      previousDialog.close();
    }
    previousDialog.remove();
  }
  const doc = table.ownerDocument;
  const dialog = doc.createElement("dialog");
  dialog.className = TABLE_DIALOG_CLASS;
  dialog.setAttribute("aria-label", "展开表格");
  const header = doc.createElement("header");
  header.className = "biliscript-md-table-dialog-header";
  const title = doc.createElement("strong");
  title.textContent = "表格";
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "biliscript-md-table-dialog-close";
  close.setAttribute("aria-label", "关闭表格");
  close.setAttribute("title", "关闭");
  close.innerHTML = CLOSE_ICON;
  close.autofocus = true;
  close.addEventListener("click", () => closeTableDialog(dialog, trigger, true));
  header.append(title, close);
  const body = doc.createElement("div");
  body.className = "biliscript-md-table-dialog-body markdown-body";
  const scroll = doc.createElement("div");
  scroll.className = TABLE_SCROLL_CLASS;
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "完整表格，可横向滚动");
  const clone = table.cloneNode(true) as HTMLTableElement;
  for (const button of Array.from(clone.querySelectorAll("button"))) {
    button.replaceWith(...Array.from(button.childNodes));
  }
  scroll.appendChild(clone);
  body.appendChild(scroll);
  dialog.append(header, body);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeTableDialog(dialog, trigger, true);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeTableDialog(dialog, trigger, true);
    }
  });
  dialog.addEventListener("close", () => {
    const isCurrent = activeDialog === dialog;
    if (isCurrent) {
      activeDialog = null;
    }
    dialog.remove();
    if (isCurrent && trigger?.isConnected) {
      trigger.focus();
    }
  });
  activeDialog = dialog;
  const host = table.closest("#biliscript-reading-view") || doc.body;
  host.querySelectorAll<HTMLElement>(`.${TABLE_DIALOG_CLASS}[data-biliscript-closing="1"]`).forEach((el) => {
    cancelTriggerExit(el);
  });
  host.appendChild(dialog);
  dialog.showModal();
  animateTriggerEnter({
    target: dialog,
    trigger,
    fallbackOrigin: "top right",
    fromScale: 0.93,
    durationMs: 190
  });
}

function createExpandButton(doc: Document, table: HTMLTableElement): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = TABLE_EXPAND_CLASS;
  button.setAttribute("aria-label", "展开表格");
  button.setAttribute("title", "展开表格");
  button.innerHTML = EXPAND_ICON;
  button.addEventListener("click", () => openTableDialog(table, button));
  return button;
}

export function enhanceMarkdownTables(root: ParentNode): void {
  const tables = Array.from(root.querySelectorAll("table"));
  for (const table of tables) {
    if (table.closest(`.${TABLE_DIALOG_CLASS}`)) {
      continue;
    }
    let shell: HTMLElement;
    if (table.parentElement?.classList.contains(TABLE_SCROLL_CLASS)) {
      shell = table.parentElement.parentElement!;
    } else {
      const doc = table.ownerDocument;
      shell = doc.createElement("div");
      shell.className = TABLE_SHELL_CLASS;
      const tools = doc.createElement("div");
      tools.className = "biliscript-md-table-tools";
      tools.appendChild(createExpandButton(doc, table));
      const scroll = doc.createElement("div");
      scroll.className = TABLE_SCROLL_CLASS;
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", "表格，可横向滚动");
      table.replaceWith(shell);
      scroll.appendChild(table);
      shell.append(tools, scroll);
    }
    syncTable(table, shell);
  }
}
