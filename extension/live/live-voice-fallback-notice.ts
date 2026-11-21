export const LIVE_VOICE_FALLBACK_NOTICE_STORAGE = "liveVoiceFallbackNotice";

export interface LiveVoiceFallbackNotice {
  voiceId: string;
}

export const LIVE_VOICE_FALLBACK_NOTICE_TEXT = "所选音色已不可用，伴看已回退默认音色。";

function normalizeNotice(value: unknown): LiveVoiceFallbackNotice | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LiveVoiceFallbackNotice>;
  const voiceId = String(raw.voiceId || "").trim();
  if (!voiceId) return null;
  return {
    voiceId
  };
}

export async function recordLiveVoiceFallbackNotice(notice: LiveVoiceFallbackNotice): Promise<void> {
  try {
    await chrome.storage.local.set({
      [LIVE_VOICE_FALLBACK_NOTICE_STORAGE]: normalizeNotice(notice)
    });
  } catch {
  }
}

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
