import { describe, expect, it } from "vitest";
import {
  buildVideoNotePrompt,
  getNotePromptPresetLabel,
  NOTE_PROMPT_PRESET_OPTIONS
} from "../../extension/notes/note-prompts.js";

describe("notes/note-prompts 站点感知视频笔记提示词预设", () => {
  it("导出 5 项预设元数据与对应中文标签", () => {
    expect(NOTE_PROMPT_PRESET_OPTIONS.map((item) => item.value)).toEqual([
      "general",
      "tutorial",
      "course",
      "opinion",
      "custom"
    ]);
    expect(getNotePromptPresetLabel("general")).toBe("通用结构化");
    expect(getNotePromptPresetLabel("tutorial")).toBe("教程实操");
    expect(getNotePromptPresetLabel("course")).toBe("课程学习");
    expect(getNotePromptPresetLabel("opinion")).toBe("观点提炼");
    expect(getNotePromptPresetLabel("custom")).toBe("自定义");
    expect(getNotePromptPresetLabel("unknown-preset")).toBe("通用结构化");
  });

  it("4 套内置预设在 bilibili 站点输出各自结构化契约与 UP 主称呼", () => {
    const general = buildVideoNotePrompt({
      preset: "general",
      site: "bilibili",
      supportsHotComments: true,
      includeKeyframes: false
    });
    expect(general).toContain("一句话主旨");
    expect(general).toContain("逻辑脉络大纲");
    expect(general).toContain("[MM:SS]");
    expect(general).toContain("UP 主");
    expect(general).toContain("评论");
    expect(general).not.toContain("{{frame:");

    const tutorial = buildVideoNotePrompt({
      preset: "tutorial",
      site: "bilibili",
      supportsHotComments: false,
      includeKeyframes: false
    });
    expect(tutorial).toContain("目标产物");
    expect(tutorial).toContain("前置环境");
    expect(tutorial).toContain("分步操作");
    expect(tutorial).toContain("常见报错");
    expect(tutorial).toContain("UP 主");
    expect(tutorial).not.toContain("评论区");

    const course = buildVideoNotePrompt({
      preset: "course",
      site: "bilibili",
      supportsHotComments: false,
      includeKeyframes: false
    });
    expect(course).toContain("知识地图");
    expect(course).toContain("Mermaid");
    expect(course).toContain("LaTeX");
    expect(course).toContain("易混点");
    expect(course).toContain("3 道");

    const opinion = buildVideoNotePrompt({
      preset: "opinion",
      site: "bilibili",
      supportsHotComments: false,
      includeKeyframes: false
    });
    expect(opinion).toContain("核心论点");
    expect(opinion).toContain("论证链条");
    expect(opinion).toContain("隐含前提");
    expect(opinion).toContain("适用边界");
  });

  it("youtube 站点采用中性称呼，热评条款按 supportsHotComments 能力门控且绝不注入 B 站术语", () => {
    const withHotComments = buildVideoNotePrompt({
      preset: "general",
      site: "youtube",
      supportsHotComments: true,
      includeKeyframes: false
    });
    expect(withHotComments).toContain("YouTube 视频");
    expect(withHotComments).toContain("频道作者");
    expect(withHotComments).toContain("评论补充");
    expect(withHotComments).toContain("频道作者原片观点");
    expect(withHotComments).not.toContain("UP 主");
    expect(withHotComments).not.toContain("UP主");
    expect(withHotComments).not.toContain("B 站");
    expect(withHotComments).not.toContain("B站");

    const withoutHotComments = buildVideoNotePrompt({
      preset: "general",
      site: "youtube",
      supportsHotComments: false,
      includeKeyframes: false
    });
    expect(withoutHotComments).toContain("YouTube 视频");
    expect(withoutHotComments).toContain("频道作者");
    expect(withoutHotComments).not.toContain("评论补充");
    expect(withoutHotComments).not.toContain("UP 主");
    expect(withoutHotComments).not.toContain("B 站");
  });

  it("custom 预设优先使用非空自定义提示词，空白时回退 general", () => {
    const custom = buildVideoNotePrompt({
      preset: "custom",
      customPrompt: "请按「问题背景 / 实验方案 / 关键指标」三段式整理笔记。",
      site: "youtube",
      supportsHotComments: false,
      includeKeyframes: false
    });
    expect(custom).toContain("请按「问题背景 / 实验方案 / 关键指标」三段式整理笔记。");
    expect(custom).toContain("频道作者");
    expect(custom).not.toContain("一句话主旨");

    const fallback = buildVideoNotePrompt({
      preset: "custom",
      customPrompt: "   \n\t  ",
      site: "bilibili",
      supportsHotComments: false,
      includeKeyframes: false
    });
    expect(fallback).toContain("一句话主旨");
    expect(fallback).toContain("逻辑脉络大纲");
  });

  it("includeKeyframes 开启时追加最多 6 处的 {{frame:MM:SS | 画面简述}} 约束，关闭时不注入", () => {
    const withFrames = buildVideoNotePrompt({
      preset: "tutorial",
      site: "youtube",
      supportsHotComments: false,
      includeKeyframes: true
    });
    expect(withFrames).toContain("{{frame:MM:SS | 画面简述}}");
    expect(withFrames).toContain("6");
    expect(withFrames).toContain("架构图");
    expect(withFrames).toContain("独立成行");

    const withoutFrames = buildVideoNotePrompt({
      preset: "tutorial",
      site: "youtube",
      supportsHotComments: false,
      includeKeyframes: false
    });
    expect(withoutFrames).not.toContain("{{frame:");
  });
});
