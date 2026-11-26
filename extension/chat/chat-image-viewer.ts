import type { ImagePart } from "../ai/types.js";
import { getActiveReaderDocument, onActiveHostChange } from "../shared/active-host.js";
import { resolveNodeDocument, safeRemoveListener } from "../shared/cross-doc.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit
} from "../ui/trigger-motion.js";
import { renderUiIcon } from "../ui/icon-registry.js";

const CLOSE_ICON = renderUiIcon("close", { size: 16 });

export interface ChatImageViewer {
  open(src: string, trigger: HTMLElement, alt?: string): void;
  close(restoreFocus?: boolean): void;
}

export function chatImageDataUrl(image: ImagePart): string {
  return `data:${image.mime};base64,${image.data}`;
}

export function createChatImageViewer(): ChatImageViewer {
  let overlay: HTMLDialogElement | null = null;
  let returnFocus: HTMLElement | null = null;
  let boundKeyDownDoc: Document | null = null;
  let stopHostWatch: (() => void) | null = null;

  function close(restoreFocus = true): void {
    const dialog = overlay;
    if (!dialog) {
      return;
    }
    overlay = null;
    const target = returnFocus;
    returnFocus = null;
    stopHostWatch?.();
    stopHostWatch = null;
    safeRemoveListener(boundKeyDownDoc, "keydown", onKeydown, true);
    boundKeyDownDoc = null;
    const image = dialog.querySelector<HTMLElement>(".chat-image-viewer-image");
    const finish = () => {
      try {
        if (dialog.isConnected && dialog.open && typeof dialog.close === "function") {
          dialog.close();
        }
      } catch {
      }
      try {
        dialog.removeAttribute("open");
        dialog.remove();
      } catch {
      }
      try {
        if (restoreFocus && !overlay && target?.isConnected) {
          target.focus({ preventScroll: true });
        }
      } catch {
      }
    };
    if (image) {
      animateTriggerExit({
        target: image,
        host: dialog,
        trigger: target,
        fallbackOrigin: "bottom right",
        toScale: 0.85,
        durationMs: 140,
        onFinish: finish
      });
    } else {
      finish();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!overlay?.isConnected) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      overlay.querySelector<HTMLButtonElement>(".chat-image-viewer-close")?.focus({ preventScroll: true });
    }
  }

  function open(src: string, trigger: HTMLElement, alt = "查看图片"): void {
    close(false);
    returnFocus = trigger;
    const doc = resolveNodeDocument(trigger);
    const viewer = doc.createElement("dialog");
    viewer.className = "chat-image-viewer";
    viewer.setAttribute("aria-label", alt || "查看图片");
    const image = doc.createElement("img");
    image.className = "chat-image-viewer-image";
    image.src = src;
    image.alt = alt || "查看图片";
    const closeButton = doc.createElement("button");
    closeButton.type = "button";
    closeButton.className = "chat-image-viewer-close";
    closeButton.setAttribute("aria-label", "关闭图片");
    closeButton.title = "关闭图片";
    closeButton.innerHTML = CLOSE_ICON;
    closeButton.addEventListener("click", () => close(true));
    viewer.addEventListener("cancel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    });
    viewer.addEventListener("close", () => {
      close(true);
    });
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer) {
        close(true);
      }
    });
    viewer.append(image, closeButton);
    const host = trigger.closest<HTMLElement>("#biliscript-reading-view") || doc.body;
    host.querySelectorAll<HTMLElement>('.chat-image-viewer[data-biliscript-closing="1"]').forEach((el) => {
      cancelTriggerExit(el);
    });
    host.appendChild(viewer);
    overlay = viewer;
    if (typeof viewer.showModal === "function") {
      viewer.showModal();
    } else {
      viewer.setAttribute("open", "");
    }
    animateTriggerEnter({
      target: image,
      trigger,
      fallbackOrigin: "bottom right",
      fromScale: 0.85,
      durationMs: 210
    });
    boundKeyDownDoc = doc;
    doc.addEventListener("keydown", onKeydown, true);
    stopHostWatch = onActiveHostChange(() => {
      close(false);
    });
    closeButton.focus({ preventScroll: true });
  }

  return { open, close };
}

export function createChatImageViewButton(image: ImagePart, viewer: ChatImageViewer, alt: string): HTMLButtonElement {
  const doc = getActiveReaderDocument();
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "chat-image-open";
  button.setAttribute("aria-label", "查看图片");
  button.title = "查看图片";
  const thumbnail = doc.createElement("img");
  thumbnail.className = "chat-image-thumb";
  thumbnail.src = chatImageDataUrl(image);
  thumbnail.alt = alt;
  button.appendChild(thumbnail);
  button.addEventListener("click", () => viewer.open(thumbnail.src, button, alt));
  return button;
}
