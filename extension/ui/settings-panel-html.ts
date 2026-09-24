// ui/settings-panel-html.ts — 设置抽屉的 HTML 模板（script-only-ui，2026-09 拆分）。
//
// 自 settings-panel.ts 拆出（大文件拆分工单）：settings-panel.ts 只留流程编排
//（模板挂载/装载/收集校验/保存/事件绑定/编辑 Modal 接线），模板字符串单独成
// 表——模板是纯 HTML 字符串零逻辑，不触碰任何状态，单独成模块后模板结构
//（分节、id、类名契约）与流程代码互不干扰，模板改动只落本文件。
// id 契约与原 options 页保持一致：settings-panel.ts 的 collectElements 按 id
// 取自宿主容器，options-rows / validators 的行级选择器直接复用；分节顺序即
// 抽屉内展示顺序（AI 模型平台 → 语音转写平台 → 搜索平台 → AI 按钮 → AI 对话 →
// 导出 → 保存行）。
// 样式：分区类名消费 reader-settings-*.css 设置分区表组（随 ui/settings-panel
// chunk 按需挂载，shared/style-injector 的 ensureReaderSettingsStyles）。

export function buildSettingsHtml(): string {
  return `
    <section class="biliscript-set-group">
      <div class="biliscript-set-h">AI 模型平台</div>
      <p class="biliscript-set-hint">支持 OpenAI 兼容协议（OpenAI / DeepSeek / Qwen / GLM / Kimi / MiniMax / Ollama 等）。在下方点击 + 添加平台，填写名称、API Base URL、API Key 与模型名称，点「测试」可验证连通性，点「保存」后才会写入设置。</p>
      <div id="aiProvidersList" class="ai-providers-list"></div>
      <p id="aiProvidersEmpty" class="ai-providers-empty">还没有配置平台，点击下方按钮添加。</p>
      <button id="addAiProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
    </section>

    <section class="biliscript-set-group">
      <div class="biliscript-set-h">语音转写平台</div>
      <p class="biliscript-set-hint">无字幕轨视频可通过语音识别自动生成字幕。当前选用平台将用于转写。</p>
      <div id="asrProvidersList" class="ai-providers-list"></div>
      <p id="asrProvidersEmpty" class="ai-providers-empty">还没有配置语音转写平台。点击下方添加按钮从预设创建，无字幕视频将无法自动生成字幕。</p>
      <button id="addAsrProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
      <label class="biliscript-set-check asr-fallback-checkbox">
        <input id="asrAutoFallback" type="checkbox" />
        无字幕时自动生成字幕
      </label>
    </section>

    <section class="biliscript-set-group">
      <div class="biliscript-set-h">搜索平台</div>
      <p class="biliscript-set-hint">AI 对话与选区解释可联网搜索视频内容之外的信息（function calling，由模型决定何时搜）。当前选用平台提供搜索结果。</p>
      <div id="searchProvidersList" class="ai-providers-list"></div>
      <p id="searchProvidersEmpty" class="ai-providers-empty">还没有配置搜索平台。点击下方添加按钮从预设创建（Tavily / Exa / Brave）。</p>
      <button id="addSearchProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
      <div class="biliscript-set-row">
        <label class="biliscript-set-label" for="webSearchMaxToolCalls">单轮搜索次数上限</label>
        <input id="webSearchMaxToolCalls" class="biliscript-set-input" type="number" min="1" max="10" step="1" />
      </div>
    </section>

    <section class="biliscript-set-group">
      <div class="biliscript-set-h">AI 按钮</div>
      <label class="biliscript-set-check">
        <input id="enablePlayerAiQuickAction" type="checkbox" />
        在视频播放器显示 AI 按钮，点击按照预设提示词调用 AI 对话，提示词可为空
      </label>
      <textarea
        id="playerAiQuickPrompt"
        class="biliscript-set-textarea"
        placeholder="例如：整理这期视频的内容，输出结构化总结。"
      ></textarea>
    </section>

    <section class="biliscript-set-group">
      <div class="biliscript-set-h">AI 对话 - 系统提示词</div>
      <textarea id="aiSystemPrompt" class="biliscript-set-textarea" placeholder="例如：回答尽量简洁；优先总结视频观点；必要时引用字幕原话。"></textarea>
    </section>

    <section class="biliscript-set-group">
      <div class="biliscript-set-h">AI 对话 - 初始问题</div>
      <p class="biliscript-set-hint">新视频没有历史对话时显示，最多 4 条，留空则不显示。</p>
      <div class="biliscript-set-quick-prompts">
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 1" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 2" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 3" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 4" />
      </div>
    </section>

    <section class="biliscript-set-group">
      <div class="biliscript-set-h">导出</div>
      <div class="biliscript-set-row">
        <label class="biliscript-set-label" for="downloadFormat">下载格式</label>
        <select id="downloadFormat" class="biliscript-set-select">
          <option value="srt">SRT</option>
          <option value="txt">TXT</option>
        </select>
      </div>
      <label class="biliscript-set-check">
        <input id="includeDateInFilename" type="checkbox" />
        文件名前包含导出日期
      </label>
      <label class="biliscript-set-check">
        <input id="includeTimestampInBody" type="checkbox" />
        在字幕正文中保留时间戳
      </label>
      <label class="biliscript-set-check">
        <input id="enableDebugLogs" type="checkbox" />
        启用调试日志（仅在排查问题时开启）
      </label>
    </section>

    <div class="biliscript-set-actions">
      <button id="biliscriptSettingsResetBtn" type="button" class="add-property-btn">恢复默认偏好</button>
      <button id="biliscriptSettingsSaveBtn" type="button" class="biliscript-set-save-btn">保存设置</button>
    </div>
    <p id="biliscriptSettingsStatus" class="biliscript-set-status"></p>
  `;
}
