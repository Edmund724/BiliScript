import { writeSnapshotKeys } from "../../extension/core/settings-snapshot.js";
import { SEARCH_PROVIDER_ORDER_STORAGE } from "../../extension/search/search-provider-store.js";

export async function assertWriteSeamHasNoAreaParam(): Promise<void> {
  // @ts-expect-error 区不是入参：写点不得再报区（区由快照键面表决定）
  await writeSnapshotKeys("sync", { [SEARCH_PROVIDER_ORDER_STORAGE]: [] });

  await writeSnapshotKeys({ [SEARCH_PROVIDER_ORDER_STORAGE]: [] });
}
