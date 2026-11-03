export const CHAT_SPEECH_PORT_NAME = "chat-speech";

export interface ChatSpeechVoice {
  voiceName?: string;
  lang?: string;
  remote?: boolean;
}

export interface ChatSpeechEvent {
  type: string;
  errorMessage?: string;
}

export type ChatSpeechRequest =
  | { type: "get-voices"; requestId: number }
  | { type: "speak"; requestId: number; text: string; voiceName?: string; lang?: string; volume?: number }
  | { type: "stop" };

export type ChatSpeechPortMessage =
  | { type: "voices"; requestId: number; voices: ChatSpeechVoice[] }
  | { type: "event"; requestId: number; event: ChatSpeechEvent }
  | { type: "error"; requestId: number; message: string };
