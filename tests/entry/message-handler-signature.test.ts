import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../extension/core/url-watcher.js", () => ({
  startUrlWatcher: vi.fn()
}));
vi.mock("../../extension/bilibili/reader-url.js", () => ({
  replaceReaderModeUrl: vi.fn()
}));
vi.mock("../../extension/bilibili/video-probe.js", () => ({
  getRuntimeVideoElement: vi.fn(() => null),
  waitForVideoMetadata: vi.fn(async () => {})
}));
vi.mock("../../extension/subtitle/ui.js", () => ({}));
vi.mock("../../extension/subtitle/fetcher.js", () => ({
  refreshClip: vi.fn(async () => {}),
  loadSubtitle: vi.fn(async () => {}),
  resetClipState: vi.fn()
}));
vi.mock("../../extension/core/ui-status.js", () => ({
  setStatus: vi.fn()
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(async () => {})
}));
vi.mock("../../extension/reader/lazy-reader-presentation.js", () => ({
  renderReadingStatus: vi.fn(async () => {}),
  announceReadingStatus: vi.fn()
}));
vi.mock("../../extension/ai/player-ai.js", () => ({
  removePlayerAiQuickActionButton: vi.fn(),
  schedulePlayerAiQuickActionSync: vi.fn()
}));
vi.mock("../../extension/reader/index.js", () => ({
  updateReaderFollowState: vi.fn(),
  syncReadingViewPlayback: vi.fn(),
  enterReaderMode: vi.fn(async () => {}),
  closeReadingView: vi.fn(),
  waitForVideoMetadata: vi.fn(async () => {})
}));
vi.mock("../../extension/reader/state.js", () => ({
  isReaderViewOpen: vi.fn(() => false),
  enforceNormalPageStateIfNeeded: vi.fn()
}));
vi.mock("../../extension/reader/presentation.js", () => ({
  renderReadingStatus: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: vi.fn(() => ""),
  fetchHotComments: vi.fn(async () => [])
}));

import {
  bindRuntimeEvents
} from "../../extension/entry/message-handler.js";
import {
  READER_CONTEXT_PAYLOAD_FIELDS,
  SIGNATURE_PARTICIPATING_FIELDS,
  SIGNATURE_INDIRECT_FIELDS,
  SIGNATURE_EXCLUDED_FIELDS,
  createReaderContextPayload,
  computeContextStateSignature,
  type ReaderContextPayload
} from "../../extension/core/context-payload.js";
import { state, type ClipState } from "../../extension/core/state.js";

type OnMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => unknown;

const onMessageListeners: OnMessageListener[] = [];
vi.stubGlobal("chrome", {
  runtime: {
    onMessage: {
      addListener: (listener: OnMessageListener) => onMessageListeners.push(listener)
    }
  }
});

bindRuntimeEvents();

function seedReadyClip() {
  state.clip.setBvid("BV1sig");
  state.clip.setAid("9");
  state.clip.setCid("101");
  state.clip.setPageIndex(1);
  state.clip.setTitle("签名测试");
  state.clip.setSubtitles([{ id: "s1", subtitleUrl: "u1", lan: "zh" }]);
  state.clip.setSelectedSubtitleId("s1");
  state.clip.setSelectedSubtitleLang("zh-CN");
  state.clip.setSubtitleBody([
    { from: 0, to: 5, content: "第一句" },
    { from: 5, to: 9, content: "第二句" }
  ]);
  state.clip.setSubtitleFetchState("ready");
  state.clip.setNoSubtitleReason(null);
  state.clip.setChapters([]);
}

describe("computeContextStateSignature 纯函数", () => {
  beforeEach(() => {
    seedReadyClip();
  });

  it("同一状态 → 签名稳定", () => {
    const a = computeContextStateSignature(buildPayload());
    const b = computeContextStateSignature(buildPayload());
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  it("签名覆盖字段逐一变化 → 签名变化", () => {
    const base = computeContextStateSignature(buildPayload());

    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "第一句" }]);
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    state.clip.setSubtitleFetchState("loading");
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    state.clip.setSelectedSubtitleId("s2");
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    state.clip.setSubtitles([
      { id: "s1", subtitleUrl: "u1", lan: "zh" },
      { id: "s2", subtitleUrl: "u2", lan: "en" }
    ]);
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    state.clip.setChapters([{ title: "开场", from: 0, to: 60 }]);
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    state.setSettings({ ...state.settings!, includeTimestampInBody: false });
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    state.setSettings({ ...state.settings!, includeTimestampInBody: true });

    state.clip.setBvid("BV1other");
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
    state.clip.setCid("202");
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
    state.clip.setPageIndex(2);
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
    state.clip.setSelectedSubtitleLang("en-US");
    expect(computeContextStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
  });

  it("cid 缺失时回退 aid（无 cid 场景仍有稳定键）", () => {
    state.clip.setCid("");
    state.clip.setAid("9");
    const byAid = computeContextStateSignature(buildPayload());
    state.clip.setAid("");
    state.clip.setCid("9");
    const byCid = computeContextStateSignature(buildPayload());
    expect(byAid).toBe(byCid);
  });

  it("非判定字段（title/url/hotComments/pageCount 等）变化 → 签名不变", () => {
    const base = computeContextStateSignature(buildPayload());
    state.clip.setTitle("换了标题");
    state.clip.setPageCount(7);
    state.clip.setSelectedSubtitleUrl("u1?alt=signed");
    state.clip.setNoSubtitleReason("asr-unknown");
    const payload = buildPayload();
    payload.url = "https://www.bilibili.com/video/BV1sig/?p=9&t=1";
    payload.hotComments = [{ uname: "u", like: 1, message: "m" }];
    payload.subtitleBody = [
      { from: 0, to: 5, content: "完全不同的内容" },
      { from: 5, to: 9, content: "另一条不同的内容" }
    ];
    expect(computeContextStateSignature(payload)).toBe(base);
  });
});

const EXPECTED_PAYLOAD_FIELDS: (keyof ReaderContextPayload)[] = [
  "url",
  "title",
  "author",
  "uploadDate",
  "bvid",
  "cid",
  "aid",
  "pageIndex",
  "pageCount",
  "pageTitle",
  "subtitleBody",
  "videoDuration",
  "includeTimestampInBody",
  "subtitleFetchState",
  "noSubtitleReason",
  "subtitleLang",
  "selectedSubtitleId",
  "selectedSubtitleUrl",
  "subtitleOptions",
  "chapters",
  "hotComments"
];

const FULL_CLIP = {
  title: "映射测试视频",
  author: "某位UP主",
  uploadDate: "2026-01-02",
  bvid: "BV1map",
  cid: "201",
  aid: "99",
  pageIndex: 3,
  pageCount: 12,
  pageTitle: "第三话",
  subtitleBody: [
    { from: 0, to: 5, content: "第一句" },
    { from: 5, to: 9, content: "第二句" }
  ],
  videoDuration: 754.5,
  subtitleFetchState: "ready",
  noSubtitleReason: "",
  selectedSubtitleLang: "zh-CN",
  selectedSubtitleId: "s9",
  selectedSubtitleUrl: "https://subtitle/9",
  subtitles: [{ id: "s9" }, { id: "s8" }],
  chapters: [{ title: "开场", from: 0, to: 60 }]
};
const FULL_SETTINGS = { includeTimestampInBody: true };
const FULL_URL = "https://www.bilibili.com/video/BV1map/?p=3";

const EXPECTED_FULL_PAYLOAD: Record<string, unknown> = {
  url: FULL_URL,
  title: "映射测试视频",
  author: "某位UP主",
  uploadDate: "2026-01-02",
  bvid: "BV1map",
  cid: "201",
  aid: "99",
  pageIndex: 3,
  pageCount: 12,
  pageTitle: "第三话",
  subtitleBody: FULL_CLIP.subtitleBody,
  videoDuration: 754.5,
  includeTimestampInBody: true,
  subtitleFetchState: "ready",
  noSubtitleReason: null,
  subtitleLang: "zh-CN",
  selectedSubtitleId: "s9",
  selectedSubtitleUrl: "https://subtitle/9",
  subtitleOptions: FULL_CLIP.subtitles,
  chapters: FULL_CLIP.chapters,
  hotComments: []
};

function buildPayload() {
  return createReaderContextPayload({
    clip: state.clip,
    settings: state.settings,
    url: "https://www.bilibili.com/video/BV1sig"
  });
}

function makeFullPayload() {
  return createReaderContextPayload({
    clip: FULL_CLIP as Partial<ClipState>,
    settings: FULL_SETTINGS,
    url: FULL_URL
  });
}

describe("context-payload 形状快照与签名三分类对账", () => {
  it("工厂产物的 key 集合与顺序 = 字段清单（形状快照）", () => {
    const payload = makeFullPayload();
    expect(Object.keys(payload)).toEqual(EXPECTED_PAYLOAD_FIELDS);
  });

  it("三分类完备：参与 ∪ 间接 ∪ 排除 = 字段清单，且两两不交", () => {
    const union = new Set([
      ...SIGNATURE_PARTICIPATING_FIELDS,
      ...SIGNATURE_INDIRECT_FIELDS,
      ...SIGNATURE_EXCLUDED_FIELDS
    ]);
    expect([...union].sort()).toEqual([...READER_CONTEXT_PAYLOAD_FIELDS].sort());

    const participating = new Set(SIGNATURE_PARTICIPATING_FIELDS);
    const indirect = new Set(SIGNATURE_INDIRECT_FIELDS);
    const excluded = new Set(SIGNATURE_EXCLUDED_FIELDS);
    for (const field of SIGNATURE_PARTICIPATING_FIELDS) {
      expect(indirect.has(field) || excluded.has(field), `参与字段 ${field} 不得同时出现在间接/排除清单`).toBe(false);
    }
    for (const field of SIGNATURE_INDIRECT_FIELDS) {
      expect(participating.has(field) || excluded.has(field), `间接字段 ${field} 不得同时出现在参与/排除清单`).toBe(false);
    }
    for (const field of SIGNATURE_EXCLUDED_FIELDS) {
      expect(participating.has(field) || indirect.has(field), `排除字段 ${field} 不得同时出现在参与/间接清单`).toBe(false);
    }
  });

  it("排除清单逐字段机械遍历：实质扰动 → 签名不变", () => {
    const base = computeContextStateSignature(makeFullPayload());
    const mutations: Record<string, unknown> = {
      hotComments: [{ uname: "评论者", like: 1, message: "热评内容" }],
      url: "https://www.bilibili.com/video/BV1map/?p=3&t=9",
      title: "被站点改写的标题 - 哔哩哔哩",
      author: "另一位UP主",
      uploadDate: "2020-06-01",
      pageCount: 77,
      pageTitle: "另一话标题",
      videoDuration: 12345,
      selectedSubtitleUrl: "https://subtitle/9?alt=signed",
      noSubtitleReason: "asr-unknown"
    };
    expect(Object.keys(mutations).sort()).toEqual([...SIGNATURE_EXCLUDED_FIELDS].sort());

    for (const field of SIGNATURE_EXCLUDED_FIELDS) {
      const mutated = { ...makeFullPayload(), [field]: mutations[field] };
      expect(
        computeContextStateSignature(mutated),
        `被排除字段 ${field} 变化不应改变签名`
      ).toBe(base);
    }
  });

  it("间接字段 aid：cid 在场时签名不变；cid 缺席时经回退投影生效", () => {
    const base = computeContextStateSignature(makeFullPayload());
    expect(computeContextStateSignature({ ...makeFullPayload(), aid: "100" })).toBe(base);
    const withoutCid = { ...makeFullPayload(), cid: "" };
    const byAid99 = computeContextStateSignature(withoutCid);
    expect(computeContextStateSignature({ ...withoutCid, aid: "100" })).not.toBe(byAid99);
  });

  it("参与字段逐字段机械遍历：按投影语义扰动 → 签名变化", () => {
    const full = makeFullPayload();
    const base = computeContextStateSignature(full);
    const mutations: Record<string, unknown> = {
      bvid: "BV1other",
      cid: "202",
      pageIndex: 4,
      subtitleFetchState: "loading",
      subtitleBody: [...full.subtitleBody, { from: 9, to: 12, content: "第三句" }],
      selectedSubtitleId: "s10",
      subtitleOptions: [...full.subtitleOptions, { id: "s7" }],
      chapters: [...full.chapters, { title: "高潮", from: 60, to: 120 }],
      includeTimestampInBody: false,
      subtitleLang: "en-US"
    };
    expect(Object.keys(mutations).sort()).toEqual([...SIGNATURE_PARTICIPATING_FIELDS].sort());

    for (const field of SIGNATURE_PARTICIPATING_FIELDS) {
      const mutated = { ...full, [field]: mutations[field] };
      expect(
        computeContextStateSignature(mutated),
        `参与字段 ${field} 变化应改变签名`
      ).not.toBe(base);
    }
  });

  it("索引型数组等长换内容 → 签名不变（与 对话侧 contextKey 去重语义一致）", () => {
    const full = makeFullPayload();
    const base = computeContextStateSignature(full);
    const mutated = {
      ...full,
      subtitleBody: [
        { from: 0, to: 5, content: "完全不同的内容" },
        { from: 5, to: 9, content: "另一条不同的内容" }
      ],
      subtitleOptions: [{ id: "s9x" }, { id: "s8x" }],
      chapters: [{ title: "另一章节", from: 5, to: 55 }]
    };
    expect(computeContextStateSignature(mutated)).toBe(base);
  });
});

describe("createReaderContextPayload 组装映射", () => {
  it("完整输入：逐字段与 state 输入映射正确（含字段名映射）", () => {
    const payload = makeFullPayload();
    for (const field of EXPECTED_PAYLOAD_FIELDS) {
      expect(payload[field], `字段 ${field}`).toEqual(EXPECTED_FULL_PAYLOAD[field]);
    }
  });

  it("无参/空 clip：全字段落到缺省口径", () => {
    const payload = createReaderContextPayload();
    const expected: Record<string, unknown> = {
      url: undefined,
      title: "",
      author: "",
      uploadDate: "",
      bvid: "",
      cid: "",
      aid: "",
      pageIndex: 1,
      pageCount: 0,
      pageTitle: "",
      subtitleBody: [],
      videoDuration: 0,
      includeTimestampInBody: true,
      subtitleFetchState: "idle",
      noSubtitleReason: null,
      subtitleLang: "",
      selectedSubtitleId: "",
      selectedSubtitleUrl: "",
      subtitleOptions: [],
      chapters: [],
      hotComments: []
    };
    for (const field of EXPECTED_PAYLOAD_FIELDS) {
      expect(payload[field], `字段 ${field} 的缺省值`).toEqual(expected[field]);
    }
  });

  it("归一化分支：pageIndex/pageCount/videoDuration 的 Number 归一与缺省回退", () => {
    const build = (clip: any) => createReaderContextPayload({ clip, settings: {}, url: "u" });
    expect(build({ pageIndex: "3" }).pageIndex).toBe(3);
    expect(build({ pageIndex: 0 }).pageIndex).toBe(1);
    expect(build({ pageIndex: -2 }).pageIndex).toBe(1);
    expect(build({ pageCount: "5" }).pageCount).toBe(5);
    expect(build({ pageCount: -1 }).pageCount).toBe(0);
    expect(build({ videoDuration: "180.5" }).videoDuration).toBe(180.5);
    expect(build({ videoDuration: "abc" }).videoDuration).toBe(0);
    expect(build({}).videoDuration).toBe(0);
  });

  it("归一化分支：noSubtitleReason/chapters/subtitleFetchState 的缺省口径", () => {
    const build = (clip: any) => createReaderContextPayload({ clip, settings: {}, url: "u" });
    expect(build({}).noSubtitleReason).toBe(null);
    expect(build({ noSubtitleReason: "" }).noSubtitleReason).toBe(null);
    expect(build({ noSubtitleReason: "asr-empty" }).noSubtitleReason).toBe("asr-empty");
    expect(build({ chapters: "x" }).chapters).toEqual([]);
    expect(build({ chapters: [{ title: "开场", from: 0, to: 60 }] }).chapters).toHaveLength(1);
    expect(build({}).subtitleFetchState).toBe("idle");
    expect(build({ subtitleFetchState: "loading" }).subtitleFetchState).toBe("loading");
  });

  it("includeTimestampInBody 口径：仅显式 false 关闭，缺失按默认 true", () => {
    const build = (settings: any) => createReaderContextPayload({ clip: {}, settings, url: "u" });
    expect(build(undefined).includeTimestampInBody).toBe(true);
    expect(build({}).includeTimestampInBody).toBe(true);
    expect(build({ includeTimestampInBody: false }).includeTimestampInBody).toBe(false);
    expect(build({ includeTimestampInBody: true }).includeTimestampInBody).toBe(true);
    expect(build({ includeTimestampInBody: 0 }).includeTimestampInBody).toBe(true);
  });
});

const ALLOWED_SNAPSHOT_FIELDS = new Set([
  ...READER_CONTEXT_PAYLOAD_FIELDS,
  "signature",
  "hotComments",
  "isVideoContext",
  "page",
  "unchanged"
]);

function readSource(relativePath: string) {
  const jsUrl = new URL(relativePath, import.meta.url);
  const url = existsSync(fileURLToPath(jsUrl))
    ? jsUrl
    : new URL(relativePath.replace(/\.js$/, ".ts"), import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function scanFields(source: string, receiver: string) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_$-])${receiver}[?!]*\\.([A-Za-z_$][\\w$]*)`, "g");
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

function sliceBlock(source: string, startMarker: string, endMarker: string | undefined) {
  const start = source.indexOf(startMarker);
  expect(start, `源码中应存在锚点 ${startMarker}`).toBeGreaterThan(-1);
  const from = start + startMarker.length;
  const end = endMarker ? source.indexOf(endMarker, from) : source.length;
  return source.slice(start, end > start ? end : source.length);
}

function assertReconciliation(point: Set<string>, expectedFields: string[], label: string) {
  const expected = new Set(expectedFields);
  expect([...point].sort(), `${label} 扫描到的字段`).toEqual([...expected].sort());
  for (const field of point) {
    expect(
      ALLOWED_SNAPSHOT_FIELDS.has(field),
      `${label} 读取的快照字段 ${field} 不在 payload ∪ 附加层字段内（新增读取必须过对账测试）`
    ).toBe(true);
  }
}
