// extension/ui/confirm-dialog.ts
// 面板内二次确认弹层（in-page confirm）：替代浏览器原生 confirm()——原生
// 弹窗绘制在浏览器窗口正中央，扩展面板停靠在窗口右侧时弹窗可能落在面板
// 可视区外（用户报告：删除平台时看不到确认）。本模块把确认画进扩展自己的
// 界面：宿主挂 #biliscript-reading-view 直下（provider-editor.ensureHost 同款），
// mask + role=dialog 居中卡片，弹层出现在面板内部，一定看得见。
//
// 结构契约沿用 provider-editor Modal 的先例（reader/explain-card.ts 一脉）：
// mask 与 dialog 是宿主直下的兄弟节点，点击经宿主委托分发；Esc 走 document
// capture；焦点进对话框并由 focus-scope 约束在层内。语义差异：确认是轻量单帧
// 弹层，不做 dirty 快照，遮罩点击 / Esc / 抽屉收起一律按「取消」结算。
//
// 可访问性：可见标题经 aria-labelledby、说明经 aria-describedby 关联；默认焦点
// 落在「取消」而不是破坏性的确认键。关闭/取消后焦点归还打开前仍有效的控件。
//
// 与 provider-editor 叠层关系：确认可能从编辑器 Modal（头部删除）之上打开，
// 宿主 z-index 高于 provider-editor-host（50 > 40）；编辑器的文档级
// capture 监听（外点关闭 / Esc）在确认打开期间整体让位（isConfirmDialogOpen
// 早退），由本模块承接同一批事件——一次点击只关一层。

import { escapeHtml } from "../shared/string-utils.js";
import { ids } from "../reader/state.js";
import { observeSettingsPanelHidden } from "./settings-panel-hidden.js";
import { createFocusScope, type FocusScope } from "./focus-scope.js";

export interface ConfirmDialogOptions {
  message: string;
  // 可见标题（缺省「请确认」）
  title?: string;
  // 确认键文案（缺省「确定」）
  confirmText?: string;
  // 确认键警示着色（删除等破坏性动作）：红底白字，token 与
  // provider-editor-delete 同源的 --biliscript-reader-danger 系
  danger?: boolean;
  mountHost?: HTMLElement;
}

interface ConfirmState {
  open: boolean;
  host: HTMLElement | null;
  observer: MutationObserver | null;
  focusScope: FocusScope | null;
  // 代际号：结算（resolve + 清场）只认最后一次打开——重复打开、抽屉收起、
  // 迟到点击都不会把新弹层误关或重复 resolve
  generation: number;
}

const state: ConfirmState = {
  open: false,
  host: null,
  observer: null,
  focusScope: null,
  generation: 0
};

// 标题/说明的 id 序号：同一时刻只开一层，序号仍避免与上一次结算残留的节点撞 id
let nextDialogId = 0;

export function isConfirmDialogOpen(): boolean {
  return state.open;
}

// ===== 结算（幂等：generation 比对，重复调用只第一次生效） =====

function settle(generation: number, result: boolean): void {
  if (generation !== state.generation || !state.open) {
    return;
  }
  state.open = false;
  state.observer?.disconnect();
  state.observer = null;
  document.removeEventListener("click", onDocumentClickCapture, true);
  document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
  state.host?.remove();
  state.host = null;
  state.focusScope?.dispose();
  state.focusScope = null;
  resolvePending(result);
}

let resolvePending: (result: boolean) => void = () => {};

// ===== 全局监听 =====

// 面板外点击（capture 拦截）：与 provider-editor 同款——host 在设置抽屉之外，
// 不拦会被 ui-renderer 的抽屉外点关闭委托当成外点把抽屉收掉（连带 hidden
// 联动结算）。点在 view 内（mask/按钮）正常放行，由宿主委托结算。
function onDocumentClickCapture(event: MouseEvent): void {
  if (!state.open) return;
  const view = state.host?.parentElement || document.getElementById(ids.readingView);
  if (view && event.target instanceof Node && view.contains(event.target)) {
    return;
  }
  event.stopPropagation();
  settle(state.generation, false);
}

function onDocumentKeyDownCapture(event: KeyboardEvent): void {
  if (!state.open || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  settle(state.generation, false);
}

export function closeConfirmDialog(): void {
  settle(state.generation, false);
}

// ===== 打开 =====

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  // 重复打开：先作废旧弹层（按取消结算），新弹层接管
  settle(state.generation, false);
  const view = options.mountHost || document.getElementById(ids.readingView);
  if (!view) {
    // 阅读视图不在（设置 UI 未挂载）：没有可弹的界面，按取消结算
    return Promise.resolve(false);
  }
  const host = document.createElement("div");
  host.className = "confirm-dialog-host";
  const confirmText = options.confirmText || "确定";
  const title = options.title?.trim() || "请确认";
  const dialogId = `confirm-dialog-${++nextDialogId}`;
  host.innerHTML = `
    <div class="confirm-dialog-mask" data-confirm-dialog-action="cancel"></div>
    <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="${dialogId}-title" aria-describedby="${dialogId}-message" tabindex="-1">
      <h2 class="confirm-dialog-title" id="${dialogId}-title">${escapeHtml(title)}</h2>
      <p class="confirm-dialog-message" id="${dialogId}-message">${escapeHtml(options.message)}</p>
      <footer class="confirm-dialog-foot">
        <button type="button" class="confirm-dialog-cancel" data-confirm-dialog-action="cancel">取消</button>
        <button type="button" class="confirm-dialog-confirm${options.danger ? " confirm-dialog-confirm-danger" : ""}" data-confirm-dialog-action="confirm">${escapeHtml(confirmText)}</button>
      </footer>
    </section>`;

  const generation = state.generation + 1;
  state.generation = generation;
  state.host = host;
  state.open = true;
  view.appendChild(host);

  // 委托挂宿主（mask 与 dialog 的兄弟结构，同 provider-editor 的注释）；
  // stopPropagation 同款：点击不外泄成抽屉外点
  host.addEventListener("click", (event) => {
    event.stopPropagation();
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-confirm-dialog-action]")?.dataset.confirmDialogAction;
    if (action === "confirm") {
      settle(generation, true);
    } else if (action === "cancel") {
      settle(generation, false);
    }
  });

  // 安全默认焦点：取消键（破坏性确认不以「删除 / 放弃」为默认动作）
  const dialog = host.querySelector<HTMLElement>(".confirm-dialog");
  const cancel = host.querySelector<HTMLElement>(".confirm-dialog-cancel");
  if (dialog) {
    state.focusScope = createFocusScope(dialog, {
      initialFocus: cancel ?? dialog,
      // 结算过程中 state.open 先归 false、随后才 dispose：以代际判定「仍是最上层」
      isActive: () => state.generation === generation
    });
  }
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeyDownCapture, true);
  // 外层命令收起设置时按取消结算（与 provider-editor 的强制关闭同判断，
  // 但确认没有可丢的草稿，直接 resolve(false)）。代次在此捕获，回调里
  // 结算的是本弹层的代次而非观察器触发时的当前值。
  observeSettingsPanelHidden(() => settle(generation, false), state);

  return new Promise<boolean>((resolve) => {
    resolvePending = resolve;
  });
}
