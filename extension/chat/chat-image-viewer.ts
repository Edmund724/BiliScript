import type { ImagePart } from "../ai/types.js";

export interface ChatImageViewer {
  open(src: string, trigger: HTMLElement): void;
  close(): void;
}

export function chatImageDataUrl(image: ImagePart): string {
  return `data:${image.mime};base64,${image.data}`;
}

export function createChatImageViewer(): ChatImageViewer {
  let overlay: HTMLDivElement | null = null;
  let returnFocus: HTMLElement | null = null;

  function close(): void {
    if (!overlay) {
      return;
    }
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKeydown, true);
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected) {
      target.focus();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      overlay?.querySelector<HTMLButtonElement>(".chat-image-viewer-close")?.focus();
    }
  }

  function open(src: string, trigger: HTMLElement): void {
    close();
    returnFocus = trigger;
    const viewer = document.createElement("div");
    viewer.className = "chat-image-viewer";
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-label", "查看图片");
    const image = document.createElement("img");
    image.className = "chat-image-viewer-image";
    image.src = src;
    image.alt = "已发送的图片";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "chat-image-viewer-close";
    closeButton.setAttribute("aria-label", "关闭图片");
    closeButton.title = "关闭图片";
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer) {
        close();
      }
    });
    viewer.append(image, closeButton);
    (trigger.closest(".biliscript-reading-chat") || document.body).appendChild(viewer);
    overlay = viewer;
    document.addEventListener("keydown", onKeydown, true);
    closeButton.focus();
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
  button.addEventListener("click", () => viewer.open(thumbnail.src, button));
  return button;
}
