// ui/range-slider.ts — <input type="range" class="biliscript-range-input"> 进度同步与可重置滑块组件

export interface ResettableRangeSliderOptions {
  input: HTMLInputElement | null | undefined;
  badge: HTMLElement | null | undefined;
  resetBtn: HTMLButtonElement | null | undefined;
  defaultValue: number;
  normalize: (raw: unknown) => number;
  format?: (val: number) => string;
  initialValue?: unknown;
  onPreview?: (val: number) => void;
  onCommit?: (val: number) => void | Promise<void>;
}

export interface ResettableRangeSlider {
  setValue: (raw: unknown) => number;
}

interface SliderRecord {
  options: ResettableRangeSliderOptions & {
    input: HTMLInputElement;
    badge: HTMLElement;
    resetBtn: HTMLButtonElement;
  };
  boundResetBtns: WeakSet<HTMLButtonElement>;
  controller: ResettableRangeSlider;
}

const sliderRegistry = new WeakMap<HTMLInputElement, SliderRecord>();
const pendingRawValues = new WeakMap<HTMLInputElement, unknown>();

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

export function setResettableRangeValue(
  input: HTMLInputElement | null | undefined,
  raw: unknown
): void {
  if (!input) return;
  const record = sliderRegistry.get(input);
  if (record) {
    record.controller.setValue(raw);
    return;
  }
  pendingRawValues.set(input, raw);
  if (raw !== undefined && raw !== null) {
    input.value = String(raw);
  }
  syncRangeProgress(input);
}

export function bindResettableRangeSlider(
  options: ResettableRangeSliderOptions
): ResettableRangeSlider {
  const { input, badge, resetBtn } = options;
  if (!input || !badge || !resetBtn) {
    return {
      setValue: (raw: unknown) => options.normalize(raw)
    };
  }

  const resolvedOptions = {
    ...options,
    input,
    badge,
    resetBtn
  };

  initRangeSlider(input);

  let record = sliderRegistry.get(input);
  if (!record) {
    const applyValue = (raw: unknown): number => {
      const current = record!.options;
      const val = current.normalize(raw);
      current.input.value = String(val);
      syncRangeProgress(current.input);
      current.badge.textContent = (current.format ?? String)(val);
      current.resetBtn.disabled = val === current.defaultValue;
      return val;
    };

    record = {
      options: resolvedOptions,
      boundResetBtns: new WeakSet<HTMLButtonElement>(),
      controller: {
        setValue: applyValue
      }
    };
    sliderRegistry.set(input, record);

    input.addEventListener("input", () => {
      const val = applyValue(record!.options.input.value);
      record!.options.onPreview?.(val);
    });

    input.addEventListener("change", () => {
      const val = applyValue(record!.options.input.value);
      void record!.options.onCommit?.(val);
    });
  } else {
    record.options = resolvedOptions;
  }

  if (!record.boundResetBtns.has(resetBtn)) {
    record.boundResetBtns.add(resetBtn);
    resetBtn.addEventListener("click", () => {
      const val = record!.controller.setValue(record!.options.defaultValue);
      record!.options.onPreview?.(val);
      void record!.options.onCommit?.(val);
    });
  }

  let initialSeed: unknown;
  if (options.initialValue !== undefined) {
    initialSeed = options.initialValue;
  } else if (pendingRawValues.has(input)) {
    initialSeed = pendingRawValues.get(input);
  } else {
    initialSeed = input.value;
  }
  pendingRawValues.delete(input);
  record.controller.setValue(initialSeed);

  return record.controller;
}
