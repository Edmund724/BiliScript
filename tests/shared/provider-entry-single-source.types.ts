import type { AiProvider } from "../../extension/core/ai-provider-store.js";
import type { ProviderListEntry } from "../../extension/shared/messaging-protocol.js";

type AiProduct = AiProvider & { hasSavedKey: boolean };

declare const product: AiProduct;
declare const entry: ProviderListEntry;

export function assertProviderEntrySingleSource(): void {
  const asEntry: ProviderListEntry = product;
  // @ts-expect-error 反向：协议条目缺精确必需字段，不可赋给 store 产物
  const asProduct: AiProduct = entry;
  void asEntry;
  void asProduct;
}
