/**
 * 运行时平台与能力判据（纯函数，无副作用与外部依赖）。
 *
 * 供后台与懒加载功能域判定是否运行在 Firefox 扩展环境，以及
 * TTS 朗读（Chromium 走后台 `chrome.tts`，Firefox 走 Web Speech API）与 Live 实时伴看入口是否可用。
 * 注：Content Script 常驻层（entry/content.ts）内联 `isFirefoxRuntime` 同款判据，
 * 避免本模块进入 build-content.js 双实例模块图。
 */

export interface RuntimeCapabilities {
  readonly isFirefox: boolean;
  readonly supportsTts: boolean;
  readonly supportsLiveCompanion: boolean;
}

/**
 * 基于 `chrome.runtime.getURL("")` 前缀判定是否运行在 Firefox 扩展宿主。
 */
export function isFirefoxRuntime(): boolean {
  try {
    const url = typeof chrome !== "undefined" ? chrome.runtime?.getURL?.("") : "";
    return typeof url === "string" && url.startsWith("moz-extension://");
  } catch {
    return false;
  }
}

/**
 * 后台上下文是否具备可用的 `chrome.tts` 能力位。
 */
export function hasChromeTtsApi(): boolean {
  try {
    return typeof chrome !== "undefined" && typeof chrome.tts?.speak === "function";
  } catch {
    return false;
  }
}

/**
 * 当前页面上下文是否具备标准 Web Speech 朗读 API。
 */
export function hasWebSpeechApi(): boolean {
  try {
    return typeof window !== "undefined"
      && typeof window.speechSynthesis?.speak === "function"
      && typeof window.speechSynthesis?.getVoices === "function";
  } catch {
    return false;
  }
}

/**
 * 当前平台是否允许暴露语音朗读（TTS）UI 入口。
 * Chromium 内容脚本侧经 port 转发至 SW `chrome.tts`；Firefox 依赖页面侧 `window.speechSynthesis`。
 */
export function supportsTtsSpeech(): boolean {
  return !isFirefoxRuntime() || hasWebSpeechApi();
}

/**
 * 当前平台首期是否允许暴露实时伴看（Live）UI 入口。
 */
export function supportsLiveCompanion(): boolean {
  return !isFirefoxRuntime();
}

/**
 * 一次性读取当前运行时的平台与能力位快照。
 */
export function getRuntimeCapabilities(): RuntimeCapabilities {
  const isFirefox = isFirefoxRuntime();
  return {
    isFirefox,
    supportsTts: supportsTtsSpeech(),
    supportsLiveCompanion: !isFirefox
  };
}
