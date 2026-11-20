// extension/notes/template-defaults.ts
// 模板化笔记导出的默认模板与上限常量（零依赖纯数据叶，供 validators 与 template 共享）。

export const MAX_NOTE_EXPORT_TEMPLATE_BYTES = 4096;
export const MAX_OBSIDIAN_FIELD_LENGTH = 120;

export const NOTE_TEMPLATE_VARIABLES_HELP =
  "{{title}} {{bvid}} {{author}} {{url}} {{date}} {{summary}} {{chapters}} {{quotes}} {{notes}} {{subtitles}}";

export const DEFAULT_NOTE_TEMPLATE = `---
title: "{{title}}"
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
