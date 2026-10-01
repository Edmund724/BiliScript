import { state, uiState } from "../core/state.js";
import { byId } from "../shared/dom-utils.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { themeButtonView } from "./theme-button.js";
// PR5 外点关闭单委托：对话 tab popovers 的文档级外点关闭经桥接叶子并入本模块
// 的单一 document click 委托（原双监听互踩风险收口，见 chat-tab-bridge.ts）。
import { dispatchChatTabOutsideClick } from "../reader/chat-tab-bridge.js";
// 候选03 常驻瘦身：本模块（面板 + 阅读视图壳构建、事件绑定）已整体惰性化，
// 经 ui/lazy-ui.js 动态装载。静态 import 只允许常驻叶子——reader 状态微模块
//（./reader/state.js，含 ids/view-state/scroll-state）、轻状态栏写入器
//（../core/ui-status.js）、reader 域懒加载转发助手（./reader-gate.js，动态边
// 在 reader/lazy-reader 内部）。
import { ids, isReaderViewOpen } from "../reader/state.js";
import type { ReaderScriptTab } from "../reader/state.js";
// tab 位置持久化叶子（2026-10 用户决议）：写穿与读回都已收口 reader 域属主
//（reader/script-tab-activation 的 activateScriptTab）；本壳只剩 isReaderScriptTab
// ——project-tab 投影命令的载荷守卫（未知标签不动当前投影）。
import { isReaderScriptTab } from "../reader/script-tab-persistence.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";
// 阅读壳（工单 arch-slim/02）：关闭按钮的关闭链退化为退出事务委托
//（URL 收敛 → closeReadingView → 摘阅读表，唯一实现在 reader/shell.ts）。
import { exitReaderShell } from "../reader/shell.js";
// 对话分区表（arch-slim-4/07）：投影到对话 tab 时（project-tab 命令 / 恢复链）
// 由 setReaderScriptTab 的 chat 分支同步挂载（reader/chat-tab.ts 模块顶层另兜底
// 挂一次）；不建 onload 门控——无样式窗口只落在未激活的静默空态上。
import { ensureReaderChatStyles } from "../shared/style-injector.js";
// arch-slim-2/06 ui 按 tab 全量收口：三 tab 的模板段+绑定段同居各自域叶子，
// 壳只组装与接线。叶子均为轻模块（ids 表 + reader-gate 转发助手，动态边在
// 叶子依赖内部），不把 reader 重域/总结链拖进壳闭包：
//   - reader/chat-template.ts：对话 tab 模板（绑定全在 reader/chat-tab.ts
//     组合根，含 els 表与 bindEvents；无平台空态「前往设置」的容器委托也在
//     该域——死绑定修复，见其 bindEvents 注释）；
//   - reader/subtitle-tab-ui.ts：字幕 tab 工具条/转写横幅/列表容器/Follow
//     的模板 + 搜索/切轨/复制导出/Follow/列表交互绑定；
//   - reader/explain-pop-ui.ts：选区解释浮层与卡片宿主模板 + 选区监听/定位/
//     快照/卡片委托绑定（卡片状态机在 reader/explain-card.ts）；
//   - reader/overview-ui.ts：概览占位模板 + 点击委托（状态机在 reader/overview.ts）；
//   - ui/reader-gate.ts：withReader/whenReaderReady 转发助手单源（壳与 tab
//     叶子共用，禁止复制）。
import { withReader } from "./reader-gate.js";
// 壳命令通道（arch-review-2026-09/10 reader→ui 反转）+ tab 意图反向槽：reader 域
// 对壳的回头调（属主的标签投影 / chat-tab「前往设置」）改发 reader-bus 命令，本壳
// 注册 handler 执行；tab 点击反过来经同一 reader-bus 上报意图给属主——两条边都不
// 需要 reader 域静态 import 本模块。
import { reportTabIntent, subscribeUiCommand } from "../reader/reader-bus.js";
import { buildChatTabBodyHtml } from "../reader/chat-template.js";
import { buildSubtitleTabBodyHtml, bindSubtitleTabEvents } from "../reader/subtitle-tab-ui.js";
import { buildExplainPopHtml, buildExplainCardHostHtml, bindReadingExplainEvents } from "../reader/explain-pop-ui.js";
import { buildOverviewTabBodyHtml, bindReadingOverviewEvents } from "../reader/overview-ui.js";

export function buildUiHtml(): string {
  const themeView = themeButtonView(state.reader.readingTheme);
  return `
    <section id="${ids.readingView}" aria-hidden="true" data-biliscript-reader-ready="0" aria-busy="true">
      <!-- 统一 文摘面板（B 形态）：右栏面板壳，三标签 = 字幕 / 概览 /
           AI 对话。rail（章节栏）与 stage（状态栏/播放器槽）已随整页接管退役
           ——章节列表由概览 tab 提供，播放器保持 B 站原生布局不动；
           readingStatus 挪进面板 header 下方（id 不变，subtitle/ai/chat 各域
           经 core/ui-status.js 持续写入：错误常驻、其余 5s 收起、空闲整行
           hidden——策略见 core/reading-status-line.js）。三 tab body 的内容
           模板随各自域叶子（arch-slim-2/06：壳只懂面板骨架与 tab 切换） -->
      <aside id="${ids.readingScriptPanel}" class="biliscript-reading-script-panel" aria-label="文摘面板">
            <header class="biliscript-reading-header">
              <div class="biliscript-reading-header-copy">
                <!-- meta 行由 reader/lifecycle.js 的 renderReadingView 填充
                     （UP主：… · P{n}：… · 字幕：…；网址已按 2026-09 用户决议删除）；
                     字段全空时整块 hidden，初始态即 hidden -->
                <div id="${ids.readingMeta}" class="biliscript-reading-meta" hidden></div>
              </div>
              <div class="biliscript-reading-actions">
                <button id="${ids.readingThemeSelect}" type="button" class="biliscript-reading-icon-btn" title="主题：${themeView.title}" aria-label="主题：${themeView.title}">
                  ${themeView.icon}
                </button>
                <button id="${ids.readingSettingsBtn}" type="button" class="biliscript-reading-icon-btn" title="设置" aria-label="设置">
                  ${READING_HEADER_ICONS.settings}
                </button>
                <button id="${ids.readingCloseBtn}" type="button" class="biliscript-reading-icon-btn" title="退出" aria-label="退出阅读视图">
                  ${READING_HEADER_ICONS.close}
                </button>
              </div>
            </header>

            <p id="${ids.readingStatus}" class="biliscript-reading-status" hidden></p>

            <section id="${ids.readingSettingsPanel}" class="biliscript-reading-panel biliscript-reading-settings-panel" hidden>
              <!-- 扩展设置宿主（script-only-ui）：原独立 options 页的全部设置项
                   由 ui/settings-panel.js 渲染进此容器（分节、可滚动），options
                   页面本体已删除。顶部滚动/字幕/章节三开关与字幕语言下拉已随
                   三开关退役移除——语言下拉移入字幕 tab 工具条（复制按钮左侧）。 -->
              <section class="biliscript-reading-settings-group biliscript-reading-settings-extension">
                <div id="${ids.readingSettingsHost}" class="biliscript-reading-settings-host"></div>
              </section>
            </section>

            <!-- 标签页分段控件（凹槽 + 卡片，12px 槽 / 8px 项；active 态 = accent 实底，见 prototype/direction-approved.md） -->
            <div class="biliscript-reading-tabs" role="tablist" aria-label="Script 标签">
              <button id="${ids.readingTabSubtitle}" type="button" class="biliscript-reading-tab is-active" role="tab" aria-selected="true">字幕</button>
              <button id="${ids.readingTabOverview}" type="button" class="biliscript-reading-tab" role="tab" aria-selected="false">概览</button>
              <button id="${ids.readingTabChat}" type="button" class="biliscript-reading-tab" role="tab" aria-selected="false">AI 对话</button>
            </div>

            <!-- 字幕 tab body：工具条/转写横幅/列表容器/Follow 模板与交互绑定
                 在 reader/subtitle-tab-ui.ts；选区「解释」浮层与卡片宿主在
                 reader/explain-pop-ui.ts（arch-slim-2/06 下放） -->
            <div id="${ids.readingTabBodySubtitle}" class="biliscript-reading-tab-body is-active" role="tabpanel" aria-label="字幕">
              ${buildSubtitleTabBodyHtml()}
              ${buildExplainPopHtml()}
              ${buildExplainCardHostHtml()}
            </div>

            <!-- 概览 tab（PR4）：占位模板 + 点击委托在 reader/overview-ui.ts，
                 状态机/渲染在 reader/overview.ts（PR4 状态机宿主），内容由
                 lifecycle/ui 触发路径按阶段整块重建——idle/generating/ready/
                 partial/error/empty 全诚实态，不放假数据。此为未生成初值。 -->
            <div id="${ids.readingTabBodyOverview}" class="biliscript-reading-tab-body" role="tabpanel" aria-label="概览" hidden>
              ${buildOverviewTabBodyHtml()}
            </div>

            <!-- AI 对话 tab（PR5）：真对话 UI 壳模板在 reader/chat-template.ts
                 叶子（arch-slim-2/06 下放；组合根 reader/chat-tab.ts 首次激活时
                 接线，含容器级事件委托），未激活前壳保持静默空态（空消息区 +
                 空输入框），不放假数据。 -->
            <div id="${ids.readingTabBodyChat}" class="biliscript-reading-tab-body" role="tabpanel" aria-label="AI 对话" hidden>
              ${buildChatTabBodyHtml()}
            </div>
      </aside>
    </section>
  `;
}

// ===== 统一 文摘面板三标签（PR2） =====
//
// 壳只剩「投影」一件事（读标签 → class/aria/hidden 三通道写入 + 对话分区表挂载）：
// 标签切换的状态位、持久化写穿与二级激活（对话组合根 / 概览生成）都已收口 reader
// 域属主 reader/script-tab-activation 的 activateScriptTab，壳经 project-tab 命令
// 与之对接、经 reportTabIntent 反向槽接收点击意图（见下方 handler 与 bindUiEvents）。
// active 态约定：tab 按钮 .is-active + aria-selected，tab body .is-active 且
// 去 hidden（CSS 双通道：.biliscript-reading-tab-body:not(.is-active) 与 [hidden]
// 都收敛为 display:none，防 UA 样式被作者 display 覆盖）。
// 当前激活标签的类型单源在 reader/state.js（状态位同居本叶子，ui 壳与测试
// 经本 re-export 取用，import 路径不变）。
export type { ReaderScriptTab } from "../reader/state.js";

const SCRIPT_TAB_DEFS: Array<{ name: ReaderScriptTab; buttonId: string; bodyId: string }> = [
  { name: "subtitle", buttonId: ids.readingTabSubtitle, bodyId: ids.readingTabBodySubtitle },
  { name: "overview", buttonId: ids.readingTabOverview, bodyId: ids.readingTabBodyOverview },
  { name: "chat", buttonId: ids.readingTabChat, bodyId: ids.readingTabBodyChat }
];

// 唯一的 DOM 投影写手（project-tab 命令执行点）。只写 DOM：状态位与持久化都在
// reader 域属主（reader/script-tab-activation.ts），本函数不得再写它们——否则
// 当前标签就有了第二条真源（禁止各入口自行组合「写状态位 + 投影」）。
export function setReaderScriptTab(tab: ReaderScriptTab): void {
  // 对话分区表按需装载（arch-slim-4/07）：投影到对话 tab 时同步挂载保证首开即
  // 在场；ensure 内部 mounted Map 去重，重入零成本。
  if (tab === "chat") {
    ensureReaderChatStyles();
  }
  for (const def of SCRIPT_TAB_DEFS) {
    const button = document.getElementById(def.buttonId);
    const body = document.getElementById(def.bodyId);
    if (!button || !body) {
      continue;
    }
    const active = def.name === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    body.classList.toggle("is-active", active);
    if (active) {
      body.removeAttribute("hidden");
    } else {
      body.setAttribute("hidden", "");
    }
  }
}

// script-only-ui：打开侧边栏设置抽屉（展开 + 渲染）。原「打开设置页」入口
//（open-options 消息/options 页）已删除，header 齿轮、对话 tab 设置按钮与
// 提示条「前往设置」都收敛到本函数；reader 域（lifecycle.renderReaderPanels）
// 在抽屉打开时装载设置面板。
export function openReaderSettingsPanel(): void {
  state.reader.setSettingsExpanded(true);
  withReader("reader panels render", (reader) => reader.renderReaderPanels());
}

// 壳命令通道 handler（arch-review-2026-09/10 reader→ui 反转 + 标签激活收口）：
// reader 域对壳的回头调改发 reader-bus 具名命令，本壳是唯一执行方。二命令：
//   - "project-tab"：把标签投影到 DOM（reader 域属主 reader/script-tab-activation
//     的 activateScriptTab 在写状态位/持久化之后发本命令）——本命令只做 DOM 三通道
//     + 对话分区表挂载，不写状态位、不落盘、不做二级激活（那些都在属主）；未知/
//     缺失 payload 静默忽略，不动当前投影；
//   - "open-settings"：打开侧边栏设置抽屉（chat-tab 空态「前往设置」与提示条
//     onOpenSettings）。
// 旧命令 "set-tab" / "set-tab:chat" 已随标签激活收口 reader 属主退役（本处不再
// 注册，残留发送方静默丢弃）。
// 命令到达时壳必然已装载（本模块被装载才注册），但目标 DOM 缺失时各 setter
// 空转，与原 reader 侧直调的行为同形。
subscribeUiCommand((name, payload) => {
  if (name === "project-tab") {
    const tab = (payload as { tab?: unknown } | null)?.tab;
    if (!isReaderScriptTab(tab)) {
      return;
    }
    setReaderScriptTab(tab);
    return;
  }
  if (name === "open-settings") {
    openReaderSettingsPanel();
  }
});

export function bindUiEvents(): void {
  // script-only-ui：A 形态经典侧栏面板已删除，模板不再包含旧壳节点
  //（biliscript-panel/biliscript-status/biliscript-preview 等）；面板交互只有阅读视图（Script）。
  const readingView = byId(ids.readingView);
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingThemeSelect = byId(ids.readingThemeSelect);
  const readingSettingsToggleBtn = byId(ids.readingSettingsBtn);

  // arch-slim-2/06：三 tab 的专属绑定随模板同居各自域叶子（见文件头 import 注），
  // 壳的 bindUiEvents 只保留面板骨架交互 + 各叶子接线的一次性触发。
  bindSubtitleTabEvents();
  bindReadingExplainEvents();
  bindReadingOverviewEvents();

  // 文摘面板三标签切换（标签激活收口 reader 属主，见上方 handler 注释）：点击
  // 只上报意图（reader-bus 反向槽），由属主写状态位/持久化后经 "project-tab"
  // 命令投影回 DOM；二级激活（对话组合根 / 概览生成）同属属主的串行队列。壳不
  // 直接写 tab——那会绕过唯一状态位成为第二条真源。
  for (const def of SCRIPT_TAB_DEFS) {
    byId(def.buttonId).addEventListener("click", () => {
      reportTabIntent(def.name);
    });
  }

  // script-only-ui：经典侧栏面板的按钮绑定（close/refresh/select/copy/
  // download/settings）已随 A 形态模板删除；刷新/复制/导出等动作由字幕 tab
  // 工具条与面板 header 的动作按钮承接，绑定见 reader/subtitle-tab-ui.ts。
  // ===== 阅读视图交互回调（候选02）：closeReadingView/sync/click 等属 reader
  // 重域，交互时经 ensureReaderDomain 装载后调用（视图开着 ⇒ 域几乎必然已装载
  // ，ensure 命中缓存 promise）。关闭按钮：退出事务统一走阅读壳（工单
  // arch-slim/02），与 reader-close 消息路径同一实现。
  readingCloseBtn.addEventListener("click", () => {
    exitReaderShell().catch((error) => logWarn("[BILISCRIPT] close reading view failed", error));
  });
  readingThemeSelect.addEventListener("click", () => {
    // 明暗两态循环 light ↔ dark（按钮只管明暗轴；主题族在设置抽屉手选，
    // 档位文案/图标映射见 ui/theme-button.ts）。
    const next = state.reader.readingTheme === "dark" ? "light" : "dark";
    withReader("reader theme switch", (reader) => {
      reader.updateReaderPreferences({ readerTheme: next }, { persist: true });
      readingThemeSelect.classList.add("is-active");
      setTimeout(() => readingThemeSelect.classList.remove("is-active"), 300);
    });
  });
  readingSettingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.reader.setSettingsExpanded(!state.reader.readingSettingsExpanded);
    withReader("reader panels render", (reader) => reader.renderReaderPanels());
  });

  // Click outside settings panel to close（单一文档级 click 委托：PR5 起同时
  // 承接对话 tab popovers 的外点关闭——chat-tab-bridge 注册槽转发，不另挂第二
  // 个 document 监听，避免双委托互踩。转发必须放在 settingsExpanded 早退之前）。
  if (!state.reader.readingDocumentClickBound) {
    document.addEventListener("click", (e) => {
      dispatchChatTabOutsideClick(e);
      if (!state.reader.readingSettingsExpanded) return;
      const settingsPanel = document.getElementById(ids.readingSettingsPanel);
      const settingsBtnEl = document.getElementById(ids.readingSettingsBtn);
      if (!settingsPanel || !settingsBtnEl) {
        return;
      }
      if (!settingsPanel.contains(e.target as Node | null) && !settingsBtnEl.contains(e.target as Node | null)) {
        state.reader.setSettingsExpanded(false);
        withReader(null, (reader) => reader.renderReaderPanels());
      }
    });
    state.reader.readingDocumentClickBound = true;
  }

  readingView.addEventListener("transitionend", () => {
    if (!isReaderViewOpen()) {
      withReader(null, (reader) => reader.stopReadingViewSync());
    }
  });
}

export function ensureUiReady({ forceRecreate = false }: { forceRecreate?: boolean } = {}): void {
  const existingRoot = document.getElementById(ids.root);
  if (existingRoot && forceRecreate) {
    existingRoot.remove();
    uiState.setEventsBound(false);
  }

  let root = document.getElementById(ids.root);
  if (!root) {
    root = document.createElement("div");
    root.id = ids.root;
    root.innerHTML = buildUiHtml();
    document.body.appendChild(root);
    uiState.setEventsBound(false);
  }

  if (!state.ui.uiEventsBound) {
    bindUiEvents();
    uiState.setEventsBound(true);
  }
}

// renderMeta / renderSubtitleSelect / setBusyState 已随经典侧栏面板删除
//（script-only-ui：阅读视图的元信息/字幕轨由 reader 域渲染，复制/导出由字幕
// tab 工具条接线）；setStatus / setMessage 已迁往 ../core/ui-status.js，宿主
// 收敛到 #biliscript-reading-status。
// arch-slim-2/06：三 tab 的模板与专属绑定已同居各自域叶子（对话 reader/
// chat-template.ts + chat-tab.ts；字幕 reader/subtitle-tab-ui.ts；选区解释
// reader/explain-pop-ui.ts + explain-card.ts；概览 reader/overview-ui.ts +
// overview.ts），本壳只保留面板骨架、tab 投影与点击意图上报、文档级委托与懒加载转发。
