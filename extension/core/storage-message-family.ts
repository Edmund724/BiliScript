// extension/core/storage-message-family.ts
// 「存储消息族」的 handler 壳单源。
//
// 背景：SW 侧几条以 chrome.storage 为宿主的消息族（search-cache / search-health /
// segment-cache）的 handler 壳完全同形——工厂签名 (message, sender, sendResponse) →
// void、op 判别、未知 op 文案、withOkResponse 信封（core/provider-handlers.ts）——
// 三处只差族名与 op 表。本工厂把这层壳收成一处：一族一条声明
// （type / ops / unknownOpText / toError），产出该族的 handler。
//
// 缝的边界：工厂只做「op → 分支体」的判别、未知 op 拒绝与信封，不碰任何域逻辑——
// op 分支体（读写哪个存储叶、载荷怎么归一）仍住各族自己的模块，声明在调用点原地给出。
// 这样新族只写声明与分支体，壳的字节（未知 op 回包文案形状、失败信封、回包时机归
// 协议层 reply 登记）不再手抄。
//
// 落 core/ 而非 shared/：信封落点 withOkResponse 住 core/provider-handlers.ts，shared
// 是叶子层（tests/layer-deps.test.ts 的不变量 A），工厂进 shared 会反向依赖 core。
//
// 拒绝归一：分支体拒绝（含未知 op 的自抛）统一映射为 { ok: false, error: <串> }；
// toError 缺省不传，由 withOkResponse 的缺省参数取 core/provider-http-shared 的
// errorText 单源（Error 取 message、其余走 String）——非 Error / undefined 拒绝也不会
// 写成 undefined，更不会在包装内自抛导致回包根本不发出。文案带前缀/兜底的族传 toError。
//
// op 判别按声明表的自有键（Map）：op 取到 "toString" / "constructor" 这类原型成员名时
// 不得命中分支体——那是未知 op，回族文案，而不是把 Object.prototype 的成员当处理器调。
//
// 静态 import（ADR-0003：SW 不做运行时惰性化）：组合根 entry/background.ts 直接
// import 各族的 create*Handler 工厂。

import { withOkResponse, type MessageErrorEnvelope } from "./provider-handlers.js";

// 族消息的最小形状：type 为线格式族名（类型层把 M 绑到本族），op 为本族的操作联合
// （声明表的键集即它，漏一个 op 在调用点 tsc 即红）。
export interface StorageFamilyMessage {
  type: string;
  op: string;
}

// 回包形参：成功载荷 R 与失败信封并列（与 withOkResponse 同一口径），该族的协议响应
// 类型即 R——响应载荷与消息键配错由组合根 handler 表的 satisfies 在 tsc 门禁拦下。
export type StorageFamilySendResponse<R> = (response: R | MessageErrorEnvelope) => void;

export type StorageFamilyHandler<M extends StorageFamilyMessage, R> = (
  message: M,
  sender: unknown,
  sendResponse: StorageFamilySendResponse<R>
) => void;

export interface StorageFamilyDeclaration<M extends StorageFamilyMessage, R> {
  /** 本族消息的 type 字面量（类型层载体：把 M 绑到本族，运行期不读）。 */
  readonly type: M["type"];
  /** op → 分支体：键集 = 本族消息的 op 联合；决议值即回包载荷（可为异步）。 */
  readonly ops: { readonly [K in M["op"]]: (message: M) => R | Promise<R> };
  /** 未知 op 回包文案前缀：error = 前缀 + String(op)。 */
  readonly unknownOpText: string;
  /** 拒绝归一（缺省走 withOkResponse 的 errorText 单源）。 */
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
