// AI 对话 tab 的模板叶子（arch-slim-2/06：模板段自 ui/ui-renderer.ts 下放）。
//
// 为什么是纯模板叶子：chat-tab.ts（对话组合根）已反向 import ui-renderer 的
// setReaderDigestTab/openReaderSettingsPanel——对话 tab 模板若直接搬进
// chat-tab.ts 会成环；本模块只依赖 reader/state.js 的 ids 表（零 reader/ui
// 依赖、零逻辑），壳（ui-renderer）组装、chat-tab 消费 els，依赖图保持无环。
//
// 结构对应 sidepanel.html 的 sp* 树（id 换 readingChat* 前缀）。对话组合根
//（reader/chat-tab.ts）首次激活时接线；未激活前壳保持静默空态（空消息区 +
// 空输入框），不放假数据。待解释意图引用卡（PR3 契约）由对话组合根按
// pending 意图渲染，自动发送成功即消费隐藏；卡上的取消按钮清意图。
// 工单 03 增量：档位切换区内的「关不掉思考」提示行（默认 hidden，唯一的
// 档位区 UI 增量，三档按钮本身不变）。

import { ids } from "./state.js";

export function buildChatTabBodyHtml(): string {
  return `
      <div id="${ids.readingChatRoot}" class="boc-reading-chat">
        <header class="chat-header boc-reading-chat-header">
          <button type="button" class="chat-context-chip" id="${ids.readingChatContextChip}" title="">加载中...</button>
          <button id="${ids.readingChatHistoryBtn}" type="button" class="chat-toolbar-btn" title="历史对话">
            <span>历史对话</span>
          </button>
          <button id="${ids.readingChatRefreshBtn}" type="button" class="chat-icon-btn" title="刷新当前视频上下文" aria-label="刷新上下文">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
              <path d="M21 3v5h-5"></path>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
              <path d="M8 16H3v5"></path>
            </svg>
          </button>
          <button id="${ids.readingChatNewBtn}" type="button" class="chat-icon-btn" title="开启新会话" aria-label="开启新会话">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M12 5v14"></path>
              <path d="M5 12h14"></path>
            </svg>
          </button>
        </header>

        <div id="${ids.readingChatIntent}" class="boc-reading-chat-intent" hidden>
          <div class="boc-reading-chat-intent-head">
            <span class="boc-reading-chat-intent-title">待解释的字幕句</span>
            <span class="boc-reading-chat-intent-time boc-reading-time">00:00</span>
            <button type="button" class="boc-reading-chat-intent-cancel" data-chat-intent-action="cancel" title="取消解释" aria-label="取消解释">×</button>
          </div>
          <blockquote class="boc-reading-chat-intent-quote"></blockquote>
        </div>

        <!-- 转写状态行：默认基础句；等待发送期间文案由 chat-tab.ts 切换（唯一提示，不另起消息区通知） -->
        <div id="${ids.readingChatAsrNotice}" class="chat-asr-notice" hidden>该视频无字幕，正在音频转写…</div>
        <main class="chat-messages" id="${ids.readingChatMessages}">
          <div class="chat-suggestions" id="${ids.readingChatSuggestions}"></div>
        </main>
        <footer class="chat-footer">
          <div id="${ids.readingChatPresetPopover}" class="chat-preset-popover" hidden>
            <div id="${ids.readingChatPresetList}" class="chat-preset-list"></div>
            <div class="chat-preset-editor">
              <input id="${ids.readingChatPresetInput}" class="chat-preset-input" type="text" placeholder="添加预设提示词" />
              <button id="${ids.readingChatPresetAddBtn}" type="button" class="chat-preset-add-btn">添加</button>
            </div>
          </div>
          <div id="${ids.readingChatHistoryPopover}" class="chat-history-popover" hidden>
            <div class="chat-history-popover-head">
              <span class="chat-history-popover-title">历史对话</span>
              <button id="${ids.readingChatHistoryClearBtn}" type="button" class="chat-history-clear-btn">清空全部</button>
            </div>
            <div id="${ids.readingChatHistoryList}" class="chat-history-list"></div>
          </div>
          <!-- 模型 + 思考档位面板：点发送框底部模型 chip 弹出。上部分组模型列表
               （滚动），底部固定思考档位行 + 「关不掉」提示行（工单 03）。 -->
          <div id="${ids.readingChatModelPanel}" class="chat-model-panel" hidden>
            <div id="${ids.readingChatModelList}" class="chat-model-list"></div>
            <div class="chat-model-panel-foot">
              <div class="chat-model-panel-thinking">
                <span class="chat-model-thinking-label">思考</span>
                <div id="${ids.readingChatThinkingToggle}" class="chat-thinking-toggle" role="group" aria-label="思考档位">
                  <button type="button" class="chat-thinking-btn" data-level="off">Off</button>
                  <button type="button" class="chat-thinking-btn" data-level="low">Low</button>
                  <button type="button" class="chat-thinking-btn" data-level="high">High</button>
                </div>
              </div>
              <div id="${ids.readingChatThinkingHint}" class="chat-thinking-hint" role="note" hidden></div>
            </div>
          </div>
          <!-- 发送卡片：上方输入区 + 下方控件行（+ / 模型 chip / 发送键），整体一个
               圆角卡片。模型 chip 是隐藏 select 的展示层（值源不变）。 -->
          <div class="chat-input-card">
            <textarea
              id="${ids.readingChatInput}"
              rows="2"
              placeholder="回车发送，Shift+Enter 换行"
              autocomplete="off"
            ></textarea>
            <div id="${ids.readingChatInputBar}" class="chat-input-bar">
              <button id="${ids.readingChatPresetBtn}" type="button" class="chat-add-btn" title="预设提示词" aria-label="预设提示词">
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M12 5v14"></path>
                  <path d="M5 12h14"></path>
                </svg>
              </button>
              <!-- 联网搜索开关（spec §4）：输入行 + 右侧的 pill，点击即改全局记忆；
                   开启态 accent-soft 底 + accent 字（DeepSeek 输入框工具 pill 同款位） -->
              <button id="${ids.readingChatWebSearchPill}" type="button" class="chat-web-search-pill" title="联网搜索" aria-pressed="false">
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <circle cx="12" cy="12" r="9"></circle>
                  <path d="M3 12h18"></path>
                  <path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18"></path>
                </svg>
                <span>联网搜索</span>
              </button>
              <button id="${ids.readingChatModelChip}" type="button" class="chat-model-chip" aria-label="选择模型与思考档位">
                <!-- 模型名与档位分 span：溢出截断只作用于模型名，档位与 chevron 恒完整 -->
                <span class="chat-model-chip-model">未配置平台</span>
                <span class="chat-model-chip-level">Off</span>
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="m6 9 6 6 6-6"></path>
                </svg>
              </button>
              <button id="${ids.readingChatSendBtn}" type="button" class="chat-send-btn" disabled aria-label="发送">
                <svg class="chat-send-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M12 19V5"></path>
                  <path d="m5 12 7-7 7 7"></path>
                </svg>
                <svg class="chat-stop-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="1.5"></rect>
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
