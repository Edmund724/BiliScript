// tests/shared/messaging-handler-types.types.ts — SW handler 注册面（按消息键收型）
// 的编译期断言（票 message-registry/02 第 1、2 项）。
//
// 本文件不是 vitest 用例（文件名不匹配 vitest 的 test/spec glob），由 `pnpm typecheck`
//（tsc --noEmit，include tests/**/*.ts）执行：
// - 每条 `@ts-expect-error` 的直写都必须编译失败——响应载荷与消息键配错、branch 档
//   判定缺失、裸布尔回退、未登记的消息键，都在此报错；若哪天某条契约被放松、断言重新
//   编译通过，tsc 报 "Unused '@ts-expect-error' directive"，断言随即失败；
// - 末尾正向对照证明合法登记面照常通过（防止断言写成「谁都传不进」）。
//
// 为什么用类型而不是运行期用例：这些约束的收益正是「配错由编译器抓」——运行期看不出
// 来（多写/错名的字段被忽略，漏返回的判定静默读成 undefined → 通道提前关闭，即 01 票
// 查明的 get-ai-provider-key 正路径丢回包一类）。断言用的 BackgroundMessageHandler<K>
// 就是 entry/background.ts 路由表 satisfies 的同一个类型面。

import type {
  BackgroundMessageHandler,
  ResponseOf
} from "../../extension/shared/messaging-protocol.js";

export function assertHandlerRegistrationTyped(): void {
  // ===== 正向对照：载荷与消息键匹配 + branch 判定显式 =====
  const legal: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true, data: { any: "json" } });
    return "hold";
  };
  void legal;

  // 正向对照②：sendResponse 的载荷面 = 该键的 ResponseOf（注册表派生的同一事实）
  const payload: ResponseOf<{ type: "fetch-json" }> = { ok: true, data: 1 };
  void payload;

  // ===== 响应载荷与消息键配错：编译期即红 =====
  const wrongPayload: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    // @ts-expect-error presets 是 ai-presets-list 的响应字段，不是 fetch-json 的
    sendResponse({ ok: true, presets: [] });
    return "answered";
  };
  void wrongPayload;

  // ===== branch 档判定缺失：编译期即红（返回 void 会让入口读 undefined → 通道提前关闭）=====
  // @ts-expect-error branch 档 handler 必须返回显式判定（MessageReplyDecision）
  const missingDecision: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
  };
  void missingDecision;

  // ===== 裸布尔回退：编译期即红（错误落在声明行：返回值不是判定联合）=====
  // @ts-expect-error 裸布尔不再是回包口径的形态（判定联合取代）
  const bareBoolean: BackgroundMessageHandler<"fetch-json"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
    return true;
  };
  void bareBoolean;

  // ===== async / sync 档：回包口径归注册表，handler 返回 void 照常通过 =====
  const asyncVoid: BackgroundMessageHandler<"get-settings"> = (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
  };
  void asyncVoid;
  // 注：async / sync 档的多余返回值（如 return "hold"）在入口被忽略（口径归注册表），
  // 类型面不禁止——反正不会成为第二个口径；branch 档的返回值才是口径本身，故必须
  // 显式回判定（见上方 missingDecision）。

  // ===== 未登记的消息键没有 handler 面（键集 = BackgroundMessageType）=====
  // @ts-expect-error 未登记的消息名不在 BackgroundMessageType 内
  type UnknownKeyHandler = BackgroundMessageHandler<"no-such-message">;
  void (null as unknown as UnknownKeyHandler);
}
