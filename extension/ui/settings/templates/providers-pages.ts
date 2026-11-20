import { READING_RESET_ICON } from "../../reading-icons.js";
import { SETTINGS_PANEL_DOM_IDS } from "../dom-ids.js";

export function buildProvidersPagesHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `    <div id="${ids.subpageAiProviders}" class="biliscript-settings-view" hidden>
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
    </div>`;
}
