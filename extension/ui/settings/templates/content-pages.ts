import { NOTE_PROMPT_PRESET_OPTIONS } from "../../../notes/note-prompts.js";
import { NOTE_TEMPLATE_VARIABLES_HELP } from "../../../notes/template-defaults.js";
import { SETTINGS_PANEL_DOM_IDS } from "../dom-ids.js";

export function buildContentPagesHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `    <div id="${ids.subpageAiPrompt}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="overview">
        <div class="biliscript-set-h">视频概览</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">进入视频自动生成概览</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.autoGenerateOverview}" type="checkbox" class="biliscript-toggle-input" aria-label="进入视频自动生成概览" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">AI 生成全片简介</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.overviewAiSummary}" type="checkbox" class="biliscript-toggle-input" aria-label="AI 生成全片简介" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">AI 生成章节与小结</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.overviewAiChapters}" type="checkbox" class="biliscript-toggle-input" aria-label="AI 生成章节与小结" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">AI 精选金句</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.overviewAiQuotes}" type="checkbox" class="biliscript-toggle-input" aria-label="AI 精选金句" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
        <p id="${ids.overviewShortcutHint}" class="biliscript-set-hint">快捷键 Alt+G 可随时展开并生成当前视频概览，可在设置「快捷键」中修改。</p>
      </section>

      <section class="biliscript-set-group" data-settings-section="system-prompt">
        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">系统提示词</div>
          <button id="${ids.aiSystemPromptResetBtn}" class="add-property-btn" type="button">恢复默认</button>
        </div>
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
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.playerAiActionMode}">点击动作</label>
            <select id="${ids.playerAiActionMode}" class="biliscript-set-select">
              <option value="summary">当场总结</option>
              <option value="note">生成视频笔记</option>
              <option value="overview">生成视频概览</option>
            </select>
          </div>
          <textarea
            id="${ids.playerAiQuickPrompt}"
            class="biliscript-set-textarea"
            placeholder="例如：整理这期视频的内容，输出结构化总结。"
          ></textarea>
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
              <option value="siliconflow-translate">SiliconFlow 硅基流动</option>
              <option value="custom">自定义 AI 平台</option>
            </select>
          </div>
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.subtitleTranslateModel}">翻译模型</label>
            <select id="${ids.subtitleTranslateModel}" class="biliscript-set-select">
              <option value="Index-Translate-35B-A3B">Index-Translate-35B-A3B</option>
            </select>
          </div>
          <div id="${ids.subtitleTranslateSiliconFlowKeyRow}" class="biliscript-set-row" hidden>
            <label class="biliscript-set-label" for="${ids.subtitleTranslateSiliconFlowKey}">硅基流动 Key</label>
            <div class="biliscript-set-inline-input">
              <input
                id="${ids.subtitleTranslateSiliconFlowKey}"
                class="biliscript-set-input"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="填写硅基流动 API Key"
              />
              <button id="${ids.subtitleTranslateSiliconFlowKeySaveBtn}" class="biliscript-reading-mini-btn" type="button">保存</button>
            </div>
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

    <div id="${ids.subpageNotes}" class="biliscript-settings-view" hidden>
      <section class="biliscript-set-group" data-settings-section="note-generation">
        <div class="biliscript-set-h">笔记生成</div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.notePromptPreset}">视频笔记预设</label>
            <select id="${ids.notePromptPreset}" class="biliscript-set-select">
              ${NOTE_PROMPT_PRESET_OPTIONS.map(
                (option) => `<option value="${option.value}">${option.label}</option>`
              ).join("")}
            </select>
          </div>

          <div class="biliscript-set-row biliscript-set-row-stack" hidden>
            <label class="biliscript-set-label" for="${ids.noteCustomPrompt}">自定义笔记提示词</label>
            <textarea
              id="${ids.noteCustomPrompt}"
              class="biliscript-set-textarea biliscript-note-custom-prompt-textarea"
              rows="4"
              placeholder="输入自定义视频笔记生成要求…"
            ></textarea>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">生成完成后自动导出笔记</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.playerAiAutoExportNote}" type="checkbox" class="biliscript-toggle-input" aria-label="生成完成后自动导出笔记" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>

          <div class="biliscript-set-check biliscript-toggle-row">
            <span class="biliscript-toggle-text">导出笔记内嵌关键画面截图</span>
            <label class="biliscript-toggle-switch">
              <input id="${ids.noteIncludeKeyframes}" type="checkbox" class="biliscript-toggle-input" aria-label="导出笔记内嵌关键画面截图" />
              <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </section>

      <section class="biliscript-set-group" data-settings-section="note-export">
        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">模板与导出</div>
          <button id="${ids.noteExportResetTemplateBtn}" class="add-property-btn" type="button">恢复默认模板</button>
        </div>
        <div class="biliscript-set-card">
          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.noteExportTarget}">笔记导出目标</label>
            <select id="${ids.noteExportTarget}" class="biliscript-set-select">
              <option value="download">下载本地 .md</option>
              <option value="obsidian">写入 Obsidian</option>
            </select>
          </div>

          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.noteDownloadSubdir}">下载子目录</label>
            <input
              id="${ids.noteDownloadSubdir}"
              class="biliscript-set-input biliscript-note-obsidian-input"
              type="text"
              spellcheck="false"
              placeholder="例如：BiliScript-Notes"
            />
          </div>

          <div class="biliscript-set-row" hidden>
            <label class="biliscript-set-label" for="${ids.obsidianVaultName}">Obsidian Vault</label>
            <input
              id="${ids.obsidianVaultName}"
              class="biliscript-set-input biliscript-note-obsidian-input"
              type="text"
              spellcheck="false"
              placeholder="留空写入默认库"
            />
          </div>

          <div class="biliscript-set-row" hidden>
            <label class="biliscript-set-label" for="${ids.obsidianFolder}">Obsidian 文件夹</label>
            <input
              id="${ids.obsidianFolder}"
              class="biliscript-set-input biliscript-note-obsidian-input"
              type="text"
              spellcheck="false"
              placeholder="例如：Clippings/Bilibili"
            />
          </div>

          <div class="biliscript-set-row biliscript-set-row-stack">
            <label class="biliscript-set-label" for="${ids.noteExportTemplate}">Markdown 导出模板</label>
            <textarea
              id="${ids.noteExportTemplate}"
              class="biliscript-set-textarea biliscript-note-template-textarea"
              rows="8"
              spellcheck="false"
              placeholder="${NOTE_TEMPLATE_VARIABLES_HELP}"
            ></textarea>
            <div class="biliscript-note-template-vars" aria-label="可用模板变量">
              ${NOTE_TEMPLATE_VARIABLES_HELP.split(" ")
                .map((token) => `<code>${token}</code>`)
                .join(" ")}
            </div>
          </div>
        </div>
      </section>
    </div>`;
}
