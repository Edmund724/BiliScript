// ui/settings-panel-hidden.ts — 设置抽屉「收起」观察（02 复制粘贴收口）。
//
// 语义来源：抽屉被外点/齿轮收起时用户意图是「关掉一切」，叠在它之上的弹层
// 必须一并结算——provider-editor 按强制关闭（丢弃 dirty 草稿），confirm-dialog
// 按取消结算。此前 provider-editor.ts 与 confirm-dialog.ts 各写了一份逐字相同的
// watchSettingsPanel，两处只在回调与（confirm 侧的）代次捕获上不同，故把公共的
// 「盯 #boc-reading-settings-panel 的 hidden 属性」抽成单份原语。
//
// 不自行持有 observer：返回实例交给调用方挂进自己的 state，便于关闭流程统一
// disconnect（两侧既有的清理路径不变）。环境不支持 MutationObserver 或面板不在
// 时返回 null，调用方按「无监听可挂」静默跳过，与原实现的早退语义一致。

import { ids } from "../shared/dom-ids.js";

export function observeSettingsPanelHidden(onHidden: () => void): MutationObserver | null {
  const panel = document.getElementById(ids.readingSettingsPanel);
  if (!panel || typeof MutationObserver === "undefined") {
    return null;
  }
  const observer = new MutationObserver(() => {
    if (panel.hidden) {
      onHidden();
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  return observer;
}
