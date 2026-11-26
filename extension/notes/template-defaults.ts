import { normalizeSiteId, type SiteId } from "../shared/site.js";

export const MAX_NOTE_EXPORT_TEMPLATE_BYTES = 4096;
export const MAX_OBSIDIAN_FIELD_LENGTH = 120;

export const NOTE_TEMPLATE_VARIABLES_HELP =
  "{{title}} {{videoId}} {{bvid}} {{site}} {{author}} {{url}} {{date}} {{summary}} {{ai_note}} {{chapters}} {{quotes}} {{notes}} {{subtitles}}";

export const DEFAULT_NOTE_TEMPLATE = `---
title: "{{title}}"
site: "{{site}}"
video_id: "{{videoId}}"
bvid: "{{bvid}}"
author: "{{author}}"
source: "{{url}}"
date: "{{date}}"
---

# {{title}}

- UP主：{{author}}
- 链接：{{url}}

{{#if summary}}
## 摘要

{{summary}}
{{/if}}

{{#if ai_note}}
## 视频笔记

{{ai_note}}
{{/if}}

{{#if chapters}}
## 章节

{{chapters}}
{{/if}}

{{#if quotes}}
## 金句

{{quotes}}
{{/if}}

{{#if notes}}
## 划词笔记

{{notes}}
{{/if}}`;

export const LEGACY_DEFAULT_NOTE_TEMPLATE = DEFAULT_NOTE_TEMPLATE
  .replace('\nsite: "{{site}}"\nvideo_id: "{{videoId}}"', "")
  .replace("\n\n{{#if ai_note}}\n## 视频笔记\n\n{{ai_note}}\n{{/if}}", "");

export const DEFAULT_YOUTUBE_NOTE_TEMPLATE = DEFAULT_NOTE_TEMPLATE
  .replace('\nvideo_id: "{{videoId}}"\nbvid: "{{bvid}}"', '\nvideoId: "{{videoId}}"')
  .replace("- UP主：{{author}}", "- 作者：{{author}}");

export function isDefaultNoteTemplate(template: unknown): boolean {
  const trimmed = String(template || "").replace(/\r\n?/g, "\n").trim();
  return (
    !trimmed ||
    trimmed === DEFAULT_NOTE_TEMPLATE.trim() ||
    trimmed === LEGACY_DEFAULT_NOTE_TEMPLATE.trim()
  );
}

export function getDefaultNoteTemplate(site: SiteId | unknown = "bilibili"): string {
  return normalizeSiteId(site) === "youtube" ? DEFAULT_YOUTUBE_NOTE_TEMPLATE : DEFAULT_NOTE_TEMPLATE;
}
