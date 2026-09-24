import { BILISCRIPT_VERSION } from "../core/defaults.js";
import { buildSubtitlePreview, buildTxt } from "../notes/render.js";
import { buildSubtitleOptionViews } from "./selection.js";
import { sanitizeFileName, escapeHtml } from "../shared/string-utils.js";
import { cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { normalizeDownloadFormat } from "../core/validators.js";
import { state } from "../core/state.js";
// 候选03 常驻瘦身：setMessage / setStatus 迁入 core/ui-status.js。
import { setMessage, setStatus } from "../core/ui-status.js";
// ids 为 reader 状态微模块（候选04 结构归并）：纯常量表，不经 reader/index.js
// facade 转发（否则总结链会静态拖起整个 reader 域）。
import { refreshDerivedContent, ensureDerivedContent } from "./core.js";

// ===== 链层交互（候选02 分层惰性：自 ui/ui-renderer.js 移入） =====
//
// copySubtitleTranscript / downloadSubtitle / buildClipSnapshotPayload 只服务
// 总结链与面板交互，留在 ui-renderer（常驻）会把它对 selection.js（isAiSubtitle）
// 及 cache/cache-lru 的依赖一并拖回常驻。
// setStatus/setMessage 仍在 core/ui-status：URL 变化编排与本模块错误提示在
// 启动期使用。
//（script-only-ui：经典侧栏面板删除后，renderMeta / renderSubtitleSelect /
// setBusyState 三件「抓取结果渲染」已无目标节点——阅读视图的元信息/字幕轨由
// reader 域的 renderReadingView/renderReadingSubtitleSelect 渲染，本节移除；
// 02 死代码清理：供经典面板「复制 Markdown」「字幕轨 <select> change」调用的
// copyMarkdown / onSubtitleChange 随面板退役后全仓零引用，一并移除。）

// 阅读模式字幕 tab 的「复制」（PR3 接线）：复制字幕纯文本——transcript 语义，
// 与 TXT 导出同一渲染管线（buildTxt，按 includeTimestampInBody 设置决定是否带
// 时间戳）；与「完整笔记」（clip.markdown，经导出/复制笔记入口消费）语义区分。
// 取数与反馈风格照抄下方 downloadSubtitle，逻辑零新增。
export async function copySubtitleTranscript(): Promise<void> {
  state.setSettings(await getSettings());
  const text = buildTxt(state.clip.subtitleBody, state.settings);
  if (!text) {
    setMessage("没有可复制的字幕，请先刷新抓取。");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setMessage("字幕已复制到剪贴板。");
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}

export async function downloadSubtitle(): Promise<void> {
  state.setSettings(await getSettings());
  // 懒生成（opt-backlog-2026-09/04）：首次消费时构建并缓存，命中即零开销。
  ensureDerivedContent();
  const format = normalizeDownloadFormat(state.settings?.downloadFormat);
  const content = format === "txt" ? state.clip.txt : state.clip.srt;
  if (!content) {
    setMessage("没有可下载的字幕，请先刷新抓取。");
    return;
  }

  const safeTitle = sanitizeFileName(state.clip.title || state.clip.bvid || "bilibili-subtitle");
  const langSuffix = sanitizeFileName(state.clip.selectedSubtitleLang || "subtitle") || "subtitle";
  const filename = `${safeTitle}.${langSuffix}.${format}`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setMessage(`已下载：${filename}`);
}

export function buildClipSnapshotPayload(): Record<string, unknown> {
  // 派生三件套懒生成后快照（opt-backlog-2026-09/04）：落账不再预建，读取前确保缓存。
  ensureDerivedContent();
  const subtitleOptions = buildSubtitleOptionViews(
    state.clip.subtitles,
    state.clip.selectedSubtitleId,
    state.clip.selectedSubtitleUrl
  );

  return {
    contentVersion: BILISCRIPT_VERSION,
    url: cleanVideoUrl(),
    title: state.clip.title || "",
    author: state.clip.author || "",
    uploadDate: state.clip.uploadDate || "",
    status: state.ui.statusText || "",
    message: state.ui.messageText || "",
    subtitlePreview: buildSubtitlePreview(state.clip.subtitleBody || [], state.settings || DEFAULT_SETTINGS),
    markdown: state.clip.markdown || "",
    srt: state.clip.srt || "",
    txt: state.clip.txt || "",
    downloadFormat: normalizeDownloadFormat(state.settings?.downloadFormat),
    subtitleOptions
  };
}

// applyNoSubtitleState 已迁入 subtitle/commit.js（commitNoSubtitle，无字幕出口
// 逆事务的唯一实现，CONTEXT.md「字幕接受」词条）——清空选中态/body/派生内容
// 与预览 DOM 属该事务，调用点（fetcher 的 finishNoSubtitle、asr/fallback 的
// 失败出口）一律改走 commit。
//
// readVideoDescription 已归位 subtitle/core.js（arch-slim-2/03，与
// readVideoTitle/readVideoAuthor/readUploadDate 同址；fetcher 直接从 core 取，
// 本模块不再承载 DOM 读取）。
