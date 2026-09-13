// ui/settings-panel-html.ts — 设置抽屉的 HTML 模板（digest-only-ui，2026-09 拆分）。
//
// 自 settings-panel.ts 拆出（大文件拆分工单）：settings-panel.ts 只留流程编排
//（模板挂载/装载/收集校验/保存/事件绑定/编辑 Modal 接线），模板字符串单独成
// 表——模板是纯 HTML 字符串零逻辑，不触碰任何状态，单独成模块后模板结构
//（分节、id、类名契约）与流程代码互不干扰，模板改动只落本文件。
// id 契约与原 options 页保持一致：settings-panel.ts 的 collectElements 按 id
// 取自宿主容器，options-rows / validators 的行级选择器直接复用；分节顺序即
// 抽屉内展示顺序（AI 模型平台 → 语音转写平台 → 搜索平台 → AI 按钮 → AI 对话 →
// 导出 → 笔记属性 → 自定义属性 → 正文附加段落 → 保存行）。
// 样式：分区类名消费 reader-settings-*.css 设置分区表组（随 ui/settings-panel
// chunk 按需挂载，shared/style-injector 的 ensureReaderSettingsStyles）。

export function buildSettingsHtml(): string {
  return `
    <section class="boc-set-group">
      <div class="boc-set-h">AI 模型平台</div>
      <p class="boc-set-hint">支持 OpenAI 兼容协议（OpenAI / DeepSeek / Qwen / GLM / Kimi / MiniMax / Ollama 等）。在下方点击 + 添加平台，填写名称、API Base URL、API Key 与模型名称，点「测试」可验证连通性，点「保存」后才会写入设置。</p>
      <div id="aiProvidersList" class="ai-providers-list"></div>
      <p id="aiProvidersEmpty" class="ai-providers-empty">还没有配置平台，点击下方按钮添加。</p>
      <button id="addAiProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">语音转写平台</div>
      <p class="boc-set-hint">无字幕轨视频可通过语音识别自动生成字幕。当前选用平台将用于转写。</p>
      <div id="asrProvidersList" class="ai-providers-list"></div>
      <p id="asrProvidersEmpty" class="ai-providers-empty">还没有配置语音转写平台。点击下方添加按钮从预设创建，无字幕视频将无法自动生成字幕。</p>
      <button id="addAsrProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
      <label class="boc-set-check asr-fallback-checkbox">
        <input id="asrAutoFallback" type="checkbox" />
        无字幕时自动生成字幕
      </label>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">搜索平台</div>
      <p class="boc-set-hint">AI 对话与选区解释可联网搜索视频内容之外的信息（function calling，由模型决定何时搜）。当前选用平台提供搜索结果。</p>
      <div id="searchProvidersList" class="ai-providers-list"></div>
      <p id="searchProvidersEmpty" class="ai-providers-empty">还没有配置搜索平台。点击下方添加按钮从预设创建（Tavily / Exa / Brave）。</p>
      <button id="addSearchProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
      <div class="boc-set-row">
        <label class="boc-set-label" for="webSearchMaxToolCalls">单轮搜索次数上限</label>
        <input id="webSearchMaxToolCalls" class="boc-set-input" type="number" min="1" max="10" step="1" />
      </div>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">AI 按钮</div>
      <label class="boc-set-check">
        <input id="enablePlayerAiQuickAction" type="checkbox" />
        在视频播放器显示 AI 按钮，点击按照预设提示词调用 AI 对话，提示词可为空
      </label>
      <textarea
        id="playerAiQuickPrompt"
        class="boc-set-textarea"
        placeholder="例如：整理这期视频的内容，输出结构化总结。"
      ></textarea>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">AI 对话 - 系统提示词</div>
      <textarea id="aiSystemPrompt" class="boc-set-textarea" placeholder="例如：回答尽量简洁；优先总结视频观点；必要时引用字幕原话。"></textarea>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">AI 对话 - 初始问题</div>
      <p class="boc-set-hint">新视频没有历史对话时显示，最多 4 条，留空则不显示。</p>
      <div class="boc-set-quick-prompts">
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 1" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 2" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 3" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 4" />
      </div>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">导出</div>
      <div class="boc-set-row">
        <label class="boc-set-label" for="tags">默认标签（逗号分隔）</label>
        <input id="tags" class="boc-set-input" type="text" placeholder="例如：clippings,bilibili,subtitle" />
      </div>
      <div class="boc-set-row">
        <label class="boc-set-label" for="downloadFormat">下载格式</label>
        <select id="downloadFormat" class="boc-set-select">
          <option value="srt">SRT</option>
          <option value="txt">TXT</option>
        </select>
      </div>
      <label class="boc-set-check">
        <input id="includeDateInFilename" type="checkbox" />
        文件名前包含导出日期
      </label>
      <label class="boc-set-check">
        <input id="includeHotCommentsInNote" type="checkbox" />
        导出前 20 条热门评论
      </label>
      <label class="boc-set-check">
        <input id="includePlayerEmbedInNote" type="checkbox" />
        在笔记正文嵌入 B 站播放器（MarkText 等不渲染 iframe 的编辑器可关闭）
      </label>
      <label class="boc-set-check">
        <input id="includeTimestampInBody" type="checkbox" />
        在字幕正文中保留时间戳
      </label>
      <label class="boc-set-check">
        <input id="enableDebugLogs" type="checkbox" />
        启用调试日志（仅在排查问题时开启）
      </label>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">笔记属性（Frontmatter）</div>
      <p class="boc-set-hint">勾选需要写入到笔记属性区（Frontmatter）的字段。</p>
      <div class="boc-set-field-grid">
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="title" /> title</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="url" /> url</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="bvid" /> bvid</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="cid" /> cid</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="author" /> author</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="upload_date" /> upload_date</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="subtitle_lang" /> subtitle_lang</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="created" /> created</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="tags" /> tags</label>
      </div>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">自定义属性</div>
      <p class="boc-set-hint">支持默认属性的变量映射，比如 {{upload_date}}、{{created}}</p>
      <div id="fixedPropertiesList" class="fixed-properties-list"></div>
      <p id="fixedPropertiesEmpty" class="fixed-properties-empty">还没有自定义属性</p>
      <button id="addFixedPropertyBtn" class="add-property-btn" type="button">+ 添加属性</button>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">正文附加段落</div>
      <p class="boc-set-hint">在正文插入占位段落标题。默认结构：简介-章节-字幕；具体内容可留空。</p>
      <div id="noteSectionsList" class="note-sections-list"></div>
      <p id="noteSectionsEmpty" class="fixed-properties-empty">还没有正文附加段落</p>
      <button id="addNoteSectionBtn" class="add-property-btn" type="button">+ 添加段落</button>
    </section>

    <div class="boc-set-actions">
      <button id="bocSettingsResetBtn" type="button" class="add-property-btn">恢复默认偏好</button>
      <button id="bocSettingsSaveBtn" type="button" class="boc-set-save-btn">保存设置</button>
    </div>
    <p id="bocSettingsStatus" class="boc-set-status"></p>
  `;
}
