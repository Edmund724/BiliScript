// extension/ui/provider-row-drag.ts
// 搜索平台列表的指针拖拽排序（spec §6.10「拖拽把手与交互」/ §12.5 第 14 行；
// 票 15 §3）：
//   - 只认行右侧把手（`.provider-row-drag-handle`，仅搜索族记录行渲染）——行体 /
//     radio / 编辑 / 删除按钮上的按下不进入拖拽；
//   - 左键 + 位移 ≥ 4px 才进入拖拽态（点一下把手不写库）；
//   - 拖拽态只移动被拖节点（insertBefore），不整表重渲染：radio 选中态、滚动位置
//     与焦点俱在；
//   - 目标位置 = 指针 clientY 与各记录行 rect 中线的比较（指针在某行中线之上 →
//     插到该行前）；
//   - pointerup 提交「列表内记录行 id 顺序」（虚拟「智能」行无把手 → 天然不进
//     数组）；顺序未变（拖回原位）不写库；
//   - pointercancel / Esc 按按下时顺序重排 DOM、不写库；
//   - onCommit 同步抛错 / rejected promise 一律静默（顺序是偏好不是数据，
//     §12.3 写）。
// 本模块零 storage / 零消息：落库由调用方（settings-panel）在 onCommit 里直写 sync。

// 把手选择器与行类是单字面量（CSS / 测试锚点，spec §6.10）。
const DRAG_HANDLE_SELECTOR = ".provider-row-drag-handle";
const ROW_SELECTOR = ".search-provider-row";
const DRAG_THRESHOLD_PX = 4;
const DRAGGING_CLASS = "search-provider-row-dragging";

export interface ProviderRowDragOptions {
  // 落定回调：参数 = 列表内**记录行**的 id 顺序（不含虚拟「智能」行）
  onCommit: (orderedRecordIds: string[]) => void | Promise<void>;
}

interface DragSession {
  row: HTMLElement;
  handle: HTMLElement;
  pointerId: number;
  startY: number;
  dragging: boolean;
  // 按下时的记录行 id 顺序（回滚目标；拖回原位判据）
  originalOrder: string[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function wireProviderRowDrag(listNode: HTMLElement, { onCommit }: ProviderRowDragOptions): void {
  let session: DragSession | null = null;

  // 记录行 = 带把手的行（虚拟「智能」行无把手，spec §6.10）——提交数组与拖拽目标
  // 都只在这一集合内取值。
  const recordRows = (): HTMLElement[] =>
    Array.from(listNode.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter(
      (row) => row.querySelector(DRAG_HANDLE_SELECTOR) !== null
    );
  const recordIds = (): string[] => recordRows().map((row) => row.dataset.providerId || "");

  // 回滚：按按下时的 id 顺序把记录行依次挪到列表尾（虚拟行恒为首个子元素，
  // 故「依次追加」即恢复原序）。
  const restore = (ids: readonly string[]): void => {
    const byId = new Map(recordRows().map((row) => [row.dataset.providerId || "", row]));
    ids.forEach((id) => {
      const row = byId.get(id);
      if (row) listNode.appendChild(row);
    });
  };

  function end(commit: boolean): void {
    const current = session;
    if (!current) return;
    session = null;
    document.removeEventListener("keydown", onKeyDown, true);
    current.row.classList.remove(DRAGGING_CLASS);
    try {
      current.handle.releasePointerCapture?.(current.pointerId);
    } catch {}
    // 未越过阈值（点一下把手）不写库、不改顺序
    if (!current.dragging) return;
    if (!commit) {
      restore(current.originalOrder);
      return;
    }
    const ids = recordIds();
    if (sameIds(ids, current.originalOrder)) return;
    try {
      const pending: unknown = onCommit(ids);
      if (typeof (pending as Promise<void> | null | undefined)?.catch === "function") {
        void (pending as Promise<void>).catch(() => {});
      }
    } catch {}
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") end(false);
  }

  function moveTo(current: DragSession, clientY: number): void {
    const others = recordRows().filter((row) => row !== current.row);
    let before: HTMLElement | null = null;
    for (const row of others) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        before = row;
        break;
      }
    }
    if (before) {
      listNode.insertBefore(current.row, before);
    } else if (listNode.lastElementChild !== current.row) {
      listNode.appendChild(current.row);
    }
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (session || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest<HTMLElement>(DRAG_HANDLE_SELECTOR);
    if (!handle || !listNode.contains(handle)) return;
    const row = handle.closest<HTMLElement>(ROW_SELECTOR);
    if (!row || row.parentElement !== listNode) return;
    session = {
      row,
      handle,
      pointerId: event.pointerId,
      startY: event.clientY,
      dragging: false,
      originalOrder: recordIds()
    };
    document.addEventListener("keydown", onKeyDown, true);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const current = session;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.dragging) {
      if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
      current.dragging = true;
      // setPointerCapture 让指针移出列表后仍收到 move（jsdom 无实现，故可选调用）
      try {
        current.handle.setPointerCapture?.(current.pointerId);
      } catch {}
      current.row.classList.add(DRAGGING_CLASS);
    }
    moveTo(current, event.clientY);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!session || event.pointerId !== session.pointerId) return;
    end(true);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (!session || event.pointerId !== session.pointerId) return;
    end(false);
  };

  listNode.addEventListener("pointerdown", onPointerDown);
  listNode.addEventListener("pointermove", onPointerMove);
  listNode.addEventListener("pointerup", onPointerUp);
  listNode.addEventListener("pointercancel", onPointerCancel);
}
