export interface SniffedSabrTemplate {
  url: string;
  body: Uint8Array;
  videoId: string;
  observedAudioItag: number;
  observedAudioXtags: string;
  capturedAt: number;
  expireSec: number;
}

export interface SabrSnifferSlot {
  installed: boolean;
  origFetch: typeof window.fetch;
  latest: SniffedSabrTemplate | null;
  byVideoId: Map<string, SniffedSabrTemplate>;
}

const SNIFFER_SLOT_KEY = "biliscript.ytSabrSniffer.v1";
const BODY_LIMIT = 65536;
const RESPONSE_SNIFF_LIMIT = 262144;
const SNIFF_READ_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_SNIFFS = 2;
const MAX_CACHED_VIDEOS = 6;
const EXPIRE_MARGIN_SEC = 30;
const DECODER = new TextDecoder();

function isAdPlaying(): boolean {
  try {
    const p = document.getElementById("movie_player");
    return Boolean(p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")));
  } catch {
    return false;
  }
}

function currentVideoId(): string {
  try {
    const p = document.getElementById("movie_player") as
      | (HTMLElement & { getVideoData?: () => { video_id?: unknown } | null })
      | null;
    const id = String(p?.getVideoData?.()?.video_id || "").trim();
    if (id) return id;
  } catch {
  }
  try {
    return new URL(location.href).searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function parseFreshGooglevideoExpire(rawUrl: string): number {
  try {
    const u = new URL(rawUrl, location.href);
    if (u.protocol !== "https:" || u.pathname !== "/videoplayback") return -1;
    const h = u.hostname.toLowerCase();
    if (h !== "googlevideo.com" && !h.endsWith(".googlevideo.com")) return -1;
    const exp = Number(u.searchParams.get("expire")) || 0;
    if (exp > 0 && exp <= Math.floor(Date.now() / 1000) + EXPIRE_MARGIN_SEC) return -1;
    return exp;
  } catch {
    return -1;
  }
}

function readUmpVarint(u8: Uint8Array, pos: number, end: number): { v: number; n: number } | null {
  if (pos >= end) return null;
  const b = u8[pos];
  if (b < 128) return { v: b, n: pos + 1 };
  if (b < 192) return pos + 2 <= end ? { v: (b & 0x3f) + (u8[pos + 1] << 6), n: pos + 2 } : null;
  if (b < 224) {
    return pos + 3 <= end
      ? { v: (b & 0x1f) + (u8[pos + 1] << 5) + (u8[pos + 2] << 13), n: pos + 3 }
      : null;
  }
  if (b < 240) {
    return pos + 4 <= end
      ? { v: ((b & 0x0f) + (u8[pos + 1] << 4) + (u8[pos + 2] << 12) + (u8[pos + 3] << 20)) >>> 0, n: pos + 4 }
      : null;
  }
  return pos + 5 <= end
    ? { v: (u8[pos + 1] | (u8[pos + 2] << 8) | (u8[pos + 3] << 16) | (u8[pos + 4] << 24)) >>> 0, n: pos + 5 }
    : null;
}

function readProtoVarintNum(u8: Uint8Array, pos: number, end: number): { v: number; n: number } | null {
  let v = 0;
  let shift = 0;
  let p = pos;
  while (p < end && shift < 49) {
    const b = u8[p++];
    v += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { v, n: p };
    shift += 7;
  }
  return null;
}

function sniffUmpMeta(u8: Uint8Array): { videoId: string; itag: number; xtags: string } {
  let videoId = "";
  let itag = 0;
  let xtags = "";
  let p = 0;
  while (p < u8.length) {
    const t = readUmpVarint(u8, p, u8.length);
    if (!t) break;
    const s = readUmpVarint(u8, t.n, u8.length);
    if (!s || s.n + s.v > u8.length) break;
    const start = s.n;
    const end = s.n + s.v;
    p = end;
    if (t.v !== 20 && t.v !== 42) continue;

    let q = start;
    let partMime = "";
    let fmtItag = 0;
    let fmtXtags = "";
    while (q < end) {
      const tag = readProtoVarintNum(u8, q, end);
      if (!tag) break;
      const fn = Math.floor(tag.v / 8);
      const wt = tag.v & 7;
      q = tag.n;
      if (wt === 0) {
        const val = readProtoVarintNum(u8, q, end);
        if (!val) break;
        q = val.n;
      } else if (wt === 1) {
        q += 8;
      } else if (wt === 5) {
        q += 4;
      } else if (wt === 2) {
        const len = readProtoVarintNum(u8, q, end);
        if (!len || len.n + len.v > end) break;
        const slice = u8.subarray(len.n, len.n + len.v);
        q = len.n + len.v;
        if (t.v === 20 && fn === 2 && !videoId) videoId = DECODER.decode(slice);
        else if (t.v === 42 && fn === 1 && !videoId) videoId = DECODER.decode(slice);
        else if (t.v === 42 && fn === 5) partMime = DECODER.decode(slice);
        else if (t.v === 42 && fn === 2) {
          let fq = 0;
          while (fq < slice.length) {
            const ft = readProtoVarintNum(slice, fq, slice.length);
            if (!ft) break;
            const ffn = Math.floor(ft.v / 8);
            const fwt = ft.v & 7;
            fq = ft.n;
            if (fwt === 0) {
              const fv = readProtoVarintNum(slice, fq, slice.length);
              if (!fv) break;
              fq = fv.n;
              if (ffn === 1) fmtItag = fv.v;
            } else if (fwt === 2) {
              const fl = readProtoVarintNum(slice, fq, slice.length);
              if (!fl || fl.n + fl.v > slice.length) break;
              if (ffn === 3) fmtXtags = DECODER.decode(slice.subarray(fl.n, fl.n + fl.v));
              fq = fl.n + fl.v;
            } else if (fwt === 1) {
              fq += 8;
            } else if (fwt === 5) {
              fq += 4;
            } else {
              break;
            }
          }
        }
      } else {
        break;
      }
    }
    if (t.v === 42 && partMime.startsWith("audio/") && fmtItag > 0) {
      itag = fmtItag;
      xtags = fmtXtags;
    }
  }
  return { videoId, itag, xtags };
}

function cloneSyncBytes(b: unknown): Uint8Array | null {
  if (b instanceof ArrayBuffer) {
    return b.byteLength > 0 && b.byteLength <= BODY_LIMIT ? new Uint8Array(b.slice(0)) : null;
  }
  if (ArrayBuffer.isView(b)) {
    return b.byteLength > 0 && b.byteLength <= BODY_LIMIT
      ? new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
      : null;
  }
  return null;
}

function captureBody(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Uint8Array | null> | null {
  const b = init?.body;
  const sync = cloneSyncBytes(b);
  if (sync) return Promise.resolve(sync);
  if (typeof Blob !== "undefined" && b instanceof Blob) {
    if (b.size <= 0 || b.size > BODY_LIMIT) return null;
    return b
      .arrayBuffer()
      .then((buf) => (buf.byteLength > 0 && buf.byteLength <= BODY_LIMIT ? new Uint8Array(buf) : null))
      .catch(() => null);
  }
  if (typeof Request !== "undefined" && input instanceof Request && !b) {
    try {
      const cloned = input.clone();
      return cloned
        .arrayBuffer()
        .then((buf) => (buf.byteLength > 0 && buf.byteLength <= BODY_LIMIT ? new Uint8Array(buf) : null))
        .catch(() => null);
    } catch {
      return null;
    }
  }
  return null;
}

async function readHead(res: Response): Promise<Uint8Array | null> {
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/vnd.yt-ump")) return null;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > 0 ? new Uint8Array(buf, 0, Math.min(buf.byteLength, RESPONSE_SNIFF_LIMIT)) : null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, SNIFF_READ_TIMEOUT_MS);
  try {
    while (!timedOut && total < RESPONSE_SNIFF_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      chunks.push(value);
      total += value.byteLength;
    }
    reader.cancel().catch(() => {});
  } catch {
  } finally {
    clearTimeout(timer);
  }
  if (!total) return null;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function recordTemplate(
  slot: SabrSnifferSlot,
  url: string,
  expireSec: number,
  reqBody: Uint8Array,
  umpBytes: Uint8Array,
  vidAtReq: string
): void {
  if (isAdPlaying()) return;
  const meta = sniffUmpMeta(umpBytes);
  const curVid = currentVideoId();
  const videoId = meta.videoId || vidAtReq || curVid;
  if (!videoId || (curVid && meta.videoId && meta.videoId !== curVid)) return;
  const tpl: SniffedSabrTemplate = {
    url,
    body: reqBody,
    videoId,
    observedAudioItag: meta.itag,
    observedAudioXtags: meta.xtags,
    capturedAt: Date.now(),
    expireSec
  };
  slot.latest = tpl;
  slot.byVideoId.delete(videoId);
  slot.byVideoId.set(videoId, tpl);
  while (slot.byVideoId.size > MAX_CACHED_VIDEOS) {
    const first = slot.byVideoId.keys().next().value;
    if (first === undefined) break;
    slot.byVideoId.delete(first);
  }
}

(function install(): void {
  const sym = Symbol.for(SNIFFER_SLOT_KEY);
  const g = globalThis as Record<symbol, SabrSnifferSlot | undefined>;
  if (g[sym]?.installed) return;
  const origFetch = window.fetch;
  if (typeof origFetch !== "function") return;
  const slot: SabrSnifferSlot = { installed: true, origFetch, latest: null, byVideoId: new Map() };
  g[sym] = slot;
  let active = 0;

  window.fetch = function biliscriptYtSabrFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    let url = "";
    let expireSec = -1;
    let bodyPromise: Promise<Uint8Array | null> | null = null;
    let vidAtReq = "";

    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : typeof (input as Request)?.url === "string"
              ? (input as Request).url
              : "";
      const method = (
        typeof init?.method === "string" && init.method
          ? init.method
          : typeof (input as Request)?.method === "string"
            ? (input as Request).method
            : "GET"
      ).toUpperCase();
      if (
        active < MAX_CONCURRENT_SNIFFS &&
        method === "POST" &&
        url.includes(".googlevideo.com/videoplayback") &&
        !isAdPlaying()
      ) {
        expireSec = parseFreshGooglevideoExpire(url);
        if (expireSec >= 0) {
          vidAtReq = currentVideoId();
          bodyPromise = captureBody(input, init);
        }
      }
    } catch {
      bodyPromise = null;
    }

    const p = Reflect.apply(origFetch, this, arguments) as Promise<Response>;

    if (!bodyPromise) {
      return p;
    }

    const capUrl = url;
    const capExp = expireSec;
    const capVid = vidAtReq;
    const capBodyPromise = bodyPromise;

    return p.then((res) => {
      try {
        if (res && res.ok && !isAdPlaying() && active < MAX_CONCURRENT_SNIFFS) {
          const ct = String(res.headers.get("content-type") || "").toLowerCase();
          if (ct.includes("application/vnd.yt-ump")) {
            const clonedRes = res.clone();
            active += 1;
            void Promise.all([capBodyPromise, readHead(clonedRes)])
              .then(([reqBody, head]) => {
                if (!reqBody || !head) return;
                recordTemplate(slot, capUrl, capExp, reqBody, head, capVid);
              })
              .catch(() => {})
              .finally(() => {
                active = Math.max(0, active - 1);
              });
          }
        }
      } catch {
      }
      return res;
    });
  };

  if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype) {
    type TrackedXhr = XMLHttpRequest & {
      __bsMethod?: string;
      __bsUrl?: string;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function biliscriptYtSabrXhrOpen(
      this: TrackedXhr,
      method: string,
      url: string | URL
    ): void {
      try {
        this.__bsMethod = String(method || "").toUpperCase();
        this.__bsUrl = typeof url === "string" ? url : url instanceof URL ? url.href : String(url || "");
      } catch {
      }
      return Reflect.apply(origOpen, this, arguments) as void;
    };
    XMLHttpRequest.prototype.send = function biliscriptYtSabrXhrSend(
      this: TrackedXhr,
      body?: Document | XMLHttpRequestBodyInit | null
    ): void {
      try {
        const u = this.__bsUrl || "";
        if (
          this.__bsMethod === "POST" &&
          u.includes(".googlevideo.com/videoplayback") &&
          !isAdPlaying()
        ) {
          const exp = parseFreshGooglevideoExpire(u);
          const reqBody = cloneSyncBytes(body);
          if (exp >= 0 && reqBody) {
            const vidAtReq = currentVideoId();
            this.addEventListener(
              "load",
              () => {
                try {
                  if (this.status < 200 || this.status >= 300) return;
                  const ct = String(this.getResponseHeader("content-type") || "").toLowerCase();
                  if (!ct.includes("application/vnd.yt-ump")) return;
                  const resp = this.response;
                  if (resp instanceof ArrayBuffer && resp.byteLength > 0) {
                    const head = new Uint8Array(resp, 0, Math.min(resp.byteLength, RESPONSE_SNIFF_LIMIT));
                    recordTemplate(slot, u, exp, reqBody, head, vidAtReq);
                  }
                } catch {
                }
              },
              { once: true }
            );
          }
        }
      } catch {
      }
      return Reflect.apply(origSend, this, arguments) as void;
    };
  }
})();
