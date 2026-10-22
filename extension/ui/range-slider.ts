// ui/range-slider.ts — <input type="range" class="biliscript-range-input"> 进度视觉同步

export function syncRangeProgress(input: HTMLInputElement | null | undefined): void {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const val = Number(input.value) || min;
  const pct = max > min ? Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100)) : 0;
  input.style.setProperty("--range-progress", `${pct}%`);
}

export function initRangeSlider(input: HTMLInputElement | null | undefined): void {
  if (!input) return;
  syncRangeProgress(input);
  if (!input.dataset.rangeInitialized) {
    input.dataset.rangeInitialized = "true";
    input.addEventListener("input", () => syncRangeProgress(input));
  }
}
