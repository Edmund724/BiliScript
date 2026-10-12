// core/message-router.ts — 消息入口的「按键取 handler → 判来源 → 判形状 → 派发 →
// 派生回包口径」策略单点。
//
// 组合根注入三样：handler 表（键 = 消息 type）、来源判据（来源标签 → 判据）与注册表
// （缺省取协议层的 SW 消息注册表 BACKGROUND_MESSAGE_REGISTRY）。本模块零 chrome：
// 来源判据本体（读扩展文档 URL）与 handler 本体都住在各自域，入口只接线——同
// core/background-content-orchestration 的先例（策略下沉 core，entry 只组装真实
// 平台 API）。
//
// 两条轴各自可省，同一份 interface 因此也容纳 content 侧既有的同形分发
// `(message, sendResponse) => boolean`：
//   - 来源守卫轴：省略 senders = 不判来源，派发面同时退回两参形态（第二形参即回包
//     回调，不再有位处给 sender）；
//   - 回包口径轴：注册表里没有本条登记 = 无 reply 可派，handler 的返回值即通道口径
//     （有登记则按 reply 档派生，branch 档读 handler 判定）。
// 本次只接 SW 半边：entry/background.ts 的 onMessage 监听器一行委派。

import {
  BACKGROUND_MESSAGE_REGISTRY,
  resolveReplyKeepOpen,
  type MessageReplyDecision,
  type MessageReplyMode,
  type MessageSender,
  type SendResponse
} from "../shared/messaging-protocol.js";

/** 来源标签：注册条目的 sender 取值，组合根按它注入对应判据。 */
export type SenderLabel = string;
export type MessageSenderLike = MessageSender;
/** SW 半边：有 sender 位（来源守卫轴开时按三参派发，回包口径照注册表 reply 档）。 */
export type MessageHandlerLike = (
  message: unknown,
  sender: MessageSenderLike,
  sendResponse: SendResponse
) => void;
/** content 侧同形分发：无 sender 位，handler 返回值即通道口径（来源守卫轴关时按
 *  两参派发）。本次不接入，只为同一份 interface 留位。 */
export type ContentMessageHandlerLike = (message: unknown, sendResponse: SendResponse) => void;

export interface MessageRouterOptions {
  /** handler 表：键 = 消息 type（逐键契约由组合根的表对注册表穷尽校验） */
  handlers: Record<string, MessageHandlerLike | ContentMessageHandlerLike>;
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
  // 当成 handler 或登记项（与组合根 messageHandlers Map 的按键查找同口径）。
  const handlerTable = new Map<string, MessageHandlerLike | ContentMessageHandlerLike>(
    Object.entries(handlers)
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
    //（SW 半边该键集与注册表键集逐键对齐；content 侧表外的类型不在注册表里，
    // 因此按「无登记」继续派发，见 ③）
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

    // ⑥ 派发：来源守卫轴开 = 三参形态；轴关 = content 侧两参形态（第二形参即回包回调）。
    // handler 返回值必须收下：branch 档的通道口径由它说。
    const invoke = handler as (
      message: unknown,
      senderOrResponse: unknown,
      sendResponse?: SendResponse
    ) => unknown;
    const handlerResult =
      senders === undefined
        ? invoke(rawMessage, sendResponse)
        : invoke(rawMessage, rawSender, sendResponse);

    // ⑦ 回包口径：有登记按 reply 档派生（branch 档读 handler 判定）；无登记 =
    // handler 返回值即通道口径
    return registration
      ? resolveReplyKeepOpen(registration.reply, handlerResult as MessageReplyDecision | void)
      : Boolean(handlerResult);
  };
}
