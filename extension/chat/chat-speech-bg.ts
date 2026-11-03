import {
  CHAT_SPEECH_PORT_NAME,
  type ChatSpeechEvent,
  type ChatSpeechPortMessage,
  type ChatSpeechRequest
} from "./chat-speech-port.js";

const TERMINAL_EVENTS = new Set(["end", "error", "interrupted", "cancelled"]);

let activePort: chrome.runtime.Port | null = null;
let activeRequestId: number | null = null;

function post(port: chrome.runtime.Port, message: ChatSpeechPortMessage): void {
  try {
    port.postMessage(message);
  } catch {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Speech request failed");
}

function emitError(port: chrome.runtime.Port, requestId: number, error: unknown): void {
  const event: ChatSpeechEvent = { type: "error", errorMessage: errorMessage(error) };
  post(port, { type: "event", requestId, event });
  if (activePort === port && activeRequestId === requestId) {
    activePort = null;
    activeRequestId = null;
  }
}

function speak(port: chrome.runtime.Port, request: Extract<ChatSpeechRequest, { type: "speak" }>): void {
  activePort = port;
  activeRequestId = request.requestId;
  try {
    const result = chrome.tts.speak(request.text, {
      voiceName: request.voiceName,
      lang: request.lang,
      onEvent: (event) => {
        if (activePort !== port || activeRequestId !== request.requestId) {
          return;
        }
        post(port, { type: "event", requestId: request.requestId, event });
        if (TERMINAL_EVENTS.has(event.type)) {
          activePort = null;
          activeRequestId = null;
        }
      }
    });
    void Promise.resolve(result).catch((error) => {
      if (activePort === port && activeRequestId === request.requestId) {
        emitError(port, request.requestId, error);
      }
    });
  } catch (error) {
    emitError(port, request.requestId, error);
  }
}

export function attachChatSpeechPort(port: chrome.runtime.Port): boolean {
  if (port.name !== CHAT_SPEECH_PORT_NAME) {
    return false;
  }
  port.onMessage.addListener((value: unknown) => {
    const request = value as ChatSpeechRequest;
    if (request?.type === "stop") {
      if (activePort === port) {
        activePort = null;
        activeRequestId = null;
      }
      try {
        chrome.tts.stop();
      } catch {}
      return;
    }
    if (request?.type === "get-voices") {
      void chrome.tts.getVoices()
        .then((voices) => post(port, { type: "voices", requestId: request.requestId, voices }))
        .catch((error: unknown) => post(port, { type: "error", requestId: request.requestId, message: errorMessage(error) }));
      return;
    }
    if (request?.type === "speak") {
      speak(port, request);
    }
  });
  port.onDisconnect.addListener(() => {
    if (activePort !== port) {
      return;
    }
    activePort = null;
    activeRequestId = null;
    try {
      chrome.tts.stop();
    } catch {}
  });
  return true;
}
