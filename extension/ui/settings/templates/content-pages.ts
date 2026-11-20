import { NOTE_TEMPLATE_VARIABLES_HELP } from "../../../notes/template-defaults.js";
import { SETTINGS_PANEL_DOM_IDS } from "../dom-ids.js";
import { buildSettingsChatDisplayRowHtml } from "./shell-and-root.js";

export function buildContentPagesHtml(): string {
  const ids = SETTINGS_PANEL_DOM_IDS;
  return `    <div id="${ids.subpageAiPrompt}" class="biliscript-settings-view" hidden>
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

      <section class="biliscript-set-group" data-settings-section="note-export">
        <div class="biliscript-set-header-row">
          <div class="biliscript-set-h">笔记模板与 Obsidian</div>
          <button id="${ids.noteExportResetTemplateBtn}" class="add-property-btn" type="button">恢复默认模板</button>
        </div>
        <div class="biliscript-set-card">
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
              <code>{{title}}</code> <code>{{bvid}}</code> <code>{{author}}</code> <code>{{url}}</code> <code>{{date}}</code> <code>{{summary}}</code> <code>{{chapters}}</code> <code>{{quotes}}</code> <code>{{notes}}</code> <code>{{subtitles}}</code>
            </div>
          </div>

          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.obsidianVaultName}">Obsidian Vault</label>
            <input
              id="${ids.obsidianVaultName}"
              class="biliscript-set-input biliscript-note-obsidian-input"
              type="text"
              spellcheck="false"
              placeholder="留空写入默认库"
            />
          </div>

          <div class="biliscript-set-row">
            <label class="biliscript-set-label" for="${ids.obsidianFolder}">Obsidian 文件夹</label>
            <input
              id="${ids.obsidianFolder}"
              class="biliscript-set-input biliscript-note-obsidian-input"
              type="text"
              spellcheck="false"
              placeholder="例如：Clippings/Bilibili"
            />
          </div>

          <div class="biliscript-set-row biliscript-note-export-actions">
            <button id="${ids.noteExportCopyBtn}" class="biliscript-reading-mini-btn" type="button">复制当前笔记</button>
            <button id="${ids.noteExportObsidianBtn}" class="biliscript-reading-mini-btn is-primary" type="button">写入 Obsidian</button>
          </div>
        </div>
      </section>
    </div>`;
}
