// extension/chat/image-support.ts — 图片支持的门控与降级（image-input 05 号票）。
//
// 决策（spec §门控：乐观放行）：
//   - 目录有 input 数据且不含 image → 提示「该模型可能不支持图片」，**不阻断发送**；
//   - 目录查不到（含 7 个永远没有目录数据的 preset）→ 静默放行，支不支持交给平台
//     400 报错兜底；
//   - 不做严格门控、不手工补一份「哪些模型支持图片」的事实表。
//
// 两半职责：
//   ① createImageSupportGate —— 带图消息发送受理时（组合根包在 deps.takeInputImages
//      外侧）查目录：只有「目录明确登记不收图」才经提示通道说一句，其余一律静默。
//      判定放在发送受理点而不是粘贴时：粘贴与发送之间用户可以换模型，以实际要用的
//      那个模型为准才不会两个方向都误报。
//   ② imageUnsupportedErrorHint —— 平台 400 的用户可见文案兜底：平台 detail 自己
//      说了图片相关（既有 extractErrorDetail 的透传）就不补，无线索才补一句。
//
// 目录模块（ai/model-catalog.ts 与它的 85KB 产物）是懒加载的零依赖叶子
// （model-catalog 不变式 5）：查询只能经 ui/lazy-model-catalog 的动态 import()，
// 不得进 content script 的静态图。查表口径与设置页只读元数据栏同源
// （lookupCatalogMeta = resolvePiProvider + lookupModelMeta），不在此另写一份识别。

import type { ImagePart } from "../ai/types.js";
// 对目录模块只取类型（import type 不成运行时边）；值侧走下面这个懒加载器。
import type { CatalogModelMeta } from "../ai/model-catalog.js";
import { loadModelCatalog } from "../ui/lazy-model-catalog.js";
import { chatSessionState } from "./chat-state.js";
import { parseModelOptionValue } from "./providers.js";

// 查表结果只取 input 一个字段（能力事实）：结构上是目录元数据的窄面（Pick 单源，
// 与 ai/ladder.ts 的 BudgetPlan 同款收窄），测试替身少填字段也能过编译。
export type ImageSupportMeta = Pick<CatalogModelMeta, "input">;

export type ImageSupportLookup = (
  presetId: string | undefined,
  baseUrl: string | undefined,
  modelId: string
) => Promise<ImageSupportMeta | null>;

export interface ImageSupportGateDeps {
  // 选中项的复合值（chat/providers.ts 的 MODEL_OPTION_SEPARATOR 编码）。平台记录
  //（presetId / baseUrl）沿 chatSessionState.providers 读——与思考档位提示
  //（reader/chat-tab-core 的 updateThinkingHint）同一套识别入参，不开新消息链。
  getSelectedModelValue: () => string;
  // 用户可见提示出口（组合根接消息区通知条 showConversationContextNotice）
  notify: (message: string) => void;
  // 目录查询接缝：缺省动态 import ../ai/model-catalog.js（懒加载）；测试注入替身。
  lookupMeta?: ImageSupportLookup;
}

export interface ImageSupportGate {
  /** 带图消息被发送受理时调用：只有目录明确登记不收图才提示，其余（含查不到与查询失败）静默。 */
  check(images: readonly ImagePart[]): void;
}

// 门控提示（乐观放行：只提示、不阻断）
export const IMAGE_UNSUPPORTED_NOTICE = "当前模型可能不支持图片，发送可能失败；如需图片理解请换用支持图片的模型";

// 400 兜底提示：平台文案不含图片线索时补上，给一条可操作出路
export const IMAGE_UNSUPPORTED_ERROR_HINT = "（可能是模型不支持图片，请换用支持图片的模型，或移除图片后重试）";

// HTTP 400 的形状来自错误归一化（ai/completion.ts makeHttpError 的
// `HTTP <status>: <detail>`，detail 经 adapter.extractErrorDetail 透传）；图片线索
// 覆盖中英文常见说法——平台已自己说明原因时不再补话，避免盖过更具体的平台理由。
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

  // 选中模型的身份：复合值解析出平台 id 与模型 id，再到 providers 取该平台的
  // presetId / baseUrl（custom 与未知预设的 host 兜底在 lookupCatalogMeta 内部）。
  // 解析不出模型（未配置平台 / 旧裸 id）即无身份可比，不做任何判断。
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
      // 查不到（该平台/该模型没有目录数据）静默放行；目录登记了 image 也不提示。
      if (!meta || meta.input.includes("image")) {
        return;
      }
      deps.notify(IMAGE_UNSUPPORTED_NOTICE);
    })().catch(() => {
      // 目录加载/查询失败：门控是提示不是闸，失败一律静默放行（交给平台 400 兜底），
      // 也不把未捕获拒绝漏进消息区。
    });
  }

  return { check };
}

/**
 * 平台 400 回执的用户可见文案兜底：本次消息带图、错误是 HTTP 400、且文案里没有任何
 * 图片线索时，返回一句可操作提示；否则返回空串（沿用平台 detail 的透传文案）。
 */
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
