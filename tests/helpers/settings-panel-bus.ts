// 设置面板 / 平台编辑 Modal 类用例共用的消息总线：content 侧按 message.type 分发的
// sendMessage 桩（回包只经 callback），外加「已发消息」清单与设置面板首屏的缺省回包表。
//
// 缺省表只放设置面板首屏要的那几条；各文件在自己的表里叠专属条目，再叠用例的 overrides。
// 未登记 type 抛错（契约与 tests/helpers/chrome-runtime-host.ts 同一份）——用例会发的 type
// 必须逐条登记，静默兜底会让拼错的消息名照样通过。
//
// 总线桩写进 chrome.runtime.sendMessage，故必须在 beforeEach / 用例体内调用（缺省全局桩
// 受 tests/setup.ts 的存在性守卫，vi.unstubAllGlobals() 之后不会自动装回）。

import { installSendMessageHost, type RuntimeReplies, type SendMessageHost } from "./chrome-runtime-host.js";

export type BusMessage = { type: string } & Record<string, unknown>;

// 参数取 any（缺省）：各文件的回包表把消息窄化成自己的形状（`{ type: string } & Record<…>`），
// strictFunctionTypes 下窄参数函数进不了以 unknown 为参数的表；要精确类型就在调用点给
// installSettingsPanelBus 传自己的消息类型（泛型 M）。
export type BusResponder<M = any> = (message: M) => unknown;

/** 设置面板首屏缺省回包：无平台、预设列表失败（面板回落内置表）、设置取缺省值。 */
export const SETTINGS_PANEL_BUS_REPLIES: RuntimeReplies = {
  "get-settings": () => ({ ok: true, settings: {} }),
  "ai-presets-list": () => ({ ok: false }),
  "asr-presets-list": () => ({ ok: false }),
  "ai-providers-list": () => ({ ok: true, providers: [] }),
  "asr-providers-list": () => ({ ok: true, providers: [] }),
  "search-providers-list": () => ({ ok: true, providers: [] }),
  "save-settings": () => ({ ok: true })
};

/** 本域对「已发消息」的形状约束：带 type 判别字段。 */
export type MessageBusHost<M extends BusMessage = BusMessage> = SendMessageHost<M>;

/**
 * 装消息总线：设置面板缺省表 → overrides 合并成回包表，装配交给
 * chrome-runtime-host 的 installSendMessageHost（桩写进 chrome.runtime.sendMessage，
 * 同时记下每条已发消息）。M = 本用例自己的消息形状。
 */
export function installSettingsPanelBus<M extends BusMessage = BusMessage>(
  overrides: Record<string, unknown | BusResponder<M>> = {}
): MessageBusHost<M> {
  return installSendMessageHost<M>({ ...SETTINGS_PANEL_BUS_REPLIES, ...overrides } as RuntimeReplies);
}
