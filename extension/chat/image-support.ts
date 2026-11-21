import type { ImagePart } from "../ai/types.js";
import type { CatalogModelMeta } from "../ai/model-catalog.js";
import { loadModelCatalog } from "../ui/lazy-model-catalog.js";
import { chatSessionState } from "./chat-state.js";
import { parseModelOptionValue } from "../shared/selected-provider.js";

export type ImageSupportMeta = Pick<CatalogModelMeta, "input">;

export type ImageSupportLookup = (
  presetId: string | undefined,
  baseUrl: string | undefined,
  modelId: string
) => Promise<ImageSupportMeta | null>;

export interface ImageSupportGateDeps {
  getSelectedModelValue: () => string;
  notify: (message: string) => void;
  lookupMeta?: ImageSupportLookup;
}

export interface ImageSupportGate {
  check(images: readonly ImagePart[]): void;
  supportsImages(): Promise<boolean>;
}

export const IMAGE_UNSUPPORTED_NOTICE = "当前模型可能不支持图片，发送可能失败；如需识图请换用多模态模型";

export const IMAGE_UNSUPPORTED_ERROR_HINT = "（可能是模型不支持图片，请换用多模态模型，或移除图片后重试）";

const HTTP_BAD_REQUEST_RE = /\bHTTP 400\b/;
const IMAGE_CLUE_RE = /image|图片|图像|视觉|vision|multimodal|多模态/i;

async function lookupCatalogMetaLazily(
  presetId: string | undefined,
  baseUrl: string | undefined,
  modelId: string
): Promise<ImageSupportMeta | null> {
  const catalog = await loadModelCatalog();
  return catalog.lookupCatalogMeta(presetId, baseUrl, modelId);
}

export function createImageSupportGate(deps: ImageSupportGateDeps): ImageSupportGate {
  const lookupMeta = deps.lookupMeta || lookupCatalogMetaLazily;

  function currentTarget(): { presetId: string | undefined; baseUrl: string | undefined; modelId: string } | null {
    const { providerId, model } = parseModelOptionValue(deps.getSelectedModelValue());
    if (!model) {
      return null;
    }
    const provider = chatSessionState.providers.find((item) => String(item.id) === providerId);
    if (!provider) {
      return null;
    }
    return { presetId: provider.presetId, baseUrl: provider.baseUrl, modelId: model };
  }

  function check(images: readonly ImagePart[]): void {
    if (!images.length) {
      return;
    }
    void (async () => {
      const target = currentTarget();
      if (!target) {
        return;
      }
      const meta = await lookupMeta(target.presetId, target.baseUrl, target.modelId);
      if (!meta || meta.input.includes("image")) {
        return;
      }
      deps.notify(IMAGE_UNSUPPORTED_NOTICE);
    })().catch(() => {
    });
  }

  async function supportsImages(): Promise<boolean> {
    const target = currentTarget();
    if (!target) {
      return false;
    }
    try {
      const meta = await lookupMeta(target.presetId, target.baseUrl, target.modelId);
      return !meta || meta.input.includes("image");
    } catch {
      return true;
    }
  }

  return { check, supportsImages };
}

export function imageUnsupportedErrorHint(error: unknown, images: readonly ImagePart[]): string {
  if (!images.length) {
    return "";
  }
  const text = String(error ?? "");
  if (!HTTP_BAD_REQUEST_RE.test(text) || IMAGE_CLUE_RE.test(text)) {
    return "";
  }
  return IMAGE_UNSUPPORTED_ERROR_HINT;
}
