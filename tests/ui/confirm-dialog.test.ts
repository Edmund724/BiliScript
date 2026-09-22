// tests/ui/confirm-dialog.test.ts
// ui/confirm-dialog.ts 面板内二次确认弹层的行为契约。动机（用户报告）：删除
// AI 平台的二次确认原走浏览器原生 confirm()，弹窗绘制在浏览器窗口正中央，
// 扩展面板停靠窗口右侧时弹窗可能落在面板可视区外。本模块把确认画进扩展
// 自己的界面（宿主挂 #boc-reading-view 直下），本文件守住：
// - 打开即渲染：宿主挂 view 直下、mask + role=dialog + aria-modal、报文转义、
//   danger 警示键类名；
// - 结算路径：确认键 → true；取消键 / 遮罩 / Esc / 抽屉收起 → false，且每种
//   结算后 DOM 与监听都清场（重复结算幂等）；
// - 重复打开：前一个未决弹层按取消结算，新弹层接管；
// - 阅读视图不在：无界面可弹，按取消结算（Promise.resolve(false)）；
// - 面板外点击 capture 拦截：事件不外泄（被 ui-renderer 的抽屉外点关闭
//   委托收到会把抽屉收掉）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

function fireClick(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function mountView() {
  document.body.innerHTML = `
    <div id="boc-reading-view">
      <section id="boc-reading-settings-panel"></section>
    </div>
  `;
}

async function loadDialog() {
  return import("../../extension/ui/confirm-dialog.js");
}

describe("confirm-dialog：面板内二次确认弹层", () => {
  beforeEach(() => {
    resetModuleState();
    document.body.innerHTML = "";
  });

  it("打开即渲染：宿主挂 view 直下，mask + role=dialog + aria-modal，报文转义，danger 键类名", async () => {
    mountView();
    const { confirmDialog, isConfirmDialogOpen } = await loadDialog();
    const pending = confirmDialog({ message: "确定要删除这个平台吗？", confirmText: "删除", danger: true });

    expect(isConfirmDialogOpen()).toBe(true);
    const view = document.getElementById("boc-reading-view")!;
    const host = view.querySelector<HTMLElement>(".confirm-dialog-host")!;
    expect(host).not.toBeNull();
    expect(host.parentElement).toBe(view);
    expect(host.querySelector(".confirm-dialog-mask")).not.toBeNull();

    const dialog = host.querySelector(".confirm-dialog")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("删除");
    expect(dialog.textContent).toContain("确定要删除这个平台吗？");
    expect(host.querySelector(".confirm-dialog-confirm")!.textContent).toBe("删除");
    expect(host.querySelector(".confirm-dialog-confirm")!.classList.contains("confirm-dialog-confirm-danger")).toBe(true);
    expect(host.querySelector(".confirm-dialog-cancel")!.textContent).toBe("取消");

    // 报文 HTML 转义（防注入）
    fireClick(host.querySelector(".confirm-dialog-cancel")!);
    await expect(pending).resolves.toBe(false);
  });

  it("报文含 HTML 时按文本渲染", async () => {
    mountView();
    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({ message: "<img src=x onerror=1>" });
    const message = document.querySelector(".confirm-dialog-message")!;
    expect(message.querySelector("img")).toBeNull();
    expect(message.textContent).toBe("<img src=x onerror=1>");
    fireClick(document.querySelector(".confirm-dialog-cancel")!);
    await expect(pending).resolves.toBe(false);
  });

  it("点确认键 resolve true 并清场", async () => {
    mountView();
    const { confirmDialog, isConfirmDialogOpen } = await loadDialog();
    const pending = confirmDialog({ message: "确定？", confirmText: "删除", danger: true });
    fireClick(document.querySelector(".confirm-dialog-confirm")!);
    await expect(pending).resolves.toBe(true);
    expect(isConfirmDialogOpen()).toBe(false);
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });

  it("点取消键 / 点遮罩 / Esc 均 resolve false 并清场", async () => {
    mountView();
    const { confirmDialog, isConfirmDialogOpen } = await loadDialog();

    // 取消键
    let pending = confirmDialog({ message: "m1" });
    fireClick(document.querySelector(".confirm-dialog-cancel")!);
    await expect(pending).resolves.toBe(false);
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();

    // 遮罩（host 直下 dialog 的兄弟，从 document 查）
    pending = confirmDialog({ message: "m2" });
    fireClick(document.querySelector(".confirm-dialog-mask")!);
    await expect(pending).resolves.toBe(false);
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();

    // Esc（document capture）
    pending = confirmDialog({ message: "m3" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await expect(pending).resolves.toBe(false);
    expect(isConfirmDialogOpen()).toBe(false);
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });

  it("设置抽屉收起（hidden）时按取消结算", async () => {
    mountView();
    const { confirmDialog, isConfirmDialogOpen } = await loadDialog();
    const pending = confirmDialog({ message: "m" });
    expect(isConfirmDialogOpen()).toBe(true);

    const panel = document.getElementById("boc-reading-settings-panel")!;
    panel.hidden = true;
    await expect(pending).resolves.toBe(false);
    expect(isConfirmDialogOpen()).toBe(false);
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });

  it("重复打开：前一个未决弹层按取消结算，新弹层接管", async () => {
    mountView();
    const { confirmDialog } = await loadDialog();
    const first = confirmDialog({ message: "第一个" });
    expect(document.querySelector(".confirm-dialog-message")!.textContent).toBe("第一个");

    const second = confirmDialog({ message: "第二个" });
    await expect(first).resolves.toBe(false);
    expect(document.querySelector(".confirm-dialog-message")!.textContent).toBe("第二个");

    fireClick(document.querySelector(".confirm-dialog-confirm")!);
    await expect(second).resolves.toBe(true);
  });

  it("阅读视图不在：无界面可弹，按取消结算", async () => {
    const { confirmDialog, isConfirmDialogOpen } = await loadDialog();
    await expect(confirmDialog({ message: "m" })).resolves.toBe(false);
    expect(isConfirmDialogOpen()).toBe(false);
  });

  it("面板外点击 capture 拦截：事件不外泄（抽屉外点关闭委托收不到）", async () => {
    mountView();
    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({ message: "m" });

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    let bubbledToDocument = false;
    document.addEventListener("click", () => {
      bubbledToDocument = true;
    });
    fireClick(outside);
    expect(bubbledToDocument).toBe(false);
    await expect(pending).resolves.toBe(false);
  });

  it("弹层内点击不外泄到 document（host 委托 stopPropagation）", async () => {
    mountView();
    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({ message: "m" });

    let documentClicks = 0;
    document.addEventListener("click", () => {
      documentClicks += 1;
    });
    fireClick(document.querySelector(".confirm-dialog-confirm")!);
    expect(documentClicks).toBe(0);
    await expect(pending).resolves.toBe(true);
  });
});
