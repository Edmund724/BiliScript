import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeChapters } from "../../extension/subtitle/chapters.js";
import { mapSubtitleTracks } from "../../extension/bilibili/native-payload.js";
import {
  findSecondaryTrackByPreferredLang,
  findTrackByPreferredLang,
  findTrackByRef,
  isMainSubtitleTrack,
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  resolveTrackTarget,
  sortSubtitleBodyByFrom
} from "../../extension/subtitle/selection.js";

beforeEach(() => {
  resetModuleState();
});

describe("normalizeChapters：按引用缓存", () => {
  const input = [
    { title: "开场", from: 30, to: 60 },
    { title: "正片", from: 0, to: 30 },
    { title: "正片", from: 0, to: 30 }
  ];

  it("同引用返回同一结果对象（零重复归一化）", () => {
    const first = normalizeChapters(input);
    const second = normalizeChapters(input);
    expect(second).toBe(first);
  });

  it("不同引用（内容相同）重新计算：结果等价但不复用对象", () => {
    const first = normalizeChapters(input);
    const second = normalizeChapters([...input]);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("缓存下归一化语义不变：按 from 排序 + 去重 + 字段规整", () => {
    const result = normalizeChapters(input);
    expect(result).toEqual([
      { title: "正片", from: 0, to: 30, source: "" },
      { title: "开场", from: 30, to: 60, source: "" }
    ]);
    expect(normalizeChapters(input)).toEqual(result);
  });

  it("空数组与非数组输入", () => {
    const empty: unknown[] = [];
    expect(normalizeChapters(empty)).toEqual([]);
    expect(normalizeChapters(empty)).toBe(normalizeChapters(empty));
    expect(normalizeChapters(null)).toEqual([]);
    expect(normalizeChapters(undefined)).toEqual([]);
  });

  it("过滤无标题条目后缓存仍一致", () => {
    const messy = [{ title: "", from: 5 }, { title: "有效", from: 3 }];
    const first = normalizeChapters(messy);
    expect(first).toEqual([{ title: "有效", from: 3, to: 0, source: "" }]);
    expect(normalizeChapters(messy)).toBe(first);
  });
});

describe("sortSubtitleBodyByFrom：写入端稳定排序", () => {
  it("按 from 升序排列", () => {
    const body = [
      { from: 30, to: 40, content: "c" },
      { from: 0, to: 10, content: "a" },
      { from: 10, to: 20, content: "b" }
    ];
    expect(sortSubtitleBodyByFrom(body)!.map((item) => item.content)).toEqual(["a", "b", "c"]);
  });

  it("稳定：同 from 保持原有相对顺序", () => {
    const body = [
      { from: 5, to: 8, content: "first" },
      { from: 0, to: 5, content: "early" },
      { from: 5, to: 9, content: "second" }
    ];
    const sorted = sortSubtitleBodyByFrom(body)!;
    expect(sorted.map((item) => item.content)).toEqual(["early", "first", "second"]);
  });

  it("返回新数组，不原地修改入参", () => {
    const body = [{ from: 20 }, { from: 0 }];
    const sorted = sortSubtitleBodyByFrom(body)!;
    expect(sorted).not.toBe(body);
    expect(body.map((item) => item.from)).toEqual([20, 0]);
    expect(sorted.map((item) => item.from)).toEqual([0, 20]);
  });

  it("非数组输入原样透传（与读路径的防御语义一致）", () => {
    expect(sortSubtitleBodyByFrom(null)).toBe(null);
    expect(sortSubtitleBodyByFrom(undefined)).toBe(undefined);
    expect(sortSubtitleBodyByFrom([])).toEqual([]);
  });
});

const AI_TRACKS_RAW = [
  { id: 2120476497172283400, id_str: "2120476497172283392", lan: "ai-zh", lan_doc: "中文", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/zh.json" },
  { id: 2121827445538867000, id_str: "2121827445538866944", lan: "ai-en", lan_doc: "English", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/en.json" },
  { id: 2121827727664517400, id_str: "2121827727664517376", lan: "ai-ja", lan_doc: "日本語", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/ja.json" },
  { id: 2121827577382790000, id_str: "2121827577382789888", lan: "ai-es", lan_doc: "Español", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/es.json" },
  { id: 2121827639181245000, id_str: "2121827639181244928", lan: "ai-ar", lan_doc: "العربية", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/ar.json" },
  { id: 2121827571862717200, id_str: "2121827571862717184", lan: "ai-pt", lan_doc: "Português", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/pt.json" },
  { id: 2121827533660947200, id_str: "2121827533660947200", lan: "ai-th", lan_doc: "ภาษาไทย", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/th.json" },
  { id: 2121827596601096000, id_str: "2121827596601095936", lan: "ai-id", lan_doc: "Bahasa Indonesia", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/id.json" }
];

const AI_TRACK_LAN_INTERFACE_ORDER = ["ai-zh", "ai-en", "ai-ja", "ai-es", "ai-ar", "ai-pt", "ai-th", "ai-id"];

describe("normalizeSubtitleTracks / pickPreferredSubtitle：排序与身份复用口径（wayfinder 06）", () => {
  it("previousId 比对认 id_str：精确 id 命中非首轨，丢精度的旧值不模糊匹配", () => {
    const tracks = mapSubtitleTracks(AI_TRACKS_RAW);
    const ja = tracks.find((item) => item.lan === "ai-ja")!;

    expect(pickPreferredSubtitle(normalizeSubtitleTracks(tracks), { previousId: ja.id })?.lan).toBe("ai-ja");
    expect(pickPreferredSubtitle(normalizeSubtitleTracks(tracks), { previousId: "2121827727664517400" })?.lan).toBe(
      "ai-zh"
    );
  });

  it("排序键只比优先级：中文优先、英文次之，其余保持接口原顺序（8 条 ai-* 样本）", () => {
    const sorted = normalizeSubtitleTracks(mapSubtitleTracks(AI_TRACKS_RAW));

    expect(sorted.map((item) => item.lan)).toEqual(AI_TRACK_LAN_INTERFACE_ORDER);
    expect(sorted.slice(2).map((item) => item.lan)).toEqual(["ai-ja", "ai-es", "ai-ar", "ai-pt", "ai-th", "ai-id"]);
  });

  it("优先级仍生效：输入倒序也先中文后英文，同优先级段按输入倒序排列", () => {
    const sorted = normalizeSubtitleTracks(mapSubtitleTracks([...AI_TRACKS_RAW].reverse()));

    expect(sorted.map((item) => item.lan)).toEqual([
      "ai-zh",
      "ai-en",
      "ai-id",
      "ai-th",
      "ai-pt",
      "ai-ar",
      "ai-es",
      "ai-ja"
    ]);
  });

  it("同优先级、同 lanDoc 不再比 id 升序与 subtitleUrl：保持输入顺序", () => {
    const sorted = normalizeSubtitleTracks([
      { id: "2", lan: "xx", lanDoc: "Other", subtitleUrl: "//example.com/b.json" },
      { id: "1", lan: "xx", lanDoc: "Other", subtitleUrl: "//example.com/a.json" }
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["2", "1"]);
  });
});

describe("findTrackByPreferredLang（副轨语言两级匹配）", () => {
  const aiZh = { id: "1", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json" };
  const aiEn = { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json" };
  const ccEn = { id: "3", lan: "en-US", lanDoc: "English (CC)", subtitleUrl: "https://sub/cc-en.json" };
  const asrZh = { id: "asr", lan: "asr-zh", lanDoc: "中文（转写）", subtitleUrl: "" };

  it("两级：完整 lan 精确命中优先（混源视频不依赖轨序）", () => {
    expect(findTrackByPreferredLang([aiZh, aiEn, ccEn], "en-US")?.id).toBe("3");
    expect(findTrackByPreferredLang([ccEn, aiEn], "en-US")?.id).toBe("3");
  });

  it("兜底：偏好命中不了完整 lan 时退回主语言子标签（en-US → ai-en）", () => {
    expect(findTrackByPreferredLang([aiZh, aiEn], "en-US")?.id).toBe("2");
    expect(findTrackByPreferredLang([ccEn, aiEn], "ai-en")?.id).toBe("2");
    expect(findTrackByPreferredLang([ccEn, aiEn], "zh-CN")).toBe(null);
  });

  it("只考虑有 subtitleUrl 的真轨（ASR 伪轨永不被选中）+ 空偏好返回 null", () => {
    expect(findTrackByPreferredLang([asrZh, aiEn], "zh-CN")).toBe(null);
    expect(findTrackByPreferredLang([asrZh], "zh-CN")).toBe(null);
    expect(findTrackByPreferredLang([asrZh, aiZh], "zh-CN")?.id).toBe("1");
    expect(findTrackByPreferredLang([aiEn], "")).toBe(null);
    expect(findTrackByPreferredLang([aiEn], null)).toBe(null);
  });
});

describe("副轨目标 = 语言命中 + 排除主轨（findSecondaryTrackByPreferredLang / isMainSubtitleTrack）", () => {
  const aiZh = { id: "1", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json" };
  const ccZh = { id: "4", lan: "zh-CN", lanDoc: "中文（CC）", subtitleUrl: "https://sub/cc-zh.json" };
  const aiEn = { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json" };

  it("命中主轨那一条 ⇒ null（不退到同语言的另一条轨：那还是两份一样）", () => {
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "zh-CN", "4")).toBe(null);
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "ai-zh", "1")).toBe(null);
  });

  it("按轨身份与语种族双重排除：同属 zh 族的另一条轨严禁配成假双语，跨语种族照常命中", () => {
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "ai-zh", "4")).toBe(null);
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "zh-CN", "1")).toBe(null);
    expect(findSecondaryTrackByPreferredLang([ccZh, aiEn], "en-US", "4")?.id).toBe("2");
  });

  it("主轨身份为空（未选轨 / 伪轨）/ 偏好命中不了 ⇒ 与基础匹配同结果", () => {
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "zh-CN", "")?.id).toBe("4");
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "zh-CN", null)?.id).toBe("4");
    expect(findSecondaryTrackByPreferredLang([aiEn], "ja-JP", "1")).toBe(null);
  });

  it("主轨判据：任一侧 id 为空串都不算同轨（伪轨 / 未选轨不误伤）", () => {
    expect(isMainSubtitleTrack({ id: "4" }, "4")).toBe(true);
    expect(isMainSubtitleTrack({ id: "4" }, "")).toBe(false);
    expect(isMainSubtitleTrack({ id: "" }, "4")).toBe(false);
    expect(isMainSubtitleTrack({ id: "" }, "")).toBe(false);
    expect(isMainSubtitleTrack(null, "4")).toBe(false);
  });
});

describe("resolveTrackTarget / findTrackByRef（规范轨道目标投影）", () => {
  const tracks = [
    { id: "1", lan: "ai-zh", lanDoc: "中文（自动）", subtitleUrl: "https://sub/ai-zh.json" },
    { id: "2", lan: "ai-en", lanDoc: "", subtitleUrl: "https://sub/ai-en.json" }
  ];

  it("直接投影轨道：语言统一 lanDoc || lan || unknown", () => {
    expect(resolveTrackTarget(tracks[0])).toEqual({
      id: "1",
      url: "https://sub/ai-zh.json",
      lang: "中文（自动）"
    });
    expect(resolveTrackTarget(tracks[1])).toEqual({
      id: "2",
      url: "https://sub/ai-en.json",
      lang: "ai-en"
    });
    expect(resolveTrackTarget({ id: "", lan: "", lanDoc: "", subtitleUrl: "https://sub/x.json" })).toEqual({
      id: "",
      url: "https://sub/x.json",
      lang: "unknown"
    });
  });

  it("按选项行引用（id 优先，回退 URL）在轨列找回完整轨并投影 lanDoc，不漂移回机器码 lan", () => {
    expect(findTrackByRef(tracks, { id: "1", url: "https://sub/other.json" })).toBe(tracks[0]);
    expect(findTrackByRef(tracks, { id: "", url: "https://sub/ai-en.json" })).toBe(tracks[1]);

    expect(resolveTrackTarget({ id: "1", url: "https://sub/ai-zh.json", lang: "ai-zh" }, tracks)).toEqual({
      id: "1",
      url: "https://sub/ai-zh.json",
      lang: "中文（自动）"
    });
    expect(resolveTrackTarget({ id: "99", url: "https://sub/ja.json", lang: "ai-ja" }, tracks)).toEqual({
      id: "99",
      url: "https://sub/ja.json",
      lang: "ai-ja"
    });
  });
});
