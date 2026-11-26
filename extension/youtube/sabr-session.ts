import {
  STREAM_PROTECTION_REJECTED,
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
  type SabrBufferedRangeSpec,
  type SabrFormatId,
  type SelectedYoutubeAudioFormat,
  type UmpFormatInitMetadata,
  type UmpMediaSegment,
  type UmpParsedResponse,
  type UmpSabrContextSendingPolicy,
  type UmpSabrContextUpdate,
  type YoutubeAdaptiveFormatLike
} from "./sabr-protocol.js";
import type { SniffedSabrTemplate } from "./sabr-sniffer.main.js";

const MAX_SABR_ROUNDS = 400;
const MAX_CONSECUTIVE_EMPTY_ROUNDS = 5;
const MAX_BACKOFF_MS = 15_000;
const MAX_CUMULATIVE_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_WINDOW_ROUNDS = 5;
const MAX_VIDEO_WINDOW_BYTES = 24 * 1024 * 1024;
const MAX_VIDEO_EMPTY_ROUNDS = 2;
const SNIFFED_TEMPLATE_WAIT_ROUNDS = 10;
const SNIFFED_TEMPLATE_WAIT_MS = 150;

export interface SabrSessionHost {
  isAdPlaying(): boolean;
  readPlayerResponse(): Record<string, unknown> | null;
  readVideoId(playerResponse: Record<string, unknown> | null): string;
  readActiveAudioTrackId(): string;
  readYtcfg(key: string): unknown;
  getSniffedTemplate(expectedVideoId: string): SniffedSabrTemplate | null;
  isVideoMimeSupported(mimeType: string): boolean;
  fetchRound(url: string, body: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  generateCpn?: () => string;
}

export interface YoutubeAudioTrackProbePayload {
  videoId: string;
  audioTrackId: string;
  itag: number;
  hasSniffedTemplate: boolean;
  isLive: boolean;
  isAdPlaying: boolean;
}

export type SabrAudioSessionEvent =
  | { type: "init"; data: Uint8Array }
  | { type: "segment"; seq: number; data: Uint8Array }
  | { type: "end" };

export interface SabrAudioSessionInput {
  expectedVideoId: string;
  signal: AbortSignal;
}

export interface SabrVideoWindowInput {
  expectedVideoId: string;
  startMs: number;
  endMs: number;
  signal: AbortSignal;
}

export interface SabrVideoWindowResult {
  mimeType: string;
  durationMs: number;
  initSegment: Uint8Array;
  mediaSegments: Uint8Array[];
}

type SabrSessionMode = "audio" | "video-window";

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isLiveStreamingNow(playerResponse: Record<string, unknown> | null): boolean {
  const details = asObj(playerResponse?.videoDetails);
  const microformat = asObj(asObj(playerResponse?.microformat)?.playerMicroformatRenderer);
  const liveBroadcast = asObj(microformat?.liveBroadcastDetails);
  return details?.isLive === true || liveBroadcast?.isLiveNow === true;
}

function readAdaptiveFormats(playerResponse: Record<string, unknown> | null): YoutubeAdaptiveFormatLike[] {
  const streamingData = asObj(playerResponse?.streamingData);
  return Array.isArray(streamingData?.adaptiveFormats)
    ? (streamingData.adaptiveFormats as YoutubeAdaptiveFormatLike[])
    : [];
}

function extractParameterCandidate(
  playerResponse: Record<string, unknown>,
  targetFormat: Pick<SelectedYoutubeAudioFormat, "itag" | "lastModified" | "xtags">,
  host: SabrSessionHost,
  mediaType: 1 | 2
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

  const rawClientName = Number(host.readYtcfg("INNERTUBE_CONTEXT_CLIENT_NAME"));
  const clientName = Number.isFinite(rawClientName) && rawClientName > 0 ? rawClientName : 1;
  const clientVersion = String(host.readYtcfg("INNERTUBE_CONTEXT_CLIENT_VERSION") || "").trim();

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

async function waitForSniffedTemplate(
  videoId: string,
  host: SabrSessionHost,
  signal: AbortSignal
): Promise<SniffedSabrTemplate | null> {
  let sniffed = host.getSniffedTemplate(videoId);
  if (!sniffed) {
    for (let waitIdx = 0; waitIdx < SNIFFED_TEMPLATE_WAIT_ROUNDS && !sniffed && !signal.aborted; waitIdx += 1) {
      await host.sleep(SNIFFED_TEMPLATE_WAIT_MS, signal);
      sniffed = host.getSniffedTemplate(videoId);
    }
  }
  return sniffed;
}

class SabrContextLedger {
  private readonly contextMap = new Map<number, Uint8Array>();
  private readonly activeTypes = new Set<number>();
  private readonly unsentTypes = new Set<number>();

  applyUpdates(updates: readonly UmpSabrContextUpdate[]): void {
    for (const update of updates) {
      if (update.writePolicy === 2 && this.contextMap.has(update.type)) {
        continue;
      }
      this.contextMap.set(update.type, update.raw);
      this.unsentTypes.delete(update.type);
      if (update.sendByDefault) {
        this.activeTypes.add(update.type);
      }
    }
  }

  applyPolicies(policies: readonly UmpSabrContextSendingPolicy[]): void {
    for (const policy of policies) {
      for (const t of policy.startPolicy) {
        if (this.contextMap.has(t)) {
          this.activeTypes.add(t);
          this.unsentTypes.delete(t);
        }
      }
      for (const t of policy.stopPolicy) {
        this.activeTypes.delete(t);
        this.unsentTypes.add(t);
      }
      for (const t of policy.discardPolicy) {
        this.activeTypes.delete(t);
        this.contextMap.delete(t);
        this.unsentTypes.delete(t);
      }
    }
  }

  snapshot(): { sabrContexts: Uint8Array[]; unsentContextTypes: number[] } {
    const sabrContexts: Uint8Array[] = [];
    for (const ctxType of this.activeTypes) {
      const rawCtx = this.contextMap.get(ctxType);
      if (rawCtx) sabrContexts.push(rawCtx);
    }
    return {
      sabrContexts,
      unsentContextTypes: [...this.unsentTypes]
    };
  }
}

interface PreflightContext {
  videoId: string;
  playerResponse: Record<string, unknown>;
  adaptiveFormats: YoutubeAdaptiveFormatLike[];
}

function preflightSabrSession(
  expectedVideoId: string,
  mode: SabrSessionMode,
  host: SabrSessionHost
): PreflightContext {
  const actionLabel = mode === "audio" ? "语音转写" : "历史截帧";
  const cancelLabel = mode === "audio" ? "音频采集" : "历史截帧";

  if (host.isAdPlaying()) {
    throw Object.assign(new Error(`当前正在播放广告，请待正片开始后重试${actionLabel}。`), {
      code: "AD_PLAYING"
    });
  }
  const playerResponse = host.readPlayerResponse();
  if (!playerResponse) {
    throw new Error("未读取到 YouTube 播放器数据，请刷新视频页后重试。");
  }
  if (isLiveStreamingNow(playerResponse)) {
    throw Object.assign(
      new Error(
        mode === "audio"
          ? "暂不支持 YouTube 直播中视频的语音转写。"
          : "暂不支持 YouTube 直播中视频的历史时间点截帧。"
      ),
      { code: "UNSUPPORTED_LIVE" }
    );
  }
  const currentVideoId = host.readVideoId(playerResponse);
  if (expectedVideoId && currentVideoId && currentVideoId !== expectedVideoId) {
    throw new Error(`视频已切换，已取消当前${cancelLabel}。`);
  }
  const videoId = expectedVideoId || currentVideoId;
  if (!videoId) {
    throw new Error("未识别到当前 YouTube 视频 ID。");
  }

  return {
    videoId,
    playerResponse,
    adaptiveFormats: readAdaptiveFormats(playerResponse)
  };
}

function resolveTemplate(
  mode: SabrSessionMode,
  playerResponse: Record<string, unknown>,
  targetFormat: SabrFormatId,
  sniffed: SniffedSabrTemplate | null,
  host: SabrSessionHost
): { baseUrl: string; templateBody: Uint8Array; usedSniffedTemplate: boolean } {
  if (sniffed) {
    return {
      baseUrl: sniffed.url,
      templateBody: sniffed.body,
      usedSniffedTemplate: true
    };
  }
  const mediaType = mode === "audio" ? 1 : 2;
  const candidate = extractParameterCandidate(playerResponse, targetFormat, host, mediaType);
  if (!candidate) {
    throw Object.assign(
      new Error(
        mode === "audio"
          ? "尚未捕获到播放器音频流令牌，请先播放或拖动一下视频后再重试。"
          : "尚未捕获到播放器视频流令牌，请先播放或拖动一下视频后再重试。"
      ),
      { code: "NO_SABR_TEMPLATE" }
    );
  }
  return {
    baseUrl: candidate.url,
    templateBody: candidate.body,
    usedSniffedTemplate: false
  };
}

interface SabrRoundStepResult {
  rawByteLength: number;
  parsed: UmpParsedResponse;
  matchedInitMetadatas: UmpFormatInitMetadata[];
  matchedMediaSegments: UmpMediaSegment[];
  backoffMs: number;
}

class SabrRoundRunner {
  private baseUrl: string;
  private readonly templateBody: Uint8Array;
  private readonly usedSniffedTemplate: boolean;
  private readonly targetFormat: SabrFormatId;
  private readonly videoId: string;
  private readonly mode: SabrSessionMode;
  private readonly mediaType: 1 | 2;
  private readonly host: SabrSessionHost;
  private readonly cpn: string;
  private rn = 0;
  private playbackCookie: Uint8Array | null = null;
  private readonly ledger = new SabrContextLedger();

  constructor(params: {
    baseUrl: string;
    templateBody: Uint8Array;
    usedSniffedTemplate: boolean;
    targetFormat: SabrFormatId;
    videoId: string;
    mode: SabrSessionMode;
    host: SabrSessionHost;
  }) {
    this.baseUrl = params.baseUrl;
    this.templateBody = params.templateBody;
    this.usedSniffedTemplate = params.usedSniffedTemplate;
    this.targetFormat = params.targetFormat;
    this.videoId = params.videoId;
    this.mode = params.mode;
    this.mediaType = params.mode === "audio" ? 1 : 2;
    this.host = params.host;
    this.cpn = params.host.generateCpn ? params.host.generateCpn() : generateCpn(16);
  }

  async step(params: {
    positionMs: number;
    bufferedRange: SabrBufferedRangeSpec | null;
    signal: AbortSignal;
    extraGuard?: () => void;
  }): Promise<SabrRoundStepResult | null> {
    const { positionMs, bufferedRange, signal, extraGuard } = params;
    if (signal.aborted) {
      return null;
    }

    const streamLabel = this.mode === "audio" ? "音频流" : "视频流";
    const cancelLabel = this.mode === "audio" ? "音频采集" : "历史截帧";

    if (this.host.isAdPlaying()) {
      throw Object.assign(new Error(`检测到视频插播广告，已中断当前${cancelLabel}，请正片恢复后重试。`), {
        code: "AD_PLAYING"
      });
    }
    const liveVideoId = this.host.readVideoId(null);
    if (liveVideoId && liveVideoId !== this.videoId) {
      throw new Error(`视频已切换，已取消当前${cancelLabel}。`);
    }
    extraGuard?.();

    const { sabrContexts, unsentContextTypes } = this.ledger.snapshot();
    const reqBody = rewriteSabrAbrRequest({
      templateBody: this.templateBody,
      targetFormat: this.targetFormat,
      positionMs,
      mediaType: this.mediaType,
      playbackCookie: this.playbackCookie,
      bufferedRange,
      sabrContexts,
      unsentContextTypes
    });
    const reqUrl = buildSabrRequestUrl(this.baseUrl, this.cpn, this.rn);
    this.rn += 1;

    let rawResp: Uint8Array;
    try {
      rawResp = await this.host.fetchRound(reqUrl, reqBody, signal);
    } catch (err) {
      if (!this.usedSniffedTemplate && (err as { status?: number })?.status === 403) {
        throw Object.assign(
          new Error(
            this.mode === "audio"
              ? "尚未捕获到已签名播放器音频流（HTTP 403），请播放视频 1–2 秒后再重试语音转写。"
              : "尚未捕获到已签名播放器视频流（HTTP 403），请播放视频 1–2 秒后再重试历史截帧。"
          ),
          { code: "NO_SIGNED_SABR_URL", status: 403 }
        );
      }
      throw err;
    }
    if (signal.aborted) {
      return null;
    }

    const parsed = parseUmpResponse(rawResp);
    if (parsed.streamProtectionStatus === STREAM_PROTECTION_REJECTED) {
      throw Object.assign(
        new Error(`YouTube 拒绝了当前${streamLabel}令牌（ATTESTATION_REJECTED），请播放视频片刻后重试。`),
        { code: "ATTESTATION_REJECTED" }
      );
    }
    if (parsed.sabrError) {
      throw Object.assign(
        new Error(`YouTube ${streamLabel}返回错误（${parsed.sabrError.type || parsed.sabrError.code}）`),
        { code: "SABR_ERROR" }
      );
    }

    if (parsed.redirectUrl && isValidGooglevideoUrl(parsed.redirectUrl)) {
      this.baseUrl = parsed.redirectUrl;
    }
    this.ledger.applyUpdates(parsed.contextUpdates);
    this.ledger.applyPolicies(parsed.contextSendingPolicies);
    if (parsed.nextRequestPolicy?.playbackCookie) {
      this.playbackCookie = parsed.nextRequestPolicy.playbackCookie;
    }

    const matchedInitMetadatas = parsed.initMetadatas.filter((meta) => {
      if (meta.videoId && meta.videoId !== this.videoId) return false;
      return Boolean(meta.formatId && meta.formatId.itag === this.targetFormat.itag);
    });
    const matchedMediaSegments = parsed.mediaSegments.filter((seg) => {
      if (seg.header.videoId && seg.header.videoId !== this.videoId) return false;
      if (seg.header.itag > 0 && seg.header.itag !== this.targetFormat.itag) return false;
      return true;
    });

    const backoffMs = Math.min(
      MAX_BACKOFF_MS,
      Math.max(0, Number(parsed.nextRequestPolicy?.backoffTimeMs) || 0)
    );

    return {
      rawByteLength: rawResp.byteLength,
      parsed,
      matchedInitMetadatas,
      matchedMediaSegments,
      backoffMs
    };
  }
}

export function probeYoutubeSabrAudioTrack(
  expectedVideoId: string,
  host: SabrSessionHost
): YoutubeAudioTrackProbePayload {
  const playerResponse = host.readPlayerResponse();
  const videoId = host.readVideoId(playerResponse);
  const adaptiveFormats = readAdaptiveFormats(playerResponse);
  const activeAudioTrackId = host.readActiveAudioTrackId();
  const sniffed = host.getSniffedTemplate(expectedVideoId || videoId);
  const selected = selectTargetYoutubeAudioFormat(adaptiveFormats, {
    activeAudioTrackId,
    preferredXtags: sniffed?.observedAudioXtags || "",
    observedAudioItag: sniffed?.observedAudioItag || 0
  });
  return {
    videoId,
    audioTrackId: selected?.audioTrackId || activeAudioTrackId || "",
    itag: selected?.itag || 0,
    hasSniffedTemplate: Boolean(sniffed),
    isLive: isLiveStreamingNow(playerResponse),
    isAdPlaying: host.isAdPlaying()
  };
}

export async function runYoutubeSabrAudioSession(
  input: SabrAudioSessionInput,
  host: SabrSessionHost,
  onEvent: (event: SabrAudioSessionEvent) => void
): Promise<void> {
  const { expectedVideoId, signal } = input;
  const { videoId, playerResponse, adaptiveFormats } = preflightSabrSession(expectedVideoId, "audio", host);

  const activeAudioTrackId = host.readActiveAudioTrackId();
  const sniffed = await waitForSniffedTemplate(videoId, host, signal);
  if (signal.aborted) return;

  const selectedFormat = selectTargetYoutubeAudioFormat(adaptiveFormats, {
    activeAudioTrackId,
    preferredXtags: sniffed?.observedAudioXtags || "",
    observedAudioItag: sniffed?.observedAudioItag || 0
  });
  if (!selectedFormat) {
    throw new Error("未找到可用的 MP4/AAC 音轨，无法启动语音转写。");
  }

  const targetFormat: SabrFormatId = {
    itag: selectedFormat.itag,
    lastModified: selectedFormat.lastModified,
    xtags: selectedFormat.xtags
  };
  const { baseUrl, templateBody, usedSniffedTemplate } = resolveTemplate(
    "audio",
    playerResponse,
    targetFormat,
    sniffed,
    host
  );

  const runner = new SabrRoundRunner({
    baseUrl,
    templateBody,
    usedSniffedTemplate,
    targetFormat,
    videoId,
    mode: "audio",
    host
  });

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
      onEvent({ type: "segment", seq: nextSeq, data: entry.data });
    }
  };

  for (let round = 0; round < MAX_SABR_ROUNDS; round += 1) {
    const step = await runner.step({
      positionMs: accumulatedDurationMs,
      bufferedRange:
        highestContiguousSeq > 0
          ? {
              formatId: targetFormat,
              startTimeMs: 0,
              durationMs: accumulatedDurationMs,
              startSegmentIndex: 1,
              endSegmentIndex: highestContiguousSeq
            }
          : null,
      signal,
      extraGuard: () => {
        const liveTrackId = host.readActiveAudioTrackId();
        if (activeAudioTrackId && liveTrackId && liveTrackId !== activeAudioTrackId) {
          throw new Error("检测到音轨切换，已取消当前音频采集，请重试。");
        }
      }
    });
    if (!step) return;

    for (const meta of step.matchedInitMetadatas) {
      if (meta.endSegmentNumber > 0) {
        endSegmentNumber = meta.endSegmentNumber;
      }
    }

    let gotNewAudio = false;
    for (const seg of step.matchedMediaSegments) {
      if (seg.header.isInitSeg) {
        if (!sentInit) {
          sentInit = true;
          gotNewAudio = true;
          totalTransferredBytes += seg.data.byteLength;
          onEvent({ type: "init", data: seg.data });
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
      onEvent({ type: "end" });
      return;
    }

    if (gotNewAudio) {
      consecutiveEmptyRounds = 0;
    } else if (!step.parsed.redirectUrl) {
      consecutiveEmptyRounds += 1;
      if (consecutiveEmptyRounds >= MAX_CONSECUTIVE_EMPTY_ROUNDS) {
        if (sentInit && highestContiguousSeq > 0) {
          onEvent({ type: "end" });
          return;
        }
        throw new Error("未能从 YouTube 音频流获取到有效音轨分段。");
      }
    }

    if (step.backoffMs > 0) {
      await host.sleep(step.backoffMs, signal);
    }
  }

  if (sentInit && highestContiguousSeq > 0) {
    onEvent({ type: "end" });
    return;
  }
  throw new Error("YouTube 音频流采集超过最大轮次上限。");
}

export async function runYoutubeSabrVideoWindow(
  input: SabrVideoWindowInput,
  host: SabrSessionHost
): Promise<SabrVideoWindowResult> {
  const { expectedVideoId, startMs, endMs, signal } = input;
  const { videoId, playerResponse, adaptiveFormats } = preflightSabrSession(
    expectedVideoId,
    "video-window",
    host
  );

  const selectedFormat = selectTargetYoutubeVideoFormat(adaptiveFormats, {
    preferredHeight: 720,
    isTypeSupported: (mime) => host.isVideoMimeSupported(mime)
  });
  if (!selectedFormat) {
    throw new Error("未找到可用的浏览器可解码视频轨，无法截取历史画面。");
  }

  const sniffed = await waitForSniffedTemplate(videoId, host, signal);
  if (signal.aborted) {
    throw new Error("历史截帧已中止");
  }

  const targetFormat: SabrFormatId = {
    itag: selectedFormat.itag,
    lastModified: selectedFormat.lastModified,
    xtags: selectedFormat.xtags
  };
  const { baseUrl, templateBody, usedSniffedTemplate } = resolveTemplate(
    "video-window",
    playerResponse,
    targetFormat,
    sniffed,
    host
  );

  const runner = new SabrRoundRunner({
    baseUrl,
    templateBody,
    usedSniffedTemplate,
    targetFormat,
    videoId,
    mode: "video-window",
    host
  });

  let initSeg: UmpMediaSegment | null = null;
  const mediaBySeq = new Map<number, UmpMediaSegment>();
  let knownEndTimeMs = selectedFormat.approxDurationMs;
  let knownEndSeq = 0;
  let cumulativeBytes = 0;
  let consecutiveEmptyRounds = 0;

  const normalizedStartMs = Math.max(0, Math.floor(startMs));
  const normalizedEndMs = Math.max(normalizedStartMs, Math.ceil(endMs));

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

    const sortedSeqs = [...mediaBySeq.values()].sort(
      (a, b) => a.header.sequenceNumber - b.header.sequenceNumber
    );
    const bufferedRange: SabrBufferedRangeSpec | null =
      sortedSeqs.length > 0
        ? {
            formatId: targetFormat,
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

    const step = await runner.step({
      positionMs: normalizedStartMs,
      bufferedRange,
      signal
    });
    if (!step) {
      throw new Error("历史截帧已中止");
    }

    cumulativeBytes += step.rawByteLength;
    if (cumulativeBytes > MAX_VIDEO_WINDOW_BYTES) {
      break;
    }

    for (const meta of step.matchedInitMetadatas) {
      if (meta.endTimeMs > 0) knownEndTimeMs = meta.endTimeMs;
      if (meta.endSegmentNumber > 0) knownEndSeq = meta.endSegmentNumber;
    }

    let gotNewSegment = false;
    for (const seg of step.matchedMediaSegments) {
      if (seg.header.isInitSeg) {
        initSeg = seg;
        gotNewSegment = true;
      } else if (seg.header.sequenceNumber > 0 && !mediaBySeq.has(seg.header.sequenceNumber)) {
        mediaBySeq.set(seg.header.sequenceNumber, seg);
        gotNewSegment = true;
      }
    }

    if (!gotNewSegment) {
      if (step.parsed.redirectUrl) {
        continue;
      }
      consecutiveEmptyRounds += 1;
      if (consecutiveEmptyRounds >= MAX_VIDEO_EMPTY_ROUNDS) {
        break;
      }
    } else {
      consecutiveEmptyRounds = 0;
    }

    if (step.backoffMs > 0 && !hasWindowCoverage()) {
      await host.sleep(step.backoffMs, signal);
    }
  }

  const orderedMedia = [...mediaBySeq.values()].sort((a, b) => a.header.startMs - b.header.startMs);
  if (!initSeg || orderedMedia.length === 0) {
    throw new Error("未获取到目标时间点附近的 YouTube 视频分片，请稍后重试。");
  }

  return {
    mimeType: selectedFormat.mimeType,
    durationMs: knownEndTimeMs,
    initSegment: initSeg.data,
    mediaSegments: orderedMedia.map((seg) => seg.data)
  };
}
