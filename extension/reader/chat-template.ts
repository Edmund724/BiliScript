// AI 对话 tab 的模板叶子（arch-slim-2/06：模板段自 ui/ui-renderer.ts 下放）。
//
// 为什么是纯模板叶子：chat-tab.ts（对话组合根）已反向 import ui-renderer 的
// setReaderScriptTab/openReaderSettingsPanel——对话 tab 模板若直接搬进
// chat-tab.ts 会成环；本模块只依赖 reader/state.js 的 ids 表（零 reader/ui
// 依赖、零逻辑），壳（ui-renderer）组装、chat-tab 消费 els，依赖图保持无环。
//
// 结构对应 sidepanel.html 的 sp* 树（id 换 readingChat* 前缀）。对话组合根
//（reader/chat-tab.ts）首次激活时接线；未激活前壳保持静默空态（空消息区 +
// 空输入框），不放假数据。待解释意图引用卡（PR3 契约）由对话组合根按
// pending 意图渲染，自动发送成功即消费隐藏；卡上的取消按钮清意图。
// 工单 03 增量：档位切换区内的「关不掉思考」提示行（默认 hidden）。
// 06 号票增量：档位 chip 由 3 档静态按钮改为 7 档静态占位（激活后由
// reader/chat-model-panel.ts 按该模型可用集改写显隐与文案——只显示存在的档位）。
// 2026-09 用户决议：历史对话从「输入卡上方弹出的浮层」改为盖住 AI 对话 tab
// 内容区的整页（详见 reader-chat.css 的接管规则）。因此历史页是对话根的第一个
// 子元素——开合仍是 [hidden] 单源，靠「历史页:not([hidden]) ~ 对话内容」把
// 意图卡/转写行/消息区/输入卡一起 display:none，与设置抽屉接管面板第
// 3–4 行同一套纯属性反应；类名沿用 chat-history-popover（历史包袱，语义已是
// 整页而非 popover）。
// 「历史对话 / 新会话」两键已并入壳的标签行（ui-renderer.ts 的
// .biliscript-reading-tabs-tools），对话 tab 内不再有工具条行。

import { ids } from "./state.js";

export function buildChatTabBodyHtml(): string {
  return `
      <div id="${ids.readingChatRoot}" class="biliscript-reading-chat">
        <!-- 历史对话整页：必须排在全部对话内容之前，兄弟选择器才成立（顺序即契约） -->
        <section id="${ids.readingChatHistoryPopover}" class="chat-history-popover" hidden>
          <div class="chat-history-popover-head">
            <button id="${ids.readingChatHistoryBackBtn}" type="button" class="chat-icon-btn" title="返回对话" aria-label="返回对话">
              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                <path d="m15 18-6-6 6-6"></path>
              </svg>
            </button>
            <span class="chat-history-popover-title">历史对话</span>
            <button id="${ids.readingChatHistoryClearBtn}" type="button" class="chat-history-clear-btn">清空全部</button>
          </div>
          <div id="${ids.readingChatHistoryList}" class="chat-history-list"></div>
        </section>

        <div id="${ids.readingChatIntent}" class="biliscript-reading-chat-intent" hidden>
          <div class="biliscript-reading-chat-intent-head">
            <span class="biliscript-reading-chat-intent-title">待解释的字幕句</span>
            <span class="biliscript-reading-chat-intent-time biliscript-reading-time">00:00</span>
            <button type="button" class="biliscript-reading-chat-intent-cancel" data-chat-intent-action="cancel" title="取消解释" aria-label="取消解释">×</button>
          </div>
          <blockquote class="biliscript-reading-chat-intent-quote"></blockquote>
        </div>

        <!-- 转写状态行：默认基础句；等待发送期间文案由 chat-tab.ts 切换（唯一提示，不另起消息区通知） -->
        <div id="${ids.readingChatAsrNotice}" class="chat-asr-notice" hidden>该视频无字幕，正在音频转写…</div>
        <main class="chat-messages" id="${ids.readingChatMessages}">
          <div class="chat-suggestions" id="${ids.readingChatSuggestions}"></div>
        </main>
        <footer class="chat-footer">
          <!-- 滚底按钮（DeepSeek Harness 同款）：消息区离开底部即出现，点一下回底。
               默认 hidden——「回到底部」在底部是无意义的入口，初始/清场态一律不亮。
               挂 footer 内而非消息区：消息区是滚动容器，绝对定位的子节点会跟着内容
               滚走；footer 是 relative 的定位父级，按钮才固定浮在输入卡上方。历史
               整页打开时 footer 整体 display:none，按钮随之退场，无需另判。 -->
          <button id="${ids.readingChatScrollBottomBtn}" type="button" class="chat-scroll-bottom" title="跳到底部" aria-label="跳到底部" hidden>
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="m6 9 6 6 6-6"></path>
            </svg>
          </button>
          <!-- 发送卡片：上方输入区 + 下方控件行（联网搜索 pill / 模型 chip / 发送
               键），整体一个圆角卡片。模型 chip 是隐藏 select 的展示层（值源不变）。 -->
          <div class="chat-input-card">
            <!-- 图片附件区（image-input 02 号票）：粘贴（Ctrl+V）的图片缩略图 +
                 单个删除键；无附件时 hidden。内容由 chat/chat-input-images.ts 渲染。 -->
            <div id="${ids.readingChatImageStrip}" class="chat-image-strip" hidden></div>
            <!-- 输入框默认单行（省空间）：未聚焦高度由 rows=1 定；聚焦不撑高，
                 长高只随内容换行走 chat-tab.ts 的 autosizeInput 写行内
                 min-height（主轴上 flex-basis:0% 让 height 失效）。 -->
            <textarea
              id="${ids.readingChatInput}"
              rows="1"
              placeholder="回车发送，Shift+Enter 换行"
              autocomplete="off"
            ></textarea>
            <div id="${ids.readingChatInputBar}" class="chat-input-bar">
              <!-- 联网搜索开关（spec §4）：输入行 + 右侧的描边圆开关，点击即改全局
                   记忆；开启态 accent-soft 底 + accent 图标（DeepSeek 输入框工具 pill
                   同款位）。只留地球图标、不带文字：输入行宽度留给模型名（模型名是这里
                   最长的变量）。字形取地球（轮廓圆 + 赤道 + 一条 65° 经线），三条经线
                   半弧（a / b / c）共用同一模板，见 reader-chat.css 的「地球转向」注：
                   a、b 拼出静止时那条经线，c 在静止时是左半圆——正压在轮廓圆上，看不出。
                   赤道两端内缩 0.93r，圆头端帽落在轮廓圆的描边里，接缝不断。两个静止态
                   字形完全相同，方向只由切换动画表达。 -->
              <button id="${ids.readingChatWebSearchPill}" type="button" class="chat-web-search-pill" title="联网搜索" aria-label="联网搜索" aria-pressed="false">
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path class="chat-web-search-meridian chat-web-search-meridian-a" d="M12 22C14.334 22 16.226 17.523 16.226 12C16.226 6.477 14.334 2 12 2"></path>
                  <path class="chat-web-search-meridian chat-web-search-meridian-b" d="M12 22C9.666 22 7.774 17.523 7.774 12C7.774 6.477 9.666 2 12 2"></path>
                  <path class="chat-web-search-meridian chat-web-search-meridian-c" d="M12 22C6.477 22 2 17.523 2 12C2 6.477 6.477 2 12 2"></path>
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M2.714 12h18.572"></path>
                </svg>
              </button>
              <!-- 模型 chip 的锚点容器：面板的定位父级（原先挂在 footer 上 → 全宽、
                   浮在输入卡片上方；现改挂 chip，面板才落在「箭头上方」并压在
                   输入框上）。右推 margin-left:auto 也收在这里（chip 自己不再右推）。 -->
              <div class="chat-model-anchor">
                <button id="${ids.readingChatModelChip}" type="button" class="chat-model-chip" aria-label="选择模型与思考档位">
                  <!-- 模型名与档位分 span：溢出截断只作用于模型名，档位与 chevron 恒完整 -->
                  <span class="chat-model-chip-model">未配置平台</span>
                  <span class="chat-model-chip-level">Off</span>
                  <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                    <path d="m6 9 6 6 6-6"></path>
                  </svg>
                </button>
                <!-- 模型 + 思考档位面板：点 chip 弹出。上部分组模型列表（滚动），底部固定区
                     内联「思考强度 <当前值> + ↻ 重置键」与胶囊滑轨/单档胶囊 + 「关不掉」提示行。
                     档位由 reader/chat-model-panel.ts 按 chat/thinking-picker 的显示条目现渲。 -->
                <div id="${ids.readingChatModelPanel}" class="chat-model-panel" hidden>
                  <div id="${ids.readingChatModelList}" class="chat-model-list"></div>
                  <div class="chat-model-panel-foot">
                    <div id="${ids.readingChatThinkingRow}" class="chat-thinking-row" hidden>
                      <div class="chat-thinking-head">
                        <span class="chat-thinking-row-label">思考强度</span>
                        <span id="${ids.readingChatThinkingRowValue}" class="chat-thinking-row-value"></span>
                      </div>
                      <div id="${ids.readingChatThinkingToggle}" class="chat-thinking-list" role="group" aria-label="思考档位"></div>
                    </div>
                    <div id="${ids.readingChatThinkingHint}" class="chat-thinking-hint" role="note" hidden></div>
                  </div>
                </div>
              </div>
              <button id="${ids.readingChatSendBtn}" type="button" class="chat-send-btn" disabled aria-label="发送">
                <svg class="chat-send-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M12 19V5"></path>
                  <path d="m5 12 7-7 7 7"></path>
                </svg>
                <!-- 停止键：实心圆底 + 一个白色圆角方块（无内环）。方块按 32px 圆键
                     直径的 ~35% 取（viewBox 17/24），圆角 rx=4，与设计稿同比例。 -->
                <svg class="chat-stop-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <rect class="chat-stop-icon-core" x="3.5" y="3.5" width="17" height="17" rx="4"></rect>
                </svg>
              </button>
            </div>
            <!-- 模型选择值源（chip 的展示对象）：视觉上隐藏，providers 渲染选项、
                 change 持久化链不变 -->
            <select id="${ids.readingChatModelSelect}" class="chat-model-select" aria-label="选择模型平台" hidden></select>
          </div>
        </footer>
      </div>
  `;
}
