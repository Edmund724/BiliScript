import { contentFetchJson } from "../bilibili/content-transport.js";
import type { JsonTransport } from "../bilibili/gateway-core.js";

const NO_AUDIO_MESSAGE = "该视频没有可用音轨，无法语音识别";

interface DashAudioTrack {
  baseUrl?: string;
  backupUrl?: string[];
  bandwidth?: number;
}

interface DashData {
  audio?: DashAudioTrack[] | null;
}

interface PlayurlResponse {
  code?: number;
  message?: string;
  data?: { dash?: DashData | null };
}

export interface AudioSource {
  url: string | undefined;
  backupUrls: string[];
}

export function selectAudioTrack(dashData: DashData | null | undefined): AudioSource {
  const audio = dashData?.audio;
  if (!Array.isArray(audio) || audio.length === 0) {
    throw new Error(NO_AUDIO_MESSAGE);
  }
  let selected = audio[0];
  for (const track of audio) {
    const bandwidth = Number(track?.bandwidth) || 0;
    if (bandwidth < (Number(selected?.bandwidth) || 0)) {
      selected = track;
    }
  }
  return {
    url: selected?.baseUrl,
    backupUrls: Array.isArray(selected?.backupUrl) ? selected.backupUrl : []
  };
}

export function buildPlayurlUrl(bvid: string, cid: string): string {
  return (
    "https://api.bilibili.com/x/player/playurl" +
    `?bvid=${encodeURIComponent(bvid)}` +
    `&cid=${encodeURIComponent(cid)}` +
    "&fnval=16" +
    "&platform=html5" +
    "&high_quality=1"
  );
}

export async function getSourceAudioUrl(
  { bvid, cid }: { bvid: string; cid: string },
  transport: JsonTransport = contentFetchJson
): Promise<AudioSource> {
  const payload = (await transport(buildPlayurlUrl(bvid, cid))) as PlayurlResponse | null;
  if (payload?.code !== 0) {
    throw new Error(payload?.message || "无法获取音频流地址");
  }
  return selectAudioTrack(payload?.data?.dash);
}
