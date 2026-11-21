import { createLazyLoader } from "../shared/lazy-import.js";

const loader = createLazyLoader(() => import("../ai/model-catalog.js"));

export type ModelCatalogModule = Awaited<ReturnType<typeof loader.load>>;

let loaded: ModelCatalogModule | null = null;

export function loadedModelCatalog(): ModelCatalogModule | null {
  return loaded;
}

export async function loadModelCatalog(): Promise<ModelCatalogModule> {
  if (!loaded) {
    loaded = await loader.load();
  }
  return loaded;
}
