import { READING_RESET_ICON } from "../../reading-icons.js";
import { renderUiIcon } from "../../icon-registry.js";
import { SETTINGS_PANEL_DOM_IDS } from "../dom-ids.js";
import { buildSettingsChatDisplayRowHtml, CHEVRON_RIGHT_SVG } from "./shell-and-root.js";

export function buildSystemPagesHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `    <div id="${ids.subpageAppearance}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="appearance">
        <div class="biliscript-set-h">外观与排版</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.readerTheme}">外观主题</label>
            <select id="${ids.readerTheme}" class="biliscript-set-select">
              <option value="bilibili">跟随当前站点</option>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>

          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.readerPalette}">外观色板</label>
            <select id="${ids.readerPalette}" class="biliscript-set-select">
              <option value="flyme">蓝雾玻璃</option>
              <option value="editorial">数字刊物</option>
            </select>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">AI 对话输入框光晕</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.chatInputGlow}" type="checkbox" class="biliscript-toggle-input" aria-label="AI 对话输入框光晕" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">减弱透明效果</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.reduceTransparency}" type="checkbox" class="biliscript-toggle-input" aria-label="减弱透明效果" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>

          <div id="${ids.readerFontSizeScaleContainer}" class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.readerFontSizeScale}">文摘面板字体大小</label>
            <div class="biliscript-slider-control">
              <input
                id="${ids.readerFontSizeScale}"
                type="range"
                class="biliscript-range-input"
                min="70"
                max="130"
                step="5"
                value="100"
                style="--range-progress: 50%;"
              />
              <span id="${ids.readerFontSizeScaleValue}" class="biliscript-slider-badge">100%</span>
              <button id="${ids.readerFontSizeScaleResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认字体大小 (100%)" aria-label="恢复默认字体大小">${READING_RESET_ICON}</button>
            </div>
          </div>

          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.detachedWindowMode}">独立窗口模式</label>
            <select id="${ids.detachedWindowMode}" class="biliscript-set-select">
              <option value="pip">置顶画中画</option>
              <option value="popup">普通窗口</option>
            </select>
          </div>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="chat-reading" data-settings-subgroup="chat" aria-labelledby="${ids.chatPreferencesHeading}">
        <div class="biliscript-set-header-row">
          <div id="${ids.chatPreferencesHeading}" class="biliscript-set-h">阅读与朗读</div>
        </div>
        <div class="biliscript-set-card">${buildSettingsChatDisplayRowHtml("chatLineHeight", {
          inputId: ids.chatLineHeight,
          valueId: ids.chatLineHeightValue,
          resetBtnId: ids.chatLineHeightResetBtn
        })}${buildSettingsChatDisplayRowHtml("chatParagraphSpacing", {
          inputId: ids.chatParagraphSpacing,
          valueId: ids.chatParagraphSpacingValue,
          resetBtnId: ids.chatParagraphSpacingResetBtn
        })}${buildSettingsChatDisplayRowHtml("speechVoiceVolume", {
          inputId: ids.speechVoiceVolume,
          valueId: ids.speechVoiceVolumeValue,
          resetBtnId: ids.speechVoiceVolumeResetBtn
        })}
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="player-behavior">
        <div class="biliscript-set-h">播放器交互</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">进入视频页自动展开文摘面板</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.autoOpenReader}" type="checkbox" class="biliscript-toggle-input" aria-label="进入视频页自动展开文摘面板" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row" data-settings-item="extra-playback-rates">
            <span class="biliscript-toggle-text">在视频控制栏显示 3x / 4x 倍速按钮</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.enableExtraPlaybackRates}" type="checkbox" class="biliscript-toggle-input" aria-label="在视频控制栏显示 3x / 4x 倍速按钮" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </section>
    </div>

    <div id="${ids.subpageAgent}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="agent">
        <div class="biliscript-set-card biliscript-agent-bridge-card">
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">启用本地 Agent 连接</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.enableAgentBridge}" type="checkbox" class="biliscript-toggle-input" aria-label="启用本地 Agent 连接" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
          <div class="biliscript-set-row biliscript-agent-bridge-connection">
            <span class="biliscript-agent-bridge-icon" aria-hidden="true">
              ${renderUiIcon("bridge", { size: 20 })}
            </span>
            <span class="biliscript-set-label biliscript-agent-bridge-connection-copy">连接状态</span>
            <button id="${ids.agentBridgeConnectBtn}" type="button" class="biliscript-agent-bridge-connect">去连接</button>
          </div>
          <button id="${ids.agentBridgeAddressBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">连接地址</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.agentBridgeAddressSummary}" class="biliscript-entry-summary-text"></span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
        </div>
      </section>
    </div>

    <div id="${ids.subpageAdvanced}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="advanced">
        <div class="biliscript-set-h">数据与诊断</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">自动清理 30 天以前的历史会话记录</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.cleanConversationsOlderThan30Days}" type="checkbox" class="biliscript-toggle-input" aria-label="自动清理 30 天以前的历史会话记录" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">启用调试日志</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.enableDebugLogs}" type="checkbox" class="biliscript-toggle-input" aria-label="启用调试日志" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </section>
    </div>

    <section id="${ids.agentBridgeAddressView}" class="biliscript-agent-bridge-address-view biliscript-settings-view" hidden>
      <div class="biliscript-set-card">
        <input id="${ids.agentBridgeUrl}" class="biliscript-set-input biliscript-agent-bridge-url" type="text" inputmode="url" spellcheck="false" aria-label="本地 Agent 连接地址" />
      </div>
      <p id="${ids.agentBridgeAddressStatus}" class="biliscript-set-status" role="status"></p>
      <div class="biliscript-agent-bridge-address-actions">
        <button id="${ids.agentBridgeResetUrlBtn}" type="button" class="biliscript-agent-bridge-secondary">恢复默认</button>
        <button id="${ids.agentBridgeTestBtn}" type="button" class="biliscript-agent-bridge-secondary">测试</button>
        <button id="${ids.agentBridgeSaveBtn}" type="button" class="biliscript-agent-bridge-primary">保存</button>
      </div>
    </section>`;
}
