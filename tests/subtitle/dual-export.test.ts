import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { buildMarkdown } from "../../extension/notes/render.js";

const MAIN = [
  { from: 0, to: 10, content: "第一句话" },
  { from: 10, to: 30, content: "第二句话" }
];

const SECONDARY_MERGED = [{ from: 0, to: 30, content: "English merged" }];
const SECONDARY_HALF = [{ from: 0, to: 10, content: "English first" }];
const MAIN_WIDE = [{ from: 0, to: 30, content: "整段一句话" }];
const SECONDARY_SPLIT = [
  { from: 0, to: 10, content: "Part A" },
  { from: 10, to: 30, content: "Part B" }
];

const OFF_TXT = "0:00 第一句话\n0:10 第二句话";
const OFF_MD = "## 字幕\n\n`0:00` 第一句话\n`0:10` 第二句话";
const OFF_SRT = "1\n00:00:00,000 --> 00:00:10,000\n第一句话\n\n2\n00:00:10,000 --> 00:00:30,000\n第二句话";

let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let core: typeof import("../../extension/subtitle/core.js");
let createSecondaryLineResolver: typeof import("../../extension/subtitle/alignment.js")["createSecondaryLineResolver"];

function seed(main: typeof MAIN, secondary: typeof SECONDARY_MERGED | null, bilingual: boolean) {
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: bilingual });
  clipState.setSubtitleBody(main as never);
  clipState.clearSecondarySubtitle();
  if (secondary) {
    clipState.applySecondarySubtitle({
      id: "sub-en",
      url: "https://sub/en.json",
      body: secondary as never
    });
  }
}

async function bootstrap() {
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  core = await import("../../extension/subtitle/core.js");
  createSecondaryLineResolver = (await import("../../extension/subtitle/alignment.js")).createSecondaryLineResolver;
}

beforeEach(async () => {
  resetModuleState();
  await bootstrap();
});

describe("双语关：三份导出逐字不变（差异锁）", () => {
  it("TXT / Markdown / SRT 与冻结的单轨字面量逐字节相同", () => {
    seed(MAIN, null, false);
    core.rebuildDerivedContent();

    expect(state.clip.txt).toBe(OFF_TXT);
    expect(state.clip.markdown).toBe(OFF_MD);
    expect(state.clip.srt).toBe(OFF_SRT);
  });

  it("双语关时副轨槽里即使有就绪的 body 也零参与", () => {
    seed(MAIN, SECONDARY_MERGED, false);
    core.rebuildDerivedContent();

    expect(state.clip.txt).toBe(OFF_TXT);
    expect(state.clip.srt).toBe(OFF_SRT);
    expect(state.clip.markdown).toBe(OFF_MD);
  });
});

describe("双语开：三份导出的两行形态", () => {
  it("TXT：副行紧随主行、缩进两格、不带时间戳", () => {
    seed(MAIN, SECONDARY_MERGED, true);
    core.rebuildDerivedContent();

    expect(state.clip.txt).toBe("0:00 第一句话\n  English merged\n0:10 第二句话\n  English merged");
    for (const line of state.clip.txt.split("\n").filter((text) => text.startsWith("  "))) {
      expect(line).not.toMatch(/\d+:\d{2}/);
    }
  });

  it("Markdown：字幕节里主行后接缩进副行", () => {
    seed(MAIN, SECONDARY_MERGED, true);
    core.rebuildDerivedContent();

    expect(state.clip.markdown).toBe(
      "## 字幕\n\n`0:00` 第一句话\n  English merged\n`0:10` 第二句话\n  English merged"
    );
  });

  it("Markdown：副行不成为独立条目（章节分组结构不被打破）", () => {
    seed(MAIN, SECONDARY_MERGED, true);
    const markdown = buildMarkdown(
      { chapters: [{ from: 0, to: 30, title: "第一章" }] } as never,
      MAIN as never,
      { ...DEFAULT_SETTINGS } as never,
      createSecondaryLineResolver()
    );

    const section = markdown.split("## 字幕")[1] || "";
    expect(section).toContain(
      "### 第一章 `0:00`\n\n`0:00` 第一句话\n  English merged\n`0:10` 第二句话\n  English merged"
    );
  });

  it("SRT：同一个 cue 两行、副行不缩进", () => {
    seed(MAIN, SECONDARY_MERGED, true);
    core.rebuildDerivedContent();

    expect(state.clip.srt).toBe(
      "1\n00:00:00,000 --> 00:00:10,000\n第一句话\nEnglish merged\n\n" +
        "2\n00:00:10,000 --> 00:00:30,000\n第二句话\nEnglish merged"
    );
  });

  it("一对多：主轨一段对副轨两段 ⇒ 空格拼接在**一行**（不是两行）", () => {
    seed(MAIN_WIDE, SECONDARY_SPLIT, true);
    core.rebuildDerivedContent();

    expect(state.clip.txt).toBe("0:00 整段一句话\n  Part A Part B");
    expect(state.clip.srt).toBe(
      "1\n00:00:00,000 --> 00:00:30,000\n整段一句话\nPart A Part B"
    );
  });

  it("缺段折叠：副轨没覆盖到的段位只有主行", () => {
    seed(MAIN, SECONDARY_HALF, true);
    core.rebuildDerivedContent();

    expect(state.clip.txt).toBe("0:00 第一句话\n  English first\n0:10 第二句话");
    expect(state.clip.srt).toBe(
      "1\n00:00:00,000 --> 00:00:10,000\n第一句话\nEnglish first\n\n" +
        "2\n00:00:10,000 --> 00:00:30,000\n第二句话"
    );
  });

  it("副轨未就绪（loading / error / 空）：三份与单轨逐字相同（不写占位）", () => {
    for (const prepare of [
      () => clipState.markSecondarySubtitleLoading({ id: "sub-en", url: "https://sub/en.json" }),
      () => {
        clipState.markSecondarySubtitleLoading({ id: "sub-en", url: "https://sub/en.json" });
        clipState.markSecondarySubtitleError();
      }
    ]) {
      seed(MAIN, null, true);
      prepare();
      core.rebuildDerivedContent();

      expect(state.clip.txt).toBe(OFF_TXT);
      expect(state.clip.srt).toBe(OFF_SRT);
      expect(state.clip.markdown).toBe(OFF_MD);
      expect(state.clip.txt).not.toContain("译文加载");
    }
  });
});

describe("派生内容的失效（R4：指纹认副轨 body 引用）", () => {
  it("副轨 body 到站后重算：先消费过的单轨缓存不再让导出停在单轨", () => {
    seed(MAIN, null, true);
    core.ensureDerivedContent();
    expect(state.clip.txt).toBe(OFF_TXT);

    clipState.applySecondarySubtitle({
      id: "sub-en",
      url: "https://sub/en.json",
      body: SECONDARY_MERGED as never
    });
    core.ensureDerivedContent();

    expect(state.clip.txt).toContain("English merged");
    expect(state.clip.srt).toContain("English merged");
  });

  it("开关切换后重算（settings 引用早已在指纹里）", () => {
    seed(MAIN, SECONDARY_MERGED, false);
    core.ensureDerivedContent();
    expect(state.clip.txt).toBe(OFF_TXT);

    state.setSettings({ ...state.settings, bilingualSubtitles: true });
    core.ensureDerivedContent();

    expect(state.clip.txt).toContain("English merged");
  });

  it("清空副轨后重算：回到单轨逐字相同", () => {
    seed(MAIN, SECONDARY_MERGED, true);
    core.ensureDerivedContent();
    expect(state.clip.txt).toContain("English merged");

    clipState.clearSecondarySubtitle();
    core.ensureDerivedContent();

    expect(state.clip.txt).toBe(OFF_TXT);
    expect(state.clip.srt).toBe(OFF_SRT);
  });
});
