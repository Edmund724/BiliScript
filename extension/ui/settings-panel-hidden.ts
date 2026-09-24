// ui/settings-panel-hidden.ts — 设置抽屉「收起」观察（02 复制粘贴收口）。
//
// 语义来源：抽屉被外点/齿轮收起时用户意图是「关掉一切」，叠在它之上的弹层
// 必须一并结算——provider-editor 按强制关闭（丢弃 dirty 草稿），confirm-dialog
// 按取消结算。此前 provider-editor.ts 与 confirm-dialog.ts 各写了一份逐字相同的
// watchSettingsPanel，两处只在回调与（confirm 侧的）代次捕获上不同，故把公共的
// 「盯 #biliscript-reading-settings-panel 的 hidden 属性」抽成单份原语。
//
// 不自行持有 observer：调用方把宿主 state 传进来，由原语就地挂上 observer 字段，
// 便于关闭流程统一 disconnect（两侧既有的清理路径不变）。环境不支持
// MutationObserver 或面板不在时静默返回，不覆写既有 observer——与原实现的早退
// 语义一致。

import { ids } from "../shared/dom-ids.js";

// 两处调用方各有自己的 state 类型（provider-editor 与 confirm-dialog 互不共享），
// 这里只要求可写的 observer 字段，避免为复用一个原语而抽出共享基类。
export interface SettingsPanelObserverHost {
  observer: MutationObserver | null;
}

export function observeSettingsPanelHidden(onHidden: () => void, host: SettingsPanelObserverHost): void {
  const panel = document.getElementById(ids.readingSettingsPanel);
  if (!panel || typeof MutationObserver === "undefined") {
    return;
  }
  const observer = new MutationObserver(() => {
    if (panel.hidden) {
      onHidden();
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  host.observer = observer;
}
