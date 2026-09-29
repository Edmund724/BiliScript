// 字幕轨下拉的标签口径（2026-09 用户决议）：
//   - 选项文字 = 归一后的语言名 + `[AI]` 标（B 站 AI 轨的 lanDoc 自带
//     「（自动生成）」，与 [AI] 是同一个意思，不双标）；
//   - data-lang 仍是接口原文（切轨时按它写 selectedSubtitleLang——state 保持
//     接口数据，来源/语言的显示归一只在渲染层）；
//   - ASR 伪轨只有一项：显示「自配平台转写（中文）」，不再出现平台名。

import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;

function selectNode(): HTMLSelectElement {
  return document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement;
}

function optionTexts(): string[] {
  return [...selectNode().options].map((option) => option.textContent || "");
}

function optionLangs(): Array<string | undefined> {
  return [...selectNode().options].map((option) => option.dataset.lang);
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  mountReaderSkeleton(ids);
  mountPlayerChain();
});

describe("字幕轨下拉标签", () => {
  it("人工轨/人工英文轨：语言名原样；B站 AI 轨：语言名 + [AI]，不出现「（自动生成）」", () => {
    state.clip.setSubtitles([
      { id: "1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "u1" },
      { id: "2", lan: "ai-zh", lanDoc: "中文（自动生成）", subtitleUrl: "u2" },
      { id: "3", lan: "en", lanDoc: "英文", subtitleUrl: "u3" }
    ]);
    state.clip.setSelectedSubtitleId("2");
    state.clip.setSelectedSubtitleUrl("u2");
    state.clip.setSelectedSubtitleLang("中文（自动生成）");

    shell.renderReadingView();

    expect(optionTexts()).toEqual(["中文", "中文 [AI]", "英文"]);
    // data-lang 仍是接口原文：切轨写回 state 的值不受显示归一影响
    expect(optionLangs()).toEqual(["中文", "中文（自动生成）", "英文"]);
    expect(selectNode().selectedIndex).toBe(1);
    expect(selectNode().disabled).toBe(false);
  });

  it("ASR 伪轨：选项显示「自配平台转写（中文）」，无平台名", () => {
    state.clip.setSubtitles([
      { id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）", subtitleUrl: "" }
    ]);
    state.clip.setSelectedSubtitleId("asr");
    state.clip.setSelectedSubtitleUrl("");
    state.clip.setSelectedSubtitleLang("自配平台转写（中文）");

    shell.renderReadingView();

    expect(optionTexts()).toEqual(["自配平台转写（中文）"]);
    expect(optionTexts()[0]).not.toContain("SiliconFlow");
  });

  it("无字幕轨：保持「暂无字幕」占位且禁用", () => {
    state.clip.setSubtitles([]);

    shell.renderReadingView();

    expect(optionTexts()).toEqual(["暂无字幕"]);
    expect(selectNode().disabled).toBe(true);
  });
});
