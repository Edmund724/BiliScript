import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { clipState, state } from "../../extension/core/state.js";
import { YOUTUBE_UNIT_CID, encodeVideoStorageBvid } from "../../extension/shared/site.js";
import {
  NOTE_HIGHLIGHTS_STORAGE_KEY,
  addVideoHighlight,
  loadVideoHighlights,
  resetHighlightMemoryStoreForTests,
  resolveHighlightVideoKey
} from "../../extension/notes/highlights-store.js";
import {
  currentHighlightVideoKey,
  getCachedHighlightVideoKey,
  refreshSubtitleHighlightsFromStore,
  removeSubtitleItemHighlight
} from "../../extension/reader/subtitle-highlights-ui.js";
import {
  DEFAULT_NOTE_TEMPLATE,
  DEFAULT_YOUTUBE_NOTE_TEMPLATE,
  NOTE_TEMPLATE_VARIABLES_HELP
} from "../../extension/notes/template-defaults.js";
import {
  buildNoteTemplateVariables,
  renderNoteTemplate
} from "../../extension/notes/template.js";
import { renderCurrentVideoNote } from "../../extension/notes/export-actions.js";
import { buildMarkdown, buildSrt, buildTxt } from "../../extension/notes/render.js";
import { createSecondaryLineResolver } from "../../extension/subtitle/alignment.js";

const YT_ID_A = "_a_b-C12_34";
const YT_ID_B = "-_987654321";
const BILI_ID = "BV1note99901";

const YT_ENCODED_A = encodeVideoStorageBvid("youtube", YT_ID_A);
const YT_ENCODED_B = encodeVideoStorageBvid("youtube", YT_ID_B);

async function seedMixedHighlightBuckets(totalVideos: number): Promise<void> {
  for (let idx = 0; idx < totalVideos; idx += 1) {
    const isYt = idx % 2 === 0;
    const key = isYt
      ? encodeVideoStorageBvid("youtube", `_${String(idx).padStart(9, "0")}A`)
      : `BV1mix${String(idx).padStart(6, "0")}`;
    await addVideoHighlight(key, {
      text: `highlight-${idx}`,
      from: idx,
      source: "subtitle",
      subtitleIndex: 0
    });
  }
}

function createGetSettingsResponder(noteExportTemplate: string) {
  return vi.fn((message: { type?: string }, callback?: (response: unknown) => void) => {
    const response =
      message?.type === "get-settings"
        ? {
            ok: true,
            settings: {
              ...DEFAULT_SETTINGS,
              noteExportTemplate
            }
          }
        : { ok: false };
    callback?.(response);
    return Promise.resolve(response);
  });
}

describe("多站点高亮存储键隔离、UI 同步与 120 桶 LRU 淘汰", () => {
  beforeEach(() => {
    resetModuleState();
    resetHighlightMemoryStoreForTests();
    installChromeHost();
  });

  afterEach(() => {
    resetHighlightMemoryStoreForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolveHighlightVideoKey 对 YouTube 生成编码键，绝不将 /watch 按 pathname 折叠，B 站保持不变", () => {
    expect(
      resolveHighlightVideoKey(YT_ID_A, `https://www.youtube.com/watch?v=${YT_ID_A}`, "youtube")
    ).toBe(YT_ENCODED_A);
    expect(resolveHighlightVideoKey(YT_ID_A, "", "youtube")).toBe(YT_ENCODED_A);
    expect(
      resolveHighlightVideoKey("", `https://www.youtube.com/watch?v=${YT_ID_B}&t=42s`)
    ).toBe(YT_ENCODED_B);
    expect(
      resolveHighlightVideoKey(YT_ENCODED_A, `https://www.youtube.com/watch?v=${YT_ID_A}`)
    ).toBe(YT_ENCODED_A);

    expect(resolveHighlightVideoKey("", "https://www.youtube.com/watch")).toBe("");
    expect(resolveHighlightVideoKey("", "https://www.youtube.com/watch?v=too-short", "youtube")).toBe(
      ""
    );

    expect(
      resolveHighlightVideoKey(BILI_ID, `https://www.bilibili.com/video/${BILI_ID}/`, "bilibili")
    ).toBe(BILI_ID);
    expect(
      resolveHighlightVideoKey("", "https://www.bilibili.com/festival/spring2026?from=feed")
    ).toBe("https://www.bilibili.com/festival/spring2026");
  });

  it("reader/subtitle-highlights-ui 按 site 解析 YouTube 高亮键并在多视频混合场景下零串扰", async () => {
    clipState.setSite("youtube");
    clipState.setBvid(YT_ID_A);
    clipState.setCid(YOUTUBE_UNIT_CID);
    clipState.setCurrentUrl(`https://www.youtube.com/watch?v=${YT_ID_A}`);

    expect(currentHighlightVideoKey()).toBe(YT_ENCODED_A);

    await addVideoHighlight(YT_ENCODED_A, {
      text: "YouTube A 重点句",
      from: 12,
      source: "subtitle",
      subtitleIndex: 1
    });
    await addVideoHighlight(YT_ENCODED_B, {
      text: "YouTube B 重点句",
      from: 24,
      source: "subtitle",
      subtitleIndex: 2
    });
    await addVideoHighlight(BILI_ID, {
      text: "B 站重点句",
      from: 36,
      source: "subtitle",
      subtitleIndex: 3
    });

    await refreshSubtitleHighlightsFromStore();
    expect(getCachedHighlightVideoKey()).toBe(YT_ENCODED_A);

    expect(await removeSubtitleItemHighlight(1)).toBe(true);
    expect(await loadVideoHighlights(YT_ENCODED_A)).toEqual([]);
    expect(await loadVideoHighlights(YT_ENCODED_B)).toHaveLength(1);
    expect(await loadVideoHighlights(BILI_ID)).toHaveLength(1);
  });

  it("混合写入 122 个 YouTube 与 B 站高亮桶触发 MAX_VIDEO_BUCKETS=120 淘汰且无键碰撞", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10;
      return now;
    });

    await seedMixedHighlightBuckets(122);

    const stored = (await chrome.storage.local.get(NOTE_HIGHLIGHTS_STORAGE_KEY))[
      NOTE_HIGHLIGHTS_STORAGE_KEY
    ] as Record<string, unknown>;
    const keys = Object.keys(stored);
    expect(keys).toHaveLength(120);
    expect(stored[encodeVideoStorageBvid("youtube", `_${String(0).padStart(9, "0")}A`)]).toBeUndefined();
    expect(stored[`BV1mix${String(1).padStart(6, "0")}`]).toBeUndefined();
    expect(stored[encodeVideoStorageBvid("youtube", `_${String(2).padStart(9, "0")}A`)]).toBeDefined();
    expect(stored[`BV1mix${String(121).padStart(6, "0")}`]).toBeDefined();
  });
});

describe("多站点导出模板、{{videoId}}/{{site}} 与 bilingualDisplayOrder 统一", () => {
  beforeEach(() => {
    resetModuleState();
    resetHighlightMemoryStoreForTests();
    installChromeHost();
  });

  afterEach(() => {
    resetHighlightMemoryStoreForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("NOTE_TEMPLATE_VARIABLES_HELP 包含 {{videoId}} 与 {{site}}，YouTube 默认模板与自定义模板行为正确且零内部键泄漏", () => {
    expect(NOTE_TEMPLATE_VARIABLES_HELP).toContain("{{videoId}}");
    expect(NOTE_TEMPLATE_VARIABLES_HELP).toContain("{{site}}");

    const ytVars = buildNoteTemplateVariables({
      meta: {
        site: "youtube",
        title: "YouTube 技术讲解",
        bvid: YT_ID_A,
        author: "Channel Author",
        url: `https://www.youtube.com/watch?v=${YT_ID_A}`,
        uploadDate: "2026-11-24",
        description: "Video summary"
      },
      body: [{ from: 10, to: 15, content: "Hello world" }],
      overview: {
        summary: "概览摘要",
        chapters: [{ from: 0, to: 60, title: "Intro", summary: "Kickoff" }],
        quotes: [{ from: 10, content: "Hello world" }]
      }
    });

    expect(ytVars.videoId).toBe(YT_ID_A);
    expect(ytVars.bvid).toBe(YT_ID_A);
    expect(ytVars.site).toBe("youtube");

    const defaultRendered = renderNoteTemplate("", ytVars);
    expect(defaultRendered).toContain(`videoId: "${YT_ID_A}"`);
    expect(defaultRendered).toContain("- 作者：Channel Author");
    expect(defaultRendered).not.toContain('bvid: "');
    expect(defaultRendered).not.toContain("- UP主：");
    expect(defaultRendered).not.toContain("yt~");

    const normalizedDefaultRendered = renderNoteTemplate(DEFAULT_NOTE_TEMPLATE, ytVars);
    expect(normalizedDefaultRendered).toBe(defaultRendered);

    const customTemplate = "# {{title}}\n- site: {{site}}\n- videoId: {{videoId}}\n- bvid: {{bvid}}\n- UP主：{{author}}";
    const customRendered = renderNoteTemplate(customTemplate, ytVars);
    expect(customRendered).toBe(
      `# YouTube 技术讲解\n- site: youtube\n- videoId: ${YT_ID_A}\n- bvid: ${YT_ID_A}\n- UP主：Channel Author`
    );

    const leakedInputVars = buildNoteTemplateVariables({
      meta: {
        site: "youtube",
        title: "",
        bvid: YT_ENCODED_A,
        author: "Creator",
        url: `https://www.youtube.com/watch?v=${YT_ID_A}`
      }
    });
    expect(leakedInputVars.title).toBe(YT_ID_A);
    expect(leakedInputVars.bvid).toBe(YT_ID_A);
    expect(leakedInputVars.videoId).toBe(YT_ID_A);
    const leakedRendered = renderNoteTemplate(DEFAULT_YOUTUBE_NOTE_TEMPLATE, leakedInputVars);
    expect(leakedRendered).toContain(`videoId: "${YT_ID_A}"`);
    expect(leakedRendered).not.toContain("yt~");

    const biliVars = buildNoteTemplateVariables({
      meta: {
        site: "bilibili",
        title: "B站视频",
        bvid: BILI_ID,
        author: "B站UP",
        url: `https://www.bilibili.com/video/${BILI_ID}/`,
        uploadDate: "2026-11-24"
      }
    });
    expect(biliVars.site).toBe("bilibili");
    expect(biliVars.bvid).toBe(BILI_ID);
    expect(biliVars.videoId).toBe(BILI_ID);
    const biliDefaultRendered = renderNoteTemplate("", biliVars);
    expect(biliDefaultRendered).toContain(`bvid: "${BILI_ID}"`);
    expect(biliDefaultRendered).toContain("- UP主：B站UP");
    expect(biliDefaultRendered).not.toContain("videoId:");
  });

  it("renderCurrentVideoNote 端到端读取 YouTube 高亮与默认模板，输出原 11 位 ID 与零 yt~ 泄漏", async () => {
    await addVideoHighlight(YT_ENCODED_B, {
      text: "Key insight from YouTube",
      from: 65,
      source: "subtitle",
      subtitleIndex: 0
    });

    clipState.setSite("youtube");
    clipState.setBvid(YT_ID_B);
    clipState.setCid(YOUTUBE_UNIT_CID);
    clipState.setTitle("YouTube 端到端笔记");
    clipState.setAuthor("Demo Channel");
    clipState.setUploadDate("2026-11-24");
    clipState.setCurrentUrl(`https://www.youtube.com/watch?v=${YT_ID_B}&biliscript_reader=1`);
    clipState.setSubtitleBody([{ from: 65, to: 70, content: "Key insight from YouTube" }]);

    const sendSpy = createGetSettingsResponder(DEFAULT_NOTE_TEMPLATE);
    (globalThis.chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = sendSpy;

    const rendered = await renderCurrentVideoNote();
    expect(sendSpy).toHaveBeenCalledWith({ type: "get-settings" }, expect.any(Function));
    expect(rendered.site).toBe("youtube");
    expect(rendered.videoId).toBe(YT_ID_B);
    expect(rendered.bvid).toBe(YT_ID_B);
    expect(rendered.fileName).toBe("2026-11-24-YouTube 端到端笔记.md");
    expect(rendered.markdown).toContain(`videoId: "${YT_ID_B}"`);
    expect(rendered.markdown).toContain("- 作者：Demo Channel");
    expect(rendered.markdown).toContain(`source: "https://www.youtube.com/watch?v=${YT_ID_B}"`);
    expect(rendered.markdown).toContain("- `1:05` Key insight from YouTube");
    expect(rendered.markdown).not.toContain("yt~");
    expect(rendered.markdown).not.toContain("biliscript_reader");

    (globalThis.chrome.runtime as unknown as { sendMessage: unknown }).sendMessage =
      createGetSettingsResponder("# {{title}}\n- UP主：{{author}}\n- ID：{{videoId}}/{{bvid}}");
    const customRendered = await renderCurrentVideoNote();
    expect(customRendered.markdown).toBe(
      `# YouTube 端到端笔记\n- UP主：Demo Channel\n- ID：${YT_ID_B}/${YT_ID_B}`
    );
  });

  it("bilingualDisplayOrder 在 Markdown / SRT / TXT 与模板 {{subtitles}} 导出中保持一致", () => {
    const primary = [
      { from: 0, to: 4, content: "First English sentence." },
      { from: 4, to: 8, content: "Second English sentence." }
    ];
    const secondary = [
      { from: 0, to: 4, content: "第一句中文译文。" },
      { from: 4, to: 8, content: "第二句中文译文。" }
    ];

    state.setSettings({
      ...DEFAULT_SETTINGS,
      bilingualSubtitles: true,
      bilingualDisplayOrder: "original-first",
      includeTimestampInBody: true
    });
    clipState.setSubtitleBody(primary);
    clipState.applySecondarySubtitle({
      id: "id_en_translate-zh-CN",
      url: "",
      body: secondary
    });
    const resolver = createSecondaryLineResolver();

    const originalMd = buildMarkdown({}, primary, state.settings, resolver);
    const originalSrt = buildSrt(primary, resolver, state.settings);
    const originalTxt = buildTxt(primary, state.settings, resolver);
    expect(originalMd).toContain("`0:00` First English sentence.\n  第一句中文译文。");
    expect(originalSrt).toContain("1\n00:00:00,000 --> 00:00:04,000\nFirst English sentence.\n第一句中文译文。");
    expect(originalTxt).toContain("0:00 First English sentence.\n  第一句中文译文。");

    const translationFirstSettings = {
      ...state.settings,
      bilingualDisplayOrder: "translation-first" as const
    };
    state.setSettings(translationFirstSettings);

    const trMd = buildMarkdown({}, primary, translationFirstSettings, resolver);
    const trSrt = buildSrt(primary, resolver, translationFirstSettings);
    const trTxt = buildTxt(primary, translationFirstSettings, resolver);
    const trTemplate = renderNoteTemplate(
      "{{subtitles}}",
      buildNoteTemplateVariables({
        meta: { site: "youtube", bvid: YT_ID_A, title: "Bilingual" },
        body: primary,
        settings: translationFirstSettings,
        secondaryFor: resolver
      })
    );

    expect(trMd).toContain("`0:00` 第一句中文译文。\n  First English sentence.");
    expect(trSrt).toContain("1\n00:00:00,000 --> 00:00:04,000\n第一句中文译文。\nFirst English sentence.");
    expect(trTxt).toContain("0:00 第一句中文译文。\n  First English sentence.");
    expect(trTemplate).toBe("`0:00` 第一句中文译文。\n  First English sentence.\n`0:04` 第二句中文译文。\n  Second English sentence.");
  });
});
