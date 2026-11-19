/**
 * 运行时平台与能力判据（纯函数，无副作用与外部依赖）。
 *
 * 供后台与懒加载功能域判定是否运行在 Firefox 扩展环境，以及首期门控下
 * TTS 朗读与 Live 实时伴看入口是否可用。
 * 注：Content Script 常驻层（entry/content.ts）内联同一判据，避免本模块进入
 * build-content.js 双实例模块图。
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
 * 当前平台首期是否允许暴露语音朗读（TTS）UI 入口。
 * Chromium 内容脚本侧没有 `chrome.tts`（经 port 转发到 SW），故按非 Firefox 判定。
 */
export function supportsTtsSpeech(): boolean {
  return !isFirefoxRuntime();
}

/**
 * 当前平台首期是否允许暴露实时伴看（Live）UI 入口。
 */
export function supportsLiveCompanion(): boolean {
  return !isFirefoxRuntime();
}

/**
 * 一次性读取当前运行时的平台与首期能力位快照。
 */
export function getRuntimeCapabilities(): RuntimeCapabilities {
  const isFirefox = isFirefoxRuntime();
  return {
    isFirefox,
    supportsTts: !isFirefox,
    supportsLiveCompanion: !isFirefox
  };
}
