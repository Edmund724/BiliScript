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

type UnmappedResponse<M> = M extends BackgroundMessage | ContentScriptMessage
  ? ResponseOf<M> extends never
    ? M
    : never
  : never;

type UnmappedResponseMessages = UnmappedResponse<BackgroundMessage | ContentScriptMessage>;

export type EveryMessageHasResponseType = ExpectNever<UnmappedResponseMessages>;

type UnregisteredMessages = ExpectNever<
  Exclude<BackgroundMessageType, keyof typeof BACKGROUND_MESSAGE_REGISTRY>
>;
export type EveryBackgroundMessageRegistered = UnregisteredMessages;

type UnionResponse = ResponseOf<GetSettingsMessage | FetchJsonMessage>;
type UnionResponseMisses = Exclude<GetSettingsResponse | FetchJsonResponse, UnionResponse>;
type UnionResponseAdds = Exclude<UnionResponse, GetSettingsResponse | FetchJsonResponse>;
export type UnionResponseDistributes = ExpectNever<UnionResponseMisses | UnionResponseAdds>;
