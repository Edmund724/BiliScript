// 阅读壳 DOM 完好性自查（纯叶子模块）：
// 供 reader/shell.ts（restore 档自愈）与 ui/script-button.ts（按钮守卫）共用，
// 避免轻量工具栏按钮模块因调用该谓词静态拖入整个阅读壳及其重依赖。

import { ids } from "../shared/dom-ids.js";
import { READER_READY_ATTR } from "./presentation-fields.js";

// 壳完好性自查：状态说视图开着，但 DOM 侧任一必要呈现条件缺失——壳被页面重渲染
// 整树摘走、.open 掉了、ready 门控卡 0、html/body 门控属性被页面侧清掉。
// 纯 DOM 谓词，不含 readingViewOpen 状态位；组合判断由调用方表达。
export function isReaderShellIntact(): boolean {
  const shell = document.getElementById(ids.readingView);
  return Boolean(
    shell?.isConnected &&
      !shell.hidden &&
      shell.classList.contains("open") &&
      shell.getAttribute(READER_READY_ATTR) !== "0" &&
      document.body.getAttribute("data-biliscript-reader-mode") === "1" &&
      document.documentElement.getAttribute("data-biliscript-reader-mode") === "1"
  );
}
