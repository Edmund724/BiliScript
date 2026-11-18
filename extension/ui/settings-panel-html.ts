import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { READING_RESET_ICON } from "./reading-icons.js";
// ui/settings-panel-html.ts — 设置抽屉的三级总览+子页 HTML 模板。
//
// 结构约定：
//   - 顶部吸顶栏（.biliscript-settings-nav-bar）包含统一返回键（#biliscript-reading-settings-back-btn）
//     与当前页标题（#biliscriptSettingsTitle）；
//   - 一级总览（#biliscriptSettingsRootView）按 4 张卡片承载 9 个子页入口行及实时状态摘要；
//   - 二级子页（9 个 [hidden] 视图容器）按功能域分组承载具体表单控件与平台列表；
//   - 三级子页（#agentBridgeAddressView）承载本地 Agent 连接地址配置，复用顶部返回键与标题栏；
//   - 末尾动作栏（.biliscript-set-actions）保持为宿主末子节点，承载保存状态与总览重置按钮。
//
// 所有模板元素 id 与 for 引用统一声明于 SETTINGS_PANEL_DOM_IDS，由 settings-panel.ts 的
// collectElements() 严格一一对应收集。

const CHEVRON_RIGHT_SVG = `<svg class="biliscript-entry-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
const EXTERNAL_LINK_SVG = `<svg class="biliscript-entry-chevron" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

export const SETTINGS_PANEL_DOM_IDS = {
  readingSettingsBackBtn: "biliscript-reading-settings-back-btn",
  settingsTitle: "biliscriptSettingsTitle",
  settingsRootView: "biliscriptSettingsRootView",
  subpageAiProviders: "biliscriptSettingsSubpageAiProviders",
  subpageLive: "biliscriptSettingsSubpageLive",
  subpageAsr: "biliscriptSettingsSubpageAsr",
  subpageSearch: "biliscriptSettingsSubpageSearch",
  subpageAiPrompt: "biliscriptSettingsSubpageAiPrompt",
  subpageSubtitle: "biliscriptSettingsSubpageSubtitle",
  subpageAppearance: "biliscriptSettingsSubpageAppearance",
  subpageAgent: "biliscriptSettingsSubpageAgent",
  subpageAdvanced: "biliscriptSettingsSubpageAdvanced",
  openAiProvidersBtn: "openAiProvidersBtn",
  aiProvidersSummary: "aiProvidersSummary",
  openLiveSettingsBtn: "openLiveSettingsBtn",
  liveSettingsSummary: "liveSettingsSummary",
  openAsrSettingsBtn: "openAsrSettingsBtn",
  asrSettingsSummary: "asrSettingsSummary",
  openSearchSettingsBtn: "openSearchSettingsBtn",
  searchSettingsSummary: "searchSettingsSummary",
  openAiPromptBtn: "openAiPromptBtn",
  aiPromptSummary: "aiPromptSummary",
  openSubtitleSettingsBtn: "openSubtitleSettingsBtn",
  subtitleSettingsSummary: "subtitleSettingsSummary",
  openAppearanceBtn: "openAppearanceBtn",
  appearanceSettingsSummary: "appearanceSettingsSummary",
  openAgentSettingsBtn: "openAgentSettingsBtn",
  agentSettingsSummary: "agentSettingsSummary",
  openAdvancedSettingsBtn: "openAdvancedSettingsBtn",
  advancedSettingsSummary: "advancedSettingsSummary",
  openOnboardingBtn: "openOnboardingBtn",
  aiProvidersList: "aiProvidersList",
  aiProvidersEmpty: "aiProvidersEmpty",
  addAiProviderBtn: "addAiProviderBtn",
  aiDefaultModel: "aiDefaultModel",
  liveSettingsHeader: "biliscript-live-settings",
  liveProvidersList: "liveProvidersList",
  liveProvidersEmpty: "liveProvidersEmpty",
  liveVoiceFallbackHint: "liveVoiceFallbackHint",
  addLiveProviderBtn: "addLiveProviderBtn",
  liveLowBandwidth: "liveLowBandwidth",
  liveVoiceVolume: "liveVoiceVolume",
  liveVoiceVolumeValue: "liveVoiceVolumeValue",
  liveVoiceVolumeResetBtn: "liveVoiceVolumeResetBtn",
  liveVoiceSpeed: "liveVoiceSpeed",
  liveVoiceSpeedValue: "liveVoiceSpeedValue",
  liveVoiceSpeedResetBtn: "liveVoiceSpeedResetBtn",
  liveShareVideoAudio: "liveShareVideoAudio",
  liveVoicePriority: "liveVoicePriority",
  subtitleTranslateSource: "subtitleTranslateSource",
  subtitleTranslateModel: "subtitleTranslateModel",
  subtitleTranslateGlossary: "subtitleTranslateGlossary",
  bilingualDisplayOrder: "bilingualDisplayOrder",
  subtitleSegmentationStrategy: "subtitleSegmentationStrategy",
  asrProvidersList: "asrProvidersList",
  asrProvidersEmpty: "asrProvidersEmpty",
  addAsrProviderBtn: "addAsrProviderBtn",
  asrAutoFallback: "asrAutoFallback",
  searchProvidersDanglingHint: "searchProvidersDanglingHint",
  searchProvidersList: "searchProvidersList",
  searchProvidersEmpty: "searchProvidersEmpty",
  addSearchProviderBtn: "addSearchProviderBtn",
  resetSearchProviderOrderBtn: "resetSearchProviderOrderBtn",
  allowPaidSearchProviders: "allowPaidSearchProviders",
  webSearchMaxToolCallsContainer: "webSearchMaxToolCallsContainer",
  webSearchMaxToolCalls: "webSearchMaxToolCalls",
  webSearchMaxToolCallsValue: "webSearchMaxToolCallsValue",
  webSearchMaxToolCallsResetBtn: "webSearchMaxToolCallsResetBtn",
  enablePlayerAiQuickAction: "enablePlayerAiQuickAction",
  playerAiQuickPrompt: "playerAiQuickPrompt",
  aiSystemPrompt: "aiSystemPrompt",
  readerPalette: "readerPalette",
  chatInputGlow: "chatInputGlow",
  readerFontSizeScaleContainer: "readerFontSizeScaleContainer",
  readerFontSizeScale: "readerFontSizeScale",
  readerFontSizeScaleValue: "readerFontSizeScaleValue",
  readerFontSizeScaleResetBtn: "readerFontSizeScaleResetBtn",
  chatPreferencesHeading: "chatPreferencesHeading",
  chatLineHeight: "chatLineHeight",
  chatLineHeightValue: "chatLineHeightValue",
  chatLineHeightResetBtn: "chatLineHeightResetBtn",
  chatParagraphSpacing: "chatParagraphSpacing",
  chatParagraphSpacingValue: "chatParagraphSpacingValue",
  chatParagraphSpacingResetBtn: "chatParagraphSpacingResetBtn",
  speechVoiceVolume: "speechVoiceVolume",
  speechVoiceVolumeValue: "speechVoiceVolumeValue",
  speechVoiceVolumeResetBtn: "speechVoiceVolumeResetBtn",
  customPanelWidthContainer: "customPanelWidthContainer",
  customPanelWidth: "customPanelWidth",
  customPanelWidthValue: "customPanelWidthValue",
  customPanelWidthResetBtn: "customPanelWidthResetBtn",
  autoOpenReader: "autoOpenReader",
  enableExtraPlaybackRates: "enableExtraPlaybackRates",
  downloadFormat: "downloadFormat",
  includeDateInFilename: "includeDateInFilename",
  includeTimestampInBody: "includeTimestampInBody",
  enableDebugLogs: "enableDebugLogs",
  enableAgentBridge: "enableAgentBridge",
  agentBridgeConnectBtn: "agentBridgeConnectBtn",
  agentBridgeAddressBtn: "agentBridgeAddressBtn",
  agentBridgeAddressSummary: "agentBridgeAddressSummary",
  agentBridgeAddressView: "agentBridgeAddressView",
  agentBridgeUrl: "agentBridgeUrl",
  agentBridgeResetUrlBtn: "agentBridgeResetUrlBtn",
  agentBridgeTestBtn: "agentBridgeTestBtn",
  agentBridgeSaveBtn: "agentBridgeSaveBtn",
  agentBridgeAddressStatus: "agentBridgeAddressStatus",
  cleanConversationsOlderThan30Days: "cleanConversationsOlderThan30Days",
  status: "biliscriptSettingsStatus",
  resetBtn: "biliscriptSettingsResetBtn"
} as const;

export type SettingsPanelDomId = (typeof SETTINGS_PANEL_DOM_IDS)[keyof typeof SETTINGS_PANEL_DOM_IDS];

export function buildSettingsHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `
    <div class="biliscript-settings-nav-bar">
      <button id="${ids.readingSettingsBackBtn}" type="button" class="biliscript-reading-icon-btn biliscript-reading-settings-back-btn" title="返回" aria-label="返回">
        ${READING_HEADER_ICONS.back}
      </button>
      <span id="${ids.settingsTitle}" class="biliscript-settings-nav-title">设置</span>
    </div>

    <div id="${ids.settingsRootView}" class="biliscript-settings-view">
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
    </div>

    <div id="${ids.subpageAiProviders}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="llm">
        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">已配置平台</div>
          <button id="${ids.addAiProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
        </div>
        <div class="biliscript-set-card biliscript-provider-group">
          <div id="${ids.aiProvidersList}" class="ai-providers-list"></div>
          <p id="${ids.aiProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
        </div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.aiDefaultModel}">概览与解释模型</label>
            <select id="${ids.aiDefaultModel}" class="biliscript-set-select">
              <option value="">暂无可用模型</option>
            </select>
          </div>
        </div>
      </section>
    </div>

    <div id="${ids.subpageLive}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="live">
        <div id="${ids.liveSettingsHeader}" class="biliscript-set-header-row">
          <div class="biliscript-set-h">实时伴看平台</div>
          <button id="${ids.addLiveProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
        </div>
        <div class="biliscript-set-card biliscript-provider-group">
          <div id="${ids.liveProvidersList}" class="ai-providers-list"></div>
          <p id="${ids.liveProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">低带宽画面采集</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.liveLowBandwidth}" type="checkbox" class="biliscript-toggle-input" aria-label="低带宽画面采集" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="live-audio">
        <div class="biliscript-set-h">伴看语音与混音</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.liveVoiceVolume}">伴看音量</label>
            <div class="biliscript-slider-control">
              <input id="${ids.liveVoiceVolume}" type="range" class="biliscript-range-input" min="0" max="200" step="1" value="100" style="--range-progress: 50%;" />
              <span id="${ids.liveVoiceVolumeValue}" class="biliscript-slider-badge">100%</span>
              <button id="${ids.liveVoiceVolumeResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认伴看音量 (100%)" aria-label="恢复默认伴看音量">${READING_RESET_ICON}</button>
            </div>
          </div>
          <div class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.liveVoiceSpeed}">伴看语速</label>
            <div class="biliscript-slider-control">
              <input id="${ids.liveVoiceSpeed}" type="range" class="biliscript-range-input" min="0.5" max="1.5" step="0.25" value="1" style="--range-progress: 50%;" />
              <span id="${ids.liveVoiceSpeedValue}" class="biliscript-slider-badge">1×</span>
              <button id="${ids.liveVoiceSpeedResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认伴看语速 (1×)" aria-label="恢复默认伴看语速">${READING_RESET_ICON}</button>
            </div>
          </div>
          <div class="biliscript-set-check biliscript-toggle-row" title="让 AI 同时听到视频原声与你的麦克风声音">
            <span class="biliscript-toggle-text">分享视频声音</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.liveShareVideoAudio}" type="checkbox" class="biliscript-toggle-input" aria-label="分享视频声音" aria-description="让 AI 同时听到视频原声与你的麦克风声音" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
          <div class="biliscript-set-check biliscript-toggle-row" title="你说话或 AI 播报时降低视频音量，结束后恢复">
            <span class="biliscript-toggle-text">语音优先</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.liveVoicePriority}" type="checkbox" class="biliscript-toggle-input" aria-label="语音优先" aria-description="你说话或 AI 播报时降低视频音量，结束后恢复" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
        <p id="${ids.liveVoiceFallbackHint}" class="biliscript-set-hint" hidden></p>
      </section>
    </div>

    <div id="${ids.subpageAsr}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="asr">
        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">语音转写平台</div>
          <button id="${ids.addAsrProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
        </div>
        <div class="biliscript-set-card biliscript-provider-group">
          <div id="${ids.asrProvidersList}" class="ai-providers-list"></div>
          <p id="${ids.asrProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
          <div class="biliscript-set-check biliscript-toggle-row asr-fallback-checkbox">
            <span class="biliscript-toggle-text">无字幕时自动生成字幕</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.asrAutoFallback}" type="checkbox" class="biliscript-toggle-input" aria-label="无字幕时自动生成字幕" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </section>
    </div>

    <div id="${ids.subpageSearch}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="search">
        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">搜索平台</div>
          <button id="${ids.addSearchProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
        </div>
        <div class="biliscript-set-card biliscript-provider-group">
          <p class="biliscript-set-hint search-chain-mode-note" hidden>已单选平台：只使用选中的平台搜索，失败不会切换到其他平台。</p>
          <p id="${ids.searchProvidersDanglingHint}" class="biliscript-set-hint" hidden>原选用的平台已不可用，当前按默认顺序搜索</p>
          <div id="${ids.searchProvidersList}" class="ai-providers-list"></div>
          <p id="${ids.searchProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
          <div class="search-chain-footer-bar">
            <button id="${ids.resetSearchProviderOrderBtn}" class="add-property-btn" type="button">恢复默认顺序</button>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">允许智能搜索使用付费平台</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.allowPaidSearchProviders}" type="checkbox" class="biliscript-toggle-input" aria-label="允许智能搜索使用付费平台" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>

          <div id="${ids.webSearchMaxToolCallsContainer}" class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.webSearchMaxToolCalls}">单轮搜索次数上限</label>
            <div class="biliscript-slider-control">
              <input
                id="${ids.webSearchMaxToolCalls}"
                type="range"
                class="biliscript-range-input"
                min="1"
                max="20"
                step="1"
                value="5"
                style="--range-progress: 21.05%;"
              />
              <span id="${ids.webSearchMaxToolCallsValue}" class="biliscript-slider-badge">5</span>
              <button id="${ids.webSearchMaxToolCallsResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认搜索次数 (5)" aria-label="恢复默认搜索次数">${READING_RESET_ICON}</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div id="${ids.subpageAiPrompt}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="system-prompt">
        <div class="biliscript-set-h">系统提示词</div>
        <div class="biliscript-set-card">
          <textarea id="${ids.aiSystemPrompt}" class="biliscript-set-textarea" placeholder="例如：回答尽量简洁；优先总结视频观点；必要时引用字幕原话。"></textarea>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="initial-prompt">
        <div class="biliscript-set-h">对话快捷问题</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-quick-prompts">
            <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 1" />
            <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 2" />
            <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 3" />
          </div>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="ai-button">
        <div class="biliscript-set-h">播放器快捷按钮</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">在视频播放器显示 AI 按钮</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.enablePlayerAiQuickAction}" type="checkbox" class="biliscript-toggle-input" aria-label="在视频播放器显示 AI 按钮" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
          <textarea
            id="${ids.playerAiQuickPrompt}"
            class="biliscript-set-textarea"
            placeholder="例如：整理这期视频的内容，输出结构化总结。"
          ></textarea>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="chat-reading" data-settings-subgroup="chat" aria-labelledby="${ids.chatPreferencesHeading}">
        <div class="biliscript-set-header-row">
          <div id="${ids.chatPreferencesHeading}" class="biliscript-set-h">阅读与朗读</div>
        </div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.chatLineHeight}">对话行高</label>
            <div class="biliscript-slider-control">
              <input id="${ids.chatLineHeight}" type="range" class="biliscript-range-input" min="120" max="200" step="5" value="160" style="--range-progress: 50%;" />
              <span id="${ids.chatLineHeightValue}" class="biliscript-slider-badge">160%</span>
              <button id="${ids.chatLineHeightResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认对话行高 (160%)" aria-label="恢复默认对话行高">${READING_RESET_ICON}</button>
            </div>
          </div>
          <div class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.chatParagraphSpacing}">对话段落间距</label>
            <div class="biliscript-slider-control">
              <input id="${ids.chatParagraphSpacing}" type="range" class="biliscript-range-input" min="4" max="20" step="2" value="12" style="--range-progress: 50%;" />
              <span id="${ids.chatParagraphSpacingValue}" class="biliscript-slider-badge">12px</span>
              <button id="${ids.chatParagraphSpacingResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认对话段落间距 (12px)" aria-label="恢复默认对话段落间距">${READING_RESET_ICON}</button>
            </div>
          </div>
          <div class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.speechVoiceVolume}">对话朗读音量</label>
            <div class="biliscript-slider-control">
              <input id="${ids.speechVoiceVolume}" type="range" class="biliscript-range-input" min="0" max="100" step="1" value="100" style="--range-progress: 100%;" />
              <span id="${ids.speechVoiceVolumeValue}" class="biliscript-slider-badge">100%</span>
              <button id="${ids.speechVoiceVolumeResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认对话朗读音量 (100%)" aria-label="恢复默认对话朗读音量">${READING_RESET_ICON}</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div id="${ids.subpageSubtitle}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="segmentation">
        <div class="biliscript-set-h">字幕断句</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.subtitleSegmentationStrategy}">断句策略</label>
            <select id="${ids.subtitleSegmentationStrategy}" class="biliscript-set-select">
              <option value="auto">智能识别（AI / 语音转写）</option>
              <option value="rule">规则重断句</option>
              <option value="stats">统计分布断句</option>
              <option value="off">关闭</option>
            </select>
          </div>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="subtitle">
        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">字幕翻译</div>
        </div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.subtitleTranslateSource}">翻译来源</label>
            <select id="${ids.subtitleTranslateSource}" class="biliscript-set-select">
              <option value="bilibili-index-translate">Index-Translate（免 Key）</option>
              <option value="custom">自定义 AI 平台</option>
            </select>
          </div>
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.subtitleTranslateModel}">翻译模型</label>
            <select id="${ids.subtitleTranslateModel}" class="biliscript-set-select">
              <option value="Index-Translate-35B-A3B">Index-Translate-35B-A3B</option>
            </select>
          </div>
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.bilingualDisplayOrder}">双语上下顺序</label>
            <select id="${ids.bilingualDisplayOrder}" class="biliscript-set-select">
              <option value="original-first">主轨/原文在上</option>
              <option value="translation-first">副轨/译文在上</option>
            </select>
          </div>
          <div class="biliscript-set-row biliscript-set-row-stack">
            <label class="biliscript-set-label" for="${ids.subtitleTranslateGlossary}">术语对照表</label>
            <textarea
              id="${ids.subtitleTranslateGlossary}"
              class="biliscript-set-textarea"
              rows="4"
              spellcheck="false"
              placeholder="每行一条：原文 = 译文（译文留空则强制保留原词）&#10;CUDA = CUDA&#10;Warp Scheduler = 线程束调度器&#10;Tensor Core ="
            ></textarea>
          </div>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="export">
        <div class="biliscript-set-h">字幕导出</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.downloadFormat}">下载格式</label>
            <select id="${ids.downloadFormat}" class="biliscript-set-select">
              <option value="srt">SRT</option>
              <option value="txt">TXT</option>
              <option value="vtt">VTT</option>
              <option value="vtt-secondary">VTT（仅副轨）</option>
            </select>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">导出文件名包含日期</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.includeDateInFilename}" type="checkbox" class="biliscript-toggle-input" aria-label="导出文件名包含日期" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">在字幕正文中保留时间戳</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.includeTimestampInBody}" type="checkbox" class="biliscript-toggle-input" aria-label="在字幕正文中保留时间戳" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </section>
    </div>

    <div id="${ids.subpageAppearance}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="appearance">
        <div class="biliscript-set-h">外观与排版</div>
        <div class="biliscript-set-card">
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

          <div id="${ids.customPanelWidthContainer}" class="biliscript-set-row biliscript-slider-row">
            <label class="biliscript-set-label" for="${ids.customPanelWidth}">文摘面板宽度</label>
            <div class="biliscript-slider-control">
              <input
                id="${ids.customPanelWidth}"
                type="range"
                class="biliscript-range-input"
                min="400"
                max="650"
                step="10"
                value="540"
                style="--range-progress: 56%;"
              />
              <span id="${ids.customPanelWidthValue}" class="biliscript-slider-badge">540px</span>
              <button id="${ids.customPanelWidthResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认面板宽度 (540px)" aria-label="恢复默认面板宽度">${READING_RESET_ICON}</button>
            </div>
          </div>
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

          <div class="biliscript-set-check biliscript-toggle-row">
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
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12 4 17m0 0v-5m0 5h5M15 12l5-5m0 0v5m0-5h-5"/></svg>
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
    </section>

    <div class="biliscript-set-actions">
      <p id="${ids.status}" class="biliscript-set-status" role="status" aria-live="polite"></p>
      <button id="${ids.resetBtn}" type="button" class="biliscript-set-reset-btn">恢复默认偏好</button>
    </div>
  `;
}
