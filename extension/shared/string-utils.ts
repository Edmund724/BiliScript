export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

export function decodeHtmlEntities(value: unknown): string {
  return String(value ?? "").replace(
    /&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]*);/g,
    (raw, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
          return raw;
        }
        try {
          return String.fromCodePoint(code);
        } catch {
          return raw;
        }
      }
      const named = HTML_ENTITY_MAP[body];
      return named === undefined ? raw : named;
    }
  );
}

export function formatTimestamp(seconds: number | string, forSrt = false): string {
  const safe = Number(seconds) || 0;
  const msTotal = Math.max(0, Math.floor(safe * 1000));
  const hour = Math.floor(msTotal / 3600000);
  const minute = Math.floor((msTotal % 3600000) / 60000);
  const second = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  if (!forSrt) {
    return `${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}`;
  }

  return `${hh}:${mm}:${ss},${String(ms).padStart(3, "0")}`;
}

export function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}
