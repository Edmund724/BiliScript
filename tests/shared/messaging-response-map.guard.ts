// 消息协议响应映射穷尽守卫（arch-slim-2/02；消息注册表收敛后同址复核）：
// 文件名不含 .test.，vitest 不收集；tsc --noEmit 门禁执行本文件。
// 事实锚点已从「ResponseOf 条件链」迁到协议层的 BACKGROUND_MESSAGE_REGISTRY
// （一条消息一处登记：声明 + 形状判据 + 回包口径 + 响应类型载体），本文件把
// 注册表的类型层不变量钉死：
//   1. 每条 ContentScriptMessage / BackgroundMessage 都必须经 ResponseOf 映射到
//      具体响应类型（未映射 → never，ExpectNever 处报编译错误）；
//   2. 每条 BackgroundMessage 字面量都必须在注册表里显式登记（漏登记 = 守卫无
//      形状判据、ResponseOf 无响应载体）；
//   3. ResponseOf 对联合消息必须分发（塌成 never 或只剩一支都在此报错）——
//      settings-panel / provider-family 等消费点的单字面量纪律依赖这条不变式。
import {
  BACKGROUND_MESSAGE_REGISTRY,
  type BackgroundMessage,
  type BackgroundMessageType,
  type ContentScriptMessage,
  type FetchJsonMessage,
  type FetchJsonResponse,
  type GetSettingsMessage,
  type GetSettingsResponse,
  type ResponseOf
} from "../../extension/shared/messaging-protocol.js";

type ExpectNever<T extends never> = T;

// M 为裸类型参数：对消息 union 逐成员分发；未映射成员的 ResponseOf 解析为
// never，此时该成员原样浮出，否则吞为 never。
type UnmappedResponse<M> = M extends BackgroundMessage | ContentScriptMessage
  ? ResponseOf<M> extends never
    ? M
    : never
  : never;

type UnmappedResponseMessages = UnmappedResponse<BackgroundMessage | ContentScriptMessage>;

// 全部已映射时为 never（合法）；任一消息漏配响应类型，本行报
// 「Type '<消息名>' does not satisfy the constraint 'never'」。
export type EveryMessageHasResponseType = ExpectNever<UnmappedResponseMessages>;

// 注册表键覆盖：BackgroundMessageType 的每个字面量都必须有登记条目（漏一条即报
// 「Type '<消息名>' does not satisfy the constraint 'never'」）。
type UnregisteredMessages = ExpectNever<
  Exclude<BackgroundMessageType, keyof typeof BACKGROUND_MESSAGE_REGISTRY>
>;
export type EveryBackgroundMessageRegistered = UnregisteredMessages;

// 联合分发（不得退化为 never / 单支）：ResponseOf<A | B> 必须恰好是
// ResponseA | ResponseB。
type UnionResponse = ResponseOf<GetSettingsMessage | FetchJsonMessage>;
type UnionResponseMisses = Exclude<GetSettingsResponse | FetchJsonResponse, UnionResponse>;
type UnionResponseAdds = Exclude<UnionResponse, GetSettingsResponse | FetchJsonResponse>;
export type UnionResponseDistributes = ExpectNever<UnionResponseMisses | UnionResponseAdds>;
