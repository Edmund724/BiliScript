export interface RuntimeCapabilities {
  readonly isFirefox: boolean;
  readonly supportsTts: boolean;
  readonly supportsLiveCompanion: boolean;
}

export function isFirefoxRuntime(): boolean {
  try {
    const url = typeof chrome !== "undefined" ? chrome.runtime?.getURL?.("") : "";
    return typeof url === "string" && url.startsWith("moz-extension://");
  } catch {
    return false;
  }
}

export function hasChromeTtsApi(): boolean {
  try {
    return typeof chrome !== "undefined" && typeof chrome.tts?.speak === "function";
  } catch {
    return false;
  }
}

export function hasWebSpeechApi(): boolean {
  try {
    return typeof window !== "undefined"
      && typeof window.speechSynthesis?.speak === "function"
      && typeof window.speechSynthesis?.getVoices === "function";
  } catch {
    return false;
  }
}

export function supportsTtsSpeech(): boolean {
  return !isFirefoxRuntime() || hasWebSpeechApi();
}

export function supportsLiveCompanion(): boolean {
  return !isFirefoxRuntime();
}

export function getRuntimeCapabilities(): RuntimeCapabilities {
  const isFirefox = isFirefoxRuntime();
  return {
    isFirefox,
    supportsTts: supportsTtsSpeech(),
    supportsLiveCompanion: !isFirefox
  };
}
