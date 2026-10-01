// tests/ui/provider-row-drag.test.ts
// 搜索平台列表的指针拖拽排序（spec §6.10「拖拽把手与交互」/ §12.5 第 14 行 /
// 票 15 §3；验收 §10 第 78–79 行）：
// - 只认行右侧把手：pointerdown 落在行体 / 名字 / 按钮上不进入拖拽（F1）；
// - 只认左键（event.button === 0，F2）；
// - 位移 ≥ 4px 才进入拖拽态：点一下把手不写库、不改顺序（F3）；
// - 跨行落定 pointerup → 提交「列表内记录行 id 顺序」（F4）；
// - 顺序未变（拖回原位）→ 不调 onCommit（F5）；
// - pointercancel / Esc → 回滚按下时顺序且不写库（F6）；
// - onCommit 同步抛错 / reject → 静默（顺序是偏好不是数据，§12.3 写，F7）；
// - 虚拟「智能」行无把手、不进提交数组（F8）。
//
// jsdom 无布局：getBoundingClientRect 按当前 DOM 序给每行 40px 的矩形带
// （中线 = index * 40 + 20），拖拽目标判定（指针在某行中线之上 → 插到该行前）
// 由此可测。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { wireProviderRowDrag } from "../../extension/ui/provider-row-drag.js";

const SMART_ID = "__smart__";
const ROW_HEIGHT = 40;

interface Harness {
  list: HTMLElement;
  handles: Record<string, HTMLElement>;
  onCommit: ReturnType<typeof vi.fn>;
  ids: () => string[];
  dragging: () => boolean;
}

function pointer(type: string, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientY: y,
    pointerId: 1,
    ...init
  });
}

// 列表 = 可选的置顶虚拟「智能」行 + 若干记录行（只有记录行带把手）
function makeHarness(options: { withSmartRow?: boolean; order?: string[] } = {}): Harness {
  const order = options.order ?? ["a", "b", "c"];
  document.body.innerHTML = '<div id="list"></div>';
  const list = document.getElementById("list")!;

  if (options.withSmartRow) {
    const smart = document.createElement("div");
    smart.className = "search-provider-row";
    smart.dataset.providerId = SMART_ID;
    smart.innerHTML = '<div class="provider-row-line"><span class="provider-row-name">智能</span></div>';
    list.appendChild(smart);
  }

  const handles: Record<string, HTMLElement> = {};
  order.forEach((id) => {
    const row = document.createElement("div");
    row.className = "search-provider-row";
    row.dataset.providerId = `search_${id}`;
    row.innerHTML = `
      <div class="provider-row-line">
        <span class="provider-row-name">${id}</span>
        <span class="provider-row-drag-handle" title="拖拽调整搜索顺序"></span>
      </div>`;
    list.appendChild(row);
    handles[id] = row.querySelector<HTMLElement>(".provider-row-drag-handle")!;
  });

  // 矩形带按「调用时刻」的 DOM 序计算（拖拽移动后中线随之更新）
  list.querySelectorAll<HTMLElement>(".search-provider-row").forEach((row) => {
    row.getBoundingClientRect = () => {
      const index = Array.from(list.querySelectorAll(".search-provider-row")).indexOf(row);
      const top = index * ROW_HEIGHT;
      return {
        top,
        bottom: top + ROW_HEIGHT,
        height: ROW_HEIGHT,
        y: top,
        x: 0,
        left: 0,
        right: 100,
        width: 100,
        toJSON: () => ({})
      } as DOMRect;
    };
  });

  const onCommit = vi.fn();
  wireProviderRowDrag(list, { onCommit });
  return {
    list,
    handles,
    onCommit,
    ids: () =>
      Array.from(list.querySelectorAll<HTMLElement>(".search-provider-row")).map(
        (row) => row.dataset.providerId || ""
      ),
    dragging: () => list.querySelector(".search-provider-row-dragging") !== null
  };
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("wireProviderRowDrag：起手判据（spec §6.10）", () => {
  it("把手以外区域（行体名字）按下并移动不进入拖拽、不写库", () => {
    const harness = makeHarness();
    const name = harness.list.querySelector<HTMLElement>(".provider-row-name")!;

    name.dispatchEvent(pointer("pointerdown", 20));
    name.dispatchEvent(pointer("pointermove", 120));
    name.dispatchEvent(pointer("pointerup", 120));

    expect(harness.dragging()).toBe(false);
    expect(harness.onCommit).not.toHaveBeenCalled();
    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
  });

  it("右键（button !== 0）按下不进入拖拽", () => {
    const harness = makeHarness();

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20, { button: 2 }));
    harness.handles.a.dispatchEvent(pointer("pointermove", 120));
    harness.handles.a.dispatchEvent(pointer("pointerup", 120));

    expect(harness.dragging()).toBe(false);
    expect(harness.onCommit).not.toHaveBeenCalled();
  });

  it("位移 < 4px（点一下把手）不进入拖拽态、不写库", () => {
    const harness = makeHarness();

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20));
    harness.handles.a.dispatchEvent(pointer("pointermove", 22));
    harness.handles.a.dispatchEvent(pointer("pointerup", 22));

    expect(harness.dragging()).toBe(false);
    expect(harness.onCommit).not.toHaveBeenCalled();
    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
  });
});

describe("wireProviderRowDrag：落定提交（spec §6.10 / §12.5 第 14 行）", () => {
  it("拖拽态只移动被拖节点（insertBefore），pointerup 提交 DOM 记录行 id 顺序", () => {
    const harness = makeHarness();

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20));
    harness.handles.a.dispatchEvent(pointer("pointermove", 70)); // 越过 b 的中线 → 插到 c 前
    expect(harness.dragging()).toBe(true);
    harness.handles.a.dispatchEvent(pointer("pointerup", 70));

    expect(harness.ids()).toEqual(["search_b", "search_a", "search_c"]);
    expect(harness.onCommit).toHaveBeenCalledTimes(1);
    expect(harness.onCommit).toHaveBeenCalledWith(["search_b", "search_a", "search_c"]);
    expect(harness.dragging()).toBe(false);
  });

  it("拖到自身位置（顺序未变）不产生写库", () => {
    const harness = makeHarness();

    harness.handles.b.dispatchEvent(pointer("pointerdown", 60));
    harness.handles.b.dispatchEvent(pointer("pointermove", 65)); // 仍插在 c 前，顺序不变
    harness.handles.b.dispatchEvent(pointer("pointerup", 65));

    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
    expect(harness.onCommit).not.toHaveBeenCalled();
  });

  it("虚拟「智能」行不进提交数组（无把手、不参与拖拽）", () => {
    const harness = makeHarness({ withSmartRow: true });

    harness.handles.a.dispatchEvent(pointer("pointerdown", 60));
    harness.handles.a.dispatchEvent(pointer("pointermove", 110)); // 越过 b 的中线 → 插到 c 前
    harness.handles.a.dispatchEvent(pointer("pointerup", 110));

    expect(harness.onCommit).toHaveBeenCalledWith(["search_b", "search_a", "search_c"]);
    expect(harness.onCommit.mock.calls[0][0]).not.toContain(SMART_ID);
    expect(harness.ids()[0]).toBe(SMART_ID);
  });
});

describe("wireProviderRowDrag：回滚与失败静默（spec §6.10 / §12.3 写）", () => {
  it("pointercancel 回滚到按下时顺序且不写库", () => {
    const harness = makeHarness();

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20));
    harness.handles.a.dispatchEvent(pointer("pointermove", 70));
    expect(harness.ids()).toEqual(["search_b", "search_a", "search_c"]);
    harness.handles.a.dispatchEvent(pointer("pointercancel", 70));

    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
    expect(harness.onCommit).not.toHaveBeenCalled();
    expect(harness.dragging()).toBe(false);
  });

  it("Esc 回滚到按下时顺序且不写库", () => {
    const harness = makeHarness();

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20));
    harness.handles.a.dispatchEvent(pointer("pointermove", 70));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
    expect(harness.onCommit).not.toHaveBeenCalled();
  });

  it("onCommit 同步抛错不冒泡（写库失败不崩溃）", () => {
    const harness = makeHarness();
    harness.onCommit.mockImplementation(() => {
      throw new Error("storage boom");
    });

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20));
    harness.handles.a.dispatchEvent(pointer("pointermove", 70));
    expect(() => harness.handles.a.dispatchEvent(pointer("pointerup", 70))).not.toThrow();
    expect(harness.ids()).toEqual(["search_b", "search_a", "search_c"]);
  });

  it("onCommit 返回 rejected promise 不产生未处理拒绝（写失败静默）", async () => {
    const harness = makeHarness();
    harness.onCommit.mockRejectedValue(new Error("storage boom"));

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20));
    harness.handles.a.dispatchEvent(pointer("pointermove", 70));
    harness.handles.a.dispatchEvent(pointer("pointerup", 70));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.ids()).toEqual(["search_b", "search_a", "search_c"]);
  });
});
