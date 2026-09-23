// ui/lazy-model-catalog.ts — 模型目录模块的按需加载器（model-catalog/04）。
//
// 目录产物是构建期数据（85KB，11 provider / 475 模型），只服务设置页平台编辑 Modal
// 的只读展示与对话侧的发图门控（chat/image-support.ts，image-input 05 号票）——
// 首屏与 SW 不该为它买单，所以走 import() 懒加载（不触发这些路径就一次都不加载），
// 不走 fetch(chrome.runtime.getURL)：那要碰 web_accessible_resources、失败降级与
// SW 中转，纯属自找（spec §产物形态）。
//
// 加载器语义与 reader/lazy-reader.ts / ui/lazy-ui.ts 一致（createLazyLoader）：
// 同文档内重复调用共享同一 promise，失败清缓存可重试。额外的 loaded 快照给
// 「同步重算已有 DOM」用（refreshModelCatalogMeta 不能 await）。
//
// 双实例纪律（ADR-0008）：模块级 loader 缓存 + loaded 快照是闭包可变状态。
// 本模块只被懒侧引用（provider-editor 的元数据栏与 chat 门控，都不常驻），构建
// 守卫实测对账；若将来变成双实例，scripts/build-content.js 会报错要求入清单并声明
// BOC_DUAL_INSTANCE_STATEFUL 标记。

import { createLazyLoader } from "../shared/lazy-import.js";

const loader = createLazyLoader(() => import("../ai/model-catalog.js"));

export type ModelCatalogModule = Awaited<ReturnType<typeof loader.load>>;

let loaded: ModelCatalogModule | null = null;

/** 已加载的目录模块；未加载（或加载失败）返回 null——调用方据此静默跳过渲染。 */
export function loadedModelCatalog(): ModelCatalogModule | null {
  return loaded;
}

/** 取目录模块（首次调用触发懒加载并缓存 promise）。 */
export async function loadModelCatalog(): Promise<ModelCatalogModule> {
  if (!loaded) {
    loaded = await loader.load();
  }
  return loaded;
}
