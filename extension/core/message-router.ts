import {
  BACKGROUND_MESSAGE_REGISTRY,
  resolveReplyKeepOpen,
  type BackgroundMessageHandlers,
  type MessageReplyDecision,
  type MessageReplyMode,
  type MessageSender,
  type SenderLabel,
  type SendResponse
} from "../shared/messaging-protocol.js";

export type MessageSenderLike = MessageSender;
export type MessageHandlerReturn = MessageReplyDecision | boolean | void;
export type MessageHandlerLike = (
  message: unknown,
  sender: MessageSenderLike,
  sendResponse: SendResponse
) => MessageHandlerReturn;

type NormalizedMessageHandler = (
  message: unknown,
  sender: MessageSenderLike | undefined,
  sendResponse: SendResponse
) => MessageHandlerReturn;

export interface MessageRouterOptions {
  handlers: BackgroundMessageHandlers | Record<string, MessageHandlerLike>;
  senders?: Record<SenderLabel, (sender: MessageSenderLike) => boolean>;
  rejectionMessage?: string;
  registry?: typeof BACKGROUND_MESSAGE_REGISTRY;
}

export type MessageRouter = (
  rawMessage: unknown,
  rawSender: MessageSenderLike | undefined,
  sendResponse: SendResponse
) => boolean;

type RegistrationLike = {
  reply: MessageReplyMode;
  shape?: (message: unknown) => boolean;
  sender?: SenderLabel;
};

const ILLEGAL_PAYLOAD_MESSAGE = "消息载荷不合法";

function normalizeHandlers(
  handlers: MessageRouterOptions["handlers"]
): Map<string, NormalizedMessageHandler> {
  const table = new Map<string, NormalizedMessageHandler>();
  for (const [type, handler] of Object.entries(handlers)) {
    if (typeof handler === "function") {
      table.set(type, handler as NormalizedMessageHandler);
    }
  }
  return table;
}

export function createMessageRouter(options: MessageRouterOptions): MessageRouter {
  const { handlers, senders, rejectionMessage, registry = BACKGROUND_MESSAGE_REGISTRY } = options;

  const handlerTable = normalizeHandlers(handlers);
  const registrationTable = new Map<string, RegistrationLike>(Object.entries(registry));

  return (rawMessage, rawSender, sendResponse) => {
    if (!rawMessage || typeof rawMessage !== "object" || !("type" in rawMessage)) {
      return false;
    }

    const rawType = rawMessage.type;
    if (typeof rawType !== "string") {
      return false;
    }
    const handler = handlerTable.get(rawType);
    if (!handler) {
      return false;
    }

    const registration = registrationTable.get(rawType);

    const senderLabel = registration?.sender;
    const allowSender = senderLabel === undefined ? undefined : senders?.[senderLabel];
    if (allowSender && !allowSender(rawSender ?? {})) {
      sendResponse({ ok: false, error: rejectionMessage });
      return false;
    }

    const shape = registration?.shape;
    if (shape && !shape(rawMessage)) {
      sendResponse({ ok: false, error: ILLEGAL_PAYLOAD_MESSAGE });
      return false;
    }

    const handlerResult = handler(rawMessage, rawSender, sendResponse);

    if (!registration) {
      return Boolean(handlerResult);
    }
    const decision: MessageReplyDecision | void =
      handlerResult === "hold" || handlerResult === "answered" ? handlerResult : undefined;
    return resolveReplyKeepOpen(registration.reply, decision);
  };
}
