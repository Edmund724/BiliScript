import type { ImagePart } from "../ai/types.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit
} from "../ui/trigger-motion.js";

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

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

  function close(restoreFocus = true): void {
    const dialog = overlay;
    if (!dialog) {
      return;
    }
    overlay = null;
    const target = returnFocus;
    returnFocus = null;
    document.removeEventListener("keydown", onKeydown, true);
    const image = dialog.querySelector<HTMLElement>(".chat-image-viewer-image");
    const finish = () => {
      if (dialog.open && typeof dialog.close === "function") {
        try {
          dialog.close();
        } catch {
          // 忽略 JSDOM 或已脱离节点关闭异常
        }
      }
      dialog.removeAttribute("open");
      dialog.remove();
      if (restoreFocus && !overlay && target?.isConnected) {
        target.focus({ preventScroll: true });
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
    const viewer = document.createElement("dialog");
    viewer.className = "chat-image-viewer";
    viewer.setAttribute("aria-label", alt || "查看图片");
    const image = document.createElement("img");
    image.className = "chat-image-viewer-image";
    image.src = src;
    image.alt = alt || "查看图片";
    const closeButton = document.createElement("button");
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
    const host = trigger.closest<HTMLElement>("#biliscript-reading-view") || document.body;
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
    document.addEventListener("keydown", onKeydown, true);
    closeButton.focus({ preventScroll: true });
  }

  return { open, close };
}

export function createChatImageViewButton(image: ImagePart, viewer: ChatImageViewer, alt: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-image-open";
  button.setAttribute("aria-label", "查看图片");
  button.title = "查看图片";
  const thumbnail = document.createElement("img");
  thumbnail.className = "chat-image-thumb";
  thumbnail.src = chatImageDataUrl(image);
  thumbnail.alt = alt;
  button.appendChild(thumbnail);
  button.addEventListener("click", () => viewer.open(thumbnail.src, button, alt));
  return button;
}
