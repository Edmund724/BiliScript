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
        <button type="button" class="provider-row-drag-handle" title="拖拽或按上下方向键调整搜索顺序" aria-label="调整 ${id} 搜索顺序"></button>
      </div>`;
    list.appendChild(row);
    handles[id] = row.querySelector<HTMLElement>(".provider-row-drag-handle")!;
  });

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
    harness.handles.a.dispatchEvent(pointer("pointermove", 70));
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
    harness.handles.b.dispatchEvent(pointer("pointermove", 65));
    harness.handles.b.dispatchEvent(pointer("pointerup", 65));

    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
    expect(harness.onCommit).not.toHaveBeenCalled();
  });

  it("虚拟「智能」行不进提交数组（无把手、不参与拖拽）", () => {
    const harness = makeHarness({ withSmartRow: true });

    harness.handles.a.dispatchEvent(pointer("pointerdown", 60));
    harness.handles.a.dispatchEvent(pointer("pointermove", 110));
    harness.handles.a.dispatchEvent(pointer("pointerup", 110));

    expect(harness.onCommit).toHaveBeenCalledWith(["search_b", "search_a", "search_c"]);
    expect(harness.onCommit.mock.calls[0][0]).not.toContain(SMART_ID);
    expect(harness.ids()[0]).toBe(SMART_ID);
  });

  it("指针捕获挂在稳定父容器 listNode 且拖出列表外松手仍正常落定", () => {
    const harness = makeHarness();
    const listCapture = vi.fn();
    const listRelease = vi.fn();
    const handleCapture = vi.fn();
    harness.list.setPointerCapture = listCapture;
    harness.list.releasePointerCapture = listRelease;
    harness.handles.a.setPointerCapture = handleCapture;

    harness.handles.a.dispatchEvent(pointer("pointerdown", 20));
    window.dispatchEvent(pointer("pointermove", 70));
    expect(listCapture).toHaveBeenCalledWith(1);
    expect(handleCapture).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointerup", 70));
    expect(listRelease).toHaveBeenCalledWith(1);
    expect(harness.dragging()).toBe(false);
    expect(harness.ids()).toEqual(["search_b", "search_a", "search_c"]);
    expect(harness.onCommit).toHaveBeenCalledWith(["search_b", "search_a", "search_c"]);
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

describe("wireProviderRowDrag：键盘无障碍排序（P1-2）", () => {
  it("聚焦把手按 ArrowDown/ArrowUp 调整顺序、保持焦点、更新 aria-live 提示并调用 onCommit", () => {
    const harness = makeHarness({ withSmartRow: true });
    harness.handles.a.focus();

    const downEvent = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    harness.handles.a.dispatchEvent(downEvent);

    expect(downEvent.defaultPrevented).toBe(true);
    expect(harness.ids()).toEqual([SMART_ID, "search_b", "search_a", "search_c"]);
    expect(document.activeElement).toBe(harness.handles.a);
    expect(harness.onCommit).toHaveBeenLastCalledWith(["search_b", "search_a", "search_c"]);
    const liveNode = document.querySelector<HTMLElement>(".search-order-live-status");
    expect(liveNode?.getAttribute("aria-live")).toBe("polite");
    expect(liveNode?.textContent).toBe("a已移至第 2 位，共 3 位");

    const upEvent = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    harness.handles.a.dispatchEvent(upEvent);
    expect(harness.ids()).toEqual([SMART_ID, "search_a", "search_b", "search_c"]);
    expect(document.activeElement).toBe(harness.handles.a);
    expect(harness.onCommit).toHaveBeenLastCalledWith(["search_a", "search_b", "search_c"]);
    expect(liveNode?.textContent).toBe("a已移至第 1 位，共 3 位");
  });

  it("边界按 ArrowUp/ArrowDown 或单平台模式下不移动、不触发 onCommit", () => {
    const harness = makeHarness();
    harness.handles.a.focus();

    const boundaryUp = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    harness.handles.a.dispatchEvent(boundaryUp);
    expect(boundaryUp.defaultPrevented).toBe(true);
    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
    expect(harness.onCommit).not.toHaveBeenCalled();

    harness.list.classList.add("search-chain-single-mode");
    harness.handles.a.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(harness.ids()).toEqual(["search_a", "search_b", "search_c"]);
    expect(harness.onCommit).not.toHaveBeenCalled();
  });
});
