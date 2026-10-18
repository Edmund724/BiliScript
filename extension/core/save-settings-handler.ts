// extension/core/save-settings-handler.ts
// save-settings SW 端 handler 工厂：编排体自 entry/background.ts 搬入 core 域
//（与 saveSettings 落盘同域）。本模块只做编排——「写入口（落盘 + 失效）→ 撤回
// 判定 → 撤回钩子」的时序与回包信封；落盘语义（白名单、归一化）仍归 settings-store
// 单源，失效键面归 core/settings-snapshot 的 invalidatingWrite，撤回判据与清缓存
// 钩子归 search/search-opt-out.ts（撤回是搜索域知识）。
// 回包信封收进工厂（withOkResponse 先例同 core/provider-handlers.ts）：决议值
// { ok: true } 原样回包，拒绝统一 { ok: false, error }。

import { withOkResponse } from "./provider-handlers.js";
import { isSearchOptOut } from "../search/search-opt-out.js";

export interface SaveSettingsHandlerDeps {
  /** 写入口：包住 saveSettings 落盘的 invalidatingWrite 产物（payload 键全集按键域失效） */
  saveSettingsWithInvalidate: (payload: unknown) => Promise<unknown>;
  /** 保存前的 settings 快照（撤回判据取保存前的 webSearchEnabled 值） */
  getSettingsSnapshot: () => Promise<{ webSearchEnabled?: boolean }>;
  /** 撤回钩子（search 域注入；判中才调用） */
  onSearchOptOut?: () => Promise<void>;
}

export function createSaveSettingsHandler({
  saveSettingsWithInvalidate,
  getSettingsSnapshot,
  onSearchOptOut
}: SaveSettingsHandlerDeps): (
  message: unknown,
  sender: unknown,
  sendResponse: (response: { ok: boolean; error?: string }) => void
) => void {
  return function handleSaveSettings(
    message: unknown,
    _sender: unknown,
    sendResponse: (response: { ok: boolean; error?: string }) => void
  ): void {
    withOkResponse(
      (async () => {
        // 显式取撤回判据（settings 是 unknown 线格式，落盘与失效各自照旧收口）：
        // payload 的 webSearchEnabled 从 true 变 false 才是关 pill 的撤回；判据取
        // 保存前的快照值，失效顺序维持既有形态（先判后写）。
        const payload = (message as { settings?: unknown } | null | undefined)?.settings || {};
        const searchOptOut = isSearchOptOut(
          (await getSettingsSnapshot()).webSearchEnabled === true,
          payload
        );
        await saveSettingsWithInvalidate(payload);
        if (searchOptOut && onSearchOptOut) {
          // 撤回主入口（关 pill）；平台删除撤回的次入口收在 search/search-provider-deletion.ts。
          await onSearchOptOut();
        }
        return { ok: true as const };
      })(),
      sendResponse
    );
  };
}
