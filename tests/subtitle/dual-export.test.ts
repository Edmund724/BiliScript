// 双语导出 / 复制的渲染与派生内容纪律（bilingual-subtitles/07 号票）。
//
// 07 的裁定（用户批准）：
//   ① TXT / Markdown：同段两行、**副行缩进两格**；SRT：**同一个 cue 两行**（不缩进——
//      SRT 的行首空白会被播放器渲染成字幕里的缩进，不是纯文本可读性标记）。
//   ② 副行**不带时间戳**（时间戳属于「段」不属于「行」）。
//   ③ 副轨未就绪 / 缺段 / 双语关 ⇒ 折叠，输出与单轨态**逐字相同**。
//   ④ 派生内容（clip.txt/srt/markdown）的失效：指纹**认副轨 body 引用**（口径重开——
//      原 05 号票裁定「指纹表不加副轨输入」，落地时发现只剩一个洞：开关打开后、副轨
//      body 到站前若已发生过一次消费，缓存命中会让后续导出永久停在单轨）。
//   ⑤ 复制按钮的文案 / 反馈不变（只改内容）。
//
// 先列系统可能怎么坏（再据此写用例）：
//   a. 双语关时三份导出有任何一个字节变化（含时间戳口径 / 空段过滤 / 章节分组）；
//   b. 副轨 loading / error / 空 body 时把占位或半截文本写进文件；
//   c. 缺段段位仍出副行（该折叠没折叠）；
//   d. 主轨一段对多条副轨时导出成两行（该按 04 的「空格拼接一行」）；
//   e. 副行带上时间戳（两行共用一个时间戳才是对的）；
//   f. 开关切换 / 副轨到站 / 清空副轨之后仍拿到旧派生文本（R4 那个洞）；
//   g. 章节分组被副行打乱（副行不能成为独立条目）。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { buildMarkdown } from "../../extension/notes/render.js";

const MAIN = [
  { from: 0, to: 10, content: "第一句话" },
  { from: 10, to: 30, content: "第二句话" }
];

// 副轨：一段覆盖两句主轨（03 号票真机事实里的「合并段」形态，188 vs 197）
const SECONDARY_MERGED = [{ from: 0, to: 30, content: "English merged" }];
// 副轨：只覆盖第一句 ⇒ 第二句缺段（折叠用例）
const SECONDARY_HALF = [{ from: 0, to: 10, content: "English first" }];
// 主轨一段 ↔ 副轨两段（空格拼接用例）
const MAIN_WIDE = [{ from: 0, to: 30, content: "整段一句话" }];
const SECONDARY_SPLIT = [
  { from: 0, to: 10, content: "Part A" },
  { from: 10, to: 30, content: "Part B" }
];

// 双语关的逐字锁（冻结字面量，不 echo 被测函数的输出）
const OFF_TXT = "0:00 第一句话\n0:10 第二句话";
const OFF_MD = "## 字幕\n\n`0:00` 第一句话\n`0:10` 第二句话";
const OFF_SRT = "1\n00:00:00,000 --> 00:00:10,000\n第一句话\n\n2\n00:00:10,000 --> 00:00:30,000\n第二句话";

let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let core: typeof import("../../extension/subtitle/core.js");
// 配对工厂必须走**动态**导入：它读 state，而 resetModuleState 会换掉模块实例，
// 静态 import 的那份会盯着旧的 state 单例（症状：派生路径正常、直测解析器却恒 null）。
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

    // 合并段：主轨两句共享同一句译文（04 的「重复但诚实」）
    expect(state.clip.txt).toBe("0:00 第一句话\n  English merged\n0:10 第二句话\n  English merged");
    // 副行不带时间戳：每一行「两个空格开头」的就是副行，且其中不含时刻文本
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

    // 标题后紧跟主行、副行跟在**它所属的主行**之后：一章两条，条目数不被副行放大
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
    // 开关已开、副轨还在飞：此刻消费一次 ⇒ 缓存落定（单轨内容，符合「只出已就绪的副轨」）
    core.ensureDerivedContent();
    expect(state.clip.txt).toBe(OFF_TXT);

    // 副轨到站（引用替换，settings 未变）
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
