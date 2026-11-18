// 字幕 tab 选区「解释」的壳接缝（arch-slim-2/06：浮层模板 + 选区监听/定位/
// 快照 + 卡片容器委托，自 ui/ui-renderer.ts 下放；解释卡片状态机与 AI 请求
// 在 reader/explain-card.ts——「随 explain 域」的两文件同居）。
//
// 交互链：在字幕句里选中词/句 → 选区下方浮出「解释」按钮（本模块）→ 点按钮
// 调 explain-card.ts 的 openReaderExplainCard（重域，经 ui/reader-gate 的
// withReader 动态装载）→ 面板内弹卡片。卡片底部「去对话追问」才写待解释意图
//（reader/explain-intent.ts 契约），由对话 tab 消费——常驻侧不直连该契约。
//
// 本模块是壳可静态携带的轻叶子：只依赖 ids 表与 reader-gate 转发助手，动态
// 边在 reader-gate 内部（chunk 边不变形）。绑定随壳构建同步执行、
// forceRecreate 重建后随壳重绑。

import { byId } from "../shared/dom-utils.js";
import { ids } from "./state.js";
import { withReader } from "../ui/reader-gate.js";
import {
  closestSubtitleItem,
  findSubtitleItem,
  getMainLineText,
  getSubtextNode,
  SUBTITLE_SUBTEXT_CLASS
} from "./subtitle-item-dom.js";
import {
  animateTriggerExit,
  cancelTriggerExit,
  prefersReducedMotion,
  TRIGGER_ENTER_EASING
} from "../ui/trigger-motion.js";

// 选区「解释」浮层：单实例、绝对定位在 tab body（不进列表滚动容器，避免随
// 滚动裁剪/漂移），在字幕句内选中词/句后定位到选区下方。
export function buildExplainPopHtml(): string {
  return `
            <!-- 选区「解释」浮层：单实例、绝对定位在 tab body（不进列表滚动
                 容器，避免随滚动裁剪/漂移），在字幕句内选中词/句后定位到选区下方 -->
            <div id="${ids.readingExplainPop}" class="biliscript-reading-explain-pop" hidden>
              <button type="button" class="biliscript-reading-explain-btn">解释</button>
            </div>
  `;
}

// 选区「解释」卡片宿主：覆盖整个 tab body 的面板内弹层（遮罩 + 对话框），
// 内容由 reader/explain-card.ts 按状态机整块重建。
export function buildExplainCardHostHtml(): string {
  return `
            <!-- 选区「解释」卡片宿主：覆盖整个 tab body 的面板内弹层（遮罩 +
                 对话框），内容由 reader/explain-card.js 按状态机整块重建 -->
            <div id="${ids.readingExplainCard}" class="biliscript-reading-explain-card" hidden></div>
  `;
}

export function bindReadingExplainEvents(): void {
  // 触发条件是「在字幕句里选中了词/句」，不再是 hover。选区变化经 document
  // selectionchange 单点委托（拖选/双击/键盘选区都覆盖），只在选区落在字幕列表
  // 内时显示浮层，并定位到选区下方；选区清空/移出列表/列表滚动时隐藏。
  // 定位合帧到 rAF：拖选期间 selectionchange 高频触发，一帧内至多一次「读→写」
  // 相位（事件相位只做无布局的选区判定与快照）。
  // 浮层挂在本 tab body（非列表滚动容器）内，不进 .biliscript-reading-item 的点击委托
  // 链——点「解释」不会触发点句跳转。
  const readingExplainPop = byId(ids.readingExplainPop);
  const readingExplainBtn = readingExplainPop.querySelector("button") as HTMLButtonElement;
  const readingTabBodySubtitle = byId(ids.readingTabBodySubtitle);
  const subtitleList = byId(ids.readingSubtitleList);
  // 浮层显示时快照选区（条目索引 + 选中原文）：点「解释」时不再回读
  // window.getSelection()——彼时选区可能已被浏览器折叠，且快照语义更明确。
  let pendingExplainSelection: { itemIndex: string; selection: string; inReadySubtext: boolean } | null = null;
  // 本帧待定位的选区快照（cloneRange——rAF 执行时选区可能已继续变化/折叠）；
  // 两个帧句柄分别对应「定位/显形」与「显形后量宽」，hide 时一并取消。
  let pendingExplainTarget: { item: HTMLElement; range: Range; selection: string; inReadySubtext: boolean } | null = null;
  let lastPlacedTarget: { item: HTMLElement; range: Range; selection: string; inReadySubtext: boolean } | null = null;
  let showFrameId = 0;
  let measureFrameId = 0;
  // 尺寸缓存：定位热路径绝不回读 offsetWidth/offsetHeight（写 hidden 后立刻读会强制
  // 同步布局）。每次显形后的下一帧量一次（该帧只读不写），在浮层隐藏时重置标记，避免
  // 字号调整后长期沿用旧尺寸。
  const POP_MARGIN = 8;
  const POP_GAP = 4;
  const POP_WIDTH_FALLBACK = 52;
  const POP_HEIGHT_FALLBACK = 30;
  let popWidth = POP_WIDTH_FALLBACK;
  let popHeight = POP_HEIGHT_FALLBACK;
  let popSizeMeasured = false;
  let lastSelectionRect: DOMRect | null = null;
  const cancelExplainPopFrames = () => {
    if (showFrameId) {
      window.cancelAnimationFrame(showFrameId);
      showFrameId = 0;
    }
    if (measureFrameId) {
      window.cancelAnimationFrame(measureFrameId);
      measureFrameId = 0;
    }
    pendingExplainTarget = null;
  };
  const hideExplainPop = () => {
    // 先取消本帧待定位：「浮层已隐藏且尚无快照」也可能是刚排了一帧，走下面的
    // 早退会漏掉取消，下一帧又把它显形。
    cancelExplainPopFrames();
    // 浮层收起后清掉尺寸缓存标记，下次再显示时重新按当前字号校准一次宽高。
    popSizeMeasured = false;
    lastPlacedTarget = null;
    // 热路径守卫：selectionchange 对页面任何输入框的选区变化都会触发，已隐藏时
    // 直接返回，避免每次敲键盘都写一遍 DOM。
    if (readingExplainPop.hidden && !pendingExplainSelection) {
      return;
    }
    delete readingExplainPop.dataset.itemIndex;
    pendingExplainSelection = null;
    const savedRect = lastSelectionRect;
    lastSelectionRect = null;
    if (readingExplainPop.hidden) {
      return;
    }
    animateTriggerExit({
      target: readingExplainPop,
      trigger: savedRect,
      fallbackOrigin: "top center",
      toScale: 0.9,
      durationMs: 110,
      onFinish: () => {
        readingExplainPop.hidden = true;
      }
    });
  };
  // 选区矩形：jsdom 无 Range.getBoundingClientRect，取不到时退回条目矩形
  //（测试环境两者都是零矩形，定位数值不参与断言）。
  const explainAnchorRect = (range: Range, item: HTMLElement) => {
    const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    if (rect && (rect.width || rect.height || rect.top || rect.left)) {
      return rect;
    }
    return item.getBoundingClientRect();
  };
  // 显形 + 定位：本帧的「读→写」相位。读相位一次性取全部几何（body rect、
  // 选区 rect），写相位一次性写 hidden/dataset/left/top——中间不再夹读，
  // 因此不触发强制同步布局。浮层宽高取缓存值（显形下一帧只读校准）。
  const placeExplainPop = (target: { item: HTMLElement; range: Range; selection: string; inReadySubtext: boolean }) => {
    const bodyRect = readingTabBodySubtitle.getBoundingClientRect();
    const rect = explainAnchorRect(target.range, target.item);
    const width = popWidth || POP_WIDTH_FALLBACK;
    const height = popHeight || POP_HEIGHT_FALLBACK;
    // 水平位置 = 选区中点正下方居中（贴左右边界时收敛回 tab body 内）；
    // 垂直位置 = 默认放在选区下缘留 4px，若贴底溢出且上方有空间则翻转到选区上方，
    // 否则钳制在可见区域 [POP_MARGIN, maxTop] 内。
    const selectionCenter = Math.round(rect.left + rect.width / 2 - bodyRect.left);
    const maxLeft = Math.max(POP_MARGIN, Math.round(bodyRect.width) - width - POP_MARGIN);
    const left = Math.min(Math.max(POP_MARGIN, selectionCenter - Math.round(width / 2)), maxLeft);
    const belowTop = Math.round(rect.bottom - bodyRect.top) + POP_GAP;
    const aboveTop = Math.round(rect.top - bodyRect.top) - height - POP_GAP;
    const maxTop = Math.max(POP_MARGIN, Math.round(bodyRect.height) - height - POP_MARGIN);
    let top = belowTop;
    let placedAbove = false;
    if (belowTop + height > bodyRect.height - POP_MARGIN) {
      if (aboveTop >= POP_MARGIN) {
        top = aboveTop;
        placedAbove = true;
      } else {
        top = Math.min(Math.max(POP_MARGIN, belowTop), maxTop);
      }
    } else {
      top = Math.max(POP_MARGIN, belowTop);
    }
    const ox = Math.max(-24, Math.min(width + 24, selectionCenter - left));
    const oy = placedAbove ? Math.round(rect.top - bodyRect.top) - top : Math.round(rect.bottom - bodyRect.top) - top;
    const wasHidden = readingExplainPop.hidden || readingExplainPop.hasAttribute("data-biliscript-closing");
    cancelTriggerExit(readingExplainPop);
    lastSelectionRect = rect as DOMRect;
    pendingExplainSelection = {
      itemIndex: target.item.dataset.index || "",
      selection: target.selection,
      inReadySubtext: target.inReadySubtext
    };
    lastPlacedTarget = target;
    readingExplainPop.dataset.itemIndex = pendingExplainSelection.itemIndex;
    readingExplainPop.style.left = `${left}px`;
    readingExplainPop.style.top = `${top}px`;
    readingExplainPop.style.transformOrigin = `${Math.round(ox)}px ${Math.round(oy)}px`;
    readingExplainPop.hidden = false;
    if (wasHidden && !prefersReducedMotion() && typeof readingExplainPop.animate === "function") {
      try {
        readingExplainPop.animate(
          [
            { opacity: 0, scale: "0.9" },
            { opacity: 1, scale: "1" }
          ],
          { duration: 150, easing: TRIGGER_ENTER_EASING, fill: "none" }
        );
      } catch {}
    }
  };
  const runExplainPopFrame = () => {
    showFrameId = 0;
    const target = pendingExplainTarget;
    pendingExplainTarget = null;
    if (!target) {
      return;
    }
    placeExplainPop(target);
    // 尺寸校准帧：显形后布局已就绪，该帧只读不写，读 offsetWidth/offsetHeight 是干净读。
    // 量到后更新缓存；若宽高变化（如字号调整后首次重开）同步基于当前已量尺寸刷新定位。
    if (!popSizeMeasured && !measureFrameId) {
      measureFrameId = window.requestAnimationFrame(() => {
        measureFrameId = 0;
        if (readingExplainPop.hidden) {
          return;
        }
        const prevWidth = popWidth;
        const prevHeight = popHeight;
        popWidth = readingExplainPop.offsetWidth || POP_WIDTH_FALLBACK;
        popHeight = readingExplainPop.offsetHeight || POP_HEIGHT_FALLBACK;
        popSizeMeasured = true;
        if ((popWidth !== prevWidth || popHeight !== prevHeight) && lastPlacedTarget) {
          placeExplainPop(lastPlacedTarget);
        }
      });
    }
  };
  const showExplainPopForSelection = (item: HTMLElement, range: Range, selection: string, inReadySubtext: boolean) => {
    // 快照选区范围：rAF 执行时用户可能已拖到别处或折叠选区，届时 range 会失效。
    pendingExplainTarget = { item, range: range.cloneRange(), selection, inReadySubtext };
    if (!showFrameId) {
      showFrameId = window.requestAnimationFrame(runExplainPopFrame);
    }
  };
  const elementFromNode = (node: Node | null | undefined): Element | null => {
    if (!node) {
      return null;
    }
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  };
  const syncExplainPopWithSelection = () => {
    const selection = window.getSelection?.();
    const text = selection?.toString().trim() || "";
    if (!selection || !text || selection.rangeCount === 0) {
      hideExplainPop();
      return;
    }
    const range = selection.getRangeAt(0);
    const startEl = elementFromNode(range.startContainer);
    const endEl = elementFromNode(range.endContainer);
    const item = closestSubtitleItem(startEl);
    const endItem = closestSubtitleItem(endEl);
    if (!item || !endItem || item !== endItem || !subtitleList.contains(item)) {
      hideExplainPop();
      return;
    }
    const timeEl = item.querySelector<HTMLElement>(".biliscript-reading-time");
    const subEl = getSubtextNode(item);
    const startSub = startEl?.closest<HTMLElement>(`.${SUBTITLE_SUBTEXT_CLASS}`) ?? null;
    const endSub = endEl?.closest<HTMLElement>(`.${SUBTITLE_SUBTEXT_CLASS}`) ?? null;
    const touchesTime =
      Boolean(startEl?.closest(".biliscript-reading-time") || endEl?.closest(".biliscript-reading-time")) ||
      Boolean(timeEl && typeof range.intersectsNode === "function" && range.intersectsNode(timeEl));
    const subNotReady = Boolean(subEl && subEl.dataset.state !== "ready");
    const touchesInvalidSubtext =
      Boolean((startSub && startSub.dataset.state !== "ready") || (endSub && endSub.dataset.state !== "ready")) ||
      Boolean(subNotReady && subEl && typeof range.intersectsNode === "function" && range.intersectsNode(subEl));
    if (touchesTime || touchesInvalidSubtext) {
      hideExplainPop();
      return;
    }
    const inReadySubtext = Boolean(
      (startSub && startSub.dataset.state === "ready") || (endSub && endSub.dataset.state === "ready")
    );
    showExplainPopForSelection(item, range, text, inReadySubtext);
  };
  document.addEventListener("selectionchange", syncExplainPopWithSelection);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !readingExplainPop.hidden) {
      hideExplainPop();
    }
  });
  // 按住「解释」按钮的 mousedown 必须吃掉默认动作：否则 Chrome 会先折叠页面
  // 选区 → selectionchange 把浮层连同快照一起清掉 → click 落点时已无选区可用。
  readingExplainPop.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  subtitleList.addEventListener("scroll", hideExplainPop, { passive: true });
  subtitleList.addEventListener("pointerdown", hideExplainPop);
  readingExplainBtn.addEventListener("click", () => {
    // 从渲染条目取选中所在整句（主行文本 + data-seconds），不回读 state 结构——
    // 语义就是「用户看到的这句」，也避免常驻侧依赖字幕数据链。
    // 索引缺失（浮层已隐藏/重复 click）按无效处理：不回退到第 0 条。
    const snapshot = pendingExplainSelection;
    const itemIndex = Number(snapshot?.itemIndex);
    const itemNode =
      snapshot && snapshot.itemIndex !== "" && Number.isFinite(itemIndex) && itemIndex >= 0
        ? findSubtitleItem(subtitleList, itemIndex)
        : null;
    const mainLine = getMainLineText(itemNode).trim();
    const subLine = snapshot?.inReadySubtext ? getSubtextNode(itemNode)?.textContent?.trim() || "" : "";
    const line = mainLine && subLine ? `${mainLine}（${subLine}）` : mainLine;
    if (!itemNode || !line || !snapshot) {
      hideExplainPop();
      return;
    }
    const payload = {
      selection: snapshot.selection,
      line,
      from: Number(itemNode.dataset.seconds || 0) || 0,
      index: itemIndex
    };
    // 收起选区高亮与浮层：解释内容已取走，页面上残留的蓝色选区只剩干扰
    window.getSelection?.()?.removeAllRanges();
    hideExplainPop();
    // 解释卡片属 reader 动态域（要发 AI 请求），经 ensure 装载后调用；
    // 装载失败只记日志（解释不可用不拖垮字幕 tab 其余交互）。
    withReader("open explain card", (reader) => reader.openReaderExplainCard(payload));
  });

  // 解释卡片内点击委托（关闭 / 重试 / 去对话追问）：宿主容器不换、内容整块
  // 重建，与概览 tab 同款容器级委托；实现在 reader/explain-card.ts。
  const readingExplainCard = byId(ids.readingExplainCard);
  readingExplainCard.addEventListener("click", (event) => {
    withReader("explain card click", (reader) => reader.onReaderExplainCardClick(event as MouseEvent));
  });
}
