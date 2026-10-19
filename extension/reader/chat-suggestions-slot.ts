// extension/reader/chat-suggestions-slot.ts — 对话 tab 建议区的唯一属主。
//
// 建议区节点（`.chat-suggestions`，id = reader/state.ts 的
// ids.readingChatSuggestions）的建立、写入、摘除与在场判定都收在这一个模块里：
// 节点引用不再外借（此前以 get/set 钩子对的形式拆给组合根建、列表渲染读、通知
// 清理删、历史回放清引用四处各持一半）。其余模块只经 render / clear / isPresent
// 表达意图，谁也无法在属主不知情时换掉节点。
//
// 三条边界与属主职责一一对应：
//   - 在场判定：节点已随后建的清场脱开文档（消息区 innerHTML 重建 / 消息区清空）
//     就不再算在场——对账路径据此跳过，空壳不会在历史回放中途复活；
//   - 建立/写入：render 是建议区唯一写入点，节点缺失或已脱开时由它补齐并挂回
//     容器，因此「清场后重建建议区」不需要调用方再持一份创建逻辑；
//   - 摘除：clear 摘节点并忘掉引用（发送受理撤除欢迎区、历史回放清场）。
//
// 不可用态（无上下文 / 无平台 / 非视频页 / 有会话历史）由调用方折算成空表：
// render([]) 保留空壳、不落欢迎区——「建议区在场但没有内容」与「建议区不在场」
// 是两种态，前者是清场后的默认形态。
//
// 依赖方向：只依赖注入的容器节点与 id（无组合根依赖）；chip 的点击行为经
// deps.onPick 交回组合根（填输入框 + 发送是页面级编排，本模块不碰输入框）。
import { escapeHtml } from "../shared/string-utils.js";

export interface CreateChatSuggestionsSlotDeps {
  /** 建议区挂载容器（对话 tab 的消息区）。 */
  messages: HTMLElement;
  /** 节点 id（ids.readingChatSuggestions，与模板/样式表同一单源）。 */
  id: string;
  /** chip 点击：把选中的问题交回调用方。 */
  onPick: (prompt: string) => void;
}

export interface ChatSuggestionsSlot {
  /**
   * 让建议区在场并显示这些问题：节点缺失或已脱开文档时补齐一个新节点再写，
   * 空表 = 在场的空建议区（不可用态，不落欢迎区）。
   */
  render: (prompts: readonly string[]) => void;
  /** 摘除建议区节点并忘掉引用（此后 render 才需要重新建立）。 */
  clear: () => void;
  /** 建议区是否在容器里（随清场脱开或已摘除 = false）。 */
  isPresent: () => boolean;
}

// 空态欢迎区图标（✦ sparkles，24 视框）：纯装饰，svg 自带 aria-hidden；图标资产
// 本模块自带，不引外部资源。星形在视框内几何居中（外接盒 5.2–18.8 正负对称），
// tests/reader/chat-suggestions-visual.test.ts 有外接盒居中断言。
// 两套形态共用一份 path：基表（editorial）是 stroke currentColor 描边星；flyme 档
// 由 reader-gate.css 的 Gemini 门控规则以 CSS 覆盖 path 表现属性（fill: url(#…)，
// 渐变 def 内联于此，明暗两档各一），描边/填充切换不动本资产。渐变蓝段拉宽
// （0→30% 才到紫）：小尺寸星形上 0–36% 的蓝色区会被紫/珊瑚吃掉，看不出蓝。
const HERO_ICON_SVG =
  '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="biliscript-hero-g-light" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4285f4"/><stop offset=".3" stop-color="#9b72cb"/><stop offset=".68" stop-color="#d96570"/><stop offset="1" stop-color="#f49c46"/></linearGradient><linearGradient id="biliscript-hero-g-dark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#669df6"/><stop offset=".3" stop-color="#b388ff"/><stop offset=".68" stop-color="#f28b82"/><stop offset="1" stop-color="#fdd663"/></linearGradient></defs><path d="M12 5.2l1.84 4.96 4.96 1.84-4.96 1.84L12 18.8l-1.84-4.96L5.2 12l4.96-1.84L12 5.2z"/></svg>';

export function createChatSuggestionsSlot(deps: CreateChatSuggestionsSlotDeps): ChatSuggestionsSlot {
  // 本代建议区的节点句柄：非 null 只表示「属主手里有一个节点」，是否在场由
  // isPresent() 按挂载状态回答（清场把节点摘出文档时引用仍在，render 负责挂回）。
  let node: HTMLElement | null = null;

  function ensureNode(): HTMLElement {
    if (!node || !node.isConnected) {
      node = document.createElement("div");
      node.className = "chat-suggestions";
      node.id = deps.id;
      deps.messages.appendChild(node);
    }
    return node;
  }

  function render(prompts: readonly string[]): void {
    const target = ensureNode();
    if (!prompts.length) {
      target.innerHTML = "";
      return;
    }
    // 空态欢迎区（「居中开场」）：✦ 图标 + 引导语在上，建议 chips 居中于消息区；
    // 不可用态走上面的清空分支，欢迎区不出现。
    target.innerHTML =
      `<div class="chat-hero">` +
      `<span class="chat-hero-icon">${HERO_ICON_SVG}</span>` +
      `<p class="chat-hero-title">围绕这期视频，问点什么</p>` +
      `<div class="chat-hero-sugs">` +
      prompts
        .map((prompt) => `<button type="button" class="chat-chip">${escapeHtml(prompt)}</button>`)
        .join("") +
      `</div></div>`;
    target.querySelectorAll(".chat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        deps.onPick(btn.textContent || "");
      });
    });
  }

  function clear(): void {
    node?.remove();
    node = null;
  }

  return {
    render,
    clear,
    isPresent: () => Boolean(node?.isConnected)
  };
}
