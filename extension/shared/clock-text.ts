export type ClockHoursMode = "auto" | "never" | "always";

export interface ClockFormatOptions {
  hours?: ClockHoursMode;
}

const HOUR_SECONDS = 3600;

export function shouldUseHours(seconds: unknown): boolean {
  return (Number(seconds) || 0) >= HOUR_SECONDS;
}

export function shouldUseHoursForRange(from: unknown, to: unknown): boolean {
  return shouldUseHours(from) || shouldUseHours(to);
}

export function formatClock(seconds: unknown, options: ClockFormatOptions = {}): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = options.hours ?? "never";
  const withHours =
    hours === "always" || (hours === "auto" && shouldUseHours(total));
  const second = total % 60;
  if (!withHours) {
    return `${Math.floor(total / 60)}:${String(second).padStart(2, "0")}`;
  }
  const minute = Math.floor((total % HOUR_SECONDS) / 60);
  return `${Math.floor(total / HOUR_SECONDS)}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

export function parseClock(text: unknown): number | null {
  const parts = String(text ?? "")
    .trim()
    .split(":")
    .map(Number);
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  const three = parts.length === 3;
  const hh = three ? parts[0] : 0;
  const mm = three ? parts[1] : parts[0];
  const ss = three ? parts[2] : parts[1];
  if (ss >= 60) {
    return null;
  }
  if (three && (hh >= 24 || mm >= 60)) {
    return null;
  }
  return hh * 3600 + mm * 60 + ss;
}

export function parseTimestampSeconds(text: unknown): number[] {
  try {
    const s = String(text == null ? "" : text);
    const out: number[] = [];
    const seen = new Set<number>();
    for (const match of s.matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g)) {
      const seconds = parseClock(match[0]);
      if (seconds === null || seen.has(seconds)) continue;
      seen.add(seconds);
      out.push(seconds);
    }
    return out.sort((a, b) => a - b);
  } catch {
    return [];
  }
}
