import type { Chapter } from "../bilibili/gateway.js";

const normalizeChaptersCache = new WeakMap<object, Chapter[]>();

export function normalizeChapters(chapters: unknown[] | null | undefined): Chapter[] {
  if (Array.isArray(chapters)) {
    const cached = normalizeChaptersCache.get(chapters);
    if (cached) {
      return cached;
    }
    const normalized = normalizeChaptersUncached(chapters);
    normalizeChaptersCache.set(chapters, normalized);
    return normalized;
  }
  return normalizeChaptersUncached(chapters || []);
}

function normalizeChaptersUncached(chapters: unknown[]): Chapter[] {
  const normalized = chapters
    .map((item) => ({
      title: String((item as { title?: string }).title || "").trim(),
      from: Number((item as { from?: unknown }).from || 0) || 0,
      to: Number((item as { to?: unknown }).to || 0) || 0,
      source: String((item as { source?: string }).source || "")
    }))
    .filter((item) => item.title && item.from >= 0)
    .sort((a, b) => a.from - b.from);

  const unique: Chapter[] = [];
  const seen = new Set<string>();
  normalized.forEach((item) => {
    const key = `${Math.floor(item.from * 10)}|${item.title.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(item);
  });

  return unique;
}
