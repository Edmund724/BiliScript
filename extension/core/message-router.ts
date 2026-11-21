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
export type MessageHandlerLike = (
  message: unknown,
  sender: MessageSenderLike,
  sendResponse: SendResponse
) => void;

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

export function createMessageRouter(options: MessageRouterOptions): MessageRouter {
  const { handlers, senders, rejectionMessage, registry = BACKGROUND_MESSAGE_REGISTRY } = options;

  const handlerTable = new Map<string, MessageHandlerLike>(
    Object.entries(handlers) as [string, MessageHandlerLike][]
  );
  const registrationTable = new Map<string, RegistrationLike>(
    Object.entries(registry as Record<string, RegistrationLike>)
  );

  return (rawMessage, rawSender, sendResponse) => {
    if (!rawMessage || typeof rawMessage !== "object") {
      return false;
    }

    const rawType = (rawMessage as { type?: unknown }).type;
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
    if (allowSender && !allowSender(rawSender as MessageSenderLike)) {
      sendResponse({ ok: false, error: rejectionMessage });
      return false;
    }

    const shape = registration?.shape;
    if (shape && !shape(rawMessage)) {
      sendResponse({ ok: false, error: ILLEGAL_PAYLOAD_MESSAGE });
      return false;
    }

    const invoke = handler as (
      message: unknown,
      sender: MessageSenderLike | undefined,
      sendResponse: SendResponse
    ) => unknown;
    const handlerResult = invoke(rawMessage, rawSender, sendResponse);

    return registration
      ? resolveReplyKeepOpen(registration.reply, handlerResult as MessageReplyDecision | void)
      : Boolean(handlerResult);
  };
}
