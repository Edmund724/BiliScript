import { ids } from "./state.js";
import { READING_CHEVRON_DOWN_ICON } from "../ui/reading-icons.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";

export function buildChatTabBodyHtml(): string {
  const liveEnabled = supportsLiveCompanion();
  return `
      <div id="${ids.readingChatRoot}" class="biliscript-reading-chat">
        <section id="${ids.readingChatHistoryPopover}" class="chat-history-popover" hidden>
          <div class="chat-history-popover-head">
            <button id="${ids.readingChatHistoryBackBtn}" type="button" class="chat-icon-btn" title="返回对话" aria-label="返回对话">
              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                <path d="m15 18-6-6 6-6"></path>
              </svg>
            </button>
            <span class="chat-history-popover-title">历史记录</span>
            <button id="${ids.readingChatHistoryClearBtn}" type="button" class="chat-history-clear-btn">清空全部</button>
          </div>
          <div id="${ids.readingChatHistoryList}" class="chat-history-list"></div>
        </section>

        <div id="${ids.readingChatIntent}" class="biliscript-reading-chat-intent" hidden>
          <div class="biliscript-reading-chat-intent-head">
            <span class="biliscript-reading-chat-intent-title">待解释的字幕句</span>
            <span class="biliscript-reading-chat-intent-time biliscript-reading-time">00:00</span>
            <button type="button" class="biliscript-reading-mini-btn biliscript-reading-chat-intent-send" data-chat-intent-action="send" hidden>发送</button>
            <button type="button" class="biliscript-reading-chat-intent-cancel" data-chat-intent-action="cancel" title="取消解释" aria-label="取消解释">×</button>
          </div>
          <blockquote class="biliscript-reading-chat-intent-quote"></blockquote>
        </div>

        <div id="${ids.readingChatAsrNotice}" class="chat-asr-notice" hidden>当前视频无字幕，正在进行语音转写…</div>
        <section id="${ids.readingChatLiveStatus}" class="chat-live-status" aria-label="实时伴看状态" data-state="idle" hidden>
          <span class="chat-live-status-text" role="status" aria-atomic="true"></span>
          <div class="chat-live-status-actions">
            <button type="button" data-live-status-action="cancel" hidden>取消</button>
            <button type="button" data-live-status-action="restore" hidden>显示浮窗</button>
            <button type="button" data-live-status-action="retry" hidden>重试</button>
            <button type="button" data-live-status-action="settings" hidden>伴看设置</button>
            <button type="button" data-live-status-action="stop" hidden>结束</button>
          </div>
          <div class="chat-live-tool-records" hidden></div>
        </section>
        <main class="chat-messages" id="${ids.readingChatMessages}">
          <div class="chat-suggestions" id="${ids.readingChatSuggestions}"></div>
        </main>
        <footer class="chat-footer">
          <button id="${ids.readingChatScrollBottomBtn}" type="button" class="chat-scroll-bottom" title="回到底部" aria-label="回到底部" hidden>
            ${READING_CHEVRON_DOWN_ICON}
          </button>
          <div class="chat-input-card">
            <div class="chat-subtitle-wait" role="status" aria-live="polite" hidden>
              <span class="chat-notice-spinner" aria-hidden="true"></span>
              <span class="chat-subtitle-wait-text">正在等待字幕，完成后自动发送</span>
              <button type="button" class="chat-subtitle-wait-cancel">取消</button>
            </div>
            <div id="${ids.readingChatImageStrip}" class="chat-image-strip" hidden></div>
            <textarea
              id="${ids.readingChatInput}"
              rows="1"
              placeholder="回车发送，Shift+Enter 换行"
              autocomplete="off"
            ></textarea>
            <div id="${ids.readingChatInputBar}" class="chat-input-bar">
              <button id="${ids.readingChatWebSearchPill}" type="button" class="chat-web-search-pill" title="联网搜索" aria-label="联网搜索" aria-pressed="false">
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path class="chat-web-search-meridian chat-web-search-meridian-a" d="M12 22C14.334 22 16.226 17.523 16.226 12C16.226 6.477 14.334 2 12 2"></path>
                  <path class="chat-web-search-meridian chat-web-search-meridian-b" d="M12 22C9.666 22 7.774 17.523 7.774 12C7.774 6.477 9.666 2 12 2"></path>
                  <path class="chat-web-search-meridian chat-web-search-meridian-c" d="M12 22C6.477 22 2 17.523 2 12C2 6.477 6.477 2 12 2"></path>
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M2.714 12h18.572"></path>
                </svg>
              </button>
              <div class="chat-model-anchor">
                <button id="${ids.readingChatModelChip}" type="button" class="chat-model-chip" aria-label="选择模型与思考档位" aria-haspopup="true" aria-controls="${ids.readingChatModelPanel}" aria-expanded="false">
                  <span class="chat-model-chip-model">未配置平台</span>
                  <span class="chat-model-chip-level">Off</span>
                  ${READING_CHEVRON_DOWN_ICON}
                </button>
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
              <button id="${ids.readingChatSendBtn}" type="button" class="${liveEnabled ? "chat-send-btn is-live" : "chat-send-btn"}" aria-label="${liveEnabled ? "开启实时伴看" : "发送"}"${liveEnabled ? ' title="开启实时伴看"' : " disabled"}>
                <svg class="chat-send-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M12 19V5"></path>
                  <path d="m5 12 7-7 7 7"></path>
                </svg>
                <svg class="chat-stop-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <rect class="chat-stop-icon-core" x="3.5" y="3.5" width="17" height="17" rx="4"></rect>
                </svg>
                <svg class="chat-live-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                  <line x1="12" y1="19" x2="12" y2="22"></line>
                </svg>
                <svg class="chat-spinner-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="40 16" stroke-linecap="round"></circle>
                </svg>
              </button>
            </div>
            <select id="${ids.readingChatModelSelect}" class="chat-model-select" aria-label="选择模型平台" hidden></select>
          </div>
        </footer>
      </div>
  `;
}
