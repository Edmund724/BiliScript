import { createLazyLoader } from "../shared/lazy-import.js";
import type { Settings } from "../core/defaults.js";

interface PresentationDomain {
  hydrateReaderStateFromSettings(settings?: Partial<Settings>): void;
  applyReadingViewPresentation(): void;
  applyPrePaintReaderTheme(settings?: Partial<Settings> | null): unknown;
}

const loader = createLazyLoader<PresentationDomain>(() => import("./presentation.js"));

export async function hydrateReaderStateFromSettings(settings?: Partial<Settings>): Promise<void> {
  const mod = await loader.load();
  mod.hydrateReaderStateFromSettings(settings);
}

export async function applyReadingViewPresentation(): Promise<void> {
  const mod = await loader.load();
  mod.applyReadingViewPresentation();
}

export async function applyPrePaintReaderTheme(settings?: Partial<Settings> | null): Promise<void> {
  const mod = await loader.load();
  mod.applyPrePaintReaderTheme(settings);
}
