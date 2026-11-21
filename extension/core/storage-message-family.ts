import { withOkResponse, type MessageErrorEnvelope } from "./provider-handlers.js";

export interface StorageFamilyMessage {
  type: string;
  op: string;
}

export type StorageFamilySendResponse<R> = (response: R | MessageErrorEnvelope) => void;

export type StorageFamilyHandler<M extends StorageFamilyMessage, R> = (
  message: M,
  sender: unknown,
  sendResponse: StorageFamilySendResponse<R>
) => void;

export interface StorageFamilyDeclaration<M extends StorageFamilyMessage, R> {
  readonly type: M["type"];
  readonly ops: { readonly [K in M["op"]]: (message: M) => R | Promise<R> };
  readonly unknownOpText: string;
  readonly toError?: (error: unknown) => string;
}

export function defineStorageMessageFamily<M extends StorageFamilyMessage, R>(
  declaration: StorageFamilyDeclaration<M, R>
): StorageFamilyHandler<M, R> {
  const handlers = new Map<string, (message: M) => R | Promise<R>>();
  for (const op of Object.keys(declaration.ops)) {
    handlers.set(op, declaration.ops[op as M["op"]]);
  }

  return function handleStorageFamilyMessage(message, _sender, sendResponse) {
    withOkResponse(
      (async (): Promise<R> => {
        const op = (message as { op?: unknown }).op;
        const handle = handlers.get(String(op));
        if (!handle) {
          throw new Error(declaration.unknownOpText + String(op));
        }
        return handle(message);
      })(),
      sendResponse,
      declaration.toError
    );
  };
}
