import { clipState, state } from "../core/state.js";
import type { SubtitleBodyItem } from "../core/state.js";

export interface AlignableMainSegment {
  from: number;
  to: number;
}

export interface SecondaryAlignment {
  query(main: AlignableMainSegment): string | null;
}

interface NormalizedSegment {
  from: number;
  to: number;
  content: string;
}

function normalizeSecondary(secondary: readonly SubtitleBodyItem[] | null | undefined): NormalizedSegment[] {
  const out: NormalizedSegment[] = [];
  for (const item of secondary || []) {
    const content = String(item?.content ?? "").trim();
    if (!content) {
      continue;
    }
    out.push({
      from: Number(item?.from ?? 0) || 0,
      to: Number(item?.to ?? 0) || 0,
      content
    });
  }
  return out;
}

export function buildSecondaryAlignment(secondary: readonly SubtitleBodyItem[] | null | undefined): SecondaryAlignment {
  const segments = normalizeSecondary(secondary);
  const froms = segments.map((segment) => segment.from);
  return {
    query(main: AlignableMainSegment): string | null {
      const mainFrom = Number(main?.from ?? 0) || 0;
      const mainTo = Number(main?.to ?? 0) || 0;
      if (!(mainTo > mainFrom)) {
        return null;
      }
      let left = 0;
      let right = froms.length;
      while (left < right) {
        const mid = (left + right) >> 1;
        if (froms[mid] <= mainFrom) {
          left = mid + 1;
        } else {
          right = mid;
        }
      }
      const parts: string[] = [];
      for (let index = Math.max(0, left - 1); index < segments.length && froms[index] < mainTo; index += 1) {
        const segment = segments[index];
        if (Math.min(segment.to, mainTo) > Math.max(segment.from, mainFrom)) {
          parts.push(segment.content);
        }
      }
      return parts.length ? parts.join(" ") : null;
    }
  };
}

let memoizedSecondaryBody: unknown = null;
let memoizedSecondaryAlignment: SecondaryAlignment | null = null;

export function secondaryAlignmentFor(body: SubtitleBodyItem[]): SecondaryAlignment {
  if (memoizedSecondaryBody !== body || !memoizedSecondaryAlignment) {
    memoizedSecondaryAlignment = buildSecondaryAlignment(body);
    memoizedSecondaryBody = body;
  }
  return memoizedSecondaryAlignment;
}

export function secondaryContentFor(main: AlignableMainSegment): string | null {
  if (!state.settings.bilingualSubtitles) {
    return null;
  }
  const slot = clipState.secondarySubtitle;
  if (!slot || slot.state !== "ready") {
    return null;
  }
  const body = slot.body;
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }
  return secondaryAlignmentFor(body).query(main);
}

export interface SecondaryLineSource {
  from?: unknown;
  to?: unknown;
}

export type SecondaryLineResolver = (item: SecondaryLineSource) => string | null;

export function createSecondaryLineResolver(): SecondaryLineResolver | undefined {
  if (!state.settings.bilingualSubtitles) {
    return undefined;
  }
  return (item) =>
    secondaryContentFor({
      from: Number(item?.from ?? 0) || 0,
      to: Number(item?.to ?? 0) || 0
    });
}
