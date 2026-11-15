// extension/reader/explain-card.ts — 字幕 tab 内的「解释」卡片（选区解释的落点）。
//
// 交互链：在字幕句里选中词/句 → 选区下方浮出「解释」按钮（浮层 DOM 与选区
// 监听/定位/快照在 reader/explain-pop-ui.ts，arch-slim-2/06 随本域下放；壳层
// 只组装模板叶子）→ 点按钮调本模块 openReaderExplainCard
// → 面板内弹卡片（遮罩 + 对话框），就地展示模型给出的解释。
//
// 为什么不发到对话 tab：解释是「读完这句马上要懂」的即时动作，跳到对话 tab 会
// 打断阅读、且把一次短问答塞进长会话历史里。对话链路仍然保留——卡片底部的
// 「去对话追问」按钮走 reader/explain-intent 的单槽意图契约，把选中片段 + 所在
// 整句交给对话 tab 自动发送（用户在解释之后想继续追问时的正路）。
//
// 依赖方向：本模块属 reader 动态域（reader/index.js 聚合导出，ui-renderer 经
// ensureReaderDomain 装载后调用），可静态依赖 ai 域；对 ui 壳的「切对话 tab +
// 激活」回头调经标签激活属主 reader/script-tab-activation（它再经 reader-bus 的
// project-tab 命令投影 DOM），本模块不再静态 import ui 壳。
//
// 竞态：一次只开一张卡；重复打开（换选区再点）先 abort 上一请求，runId 守卫
// 丢弃过期回执。关闭阅读视图（lifecycle.closeReadingView）也走 close。
//
// 首配续跑（票 provider-onboarding-consistency/02）：配置类错误（无平台/缺 Key，
// 分类器复用 core/overview-setup-error——文案由 SW resolve-ai-provider 产生、两条
// 链同源）的 error 态给「去设置」，直达平台编辑（无记录新增 / 缺 Key 聚焦 Key）；
// 保存成功回到本卡续跑一次（runId + 视频身份 + 选区快照校验，一次性消费）；
// 取消/关抽屉/换选区/换视频均作废。非配置类错误保持原重试语义。

import { state } from "../core/state.js";
import { classifyOverviewSetupError, type OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getErrorMessage, isAbortedMarkerError } from "../shared/error-helpers.js";
import { hydrateMarkdownContent, renderMarkdown } from "../ui/markdown.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { resolveWebSearchOptIn } from "../search/opt-in-notice.js";
import { resolveWebSearchRuntime, type WebSearchRuntime } from "../search/search-runtime.js";
import { logWarn } from "../shared/logging.js";
import { ids } from "./state.js";
import { setPendingExplainIntent } from "./explain-intent.js";
import {
  clearExplainSetupResumeIntent,
  consumeExplainSetupResumeIntent,
  setExplainSetupResumeIntent
} from "./explain-setup-resume.js";
import {
  closeReaderSettingsMode,
  focusProviderEditorModelControl,
  hasReaderSettingsOverlayOpen,
  resolveEditableAiProviderId
} from "./settings-mode.js";
import { findSubtitleItem } from "./subtitle-item-dom.js";
import { activateScriptTab } from "./script-tab-activation.js";

type ExplainCardPhase = "loading" | "ready" | "error";

interface ExplainCardState {
  open: boolean;
  phase: ExplainCardPhase;
  /** 用户选中的原文 */
  selection: string;
  /** 选中所在的整条字幕句 */
  line: string;
  /** 所在句起始秒 */
  from: number;
  /** 所在句在字幕体中的下标（上下文窗口锚点） */
  index: number;
  /** 成功回执文本 */
  text: string;
  /** 失败文案 */
  error: string;
  /** 在飞请求的中止器 */
  controller: AbortController | null;
  /** 代际号：回执落定前比对，过期回执丢弃 */
  runId: number;
  /** 联网搜索进行中（loading 态文案区分「正在解释」与「正在联网搜索」） */
  searching: boolean;
  /** 工具循环给出的提示（搜索失败原因 / 额度用尽）：渲染在卡片内容区，不借全局状态条 */
  notice: string;
}

const card: ExplainCardState = {
  open: false,
  phase: "loading",
  selection: "",
  line: "",
  from: 0,
  index: -1,
  text: "",
  error: "",
  controller: null,
  runId: 0,
  searching: false,
  notice: ""
};

export interface ReaderExplainCardPayload {
  selection: string;
  line: string;
  from: number;
  index: number;
}

const CARD_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let returnFocusEl: HTMLElement | null = null;
let pendingInitialFocus = false;

function isElementFocusable(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element || !element.isConnected) {
    return false;
  }
  if (
    element.hidden ||
    element.closest("[hidden]") ||
    element.closest('[aria-hidden="true"]') ||
    element.closest("[inert]")
  ) {
    return false;
  }
  if ((element as HTMLButtonElement).disabled) {
    return false;
  }
  const view = element.ownerDocument.defaultView;
  if (view) {
    const style = view.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
  }
  return true;
}

function getDialogFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(CARD_FOCUSABLE_SELECTOR)).filter(isElementFocusable);
}

function focusExplainDialog(): void {
  const root = getCardRoot();
  const dialog = root?.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
  dialog?.focus?.({ preventScroll: true });
}

function getCardRoot(): HTMLElement | null {
  return document.getElementById(ids.readingExplainCard);
}

function getClipBody(): { from: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

// 整卡重建（结构与概览/对话 tab 同款：状态机驱动 innerHTML，容器不换）。
function renderCard(): void {
  const root = getCardRoot();
  if (!root) {
    return;
  }
  if (!card.open) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;

  const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const wasFocusInsideCard = Boolean(activeEl && root.contains(activeEl));
  const activeAction = wasFocusInsideCard ? activeEl?.dataset.explainCardAction ?? "" : "";

  const setupClass = card.phase === "error" ? classifyOverviewSetupError(card.error) : null;
  const bodyHtml =
    card.phase === "loading"
      ? `
        <div class="biliscript-reading-explain-card-state">
          <span class="biliscript-reading-explain-card-dot" aria-hidden="true"></span>
          <span>${card.searching ? "正在联网搜索…" : "正在解释…"}</span>
        </div>
        <div class="biliscript-reading-explain-card-skeleton" aria-hidden="true">
          <span class="biliscript-reading-explain-card-skeleton-line is-long"></span>
          <span class="biliscript-reading-explain-card-skeleton-line is-mid"></span>
          <span class="biliscript-reading-explain-card-skeleton-line is-short"></span>
        </div>
      `
      : card.phase === "error"
        ? `
          <div class="biliscript-reading-explain-card-state is-error">${escapeHtml(card.error || "解释失败")}</div>
          <div class="biliscript-reading-explain-card-actions">
            ${
              setupClass
                ? `<button type="button" class="biliscript-reading-mini-btn is-primary" data-explain-card-action="setup">去设置</button>`
                : `<button type="button" class="biliscript-reading-mini-btn" data-explain-card-action="retry">重试</button>`
            }
          </div>
        `
        : `<div class="biliscript-reading-explain-card-answer markdown-body">${renderMarkdown(card.text)}</div>`;
  // 工具提示（搜索失败原因 / 额度用尽）留在卡片里随答案一起呈现（回答不因搜索
  // 失败中断）；空串不渲染节点。
  const noticeHtml = card.notice
    ? `<div class="biliscript-reading-explain-card-notice">${escapeHtml(card.notice)}</div>`
    : "";
  const showAskChat = card.phase === "ready" || (card.phase === "error" && !setupClass);
  const footerHtml = showAskChat
    ? `
      <footer class="biliscript-reading-explain-card-foot">
        <button type="button" class="biliscript-reading-mini-btn" data-explain-card-action="ask-chat">去对话追问</button>
      </footer>
    `
    : "";

  root.innerHTML = `
    <div class="biliscript-reading-explain-card-mask" data-explain-card-action="close"></div>
    <section class="biliscript-reading-explain-card-dialog" role="dialog" aria-modal="true" aria-label="解释" tabindex="-1">
      <header class="biliscript-reading-explain-card-head">
        <span class="biliscript-reading-explain-card-title">解释</span>
        <button type="button" class="biliscript-reading-explain-card-close" data-explain-card-action="close" title="关闭" aria-label="关闭">×</button>
      </header>
      <div class="biliscript-reading-explain-card-quote">${escapeHtml(card.selection)}</div>
      <div class="biliscript-reading-explain-card-content">${bodyHtml}${noticeHtml}</div>
      ${footerHtml}
    </section>
  `;

  // 作答块里的图表与数学公式：卡片每次整卡重建，水合随时机同走一次
  hydrateMarkdownContent(root);

  // 仅在首次打开或聚焦本来就在卡片内时接管/恢复焦点；设置层盖在上方或后台阶段变化不抢焦点。
  const overlayBlocked = state.reader.readingSettingsExpanded || hasReaderSettingsOverlayOpen();
  if (!overlayBlocked) {
    if (pendingInitialFocus) {
      pendingInitialFocus = false;
      focusExplainDialog();
    } else if (wasFocusInsideCard) {
      const dialog = root.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
      const matching = activeAction
        ? dialog?.querySelector<HTMLElement>(`[data-explain-card-action="${activeAction}"]:not([disabled])`) ?? null
        : null;
      if (matching && isElementFocusable(matching)) {
        matching.focus?.({ preventScroll: true });
      } else {
        focusExplainDialog();
      }
    }
  }
}

// 键盘拦截（Esc 关闭 + Tab/Shift+Tab 焦点圈禁）：仅在卡片开着且无设置浮层叠加时接管。
// 设置抽屉 / 平台编辑器 / 确认弹层叠在卡片上时交回上层叠层规则处理。
function onCardKeyDown(event: KeyboardEvent): void {
  if (!card.open) {
    return;
  }
  if (state.reader.readingSettingsExpanded || hasReaderSettingsOverlayOpen()) {
    return;
  }
  if (event.key === "Escape") {
    event.stopPropagation();
    closeReaderExplainCard();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const root = getCardRoot();
  const dialog = root?.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
  if (!dialog) {
    return;
  }
  const focusables = getDialogFocusables(dialog);
  if (focusables.length === 0) {
    event.preventDefault();
    dialog.focus?.({ preventScroll: true });
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || active === dialog || !dialog.contains(active)) {
      event.preventDefault();
      last.focus?.({ preventScroll: true });
    }
    return;
  }
  if (active === last || active === dialog || !dialog.contains(active)) {
    event.preventDefault();
    first.focus?.({ preventScroll: true });
  }
}

function bindCardEsc(): void {
  document.addEventListener("keydown", onCardKeyDown, true);
}

function unbindCardEsc(): void {
  document.removeEventListener("keydown", onCardKeyDown, true);
}

// 发起解释请求（provider 解析失败/请求失败都落 error 态，不静默）。
function startExplainRequest(): void {
  const runId = card.runId;
  card.phase = "loading";
  card.text = "";
  card.error = "";
  card.searching = false;
  card.notice = "";
  renderCard();

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  card.controller = controller;

  void (async () => {
    try {
      const provider = await resolveActiveProvider();
      // explainSelection 按需动态装载（ai/explain 不再常驻 reader chunk），
      // 装载失败与请求失败同走 error 态。
      const { explainSelection } = await import("../ai/explain.js");
      // 联网搜索（spec §2.1：选区解释链同样可用）：经 search/opt-in-notice.ts 在
      // 解析搜索运行时之前完成开关判定与首次授权——未获同意不外发查询词；用户拒绝时
      // 闸侧已关闭联网偏好，本卡按无搜索继续解释。授权通过但当前链为空（未配置 /
      // 全冷却）时，平台可用性反馈与授权分开：落在本卡的 notice 通道（下方），解释
      // 照常进行。视图销毁或卡片代际失效时直接取消，不再发起生成。
      const optIn = await resolveWebSearchOptIn();
      if (optIn === "view-destroyed" || runId !== card.runId) {
        return;
      }
      let webSearch: WebSearchRuntime | undefined;
      if (optIn === "granted") {
        const resolved = await resolveWebSearchRuntime(controller?.signal ?? null);
        webSearch = resolved.runtime;
        if (!webSearch && resolved.notice && runId === card.runId) {
          card.notice = resolved.notice;
          renderCard();
        }
      }
      const text = await explainSelection({
        provider,
        videoTitle: state.clip.title,
        selection: card.selection,
        line: card.line,
        from: card.from,
        index: card.index,
        body: getClipBody(),
        signal: controller?.signal,
        webSearch,
        // 搜索中/完成切换 loading 文案；notice（搜索失败原因 / 额度用尽）留在
        // 卡片内容区呈现（本模块的 notice 通道），回答不因搜索失败中断。
        onSearchStatus: (payload) => {
          if (runId !== card.runId) {
            return;
          }
          card.searching = payload.status === "searching";
          if (card.phase === "loading") {
            renderCard();
          }
        },
        onNotice: (notice) => {
          if (runId === card.runId) {
            card.notice = String(notice || "");
            renderCard();
          }
        }
      });
      if (runId !== card.runId) {
        return; // 已被新的打开/关闭取代：丢弃过期回执
      }
      card.phase = "ready";
      card.text = text;
      card.searching = false;
      renderCard();
    } catch (error) {
      if (runId !== card.runId || isAbortedMarkerError(error)) {
        return; // 中止/过期：卡片已关闭或已换选区，不打扰
      }
      logWarn("[BILISCRIPT] explain selection failed", error);
      card.phase = "error";
      card.error = getErrorMessage(error);
      card.searching = false;
      renderCard();
    }
  })();
}

let explainSetupOpenInFlight = false;
let explainSetupSessionEpoch = 0;

// 首配「去设置」（票 02）：error 态的分类在渲染期已用同一分类器判过，点击时再判
// 一次兜底（error 只会在新一轮请求后改写，但入口收敛在这里）；记录续跑意图
// （选区/整句/时刻/下标 + 卡片代际号 + 视频身份快照）并直达正确的平台编辑界面
// （无记录新增 / 缺 Key 聚焦 Key / 缺模型编辑该平台并聚焦模型配置）。
function beginExplainSetup(): void {
  if (!card.open || explainSetupOpenInFlight) {
    return;
  }
  const errorClass = classifyOverviewSetupError(card.error);
  if (!errorClass) {
    return;
  }
  explainSetupOpenInFlight = true;
  const sessionEpoch = ++explainSetupSessionEpoch;
  const targetRunId = card.runId;
  setExplainSetupResumeIntent({
    selection: card.selection,
    line: card.line,
    from: card.from,
    index: card.index,
    runId: card.runId,
    bvid: String(state.clip.bvid || ""),
    cid: String(state.clip.cid || ""),
    createdAt: Date.now(),
    errorClass
  });
  void (async () => {
    try {
      const resolvedProviderId = errorClass === "no-model" ? await resolveEditableAiProviderId() : "";
      const { openReaderAiSetup } = await import("../ui/settings-panel.js");
      if (!card.open || card.runId !== targetRunId || sessionEpoch !== explainSetupSessionEpoch) {
        return;
      }
      // settings-panel.openReaderAiSetup 仅当 errorClass === "missing-key" 时按 providerId 编辑；
      // "no-model" 在有目标平台时借道 "missing-key" + target.providerId 打开对应平台编辑页，随后聚焦模型配置。
      const uiSetupClass: OverviewSetupErrorClass =
        errorClass === "no-model" && resolvedProviderId ? "missing-key" : errorClass;
      await openReaderAiSetup(
        uiSetupClass,
        {
          onAfterSave: () => {
            if (sessionEpoch !== explainSetupSessionEpoch) {
              return;
            }
            // 先消费意图并续跑（同一卡片重发，用户可见 loading → 结果），再退出
            // 设置抽屉；设置层完全收起后再把焦点移回解释卡对话框。
            const resumed = resumeExplainAfterSetup();
            closeReaderSettingsMode({ restoreFocus: !resumed });
            if (resumed) {
              pendingInitialFocus = false;
              focusExplainDialog();
            }
          },
          onSessionEnd: () => {
            if (sessionEpoch !== explainSetupSessionEpoch) {
              return;
            }
            clearExplainSetupResumeIntent();
          }
        },
        resolvedProviderId ? { providerId: resolvedProviderId } : undefined
      );
      if (errorClass === "no-model" && card.open && sessionEpoch === explainSetupSessionEpoch) {
        focusProviderEditorModelControl();
      }
    } catch {
      if (sessionEpoch === explainSetupSessionEpoch) {
        clearExplainSetupResumeIntent();
      }
    } finally {
      if (sessionEpoch === explainSetupSessionEpoch) {
        explainSetupOpenInFlight = false;
      }
    }
  })();
}

/**
 * 首配保存成功后续跑（票 02）：取走意图并逐项校验——卡片代际号变化（换选区
 * 重开 / 重试 / 关闭过）、视频身份变化（换视频 / 分 P）、卡片已关或选区整句快照
 * 不一致均静默作废；通过才在同一卡片续跑一次（runId +1 让迟到旧回执作废）。
 * 一次性消费：校验失败的意图已随 consume 丢弃，不会二次生效。
 */
export function resumeExplainAfterSetup(): boolean {
  const intent = consumeExplainSetupResumeIntent();
  if (!intent) {
    return false;
  }
  if (!card.open) {
    return false;
  }
  if (intent.runId !== card.runId) {
    return false;
  }
  if (String(intent.bvid) !== String(state.clip.bvid || "") || String(intent.cid) !== String(state.clip.cid || "")) {
    return false;
  }
  if (intent.selection !== card.selection || intent.line !== card.line) {
    return false;
  }
  card.runId += 1;
  startExplainRequest();
  return true;
}

/**
 * 打开解释卡片并发起解释请求。
 * 重复打开（换了选区再点「解释」）：先中止上一请求，代际号 +1 让旧回执作废。
 */
export function openReaderExplainCard(payload: ReaderExplainCardPayload): void {
  const selection = String(payload?.selection || "").trim();
  const line = String(payload?.line || "").trim();
  if (!selection) {
    return;
  }
  const root = getCardRoot();
  const pop = document.getElementById(ids.readingExplainPop);
  if (pop) {
    pop.hidden = true;
    delete pop.dataset.itemIndex;
  }
  const subtitleList = document.getElementById(ids.readingSubtitleList);
  const nextIndex = Number.isFinite(Number(payload?.index)) ? Number(payload.index) : -1;
  if (!card.open) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fromCardOrPop = Boolean(active && ((root && root.contains(active)) || (pop && pop.contains(active))));
    const fallbackItem = nextIndex >= 0 ? findSubtitleItem(subtitleList, nextIndex) : null;
    returnFocusEl =
      active && active.isConnected && !fromCardOrPop && active !== document.body && active !== document.documentElement
        ? active
        : fallbackItem;
  }
  pendingInitialFocus = true;
  explainSetupSessionEpoch += 1;
  explainSetupOpenInFlight = false;
  card.controller?.abort();
  card.runId += 1;
  card.open = true;
  card.selection = selection;
  card.line = line || selection;
  card.from = Number(payload?.from) || 0;
  card.index = nextIndex;
  bindCardEsc();
  startExplainRequest();
}

/** 关闭卡片：中止在飞请求并整卡归位（幂等）。 */
export function closeReaderExplainCard(options?: { restoreFocus?: boolean }): void {
  if (!card.open) {
    return;
  }
  const shouldRestoreFocus = options?.restoreFocus !== false;
  const savedIndex = card.index;
  const targetToRestore = shouldRestoreFocus ? returnFocusEl : null;
  returnFocusEl = null;
  pendingInitialFocus = false;
  explainSetupSessionEpoch += 1;
  explainSetupOpenInFlight = false;
  // 首配续跑意图随卡片关闭作废（票 02：关卡片即失效；保存成功路径已先消费）。
  clearExplainSetupResumeIntent();
  unbindCardEsc();
  card.controller?.abort();
  card.controller = null;
  card.runId += 1;
  card.open = false;
  card.text = "";
  card.error = "";
  card.searching = false;
  card.notice = "";
  renderCard();
  if (shouldRestoreFocus && !state.reader.readingSettingsExpanded && !hasReaderSettingsOverlayOpen()) {
    const subtitleList = document.getElementById(ids.readingSubtitleList);
    const fallbackItem = savedIndex >= 0 ? findSubtitleItem(subtitleList, savedIndex) : null;
    const candidate =
      targetToRestore && isElementFocusable(targetToRestore)
        ? targetToRestore
        : fallbackItem && isElementFocusable(fallbackItem)
          ? fallbackItem
          : null;
    candidate?.focus?.({ preventScroll: true });
  }
}

/**
 * 卡片内点击委托（reader/explain-pop-ui.ts 挂在卡片容器上转发）：
 * close（遮罩 / ×）→ 关卡片；retry → 重发；setup（票 02，配置类 error）→ 记录
 * 续跑意图并直达平台编辑；ask-chat → 写待解释意图并切到对话 tab。
 */
export function onReaderExplainCardClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-explain-card-action]");
  if (!target) {
    return;
  }
  event.stopPropagation();
  const action = target.dataset.explainCardAction;
  if (action === "close") {
    closeReaderExplainCard();
    return;
  }
  if (action === "retry") {
    if (card.open) {
      card.runId += 1;
      startExplainRequest();
    }
    return;
  }
  if (action === "setup") {
    beginExplainSetup();
    return;
  }
  if (action === "ask-chat") {
    // 意图契约（reader/explain-intent.ts）：已生成解释一并带走，对话侧直接保留上下文
    // 供用户继续追问（不再重发同一遍）；加载失败无解释时保持原解释请求兜底。
    const explanation = card.phase === "ready" && card.text.trim() ? card.text.trim() : undefined;
    setPendingExplainIntent({
      from: card.from,
      content: card.line,
      selection: card.selection,
      ...(explanation ? { explanation } : {}),
      createdAt: Date.now()
    });
    closeReaderExplainCard({ restoreFocus: false });
    // 切对话 tab + 激活（含二级激活）由标签激活属主统一执行：写状态位/持久化 →
    // 投影命令 → 对话组合根激活（consumeIntent 默认 true，落定即消费上面写入的
    // 待解释意图）。fire-and-forget：点击反馈（卡片收起、tab 投影）不依赖它。
    void activateScriptTab("chat");
  }
}

/** 卡片是否开着（closeReadingView 收尾判定 / 测试）。 */
export function isReaderExplainCardOpen(): boolean {
  return card.open;
}
