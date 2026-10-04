// 字幕 tab 工具条（2026-10 用户决议）：工具条不再有「选语言」下拉。
//
// 症状背景（用户报障）：无 CC 轨视频走自配平台转写后，工具条下拉仍显示
// 「暂无字幕」。根因是下拉读 state.clip.subtitles，而 ASR 缓存命中收尾
//（刷新抓取/重开页面）只写正文与选中态、不塞 ASR 伪轨——正文已出、下拉停在
// 空态，同屏 meta 行「字幕：自配平台转写」靠 buildReadingSubtitlePart 的
// fallback 兜出，自相矛盾。决议：B站原生轨以中文为主，不需要手动选语言，
// 整条下拉删去；字幕来源/语言仍在 meta 行显示。本锁钉住删除不可回焊。
//
// 失败方式清单（删除引入的回归面）：
//   1. 模板/骨架残留 select → 断言 1；
//   2. 空字幕轨渲染又写出「暂无字幕」→ 断言 2；
//   3. ASR 落账无轨道时面板重现该串 → 断言 3；
//   4. 删除顺手带走工具条其余控件（搜索/复制/导出）→ 断言 1。

import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

// 已删除的下拉 id 以字面量锁死（ids 表也已删，不能经 ids 引用）。
const REMOVED_SUBTITLE_SELECT_ID = "biliscript-reading-subtitle-select";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;

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

function panelText(): string {
  return (document.getElementById(ids.readingView) as HTMLElement).textContent || "";
}

describe("字幕 tab 工具条：语言下拉已删除", () => {
  it("真实模板：工具条内无 select，旧 id 不存在，其余控件保留", async () => {
    const { buildUiHtml } = await import("../../extension/ui/ui-renderer.js");
    document.body.innerHTML = buildUiHtml();

    const toolbar = document.querySelector(".biliscript-reading-sub-toolbar") as HTMLElement;
    expect(toolbar).not.toBeNull();
    expect(toolbar.querySelector("select")).toBeNull();
    expect(document.getElementById(REMOVED_SUBTITLE_SELECT_ID)).toBeNull();
    // 删除只带走下拉：搜索框与复制/导出按钮照旧在工具条内
    expect(toolbar.querySelector(".biliscript-reading-search-input")).not.toBeNull();
    expect(toolbar.textContent).toContain("复制");
    expect(toolbar.textContent).toContain("导出");
  });

  it("空字幕轨渲染：面板内不出现「暂无字幕」，空态由字幕列表占位承担", () => {
    state.clip.setSubtitles([]);
    state.clip.setSubtitleBody([]);
    state.clip.setSubtitleFetchState("empty");
    state.clip.setNoSubtitleReason(null);

    shell.renderReadingView();

    expect(panelText()).not.toContain("暂无字幕");
    expect(document.getElementById(REMOVED_SUBTITLE_SELECT_ID)).toBeNull();
    expect((document.getElementById(ids.readingSubtitleList) as HTMLElement).textContent).toContain(
      "当前视频无字幕"
    );
  });

  it("转写落账但无轨道（ASR 缓存命中）：面板内同样不出现「暂无字幕」，正文照常显示", () => {
    state.clip.setAuthor("晓舟报告");
    state.clip.setSubtitles([]);
    state.clip.setSelectedSubtitleId("asr");
    state.clip.setSelectedSubtitleUrl("");
    state.clip.setSelectedSubtitleLang("自配平台转写（中文）");
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "缓存句" }]);
    state.clip.setSubtitleFetchState("ready");

    shell.renderReadingView();

    expect(panelText()).not.toContain("暂无字幕");
    // 2026-10-04 用户决议：meta 行不再注明字幕来源，面板里也不该再冒出「字幕：」。
    expect(panelText()).not.toContain("字幕：");
    expect((document.getElementById(ids.readingSubtitleList) as HTMLElement).textContent).toContain("缓存句");
  });
});
