import { READING_RESET_ICON } from "./reading-icons.js";
// ui/settings-panel-html.ts — 设置抽屉的 HTML 模板（script-only-ui，2026-09 拆分）。
//
// 自 settings-panel.ts 拆出（大文件拆分工单）：settings-panel.ts 只留流程编排
//（模板挂载/装载/收集校验/保存/事件绑定/编辑 Modal 接线），模板字符串单独成
// 表——模板是纯 HTML 字符串零逻辑，不触碰任何状态，单独成模块后模板结构
//（分节、id、类名契约）与流程代码互不干扰，模板改动只落本文件。
// id 契约与原 options 页保持一致：settings-panel.ts 的 collectElements 按 id
// 取自宿主容器，provider-family / validators 的行级选择器直接复用；分节顺序即
// 抽屉内展示顺序（AI 模型平台 → 语音转写平台 → 搜索平台 → AI 按钮 →
// AI 对话 → 外观 → 导出 → 保存行）。
// id 单一声明在下方 SETTINGS_PANEL_DOM_IDS：本文件的模板属性与 settings-panel.ts
// collectElements 的查询 id 都从该表取值，改名单处生效。
// 样式：分区类名消费 reader-settings-*.css 设置分区表组（随 ui/settings-panel
// chunk 按需挂载，shared/style-injector 的 ensureReaderSettingsStyles）。6 个
// 布尔开关行（biliscript-toggle-row）的轨道/滑块样式走组件表
// styles/toggle-switch.css（ADR-0019，随 ui/toggle-switch.ts 挂载），id 与
// .checked 语义不变：装载/保存逻辑照读原生 input。

// 设置抽屉的 DOM id 词汇表：模板属性与收集器查询的共同声明。key = settings-panel.ts
// collectElements 元素袋的字段名（saveBtn / resetBtn / status 的 id 带
// biliscriptSettings 前缀，字段名不带）；value = 渲染进模板的 id。
export const SETTINGS_PANEL_DOM_IDS = {
  settingsNav: "biliscriptSettingsNav",
  aiProvidersList: "aiProvidersList",
  aiProvidersEmpty: "aiProvidersEmpty",
  addAiProviderBtn: "addAiProviderBtn",
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

  customPanelWidthContainer: "customPanelWidthContainer",
  customPanelWidth: "customPanelWidth",
  customPanelWidthValue: "customPanelWidthValue",
  customPanelWidthResetBtn: "customPanelWidthResetBtn",
  autoOpenReader: "autoOpenReader",
  downloadFormat: "downloadFormat",
  includeDateInFilename: "includeDateInFilename",
  includeTimestampInBody: "includeTimestampInBody",
  enableDebugLogs: "enableDebugLogs",
  status: "biliscriptSettingsStatus",
  resetBtn: "biliscriptSettingsResetBtn"
} as const;

/** 词表值域：settings-panel.ts 的 byIdIn 只接受本表声明的 id。 */
export type SettingsPanelDomId = (typeof SETTINGS_PANEL_DOM_IDS)[keyof typeof SETTINGS_PANEL_DOM_IDS];

export function buildSettingsHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `
    <nav id="${ids.settingsNav}" class="biliscript-settings-nav" aria-label="设置快速导航">
      <button type="button" class="biliscript-settings-nav-item is-active" data-section="llm">语言模型</button>
      <button type="button" class="biliscript-settings-nav-item" data-section="asr">语音转写</button>
      <button type="button" class="biliscript-settings-nav-item" data-section="search">搜索</button>
      <button type="button" class="biliscript-settings-nav-item" data-section="prompt">提示词</button>
      <button type="button" class="biliscript-settings-nav-item" data-section="appearance">外观</button>
      <button type="button" class="biliscript-settings-nav-item" data-section="export">导出</button>
      <span class="biliscript-settings-nav-indicator" aria-hidden="true"></span>
    </nav>

    <section class="biliscript-set-group" data-settings-section="llm">
      <div class="biliscript-set-h">AI 模型平台</div>
      <div id="${ids.aiProvidersList}" class="ai-providers-list"></div>
      <p id="${ids.aiProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
      <button id="${ids.addAiProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
    </section>

    <section class="biliscript-set-group" data-settings-section="asr">
      <div class="biliscript-set-h">语音转写平台</div>
      <div id="${ids.asrProvidersList}" class="ai-providers-list"></div>
      <p id="${ids.asrProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
      <button id="${ids.addAsrProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
      <div class="biliscript-set-check biliscript-toggle-row asr-fallback-checkbox">
        <span class="biliscript-toggle-text">无字幕时自动生成字幕</span>
        <label class="biliscript-toggle-switch">
          <input id="${ids.asrAutoFallback}" type="checkbox" class="biliscript-toggle-input" aria-label="无字幕时自动生成字幕" />
          <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
        </label>
      </div>
    </section>

    <section class="biliscript-set-group" data-settings-section="search">
      <div class="biliscript-set-h">搜索平台</div>
      <p id="${ids.searchProvidersDanglingHint}" class="biliscript-set-hint" hidden>原选用的平台已不可用，当前按默认顺序搜索</p>
      <div class="biliscript-set-check biliscript-toggle-row">
        <span class="biliscript-toggle-text">允许智能搜索使用付费平台</span>
        <label class="biliscript-toggle-switch">
          <input id="${ids.allowPaidSearchProviders}" type="checkbox" class="biliscript-toggle-input" aria-label="允许智能搜索使用付费平台" />
          <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
        </label>
      </div>
      <div id="${ids.searchProvidersList}" class="ai-providers-list"></div>
      <p id="${ids.searchProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
      <button id="${ids.addSearchProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
      <button id="${ids.resetSearchProviderOrderBtn}" class="add-property-btn" type="button">恢复默认顺序</button>
      <div id="${ids.webSearchMaxToolCallsContainer}" class="biliscript-set-row biliscript-slider-row">
        <div class="biliscript-slider-header">
          <label class="biliscript-set-label" for="${ids.webSearchMaxToolCalls}">单轮搜索次数上限</label>
          <div class="biliscript-slider-header-actions">
            <span id="${ids.webSearchMaxToolCallsValue}" class="biliscript-slider-badge">5</span>
            <button id="${ids.webSearchMaxToolCallsResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认搜索次数 (5)" aria-label="恢复默认搜索次数">${READING_RESET_ICON}</button>
          </div>
        </div>
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
        <div class="biliscript-slider-labels">
          <span>1</span>
          <span>20</span>
        </div>
      </div>
    </section>

    <section class="biliscript-set-group" data-settings-section="prompt">
      <div class="biliscript-set-h">AI 按钮</div>
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
    </section>

    <section class="biliscript-set-group" data-settings-section="prompt">
      <div class="biliscript-set-h">AI 对话 - 系统提示词</div>
      <textarea id="${ids.aiSystemPrompt}" class="biliscript-set-textarea" placeholder="例如：回答尽量简洁；优先总结视频观点；必要时引用字幕原话。"></textarea>
    </section>

    <section class="biliscript-set-group" data-settings-section="prompt">
      <div class="biliscript-set-h">AI 对话 - 初始问题</div>
      <div class="biliscript-set-quick-prompts">
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 1" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 2" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 3" />
      </div>
    </section>

    <section class="biliscript-set-group" data-settings-section="appearance">
      <div class="biliscript-set-h">外观与布局</div>
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
        <div class="biliscript-slider-header">
          <label class="biliscript-set-label" for="${ids.readerFontSizeScale}">文摘面板字体大小</label>
          <div class="biliscript-slider-header-actions">
            <span id="${ids.readerFontSizeScaleValue}" class="biliscript-slider-badge">100%</span>
            <button id="${ids.readerFontSizeScaleResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认字体大小 (100%)" aria-label="恢复默认字体大小">${READING_RESET_ICON}</button>
          </div>
        </div>
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
        <div class="biliscript-slider-labels">
          <span>小</span>
          <span>大</span>
        </div>
      </div>

      <div id="${ids.customPanelWidthContainer}" class="biliscript-set-row biliscript-slider-row">
        <div class="biliscript-slider-header">
          <label class="biliscript-set-label" for="${ids.customPanelWidth}">文摘面板宽度</label>
          <div class="biliscript-slider-header-actions">
            <span id="${ids.customPanelWidthValue}" class="biliscript-slider-badge">520px</span>
            <button id="${ids.customPanelWidthResetBtn}" type="button" class="biliscript-slider-reset-btn" title="恢复默认面板宽度 (520px)" aria-label="恢复默认面板宽度">${READING_RESET_ICON}</button>
          </div>
        </div>
        <input
          id="${ids.customPanelWidth}"
          type="range"
          class="biliscript-range-input"
          min="400"
          max="650"
          step="10"
          value="520"
          style="--range-progress: 48%;"
        />
        <div class="biliscript-slider-labels">
          <span>窄</span>
          <span>宽</span>
        </div>
      </div>
      <div class="biliscript-set-check biliscript-toggle-row">
        <span class="biliscript-toggle-text">进入视频页自动展开文摘面板</span>
        <label class="biliscript-toggle-switch">
          <input id="${ids.autoOpenReader}" type="checkbox" class="biliscript-toggle-input" aria-label="进入视频页自动展开文摘面板" />
          <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
        </label>
      </div>
    </section>

    <section class="biliscript-set-group" data-settings-section="export">
      <div class="biliscript-set-h">导出</div>
      <div class="biliscript-set-row">
        <label class="biliscript-set-label" for="${ids.downloadFormat}">下载格式</label>
        <select id="${ids.downloadFormat}" class="biliscript-set-select">
          <option value="srt">SRT</option>
          <option value="txt">TXT</option>
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
      <div class="biliscript-set-check biliscript-toggle-row">
        <span class="biliscript-toggle-text">启用调试日志</span>
        <label class="biliscript-toggle-switch">
          <input id="${ids.enableDebugLogs}" type="checkbox" class="biliscript-toggle-input" aria-label="启用调试日志" />
          <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
        </label>
      </div>
    </section>

    <div class="biliscript-set-actions">
      <p id="${ids.status}" class="biliscript-set-status"></p>
      <button id="${ids.resetBtn}" type="button" class="biliscript-set-reset-btn">恢复默认偏好</button>
    </div>
  `;
}
