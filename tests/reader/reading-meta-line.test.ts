// 面板 header 元信息行（2026-09 用户决议）：
//   - 删除「bilibili.com」：面板本就长在 B 站页面上，域名零信息量；
//   - 作者加「UP主：」前缀，与同行的「字幕：中文」统一为「标签：值」口径；
//   - 分P 采用「P{n}：分P标题」（无标题时不落裸冒号）；
//   - 全部字段皆空时整块 hidden —— header 不留空行。只隐藏 meta 本体：
//     .biliscript-reading-header-copy 的「手动浏览中」::after 挂在它的父节点上
//     （reader-gate.css），隐藏父节点会把该标注一并吃掉。

import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;

function metaNode(): HTMLElement {
  return document.getElementById(ids.readingMeta) as HTMLElement;
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

describe("面板 header 元信息行", () => {
  it("作者/分P/字幕语言：UP主 与 P{n} 都带标签，且不含网址", () => {
    state.clip.setAuthor("硅谷101");
    state.clip.setPageCount(3);
    state.clip.setPageIndex(2);
    state.clip.setPageTitle("第二话");
    state.clip.setSelectedSubtitleLang("中文");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：硅谷101 · P2：第二话 · 字幕：中文");
    expect(metaNode().textContent).not.toContain("bilibili.com");
    expect(metaNode().hidden).toBe(false);
  });

  it("分P 无标题：只留 P{n}，不出现裸冒号", () => {
    state.clip.setPageCount(2);
    state.clip.setPageIndex(2);
    state.clip.setPageTitle("");
    state.clip.setSelectedSubtitleLang("中文");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("P2 · 字幕：中文");
  });

  it("单P（pageCount <= 1）：不显示分P", () => {
    state.clip.setAuthor("硅谷101");
    state.clip.setPageCount(1);
    state.clip.setPageIndex(1);
    state.clip.setPageTitle("唯一P");
    state.clip.setSelectedSubtitleLang("中文");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：硅谷101 · 字幕：中文");
  });

  it("无作者且无其余字段：整块 hidden（header 不留空行）", () => {
    state.clip.setAuthor("");
    state.clip.setSelectedSubtitleLang("");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("");
    expect(metaNode().hidden).toBe(true);
  });

  it("空态回到有内容：hidden 复位", () => {
    state.clip.setAuthor("");
    state.clip.setSelectedSubtitleLang("");
    shell.renderReadingView();

    state.clip.setAuthor("硅谷101");
    shell.renderReadingView();

    expect(metaNode().hidden).toBe(false);
    expect(metaNode().textContent).toBe("UP主：硅谷101");
  });

  it("真实模板初始态：meta 为空且 hidden（不再预置 bilibili.com）", async () => {
    const { buildUiHtml } = await import("../../extension/ui/ui-renderer.js");
    document.body.innerHTML = buildUiHtml();

    const templateMeta = document.getElementById(ids.readingMeta) as HTMLElement;
    expect(templateMeta.textContent).toBe("");
    expect(templateMeta.hidden).toBe(true);
    expect(buildUiHtml()).not.toContain("bilibili.com");
  });
});
