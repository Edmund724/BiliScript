// core/message-router.ts — 消息入口的「按键取 handler → 判来源 → 判形状 → 派发 →
// 派生回包口径」策略单点。
//
// 组合根注入三样：handler 表（键 = 消息 type）、来源判据（来源标签 → 判据）与注册表
// （缺省取协议层的 SW 消息注册表 BACKGROUND_MESSAGE_REGISTRY）。本模块零 chrome：
// 来源判据本体（读扩展文档 URL）与 handler 本体都住在各自域，入口只接线——同
// core/background-content-orchestration 的先例（策略下沉 core，entry 只组装真实
// 平台 API）。
//
// 本模块是 SW 专用：唯一接线点是 entry/background.ts 的 onMessage 监听器一行委派，
// 派发面恒为三参形态 `(message, sender, sendResponse)`。两条轴各自可省：
//   - 来源守卫轴：省略 senders = 不判来源；
//   - 回包口径轴：注册表里没有本条登记 = 无 reply 可派，handler 的返回值即通道口径
//     （有登记则按 reply 档派生，branch 档读 handler 判定）。

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
/** SW 派发面：三参形态（来源守卫轴开时按 sender 先判，回包口径照注册表 reply 档）。 */
export type MessageHandlerLike = (
  message: unknown,
  sender: MessageSenderLike,
  sendResponse: SendResponse
) => void;

export interface MessageRouterOptions {
  /** handler 表：SW 组合根注入由注册表派生的 BackgroundMessageHandlers（逐键形参/响应载荷/返回值精确收窄）；
   *  测试可传入兼容的 Record<string, MessageHandlerLike>。 */
  handlers: BackgroundMessageHandlers | Record<string, MessageHandlerLike>;
  /** 来源判据：标签 → 判据（缺省 = 不判来源；注入的标签无判据即放行） */
  senders?: Record<SenderLabel, (sender: MessageSenderLike) => boolean>;
  /** 来源守卫拒绝时的回包文案（字面量单源由组合根注入，本模块不持文案） */
  rejectionMessage?: string;
  /** 消息注册表（缺省取协议层的 SW 注册表） */
  registry?: typeof BACKGROUND_MESSAGE_REGISTRY;
}

export type MessageRouter = (
  rawMessage: unknown,
  rawSender: MessageSenderLike | undefined,
  sendResponse: SendResponse
) => boolean;

/** 守卫只读这三项登记事实（形状判据 / 来源标签 / 回包口径），不持注册表键集。 */
type RegistrationLike = {
  reply: MessageReplyMode;
  shape?: (message: unknown) => boolean;
  sender?: SenderLabel;
};

// payload 形状不合法的回包文案（职责并入本模块，不导出）。
const ILLEGAL_PAYLOAD_MESSAGE = "消息载荷不合法";

export function createMessageRouter(options: MessageRouterOptions): MessageRouter {
  const { handlers, senders, rejectionMessage, registry = BACKGROUND_MESSAGE_REGISTRY } = options;

  // 键表 Map 化一次：Object.prototype 上的同名键（constructor / toString 等）不得被
  // 当成 handler 或登记项（与登记表同口径的按键查找）。
  // 类型在组合根已穷尽校验，收拢点保留显式断言。
  const handlerTable = new Map<string, MessageHandlerLike>(
    Object.entries(handlers) as [string, MessageHandlerLike][]
  );
  const registrationTable = new Map<string, RegistrationLike>(
    Object.entries(registry as Record<string, RegistrationLike>)
  );

  return (rawMessage, rawSender, sendResponse) => {
    // ① 非对象载荷：不收、不回包
    if (!rawMessage || typeof rawMessage !== "object") {
      return false;
    }

    // ② 消息类型：非字符串或不认识都不收、不回包。认可集合 = handler 表键集
    //（组合根注入的表与注册表键集逐键对齐）
    const rawType = (rawMessage as { type?: unknown }).type;
    if (typeof rawType !== "string") {
      return false;
    }
    const handler = handlerTable.get(rawType);
    if (!handler) {
      return false;
    }

    // ③ 登记事实：无登记 = 无来源标签、无形状判据，回包口径退回 handler 返回值
    const registration = registrationTable.get(rawType);

    // ④ 来源守卫：只认「注册表标签 + 注入判据」这一对（无标签 / 无判据 = 放行，
    // 默认放行是既有语义）；拒绝在 handler 执行前即答，零副作用
    const senderLabel = registration?.sender;
    const allowSender = senderLabel === undefined ? undefined : senders?.[senderLabel];
    if (allowSender && !allowSender(rawSender as MessageSenderLike)) {
      sendResponse({ ok: false, error: rejectionMessage });
      return false;
    }

    // ⑤ payload 形状守卫：只拦形状明显非法，业务归一仍归 handler
    const shape = registration?.shape;
    if (shape && !shape(rawMessage)) {
      sendResponse({ ok: false, error: ILLEGAL_PAYLOAD_MESSAGE });
      return false;
    }

    // ⑥ 派发（三参形态，sender 原样透传——监听器侧的 sender 可能缺位）。
    // handler 返回值必须收下：branch 档的通道口径由它说。
    const invoke = handler as (
      message: unknown,
      sender: MessageSenderLike | undefined,
      sendResponse: SendResponse
    ) => unknown;
    const handlerResult = invoke(rawMessage, rawSender, sendResponse);

    // ⑦ 回包口径：有登记按 reply 档派生（branch 档读 handler 判定）；无登记 =
    // handler 返回值即通道口径
    return registration
      ? resolveReplyKeepOpen(registration.reply, handlerResult as MessageReplyDecision | void)
      : Boolean(handlerResult);
  };
}
