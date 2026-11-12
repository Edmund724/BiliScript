// 输入区图片附件：粘贴时同步占位，压缩后原位填充；发送按快照消费，
// 保留等待期间新增的图片及其在途压缩。

import type { ImagePart } from "../ai/types.js";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  IMAGE_MAX_TOTAL_BYTES,
  ImageRejectError,
  createImageCompressor,
  type CompressedImage,
  type ImageRejectReason
} from "./image-compress.js";

export interface PasteClipboardItem {
  kind?: string;
  type?: string;
  getAsFile(): File | null;
}

export interface PasteEventLike {
  clipboardData: { items: ArrayLike<PasteClipboardItem> } | null;
  preventDefault(): void;
}

export interface ChatInputImagesDeps {
  strip: HTMLElement | null;
  compress?: (blob: Blob) => Promise<CompressedImage>;
  // 流式生成中不接受新图片；字幕等待期间仍可粘贴。
  isStreaming?: () => boolean;
  onReject: (message: string) => void;
  onPendingChange?: (pending: boolean) => void;
  focusInput?: () => void;
}

export interface ChatInputImages {
  handlePaste(event: PasteEventLike): void;
  previewAt(index: number): void;
  removeAt(index: number): void;
  clear(): void;
  getImages(): ImagePart[];
  takeImages(snapshot?: ImagePart[]): ImagePart[];
  count(): number;
  isPending(): boolean;
}

const MB = 1024 * 1024;
const REJECT_MESSAGES: Record<ImageRejectReason, string> = {
  "too-many": `一条消息最多 ${IMAGE_MAX_COUNT} 张图片`,
  "single-too-large": `图片压缩后仍超过 ${IMAGE_MAX_BYTES / MB}MB，无法发送`,
  "total-too-large": `图片合计超过 ${IMAGE_MAX_TOTAL_BYTES / MB}MB，无法发送`,
  "decode-failed": "图片解码失败，请换一张图片重试",
  "encode-failed": "图片处理失败，请换一张图片重试"
};

export const IMAGE_STREAMING_REJECT_MESSAGE = "正在生成回答，暂不支持添加图片";

interface Attachment {
  id: number;
  compressed: CompressedImage | null;
}

interface ActivePreview {
  id: number;
  overlay: HTMLElement;
  onKeyDown: (event: KeyboardEvent) => void;
}

function collectImageFiles(clipboardData: PasteEventLike["clipboardData"]): File[] {
  const items = clipboardData?.items;
  if (!items) {
    return [];
  }
  const files: File[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file" || !/^image\//i.test(String(item.type || ""))) {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

export function createChatInputImages(deps: ChatInputImagesDeps): ChatInputImages {
  const compress = deps.compress || createImageCompressor().compress;
  let attachments: Attachment[] = [];
  let generation = 0;
  let nextId = 1;
  let pendingUi = false;
  let activePreview: ActivePreview | null = null;

  function isPending(): boolean {
    return attachments.some((item) => item.compressed === null);
  }

  function syncPending(): void {
    const pending = isPending();
    if (pending === pendingUi) {
      return;
    }
    pendingUi = pending;
    deps.onPendingChange?.(pending);
  }

  function closePreview(restoreFocus = true): void {
    if (!activePreview) {
      return;
    }
    const { id, overlay, onKeyDown } = activePreview;
    activePreview = null;
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    if (!restoreFocus) {
      return;
    }
    const candidates = deps.strip
      ? Array.from(deps.strip.querySelectorAll<HTMLButtonElement>("[data-chat-image-preview]"))
      : [];
    const trigger = candidates.find((node) => Number(node.dataset.chatImageId) === id);
    if (trigger) {
      trigger.focus();
    } else {
      deps.focusInput?.();
    }
  }

  function render(): void {
    const strip = deps.strip;
    if (!strip) {
      return;
    }
    strip.innerHTML = "";
    strip.hidden = attachments.length === 0;
    strip.setAttribute("aria-busy", String(isPending()));
    attachments.forEach((item, index) => {
      const node = document.createElement("div");
      node.className = "chat-image-item";
      node.dataset.chatImageId = String(item.id);
      if (item.compressed) {
        const preview = document.createElement("button");
        preview.type = "button";
        preview.className = "chat-image-preview";
        preview.dataset.chatImagePreview = String(index);
        preview.dataset.chatImageId = String(item.id);
        preview.setAttribute("aria-label", `预览第 ${index + 1} 张图片`);
        preview.title = "预览图片";
        const thumb = document.createElement("img");
        thumb.className = "chat-image-thumb";
        thumb.src = `data:${item.compressed.part.mime};base64,${item.compressed.part.data}`;
        thumb.alt = `第 ${index + 1} 张粘贴图片`;
        preview.appendChild(thumb);
        node.appendChild(preview);
      } else {
        const skeleton = document.createElement("span");
        skeleton.className = "chat-image-skeleton";
        skeleton.setAttribute("role", "img");
        skeleton.setAttribute("aria-label", `第 ${index + 1} 张图片处理中`);
        node.appendChild(skeleton);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-image-remove";
      remove.dataset.chatImageRemove = String(index);
      remove.dataset.chatImageId = String(item.id);
      remove.title = `删除第 ${index + 1} 张图片`;
      remove.setAttribute("aria-label", remove.title);
      remove.textContent = "×";
      node.appendChild(remove);
      strip.appendChild(node);
    });
  }

  function rejectAt(position: number, reason: ImageRejectReason): void {
    deps.onReject(`第 ${position} 张图片：${REJECT_MESSAGES[reason]}`);
  }

  async function compressEntry(entry: Attachment, file: File, currentGeneration: number): Promise<void> {
    try {
      const compressed = await compress(file);
      if (currentGeneration !== generation || !attachments.includes(entry)) {
        return;
      }
      const total = attachments.reduce((sum, item) => sum + (item.compressed?.bytes ?? 0), 0) + compressed.bytes;
      if (total > IMAGE_MAX_TOTAL_BYTES) {
        const index = attachments.indexOf(entry);
        attachments.splice(index, 1);
        render();
        rejectAt(index + 1, "total-too-large");
        return;
      }
      entry.compressed = compressed;
      render();
    } catch (error) {
      if (currentGeneration !== generation || !attachments.includes(entry)) {
        return;
      }
      const index = attachments.indexOf(entry);
      attachments.splice(index, 1);
      render();
      rejectAt(index + 1, error instanceof ImageRejectError ? error.reason : "encode-failed");
    } finally {
      syncPending();
    }
  }

  function acceptFiles(files: File[]): void {
    const firstPosition = attachments.length + 1;
    const available = Math.max(0, IMAGE_MAX_COUNT - attachments.length);
    const accepted = files.slice(0, available).map((file) => {
      const entry: Attachment = { id: nextId++, compressed: null };
      attachments.push(entry);
      return { entry, file, generation };
    });
    render();
    syncPending();
    for (let index = available; index < files.length; index += 1) {
      rejectAt(firstPosition + index, "too-many");
    }
    for (const item of accepted) {
      void compressEntry(item.entry, item.file, item.generation);
    }
  }

  function handlePaste(event: PasteEventLike): void {
    const files = collectImageFiles(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    if (deps.isStreaming?.()) {
      deps.onReject(IMAGE_STREAMING_REJECT_MESSAGE);
      return;
    }
    acceptFiles(files);
  }

  function previewAt(index: number): void {
    const entry = attachments[index];
    if (!entry?.compressed) {
      return;
    }
    closePreview(false);
    const overlay = document.createElement("div");
    overlay.className = "chat-image-lightbox";
    const dialog = document.createElement("div");
    dialog.className = "chat-image-lightbox-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", `第 ${index + 1} 张图片预览`);
    const image = document.createElement("img");
    image.className = "chat-image-lightbox-image";
    image.src = `data:${entry.compressed.part.mime};base64,${entry.compressed.part.data}`;
    image.alt = `第 ${index + 1} 张粘贴图片的大图预览`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "chat-image-lightbox-close";
    close.setAttribute("aria-label", "关闭图片预览");
    close.title = "关闭";
    close.textContent = "×";
    dialog.append(image, close);
    overlay.appendChild(dialog);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
      }
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closePreview();
      }
    });
    close.addEventListener("click", () => closePreview());
    document.addEventListener("keydown", onKeyDown);
    activePreview = { id: entry.id, overlay, onKeyDown };
    const host = deps.strip?.closest<HTMLElement>(".biliscript-reading-chat") ?? document.body;
    host.appendChild(overlay);
    close.focus();
  }

  function clear(): void {
    generation += 1;
    closePreview(false);
    attachments = [];
    render();
    syncPending();
  }

  function removeAt(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= attachments.length) {
      return;
    }
    const [removed] = attachments.splice(index, 1);
    if (activePreview?.id === removed.id) {
      closePreview(false);
    }
    render();
    syncPending();
    const items = deps.strip?.querySelectorAll<HTMLElement>(".chat-image-item");
    const adjacent = items?.[Math.min(index, items.length - 1)];
    const focusTarget = adjacent?.querySelector<HTMLButtonElement>(".chat-image-preview, .chat-image-remove");
    if (focusTarget) {
      focusTarget.focus();
    } else {
      deps.focusInput?.();
    }
  }

  function getImages(): ImagePart[] {
    return attachments.flatMap((item) => item.compressed ? [item.compressed.part] : []);
  }

  function takeImages(snapshot?: ImagePart[]): ImagePart[] {
    if (snapshot) {
      const consumed = new Set(snapshot);
      const removedIds = new Set(
        attachments.filter((item) => item.compressed && consumed.has(item.compressed.part)).map((item) => item.id)
      );
      if (activePreview && removedIds.has(activePreview.id)) {
        closePreview(false);
      }
      attachments = attachments.filter((item) => !removedIds.has(item.id));
      render();
      syncPending();
      return snapshot;
    }
    const parts = getImages();
    clear();
    return parts;
  }

  return {
    handlePaste,
    previewAt,
    removeAt,
    clear,
    getImages,
    takeImages,
    count: () => attachments.length,
    isPending
  };
}
