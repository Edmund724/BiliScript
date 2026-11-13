// tests/ui/confirm-dialog.test.ts
// ui/confirm-dialog.ts 面板内二次确认弹层的行为契约。动机（用户报告）：删除
// AI 平台的二次确认原走浏览器原生 confirm()，弹窗绘制在浏览器窗口正中央，
// 扩展面板停靠窗口右侧时弹窗可能落在面板可视区外。本模块把确认画进扩展
// 自己的界面（宿主挂 #biliscript-reading-view 直下），本文件守住：
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
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel"></section>
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

  it("打开即渲染：宿主挂 view 直下，mask + role=dialog + aria-modal，可见标题与描述关联，报文转义，danger 键类名", async () => {
    mountView();
    const { confirmDialog, isConfirmDialogOpen } = await loadDialog();
    const pending = confirmDialog({
      title: "删除平台",
      message: "确定要删除这个平台吗？",
      confirmText: "删除",
      danger: true
    });

    expect(isConfirmDialogOpen()).toBe(true);
    const view = document.getElementById("biliscript-reading-view")!;
    const host = view.querySelector<HTMLElement>(".confirm-dialog-host")!;
    expect(host).not.toBeNull();
    expect(host.parentElement).toBe(view);
    expect(host.querySelector(".confirm-dialog-mask")).not.toBeNull();

    const dialog = host.querySelector(".confirm-dialog")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // 可见标题与说明经 aria-labelledby / aria-describedby 关联到对话框
    const title = host.querySelector<HTMLElement>(".confirm-dialog-title")!;
    const message = host.querySelector<HTMLElement>(".confirm-dialog-message")!;
    expect(title.textContent).toBe("删除平台");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(message.id);
    expect(message.textContent).toBe("确定要删除这个平台吗？");
    expect(host.querySelector(".confirm-dialog-confirm")!.textContent).toBe("删除");
    expect(host.querySelector(".confirm-dialog-confirm")!.classList.contains("confirm-dialog-confirm-danger")).toBe(true);
    expect(host.querySelector(".confirm-dialog-cancel")!.textContent).toBe("取消");

    // 报文 HTML 转义（防注入）
    fireClick(host.querySelector(".confirm-dialog-cancel")!);
    await expect(pending).resolves.toBe(false);
  });

  it("未给标题时回退可见的「请确认」", async () => {
    mountView();
    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({ message: "m" });
    expect(document.querySelector(".confirm-dialog-title")!.textContent).toBe("请确认");
    fireClick(document.querySelector(".confirm-dialog-cancel")!);
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

  it("取消键文案可定制（授权类双动作给具体语义），缺省仍是「取消」", async () => {
    mountView();
    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({
      title: "联网搜索授权",
      message: "m",
      confirmText: "允许并继续",
      cancelText: "关闭联网搜索"
    });
    expect(document.querySelector(".confirm-dialog-confirm")!.textContent).toBe("允许并继续");
    expect(document.querySelector(".confirm-dialog-cancel")!.textContent).toBe("关闭联网搜索");
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

    const panel = document.getElementById("biliscript-reading-settings-panel")!;
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

  it("安全默认焦点落在取消键；Tab / Shift+Tab 在层内环绕", async () => {
    mountView();
    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({ message: "确定删除？", confirmText: "删除", danger: true });

    const cancel = document.querySelector<HTMLElement>(".confirm-dialog-cancel")!;
    const confirm = document.querySelector<HTMLElement>(".confirm-dialog-confirm")!;
    // 破坏性确认不以「删除」为默认动作
    expect(document.activeElement).toBe(cancel);

    // 焦点在最后一个控件时 Tab 回到第一个
    confirm.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(cancel);

    // 焦点在第一个控件时 Shift+Tab 回到最后一个
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(confirm);

    fireClick(cancel);
    await expect(pending).resolves.toBe(false);
  });

  it("关闭 / 取消后焦点归还仍有效的触发控件", async () => {
    mountView();
    const trigger = document.createElement("button");
    trigger.textContent = "删除";
    document.getElementById("biliscript-reading-view")!.appendChild(trigger);
    trigger.focus();

    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({ message: "m" });
    expect(document.activeElement).toBe(document.querySelector(".confirm-dialog-cancel"));

    fireClick(document.querySelector(".confirm-dialog-confirm")!);
    await expect(pending).resolves.toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("触发控件已从文档移除时不归还焦点（也不抛错）", async () => {
    mountView();
    const trigger = document.createElement("button");
    document.getElementById("biliscript-reading-view")!.appendChild(trigger);
    trigger.focus();

    const { confirmDialog } = await loadDialog();
    const pending = confirmDialog({ message: "m" });
    trigger.remove();
    expect(document.activeElement).toBe(document.querySelector(".confirm-dialog-cancel"));

    fireClick(document.querySelector(".confirm-dialog-cancel")!);
    await expect(pending).resolves.toBe(false);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("视图销毁按 view-destroyed 结算并释放事件捕获；重开可新建弹层", async () => {
    mountView();
    const { confirmDialogWithResult, dismissConfirmDialog, isConfirmDialogOpen } = await loadDialog();
    const pending = confirmDialogWithResult({ message: "m" });

    dismissConfirmDialog();
    await expect(pending).resolves.toBe("view-destroyed");
    expect(isConfirmDialogOpen()).toBe(false);
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const documentClick = vi.fn();
    document.addEventListener("click", documentClick);
    fireClick(outside);
    expect(documentClick).toHaveBeenCalledTimes(1);

    mountView();
    const reopened = confirmDialogWithResult({ message: "重开" });
    fireClick(document.querySelector(".confirm-dialog-confirm")!);
    await expect(reopened).resolves.toBe("confirmed");
  });
});
