import { READING_HEADER_ICONS } from "../../reading-header-icons.js";
import { READING_RESET_ICON } from "../../reading-icons.js";
import {
  CHAT_DISPLAY_SLIDER_SPECS,
  type ChatDisplaySettingKey
} from "../../../reader/chat-display-settings.js";
import { SETTINGS_PANEL_DOM_IDS } from "../dom-ids.js";

export function buildSettingsChatDisplayRowHtml(
  key: ChatDisplaySettingKey,
  dom: { inputId: string; valueId: string; resetBtnId: string }
): string {
  const spec = CHAT_DISPLAY_SLIDER_SPECS[key];
  return `
          <div class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${dom.inputId}">${spec.label}</label>
            <div class="biliscript-slider-control">
              <input id="${dom.inputId}" type="range" class="biliscript-range-input" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.defaultValue}" style="--range-progress: ${spec.defaultProgressPct}%;" />
              <span id="${dom.valueId}" class="biliscript-slider-badge">${spec.format(spec.defaultValue)}</span>
              <button id="${dom.resetBtnId}" type="button" class="biliscript-slider-reset-btn" title="${spec.resetTitle}" aria-label="${spec.resetAriaLabel}">${READING_RESET_ICON}</button>
            </div>
          </div>`;
}

export const CHEVRON_RIGHT_SVG = `<svg class="biliscript-entry-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
export const EXTERNAL_LINK_SVG = `<svg class="biliscript-entry-chevron" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

export function buildSettingsNavBarHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `    <div class="biliscript-settings-nav-bar">
      <button id="${ids.readingSettingsBackBtn}" type="button" class="biliscript-reading-icon-btn biliscript-reading-settings-back-btn" title="返回" aria-label="返回">
        ${READING_HEADER_ICONS.back}
      </button>
      <span id="${ids.settingsTitle}" class="biliscript-settings-nav-title">设置</span>
    </div>`;
}

export function buildSettingsRootViewHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `    <div id="${ids.settingsRootView}" class="biliscript-settings-view">
      <section class="biliscript-set-group" data-settings-root-card="services">
        <div class="biliscript-set-h">模型与扩展服务</div>
        <div class="biliscript-set-card">
          <button id="${ids.openAiProvidersBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">AI 模型平台</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.aiProvidersSummary}" class="biliscript-entry-summary-text">未配置</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
          <button id="${ids.openLiveSettingsBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">实时伴看</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.liveSettingsSummary}" class="biliscript-entry-summary-text">未配置</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
          <button id="${ids.openAsrSettingsBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">语音转写</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.asrSettingsSummary}" class="biliscript-entry-summary-text">未配置</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
          <button id="${ids.openSearchSettingsBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">联网搜索</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.searchSettingsSummary}" class="biliscript-entry-summary-text">智能回退</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-root-card="content">
        <div class="biliscript-set-h">内容与阅读体验</div>
        <div class="biliscript-set-card">
          <button id="${ids.openAiPromptBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">AI 对话与快捷动作</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.aiPromptSummary}" class="biliscript-entry-summary-text"></span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
          <button id="${ids.openSubtitleSettingsBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">字幕翻译与导出</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.subtitleSettingsSummary}" class="biliscript-entry-summary-text">SRT</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-root-card="appearance">
        <div class="biliscript-set-h">外观与交互</div>
        <div class="biliscript-set-card">
          <button id="${ids.openAppearanceBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">阅读器与播放器</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.appearanceSettingsSummary}" class="biliscript-entry-summary-text">蓝雾玻璃 · 100% · 540px</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-root-card="system">
        <div class="biliscript-set-h">系统与连接</div>
        <div class="biliscript-set-card">
          <button id="${ids.openAgentSettingsBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">本地 Agent 连接</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.agentSettingsSummary}" class="biliscript-entry-summary-text">未启用</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
          <button id="${ids.openAdvancedSettingsBtn}" type="button" class="biliscript-set-row biliscript-entry-row">
            <span class="biliscript-set-label">高级设置</span>
            <span class="biliscript-entry-summary">
              <span id="${ids.advancedSettingsSummary}" class="biliscript-entry-summary-text">常规</span>
              ${CHEVRON_RIGHT_SVG}
            </span>
          </button>
          <button id="${ids.openOnboardingBtn}" type="button" class="biliscript-set-row biliscript-action-entry-row">
            <span class="biliscript-set-label">新手引导 / 快速上手</span>
            <span class="biliscript-entry-summary">
              <span class="biliscript-entry-summary-text">配置向导</span>
              ${EXTERNAL_LINK_SVG}
            </span>
          </button>
        </div>
      </section>
    </div>`;
}

export function buildSettingsActionsHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `    <div class="biliscript-set-actions">
      <p id="${ids.status}" class="biliscript-set-status" role="status" aria-live="polite"></p>
      <button id="${ids.resetBtn}" type="button" class="biliscript-set-reset-btn">恢复默认偏好</button>
    </div>`;
}
