import { sanitizeFileName } from "../shared/string-utils.js";

export function downloadChatAnswerMarkdown(content: string, videoTitle: string, answerNumber: number): string {
  const safeTitle = sanitizeFileName(videoTitle) || "BiliScript";
  const filename = `${safeTitle}-回答-${answerNumber}.md`;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return filename;
}
