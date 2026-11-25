import {
  SABR_BODY_LIMIT,
  STREAM_PROTECTION_REJECTED,
  YOUTUBE_SABR_CHANNEL,
  YOUTUBE_SABR_SNIFFER_SLOT_KEY,
  YOUTUBE_SABR_WORKER_SLOT_KEY,
  buildSabrRequestUrl,
  decodeBase64UrlToBytes,
  generateCpn,
  isGooglevideoUrlFresh,
  isValidGooglevideoUrl,
  parseUmpResponse,
  rewriteSabrAbrRequest,
  selectTargetYoutubeAudioFormat,
  selectTargetYoutubeVideoFormat,
  synthesizeSabrTemplateBody,
  type SabrFormatId,
  type SelectedYoutubeAudioFormat,
  type UmpMediaSegment,
  type YoutubeAdaptiveFormatLike
} from "./sabr-protocol.js";
import type { SabrSnifferSlot, SniffedSabrTemplate } from "./sabr-sniffer.main.js";

interface PlayerLike extends HTMLElement {
  getPlayerResponse?: () => Record<string, unknown> | null;
  getVideoData?: () => { video_id?: unknown; isLive?: unknown } | null;
  getAudioTrack?: () => { id?: unknown; languageCode?: unknown; displayName?: unknown } | null;
}

interface YtCfgLike {
  get?: (key: string) => unknown;
  data_?: Record<string, unknown>;
}

const MAX_SABR_ROUNDS = 400;
const MAX_CONSECUTIVE_EMPTY_ROUNDS = 5;
const MAX_BACKOFF_MS = 15_000;
const SABR_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CUMULATIVE_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_WINDOW_ROUNDS = 5;
const MAX_VIDEO_WINDOW_BYTES = 24 * 1024 * 1024;

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getMoviePlayer(): PlayerLike | null {
  return document.getElementById("movie_player") as PlayerLike | null;
}

function isAdActive(player: PlayerLike | null): boolean {
  if (!player) return false;
  return (
    player.classList.contains("ad-showing") ||
    player.classList.contains("ad-interrupting")
  );
}

function readYtcfg(key: string): unknown {
  const ytcfg = asObj((window as unknown as { ytcfg?: unknown }).ytcfg) as YtCfgLike | null;
  if (!ytcfg) return undefined;
  try {
    if (typeof ytcfg.get === "function") {
      return ytcfg.get(key);
    }
  } catch {
  }
  return asObj(ytcfg.data_)?.[key];
}

function readPlayerResponse(player: PlayerLike | null): Record<string, unknown> | null {
  try {
    const live = asObj(player?.getPlayerResponse?.());
    if (live) return live;
  } catch {
  }
  return asObj((window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse);
}

function readActiveAudioTrackId(player: PlayerLike | null): string {
  try {
    const track = player?.getAudioTrack?.();
    const id = String(track?.id || "").trim();
    if (id) return id;
  } catch {
  }
  return "";
}

function readPlayerVideoId(player: PlayerLike | null, playerResponse: Record<string, unknown> | null): string {
  try {
    const fromData = String(player?.getVideoData?.()?.video_id || "").trim();
    if (fromData) return fromData;
  } catch {
  }
  const details = asObj(playerResponse?.videoDetails);
  const fromResp = String(details?.videoId || "").trim();
  if (fromResp) return fromResp;
  try {
    return new URL(location.href).searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function isLiveStreamingNow(playerResponse: Record<string, unknown> | null): boolean {
  const details = asObj(playerResponse?.videoDetails);
  const microformat = asObj(asObj(playerResponse?.microformat)?.playerMicroformatRenderer);
  const liveBroadcast = asObj(microformat?.liveBroadcastDetails);
  if (details?.isLive === true || liveBroadcast?.isLiveNow === true) {
    return true;
  }
  return false;
}

function getSniffedTemplate(expectedVideoId: string): SniffedSabrTemplate | null {
  const slotSym = Symbol.for(YOUTUBE_SABR_SNIFFER_SLOT_KEY);
  const slot = (globalThis as Record<symbol, SabrSnifferSlot | undefined>)[slotSym];
  if (!slot) return null;
  const byId = expectedVideoId ? slot.byVideoId.get(expectedVideoId) : null;
  const candidate = byId || (slot.latest?.videoId === expectedVideoId ? slot.latest : null);
  if (!candidate) return null;
  if (!isGooglevideoUrlFresh(candidate.url)) return null;
  if (!(candidate.body instanceof Uint8Array) || candidate.body.byteLength === 0 || candidate.body.byteLength > SABR_BODY_LIMIT) {
    return null;
  }
  return candidate;
}

function extractParameterCandidate(
  playerResponse: Record<string, unknown>,
  targetFormat: Pick<SelectedYoutubeAudioFormat, "itag" | "lastModified" | "xtags">,
  mediaType: 1 | 2 = 1
): { url: string; body: Uint8Array } | null {
  const streamingData = asObj(playerResponse.streamingData);
  const serverAbrStreamingUrl = String(streamingData?.serverAbrStreamingUrl || "").trim();
  if (!serverAbrStreamingUrl || !isGooglevideoUrlFresh(serverAbrStreamingUrl)) {
    return null;
  }

  const playerConfig = asObj(playerResponse.playerConfig);
  const mediaCommonConfig = asObj(playerConfig?.mediaCommonConfig);
  const sabrConfig = asObj(mediaCommonConfig?.mediaUstreamerRequestConfig);
  const ustreamerConfigB64 = String(sabrConfig?.videoPlaybackUstreamerConfig || "").trim();
  if (!ustreamerConfigB64) {
    return null;
  }
  let ustreamerConfig: Uint8Array;
  try {
    ustreamerConfig = decodeBase64UrlToBytes(ustreamerConfigB64);
  } catch {
    return null;
  }
  if (ustreamerConfig.length === 0) {
    return null;
  }

  const rawClientName = Number(readYtcfg("INNERTUBE_CONTEXT_CLIENT_NAME"));
  const clientName = Number.isFinite(rawClientName) && rawClientName > 0 ? rawClientName : 1;
  const clientVersion = String(readYtcfg("INNERTUBE_CONTEXT_CLIENT_VERSION") || "").trim();

  const serviceIntegrity = asObj(playerResponse.serviceIntegrityDimensions);
  const poTokenRaw = String(serviceIntegrity?.poToken || "").trim();
  let poToken: Uint8Array | null = null;
  if (poTokenRaw) {
    try {
      poToken = decodeBase64UrlToBytes(poTokenRaw);
    } catch {
      poToken = null;
    }
  }

  const body = synthesizeSabrTemplateBody({
    clientName,
    clientVersion,
    ustreamerConfig,
    poToken,
    mediaType,
    targetFormat: {
      itag: targetFormat.itag,
      lastModified: targetFormat.lastModified,
      xtags: targetFormat.xtags
    }
  });
  return { url: serverAbrStreamingUrl, body };
}

function postToIsolated(payload: Record<string, unknown>, transfer?: Transferable[]): void {
  const origin = window.location.origin;
  if (transfer && transfer.length > 0) {
    window.postMessage({ channel: YOUTUBE_SABR_CHANNEL, ...payload }, origin, transfer);
  } else {
    window.postMessage({ channel: YOUTUBE_SABR_CHANNEL, ...payload }, origin);
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("SABR 会话已中止"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchSabrRound(
  url: string,
  body: Uint8Array,
  signal: AbortSignal
): Promise<Uint8Array> {
  const roundController = new AbortController();
  const onOuterAbort = () => roundController.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => roundController.abort(), SABR_REQUEST_TIMEOUT_MS);
  try {
    const slotSym = Symbol.for(YOUTUBE_SABR_SNIFFER_SLOT_KEY);
    const slot = (globalThis as Record<symbol, SabrSnifferSlot | undefined>)[slotSym];
    const nativeFetch = typeof slot?.origFetch === "function" ? slot.origFetch : window.fetch;
    const res = await nativeFetch.call(window, url, {
      method: "POST",
      credentials: "omit",
      body: body.slice(),
      signal: roundController.signal
    });
    if (!res.ok) {
      throw Object.assign(new Error(`YouTube 音频流请求失败（HTTP ${res.status}）`), {
        code: "SABR_HTTP_ERROR",
        status: res.status
      });
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onOuterAbort);
  }
}

async function runSabrSession(
  sessionId: string,
  expectedVideoId: string,
  signal: AbortSignal
): Promise<void> {
  const player = getMoviePlayer();
  if (isAdActive(player)) {
    throw Object.assign(new Error("当前正在播放广告，请待正片开始后重试语音转写。"), {
      code: "AD_PLAYING"
    });
  }
  const playerResponse = readPlayerResponse(player);
  if (!playerResponse) {
    throw new Error("未读取到 YouTube 播放器数据，请刷新视频页后重试。");
  }
  if (isLiveStreamingNow(playerResponse)) {
    throw Object.assign(new Error("暂不支持 YouTube 直播中视频的语音转写。"), {
      code: "UNSUPPORTED_LIVE"
    });
  }
  const currentVideoId = readPlayerVideoId(player, playerResponse);
  if (expectedVideoId && currentVideoId && currentVideoId !== expectedVideoId) {
    throw new Error("视频已切换，已取消当前音频采集。");
  }
  const videoId = expectedVideoId || currentVideoId;
  if (!videoId) {
    throw new Error("未识别到当前 YouTube 视频 ID。");
  }

  const streamingData = asObj(playerResponse.streamingData);
  const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats)
    ? (streamingData.adaptiveFormats as YoutubeAdaptiveFormatLike[])
    : [];
  const activeAudioTrackId = readActiveAudioTrackId(player);
  let sniffed = getSniffedTemplate(videoId);
  if (!sniffed) {
    for (let waitIdx = 0; waitIdx < 10 && !sniffed && !signal.aborted; waitIdx += 1) {
      await sleepAbortable(150, signal);
      sniffed = getSniffedTemplate(videoId);
    }
  }

  const selectedFormat = selectTargetYoutubeAudioFormat(adaptiveFormats, {
    activeAudioTrackId,
    preferredXtags: sniffed?.observedAudioXtags || "",
    observedAudioItag: sniffed?.observedAudioItag || 0
  });
  if (!selectedFormat) {
    throw new Error("未找到可用的 MP4/AAC 音轨，无法启动语音转写。");
  }

  let baseUrl = "";
  let templateBody: Uint8Array | null = null;
  let usedSniffedTemplate = false;
  if (sniffed) {
    baseUrl = sniffed.url;
    templateBody = sniffed.body;
    usedSniffedTemplate = true;
  } else {
    const candidate = extractParameterCandidate(playerResponse, selectedFormat);
    if (!candidate) {
      throw Object.assign(
        new Error("尚未捕获到播放器音频流令牌，请先播放或拖动一下视频后再重试。"),
        { code: "NO_SABR_TEMPLATE" }
      );
    }
    baseUrl = candidate.url;
    templateBody = candidate.body;
  }

  const targetFormatId: SabrFormatId = {
    itag: selectedFormat.itag,
    lastModified: selectedFormat.lastModified,
    xtags: selectedFormat.xtags
  };

  const cpn = generateCpn(16);
  let rn = 0;
  let playbackCookie: Uint8Array | null = null;
  const sabrContextMap = new Map<number, Uint8Array>();
  const activeContextTypes = new Set<number>();
  const unsentContextTypes = new Set<number>();

  let sentInit = false;
  let endSegmentNumber = 0;
  let highestContiguousSeq = 0;
  let accumulatedDurationMs = 0;
  let totalTransferredBytes = 0;
  let consecutiveEmptyRounds = 0;
  const receivedSeqSet = new Set<number>();
  const pendingOutOfOrder = new Map<number, { data: Uint8Array; durationMs: number }>();

  const emitContiguous = () => {
    while (pendingOutOfOrder.has(highestContiguousSeq + 1)) {
      const nextSeq = highestContiguousSeq + 1;
      const entry = pendingOutOfOrder.get(nextSeq)!;
      pendingOutOfOrder.delete(nextSeq);
      highestContiguousSeq = nextSeq;
      accumulatedDurationMs += Math.max(0, entry.durationMs);
      const copy = entry.data.slice();
      postToIsolated(
        {
          sessionId,
          type: "segment",
          seq: nextSeq,
          buffer: copy.buffer
        },
        [copy.buffer]
      );
    }
  };

  for (let round = 0; round < MAX_SABR_ROUNDS; round += 1) {
    if (signal.aborted) return;

    const curPlayer = getMoviePlayer();
    if (isAdActive(curPlayer)) {
      throw Object.assign(new Error("检测到视频插播广告，已中断当前音频采集，请正片恢复后重试。"), {
        code: "AD_PLAYING"
      });
    }
    const liveVideoId = readPlayerVideoId(curPlayer, null);
    if (liveVideoId && liveVideoId !== videoId) {
      throw new Error("视频已切换，已取消当前音频采集。");
    }
    const liveTrackId = readActiveAudioTrackId(curPlayer);
    if (activeAudioTrackId && liveTrackId && liveTrackId !== activeAudioTrackId) {
      throw new Error("检测到音轨切换，已取消当前音频采集，请重试。");
    }

    const activeContexts: Uint8Array[] = [];
    for (const ctxType of activeContextTypes) {
      const rawCtx = sabrContextMap.get(ctxType);
      if (rawCtx) activeContexts.push(rawCtx);
    }

    const reqBody = rewriteSabrAbrRequest({
      templateBody,
      targetFormat: targetFormatId,
      positionMs: accumulatedDurationMs,
      playbackCookie,
      bufferedRange:
        highestContiguousSeq > 0
          ? {
              formatId: targetFormatId,
              startTimeMs: 0,
              durationMs: accumulatedDurationMs,
              startSegmentIndex: 1,
              endSegmentIndex: highestContiguousSeq
            }
          : null,
      sabrContexts: activeContexts,
      unsentContextTypes: [...unsentContextTypes]
    });

    const reqUrl = buildSabrRequestUrl(baseUrl, cpn, rn);
    rn += 1;

    let rawResp: Uint8Array;
    try {
      rawResp = await fetchSabrRound(reqUrl, reqBody, signal);
    } catch (err) {
      if (!usedSniffedTemplate && (err as { status?: number })?.status === 403) {
        throw Object.assign(
          new Error("尚未捕获到已签名播放器音频流（HTTP 403），请播放视频 1–2 秒后再重试语音转写。"),
          { code: "NO_SIGNED_SABR_URL", status: 403 }
        );
      }
      throw err;
    }
    if (signal.aborted) return;

    const parsed = parseUmpResponse(rawResp);

    if (parsed.streamProtectionStatus === STREAM_PROTECTION_REJECTED) {
      throw Object.assign(
        new Error("YouTube 拒绝了当前音频流令牌（ATTESTATION_REJECTED），请播放视频片刻后重试。"),
        { code: "ATTESTATION_REJECTED" }
      );
    }
    if (parsed.sabrError) {
      throw Object.assign(
        new Error(`YouTube 音频流返回错误（${parsed.sabrError.type || parsed.sabrError.code}）`),
        { code: "SABR_ERROR" }
      );
    }

    if (parsed.redirectUrl && isValidGooglevideoUrl(parsed.redirectUrl)) {
      baseUrl = parsed.redirectUrl;
    }

    for (const update of parsed.contextUpdates) {
      if (update.writePolicy === 2 && sabrContextMap.has(update.type)) {
        continue;
      }
      sabrContextMap.set(update.type, update.raw);
      unsentContextTypes.delete(update.type);
      if (update.sendByDefault) {
        activeContextTypes.add(update.type);
      }
    }
    for (const policy of parsed.contextSendingPolicies) {
      for (const t of policy.startPolicy) {
        if (sabrContextMap.has(t)) {
          activeContextTypes.add(t);
          unsentContextTypes.delete(t);
        }
      }
      for (const t of policy.stopPolicy) {
        activeContextTypes.delete(t);
        unsentContextTypes.add(t);
      }
      for (const t of policy.discardPolicy) {
        activeContextTypes.delete(t);
        sabrContextMap.delete(t);
        unsentContextTypes.delete(t);
      }
    }

    if (parsed.nextRequestPolicy?.playbackCookie) {
      playbackCookie = parsed.nextRequestPolicy.playbackCookie;
    }

    for (const meta of parsed.initMetadatas) {
      if (meta.videoId && meta.videoId !== videoId) {
        continue;
      }
      if (meta.formatId && meta.formatId.itag === targetFormatId.itag && meta.endSegmentNumber > 0) {
        endSegmentNumber = meta.endSegmentNumber;
      }
    }

    let gotNewAudio = false;
    for (const seg of parsed.mediaSegments) {
      if (seg.header.videoId && seg.header.videoId !== videoId) {
        continue;
      }
      if (seg.header.itag && seg.header.itag !== targetFormatId.itag) {
        continue;
      }
      if (seg.header.isInitSeg) {
        if (!sentInit) {
          sentInit = true;
          gotNewAudio = true;
          totalTransferredBytes += seg.data.byteLength;
          const copy = seg.data.slice();
          postToIsolated(
            {
              sessionId,
              type: "init",
              buffer: copy.buffer
            },
            [copy.buffer]
          );
        }
        continue;
      }
      const seq = seg.header.sequenceNumber;
      if (seq < 1 || receivedSeqSet.has(seq)) {
        continue;
      }
      receivedSeqSet.add(seq);
      gotNewAudio = true;
      totalTransferredBytes += seg.data.byteLength;
      if (totalTransferredBytes > MAX_CUMULATIVE_BYTES) {
        throw new Error("音频下载量超出上限（>200MB），已停止下载");
      }
      pendingOutOfOrder.set(seq, {
        data: seg.data,
        durationMs: seg.header.durationMs
      });
    }

    emitContiguous();

    if (endSegmentNumber > 0 && highestContiguousSeq >= endSegmentNumber) {
      postToIsolated({ sessionId, type: "end" });
      return;
    }

    if (gotNewAudio) {
      consecutiveEmptyRounds = 0;
    } else if (!parsed.redirectUrl) {
      consecutiveEmptyRounds += 1;
      if (consecutiveEmptyRounds >= MAX_CONSECUTIVE_EMPTY_ROUNDS) {
        if (sentInit && highestContiguousSeq > 0) {
          postToIsolated({ sessionId, type: "end" });
          return;
        }
        throw new Error("未能从 YouTube 音频流获取到有效音轨分段。");
      }
    }

    const backoffMs = Math.min(
      MAX_BACKOFF_MS,
      Math.max(0, Number(parsed.nextRequestPolicy?.backoffTimeMs) || 0)
    );
    if (backoffMs > 0) {
      await sleepAbortable(backoffMs, signal);
    }
  }

  if (sentInit && highestContiguousSeq > 0) {
    postToIsolated({ sessionId, type: "end" });
    return;
  }
  throw new Error("YouTube 音频流采集超过最大轮次上限。");
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function runSabrVideoWindowSession(
  sessionId: string,
  expectedVideoId: string,
  wantStartMs: number,
  wantEndMs: number,
  signal: AbortSignal
): Promise<void> {
  const player = getMoviePlayer();
  if (isAdActive(player)) {
    throw Object.assign(new Error("当前正在播放广告，请待正片开始后重试历史截帧。"), {
      code: "AD_PLAYING"
    });
  }
  const playerResponse = readPlayerResponse(player);
  if (!playerResponse) {
    throw new Error("未读取到 YouTube 播放器数据，请刷新视频页后重试。");
  }
  if (isLiveStreamingNow(playerResponse)) {
    throw Object.assign(new Error("暂不支持 YouTube 直播中视频的历史时间点截帧。"), {
      code: "UNSUPPORTED_LIVE"
    });
  }
  const currentVideoId = readPlayerVideoId(player, playerResponse);
  if (expectedVideoId && currentVideoId && currentVideoId !== expectedVideoId) {
    throw new Error("视频已切换，已取消当前历史截帧。");
  }
  const videoId = expectedVideoId || currentVideoId;
  if (!videoId) {
    throw new Error("未识别到当前 YouTube 视频 ID。");
  }

  const streamingData = asObj(playerResponse.streamingData);
  const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats)
    ? (streamingData.adaptiveFormats as YoutubeAdaptiveFormatLike[])
    : [];
  const selectedFormat = selectTargetYoutubeVideoFormat(adaptiveFormats, {
    preferredHeight: 720,
    isTypeSupported: (mime) =>
      typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function"
        ? MediaSource.isTypeSupported(mime)
        : true
  });
  if (!selectedFormat) {
    throw new Error("未找到可用的浏览器可解码视频轨，无法截取历史画面。");
  }

  let sniffed = getSniffedTemplate(videoId);
  if (!sniffed) {
    for (let waitIdx = 0; waitIdx < 10 && !sniffed && !signal.aborted; waitIdx += 1) {
      await sleepAbortable(150, signal);
      sniffed = getSniffedTemplate(videoId);
    }
  }

  let baseUrl = "";
  let templateBody: Uint8Array | null = null;
  if (sniffed) {
    baseUrl = sniffed.url;
    templateBody = sniffed.body;
  } else {
    const candidate = extractParameterCandidate(playerResponse, selectedFormat, 2);
    if (!candidate) {
      throw Object.assign(
        new Error("尚未捕获到播放器视频流令牌，请先播放或拖动一下视频后再重试。"),
        { code: "NO_SABR_TEMPLATE" }
      );
    }
    baseUrl = candidate.url;
    templateBody = candidate.body;
  }

  const targetFormatId: SabrFormatId = {
    itag: selectedFormat.itag,
    lastModified: selectedFormat.lastModified,
    xtags: selectedFormat.xtags
  };

  const cpn = generateCpn(16);
  let rn = 0;
  let playbackCookie: Uint8Array | null = null;
  const sabrContextMap = new Map<number, Uint8Array>();
  const activeContextTypes = new Set<number>();
  let initSeg: UmpMediaSegment | null = null;
  const mediaBySeq = new Map<number, UmpMediaSegment>();
  let knownEndTimeMs = selectedFormat.approxDurationMs;
  let knownEndSeq = 0;
  let cumulativeBytes = 0;
  let consecutiveEmptyRounds = 0;

  const normalizedStartMs = Math.max(0, Math.floor(wantStartMs));
  const normalizedEndMs = Math.max(normalizedStartMs, Math.ceil(wantEndMs));

  const hasWindowCoverage = (): boolean => {
    if (!initSeg || mediaBySeq.size === 0) return false;
    const sorted = [...mediaBySeq.values()].sort((a, b) => a.header.startMs - b.header.startMs);
    const firstStart = sorted[0].header.startMs;
    const lastSeg = sorted[sorted.length - 1];
    const lastEnd = lastSeg.header.startMs + lastSeg.header.durationMs;
    const effectiveTargetEnd =
      knownEndTimeMs > 0 ? Math.min(normalizedEndMs, Math.max(0, knownEndTimeMs - 200)) : normalizedEndMs;
    const reachedStreamEnd =
      (knownEndSeq > 0 && lastSeg.header.sequenceNumber >= knownEndSeq) ||
      (knownEndTimeMs > 0 && lastEnd >= knownEndTimeMs - 250);
    return firstStart <= normalizedStartMs + 500 && (lastEnd >= effectiveTargetEnd || reachedStreamEnd);
  };

  for (let round = 0; round < MAX_VIDEO_WINDOW_ROUNDS && !hasWindowCoverage(); round += 1) {
    if (signal.aborted) {
      throw new Error("历史截帧已中止");
    }
    const sortedSeqs = [...mediaBySeq.values()].sort((a, b) => a.header.sequenceNumber - b.header.sequenceNumber);
    const bufferedRange = sortedSeqs.length > 0
      ? {
          formatId: targetFormatId,
          startTimeMs: sortedSeqs[0].header.startMs,
          durationMs: Math.max(
            0,
            sortedSeqs[sortedSeqs.length - 1].header.startMs +
              sortedSeqs[sortedSeqs.length - 1].header.durationMs -
              sortedSeqs[0].header.startMs
          ),
          startSegmentIndex: sortedSeqs[0].header.sequenceNumber,
          endSegmentIndex: sortedSeqs[sortedSeqs.length - 1].header.sequenceNumber
        }
      : null;

    const sentContexts: Uint8Array[] = [];
    const unsentTypes: number[] = [];
    for (const [ctxType, raw] of sabrContextMap.entries()) {
      if (activeContextTypes.has(ctxType)) {
        sentContexts.push(raw);
      } else {
        unsentTypes.push(ctxType);
      }
    }

    const requestBody = rewriteSabrAbrRequest({
      templateBody,
      targetFormat: targetFormatId,
      positionMs: normalizedStartMs,
      mediaType: 2,
      playbackCookie,
      bufferedRange,
      sabrContexts: sentContexts,
      unsentContextTypes: unsentTypes
    });
    const requestUrl = buildSabrRequestUrl(baseUrl, cpn, rn);
    rn += 1;

    const rawBytes = await fetchSabrRound(requestUrl, requestBody, signal);
    cumulativeBytes += rawBytes.byteLength;
    if (cumulativeBytes > MAX_VIDEO_WINDOW_BYTES) {
      break;
    }

    const parsed = parseUmpResponse(rawBytes);
    if (parsed.redirectUrl && isValidGooglevideoUrl(parsed.redirectUrl)) {
      baseUrl = parsed.redirectUrl;
    }
    if (parsed.nextRequestPolicy?.playbackCookie) {
      playbackCookie = parsed.nextRequestPolicy.playbackCookie;
    }
    for (const update of parsed.contextUpdates) {
      sabrContextMap.set(update.type, update.raw);
      if (update.sendByDefault) {
        activeContextTypes.add(update.type);
      }
    }
    for (const policy of parsed.contextSendingPolicies) {
      for (const t of policy.startPolicy) activeContextTypes.add(t);
      for (const t of policy.stopPolicy) activeContextTypes.delete(t);
      for (const t of policy.discardPolicy) {
        activeContextTypes.delete(t);
        sabrContextMap.delete(t);
      }
    }
    for (const meta of parsed.initMetadatas) {
      if (meta.formatId && meta.formatId.itag === selectedFormat.itag) {
        if (meta.endTimeMs > 0) knownEndTimeMs = meta.endTimeMs;
        if (meta.endSegmentNumber > 0) knownEndSeq = meta.endSegmentNumber;
      }
    }

    if (parsed.streamProtectionStatus === STREAM_PROTECTION_REJECTED) {
      throw Object.assign(
        new Error("YouTube 拒绝了本次视频流请求（风控校验未通过），请先播放视频片刻后重试。"),
        { code: "STREAM_PROTECTION_REJECTED" }
      );
    }
    if (parsed.sabrError) {
      throw Object.assign(
        new Error(`YouTube 视频流返回错误：${parsed.sabrError.type || parsed.sabrError.code}`),
        { code: "SABR_SERVER_ERROR" }
      );
    }

    let gotNewSegment = false;
    for (const seg of parsed.mediaSegments) {
      if (seg.header.itag > 0 && seg.header.itag !== selectedFormat.itag) {
        continue;
      }
      if (seg.header.isInitSeg) {
        initSeg = seg;
        gotNewSegment = true;
      } else if (seg.header.sequenceNumber > 0 && !mediaBySeq.has(seg.header.sequenceNumber)) {
        mediaBySeq.set(seg.header.sequenceNumber, seg);
        gotNewSegment = true;
      }
    }

    if (!gotNewSegment) {
      if (parsed.redirectUrl) {
        continue;
      }
      consecutiveEmptyRounds += 1;
      if (consecutiveEmptyRounds >= 2) {
        break;
      }
    } else {
      consecutiveEmptyRounds = 0;
    }

    const backoffMs = Math.min(MAX_BACKOFF_MS, parsed.nextRequestPolicy?.backoffTimeMs || 0);
    if (backoffMs > 0 && !hasWindowCoverage()) {
      await sleepAbortable(backoffMs, signal);
    }
  }

  const orderedMedia = [...mediaBySeq.values()].sort((a, b) => a.header.startMs - b.header.startMs);
  if (!initSeg || orderedMedia.length === 0) {
    throw new Error("未获取到目标时间点附近的 YouTube 视频分片，请稍后重试。");
  }

  const initBuf = toOwnedArrayBuffer(initSeg.data);
  const mediaBufs = orderedMedia.map((seg) => toOwnedArrayBuffer(seg.data));
  const transfer: Transferable[] = [initBuf, ...mediaBufs];

  postToIsolated(
    {
      sessionId,
      type: "video-window-result",
      mimeType: selectedFormat.mimeType,
      durationMs: knownEndTimeMs,
      initSegment: initBuf,
      mediaSegments: mediaBufs
    },
    transfer
  );
}

(function installYoutubeSabrWorker(): void {
  const slotSym = Symbol.for(YOUTUBE_SABR_WORKER_SLOT_KEY);
  const g = globalThis as Record<symbol, { installed: boolean } | undefined>;
  if (g[slotSym]?.installed) {
    return;
  }
  g[slotSym] = { installed: true };

  const activeSessions = new Map<string, AbortController>();

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.channel !== YOUTUBE_SABR_CHANNEL) return;

    const reqType = String(msg.type || "");
    const sessionId = String(msg.sessionId || "");
    if (!sessionId) return;

    if (reqType === "probe-audio-track") {
      try {
        const expectedVideoId = String(msg.expectedVideoId || "").trim();
        const player = getMoviePlayer();
        const playerResponse = readPlayerResponse(player);
        const videoId = readPlayerVideoId(player, playerResponse);
        const streamingData = asObj(playerResponse?.streamingData);
        const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats)
          ? (streamingData.adaptiveFormats as YoutubeAdaptiveFormatLike[])
          : [];
        const activeAudioTrackId = readActiveAudioTrackId(player);
        const sniffed = getSniffedTemplate(expectedVideoId || videoId);
        const selected = selectTargetYoutubeAudioFormat(adaptiveFormats, {
          activeAudioTrackId,
          preferredXtags: sniffed?.observedAudioXtags || "",
          observedAudioItag: sniffed?.observedAudioItag || 0
        });
        postToIsolated({
          sessionId,
          type: "probe-result",
          ok: true,
          videoId,
          audioTrackId: selected?.audioTrackId || activeAudioTrackId || "",
          itag: selected?.itag || 0,
          hasSniffedTemplate: Boolean(sniffed),
          isLive: isLiveStreamingNow(playerResponse),
          isAdPlaying: isAdActive(player)
        });
      } catch (err) {
        postToIsolated({
          sessionId,
          type: "probe-result",
          ok: false,
          error: (err as Error)?.message || String(err)
        });
      }
      return;
    }

    if (reqType === "abort-stream" || reqType === "abort-video-window") {
      const controller = activeSessions.get(sessionId);
      if (controller) {
        controller.abort();
        activeSessions.delete(sessionId);
      }
      return;
    }

    if (reqType === "capture-video-window") {
      if (activeSessions.has(sessionId)) {
        return;
      }
      const controller = new AbortController();
      activeSessions.set(sessionId, controller);
      const expectedVideoId = String(msg.expectedVideoId || "").trim();
      const startMs = Math.max(0, Number(msg.startMs) || 0);
      const endMs = Math.max(startMs, Number(msg.endMs) || startMs);

      void runSabrVideoWindowSession(sessionId, expectedVideoId, startMs, endMs, controller.signal)
        .catch((err) => {
          if (controller.signal.aborted) return;
          const code = typeof (err as { code?: unknown })?.code === "string"
            ? (err as { code: string }).code
            : undefined;
          postToIsolated({
            sessionId,
            type: "video-window-error",
            error: (err as Error)?.message || String(err),
            ...(code ? { code } : {})
          });
        })
        .finally(() => {
          activeSessions.delete(sessionId);
        });
      return;
    }

    if (reqType === "start-stream") {
      if (activeSessions.has(sessionId)) {
        return;
      }
      const controller = new AbortController();
      activeSessions.set(sessionId, controller);
      const expectedVideoId = String(msg.expectedVideoId || "").trim();

      void runSabrSession(sessionId, expectedVideoId, controller.signal)
        .catch((err) => {
          if (controller.signal.aborted) return;
          const code = typeof (err as { code?: unknown })?.code === "string"
            ? (err as { code: string }).code
            : undefined;
          postToIsolated({
            sessionId,
            type: "error",
            error: (err as Error)?.message || String(err),
            ...(code ? { code } : {})
          });
        })
        .finally(() => {
          activeSessions.delete(sessionId);
        });
    }
  });
})();
