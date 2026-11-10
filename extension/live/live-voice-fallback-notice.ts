// extension/live/live-voice-fallback-notice.ts
// 音色回退的一次性提示信箱：伴看会话里 change_voice 失败时由页面侧写入
//（chrome.storage.local），设置面板下一次打开时取出并清除——「设置里提示一次」
// 的存储口径只此一处，避免会话侧与设置侧各自拼 key/形状。

export const LIVE_VOICE_FALLBACK_NOTICE_STORAGE = "liveVoiceFallbackNotice";

export interface LiveVoiceFallbackNotice {
  providerId: string;
  voiceId: string;
  at: number;
}

export const LIVE_VOICE_FALLBACK_NOTICE_TEXT = "所选音色已不可用，伴看已回退默认音色。";

function normalizeNotice(value: unknown): LiveVoiceFallbackNotice | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LiveVoiceFallbackNotice>;
  const voiceId = String(raw.voiceId || "").trim();
  if (!voiceId) return null;
  return {
    providerId: String(raw.providerId || "").trim(),
    voiceId,
    at: Number.isFinite(raw.at) ? Number(raw.at) : 0
  };
}

export async function recordLiveVoiceFallbackNotice(notice: LiveVoiceFallbackNotice): Promise<void> {
  try {
    await chrome.storage.local.set({
      [LIVE_VOICE_FALLBACK_NOTICE_STORAGE]: normalizeNotice(notice)
    });
  } catch {
    // 提示信箱是尽力而为：写失败不影响会话回退本身
  }
}

/** 读取并清除：同一份提示最多出现一次。 */
export async function takeLiveVoiceFallbackNotice(): Promise<LiveVoiceFallbackNotice | null> {
  try {
    const stored = await chrome.storage.local.get([LIVE_VOICE_FALLBACK_NOTICE_STORAGE]);
    const notice = normalizeNotice(stored?.[LIVE_VOICE_FALLBACK_NOTICE_STORAGE]);
    if (notice) {
      await chrome.storage.local.remove?.(LIVE_VOICE_FALLBACK_NOTICE_STORAGE);
    }
    return notice;
  } catch {
    return null;
  }
}
