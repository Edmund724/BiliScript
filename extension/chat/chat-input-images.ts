// chat-input-images.ts — 输入区图片附件（image-input 02 号票：粘贴入口 + 缩略图
// 预览 + 单个删除 + 发送时消费）。
//
// 职责：剪贴板粘贴的 image/* 项 → 压缩（./image-compress.js 的 03 号票规格）→
// 缩略图条目；张数 / 单条总量的上限判定与拒绝文案；发送受理时的消费
//（takeImages 读取并清空）与在途压缩的世代作废（迟到结果不回填已清空的附件区）。
//
// 边界：
//   - 只做粘贴入口（文件选择器 / 拖拽 / 视频帧截取都不做，spec 非目标）；
//   - 纯文本与其它非图片剪贴板内容**不拦截**（不 preventDefault），既有粘贴行为
//     逐字不变；
//   - 附件只在会话内存中，不落 chrome.storage（04 号票的落盘策略另票实现）；
//   - 事件注册在组合根（reader/chat-tab-lifecycle 的 bindEvents：paste 与容器委托
//     的删除键），本模块只给方法——与 chat-lists / chat-popovers 同款分工。

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

// 剪贴板事件的窄视图（chat-runtime 的 ChatPort 窄视图同款：结构子集，真实
// ClipboardEvent / DataTransferItemList 天然同构，测试可直接传字面量）。
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
  // 附件区容器（模板 .chat-image-strip；缺失时逻辑照跑，仅不渲染）
  strip: HTMLElement | null;
  // 压缩管线（缺省 image-compress 的真实实现；测试注入替身）
  compress?: (blob: Blob) => Promise<CompressedImage>;
  // 回答生成中（流式/在途发送）判定：此期间不接受新图片
  isStreaming?: () => boolean;
  // 用户可见反馈出口（拒绝原因 → 文案，展示由调用方决定）
  onReject: (message: string) => void;
}

export interface ChatInputImages {
  handlePaste(event: PasteEventLike): void;
  removeAt(index: number): void;
  clear(): void;
  takeImages(): ImagePart[];
  count(): number;
}

// 拒绝文案（03 号票上限；数值取自 image-compress 的常量，不另写一份）。
const MB = 1024 * 1024;
const REJECT_MESSAGES: Record<ImageRejectReason, string> = {
  "too-many": `一条消息最多 ${IMAGE_MAX_COUNT} 张图片`,
  "single-too-large": `图片压缩后仍超过 ${IMAGE_MAX_BYTES / MB}MB，无法发送`,
  "total-too-large": `图片合计超过 ${IMAGE_MAX_TOTAL_BYTES / MB}MB，无法发送`,
  "decode-failed": "图片解码失败，请换一张图片重试",
  "encode-failed": "图片处理失败，请换一张图片重试"
};

// 流式中加图被拒（02 号票行为细节：发送中不允许再加图）。
export const IMAGE_STREAMING_REJECT_MESSAGE = "回答生成中，暂时不能添加图片";

const REMOVE_LABEL = "删除图片";
const THUMB_ALT = "粘贴的图片";

function collectImageFiles(clipboardData: PasteEventLike["clipboardData"]): File[] {
  const items = clipboardData?.items;
  if (!items) {
    return [];
  }
  const files: File[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    // 仅 file 类且 MIME 为 image/* 的项算图片；文本项（kind=string）不在此列。
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
  let attachments: CompressedImage[] = [];
  // 附件区世代号：clear / takeImages（发送受理）即自增；在途压缩完成后据此判定
  // 本轮结果是否仍归属当前附件区（迟到结果不回填——否则发送清空的附件区会被
  // 上一次粘贴的压缩结果重新填上，与「发送后清空」相矛盾）。
  let generation = 0;
  // 在途压缩计数：并发粘贴时张数上限要算上还没落位的那些。
  let pending = 0;

  function render(): void {
    const strip = deps.strip;
    if (!strip) {
      return;
    }
    strip.innerHTML = "";
    strip.hidden = attachments.length === 0;
    attachments.forEach((item, index) => {
      const node = document.createElement("div");
      node.className = "chat-image-item";
      const thumb = document.createElement("img");
      thumb.className = "chat-image-thumb";
      thumb.src = `data:${item.part.mime};base64,${item.part.data}`;
      thumb.alt = THUMB_ALT;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-image-remove";
      remove.dataset.chatImageRemove = String(index);
      remove.title = REMOVE_LABEL;
      remove.setAttribute("aria-label", REMOVE_LABEL);
      remove.textContent = "×";
      node.append(thumb, remove);
      strip.appendChild(node);
    });
  }

  function reject(reason: ImageRejectReason): void {
    deps.onReject(REJECT_MESSAGES[reason]);
  }

  async function acceptFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (attachments.length + pending >= IMAGE_MAX_COUNT) {
        deps.onReject(REJECT_MESSAGES["too-many"]);
        return;
      }
      const current = generation;
      pending += 1;
      try {
        const compressed = await compress(file);
        // 附件区已被消费（发送受理）/清空：本轮结果作废，不回填。
        if (current !== generation) {
          return;
        }
        const total = attachments.reduce((sum, item) => sum + item.bytes, 0) + compressed.bytes;
        if (total > IMAGE_MAX_TOTAL_BYTES) {
          reject("total-too-large");
          continue;
        }
        attachments.push(compressed);
        render();
      } catch (error) {
        // 单张超限（compress 内判定）与解码/编码失败都走这里：一律给可见提示，
        // 绝不静默丢。一张失败不影响同批其余图片继续处理。
        if (error instanceof ImageRejectError) {
          reject(error.reason);
        } else {
          reject("encode-failed");
        }
      } finally {
        pending -= 1;
      }
    }
  }

  function handlePaste(event: PasteEventLike): void {
    const files = collectImageFiles(event.clipboardData);
    if (!files.length) {
      // 纯文本 / 非图片：不拦截，默认粘贴行为不变。
      return;
    }
    // 含 image/*：拦截（不让浏览器把图片当文件拖进 textarea 的既有效果），
    // 再按流式闸 / 上限逐张收。
    event.preventDefault();
    if (deps.isStreaming?.()) {
      deps.onReject(IMAGE_STREAMING_REJECT_MESSAGE);
      return;
    }
    void acceptFiles(files);
  }

  function clear(): void {
    generation += 1;
    attachments = [];
    render();
  }

  function removeAt(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= attachments.length) {
      return;
    }
    attachments.splice(index, 1);
    render();
  }

  // 发送受理即消费：读出 ImagePart 列表并清空附件区（发送后清空是 02 号票的
  // 行为细节；读与清同一次调用，避免「读了没清」或「清了没发」两种半态）。
  function takeImages(): ImagePart[] {
    const parts = attachments.map((item) => item.part);
    clear();
    return parts;
  }

  return {
    handlePaste,
    removeAt,
    clear,
    takeImages,
    count: () => attachments.length
  };
}
