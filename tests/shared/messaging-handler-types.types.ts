import type {
  BackgroundMessageHandler,
  ResponseOf
} from "../../extension/shared/messaging-protocol.js";

export function assertHandlerRegistrationTyped(): void {
  const legal: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true, data: { any: "json" } });
    return "hold";
  };
  void legal;

  const payload: ResponseOf<{ type: "fetch-json" }> = { ok: true, data: 1 };
  void payload;

  const wrongPayload: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    // @ts-expect-error presets 是 ai-presets-list 的响应字段，不是 fetch-json 的
    sendResponse({ ok: true, presets: [] });
    return "answered";
  };
  void wrongPayload;

  // @ts-expect-error branch 档 handler 必须返回显式判定（MessageReplyDecision）
  const missingDecision: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
  };
  void missingDecision;

  // @ts-expect-error 裸布尔不再是回包口径的形态（判定联合取代）
  const bareBoolean: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
    return true;
  };
  void bareBoolean;

  const asyncVoid: BackgroundMessageHandler<"get-settings"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
  };
  void asyncVoid;

  // @ts-expect-error 未登记的消息名不在 BackgroundMessageType 内
  type UnknownKeyHandler = BackgroundMessageHandler<"no-such-message">;
  void (null as unknown as UnknownKeyHandler);
}
