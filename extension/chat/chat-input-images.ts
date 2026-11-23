import type { ImagePart } from "../ai/types.js";
import { resolveNodeDocument } from "../shared/cross-doc.js";
import { createChatImageViewer, createChatImageViewButton } from "./chat-image-viewer.js";
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
  isStreaming?: () => boolean;
  onReject: (message: string) => void;
  onPendingChange?: (pending: boolean) => void;
  focusInput?: () => void;
}

export interface ChatInputImages {
  handlePaste(event: PasteEventLike): void;
  addFiles(files: readonly File[]): void;
  restoreImages(parts: readonly ImagePart[]): void;
  closeViewer(restoreFocus?: boolean): void;
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
  const viewer = createChatImageViewer();
  let attachments: Attachment[] = [];
  let generation = 0;
  let nextId = 1;
  let pendingUi = false;

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

  function render(): void {
    const strip = deps.strip;
    if (!strip) {
      return;
    }
    strip.innerHTML = "";
    strip.hidden = attachments.length === 0;
    strip.setAttribute("aria-busy", String(isPending()));
    const doc = resolveNodeDocument(strip);
    attachments.forEach((item, index) => {
      const node = doc.createElement("div");
      node.className = "chat-image-item";
      node.dataset.chatImageId = String(item.id);
      if (item.compressed) {
        const open = createChatImageViewButton(item.compressed.part, viewer, `第 ${index + 1} 张粘贴图片`);
        open.classList.add("chat-image-preview");
        open.dataset.chatImageId = String(item.id);
        open.setAttribute("aria-label", `预览第 ${index + 1} 张图片`);
        open.title = "预览图片";
        node.appendChild(open);
      } else {
        const skeleton = doc.createElement("span");
        skeleton.className = "chat-image-skeleton";
        skeleton.setAttribute("role", "img");
        skeleton.setAttribute("aria-label", `第 ${index + 1} 张图片处理中`);
        node.appendChild(skeleton);
      }
      const remove = doc.createElement("button");
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

  function addFiles(files: readonly File[]): void {
    const imageFiles = files.filter((file) => /^image\//i.test(String(file.type || "")));
    if (!imageFiles.length) {
      return;
    }
    if (deps.isStreaming?.()) {
      deps.onReject(IMAGE_STREAMING_REJECT_MESSAGE);
      return;
    }
    acceptFiles(imageFiles);
  }

  function handlePaste(event: PasteEventLike): void {
    const files = collectImageFiles(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    addFiles(files);
  }

  function restoreImages(parts: readonly ImagePart[]): void {
    if (attachments.length > 0 || isPending() || !parts.length) {
      return;
    }
    attachments = parts.slice(0, IMAGE_MAX_COUNT).map((part) => {
      const copy: ImagePart = { mime: part.mime, data: part.data };
      const bytes = Math.floor((copy.data.length * 3) / 4);
      return {
        id: nextId++,
        compressed: { part: copy, bytes }
      };
    });
    render();
    syncPending();
  }

  function closeViewer(restoreFocus = true): void {
    viewer.close(restoreFocus);
  }

  function clear(): void {
    viewer.close(false);
    generation += 1;
    attachments = [];
    render();
    syncPending();
  }

  function removeAt(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= attachments.length) {
      return;
    }
    viewer.close(false);
    attachments.splice(index, 1);
    render();
    syncPending();
    const items = deps.strip?.querySelectorAll<HTMLElement>(".chat-image-item");
    const adjacent = items?.[Math.min(index, items.length - 1)];
    const focusTarget = adjacent?.querySelector<HTMLButtonElement>(".chat-image-preview, .chat-image-remove");
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
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
      if (removedIds.size > 0) {
        viewer.close(false);
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
    addFiles,
    restoreImages,
    closeViewer,
    removeAt,
    clear,
    getImages,
    takeImages,
    count: () => attachments.length,
    isPending
  };
}
