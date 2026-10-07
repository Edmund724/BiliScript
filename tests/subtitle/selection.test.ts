// subtitle/selection.js + subtitle/chapters.js 直测（候选10 批1）：
// - normalizeChapters 按输入数组引用的 WeakMap 缓存（同引用复用同一结果对象，
//   不同引用重新计算，去重/排序结果与原实现一致；arch-review-2026-09/04 起
//   居住在 chapters.js 叶子）；
// - sortSubtitleBodyByFrom 写入端稳定排序（findActiveSubtitleIndex 二分依赖的
//   「subtitleBody 按 from 升序」不变量的来源）；
// - normalizeSubtitleTracks / pickPreferredSubtitle 的排序与身份复用口径
//   （wayfinder 06）：排序键只比优先级、同优先级保持输入顺序（Q8′）。
// 映射的轨道身份口径（id_str 优先）随落点迁往 tests/bilibili/native-payload.test.ts
//（架构评审「轨道身份」：原生产物映射归位 bilibili/native-payload.ts）。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeChapters } from "../../extension/subtitle/chapters.js";
import { mapSubtitleTracks } from "../../extension/bilibili/native-payload.js";
import {
  findSecondaryTrackByPreferredLang,
  findTrackByPreferredLang,
  isMainSubtitleTrack,
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  sortSubtitleBodyByFrom
} from "../../extension/subtitle/selection.js";

beforeEach(() => {
  resetModuleState();
});

describe("normalizeChapters：按引用缓存", () => {
  const input = [
    { title: "开场", from: 30, to: 60 },
    { title: "正片", from: 0, to: 30 },
    { title: "正片", from: 0, to: 30 } // 重复（同 from 同标题），应去重
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
    // 再取一次仍走缓存，结果一致
    expect(normalizeChapters(input)).toEqual(result);
  });

  it("空数组与非数组输入", () => {
    const empty: unknown[] = [];
    expect(normalizeChapters(empty)).toEqual([]);
    expect(normalizeChapters(empty)).toBe(normalizeChapters(empty)); // 同引用命中缓存
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

// BV1mAam6tEL8 的 8 条真实 ai-* 轨（research/01-track-shape.md）：lan 一律
// `ai-` + ISO-639-1，lan_doc 是裸语言名；接口 id 是 19 位 JSON 数字（> 2^53），
// 下面的 id 写 JSON.parse 之后的丢精度值，id_str 写精确值——两者成对还原真实响应。
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

// 接口原顺序（= 播放器菜单顺序）：中文（原语言 ASR）→ English → 其余按接口给出顺序。
const AI_TRACK_LAN_INTERFACE_ORDER = ["ai-zh", "ai-en", "ai-ja", "ai-es", "ai-ar", "ai-pt", "ai-th", "ai-id"];

describe("normalizeSubtitleTracks / pickPreferredSubtitle：排序与身份复用口径（wayfinder 06）", () => {
  it("previousId 比对认 id_str：精确 id 命中非首轨，丢精度的旧值不模糊匹配", () => {
    const tracks = mapSubtitleTracks(AI_TRACKS_RAW);
    const ja = tracks.find((item) => item.lan === "ai-ja")!;

    // 选中态与轨道两端同源（都取 id_str）→ 命中排序后并非首位的 日本語轨
    expect(pickPreferredSubtitle(normalizeSubtitleTracks(tracks), { previousId: ja.id })?.lan).toBe("ai-ja");
    // 旧的丢精度值（…400）不属于任何轨：不模糊匹配，回落 tracks[0] 兜底
    expect(pickPreferredSubtitle(normalizeSubtitleTracks(tracks), { previousId: "2121827727664517400" })?.lan).toBe(
      "ai-zh"
    );
  });

  it("排序键只比优先级：中文优先、英文次之，其余保持接口原顺序（8 条 ai-* 样本）", () => {
    const sorted = normalizeSubtitleTracks(mapSubtitleTracks(AI_TRACKS_RAW));

    expect(sorted.map((item) => item.lan)).toEqual(AI_TRACK_LAN_INTERFACE_ORDER);
    // 同优先级段（其余 6 条）逐条保持输入顺序——旧的 lanDoc 字符串序 / 数字 id
    // 升序二级键把这段排成 ai-id / ai-es / ai-pt / ai-ar / ai-th / ai-ja（代码单元
    // 序确定，与引擎 ICU 无关），与接口原顺序不同。
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

// ===== 副字幕语言匹配（bilingual-subtitles 05/06）：两级 + 真轨过滤 =====
describe("findTrackByPreferredLang（副轨语言两级匹配）", () => {
  const aiZh = { id: "1", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json" };
  const aiEn = { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json" };
  const ccEn = { id: "3", lan: "en-US", lanDoc: "English (CC)", subtitleUrl: "https://sub/cc-en.json" };
  const asrZh = { id: "asr", lan: "asr-zh", lanDoc: "中文（转写）", subtitleUrl: "" };

  it("两级：完整 lan 精确命中优先（混源视频不依赖轨序）", () => {
    // AI 轨排在人工轨前面：单级子标签匹配会先命中 ai-en ⇒ 两级必须仍选 en-US
    expect(findTrackByPreferredLang([aiZh, aiEn, ccEn], "en-US")?.id).toBe("3");
    expect(findTrackByPreferredLang([ccEn, aiEn], "en-US")?.id).toBe("3");
  });

  it("兜底：偏好命中不了完整 lan 时退回主语言子标签（en-US → ai-en）", () => {
    expect(findTrackByPreferredLang([aiZh, aiEn], "en-US")?.id).toBe("2");
    // 偏好存的是轨自己的 lan ⇒ 二级匹配让偏好粘在同一族（ai-en 仍选 ai-en）
    expect(findTrackByPreferredLang([ccEn, aiEn], "ai-en")?.id).toBe("2");
    expect(findTrackByPreferredLang([ccEn, aiEn], "zh-CN")).toBe(null);
  });

  it("只考虑有 subtitleUrl 的真轨（ASR 伪轨永不被选中）+ 空偏好返回 null", () => {
    // 只有伪轨命中目标语言（asr-zh 的子标签是 zh）时按无解处理——绝不拿伪轨充数
    expect(findTrackByPreferredLang([asrZh, aiEn], "zh-CN")).toBe(null);
    expect(findTrackByPreferredLang([asrZh], "zh-CN")).toBe(null);
    // 真轨在场时选中真轨（伪轨从候选里消失）
    expect(findTrackByPreferredLang([asrZh, aiZh], "zh-CN")?.id).toBe("1");
    expect(findTrackByPreferredLang([aiEn], "")).toBe(null);
    expect(findTrackByPreferredLang([aiEn], null)).toBe(null);
  });
});

// ===== 副字幕的目标轨（bilingual-subtitles/06 + 2026-10-06 图外回访）=====
// 副轨槽不许装主轨：装进去会在列表里出两份一样的正文，而弹层副列同时写着
// 「主副字幕相同」（文案与 state 两说）。排除判据与两级语言匹配
// 同住一个叶子，因为装载入口有两条（弹层副列 / reader 生命周期自动装载）——
// 只在一处加，另一处就会把主轨当副轨抓下来（用户实测的那两份一样）。
describe("副轨目标 = 语言命中 + 排除主轨（findSecondaryTrackByPreferredLang / isMainSubtitleTrack）", () => {
  const aiZh = { id: "1", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json" };
  const ccZh = { id: "4", lan: "zh-CN", lanDoc: "中文（CC）", subtitleUrl: "https://sub/cc-zh.json" };
  const aiEn = { id: "2", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://sub/ai-en.json" };

  it("命中主轨那一条 ⇒ null（不退到同语言的另一条轨：那还是两份一样）", () => {
    // 偏好 zh-CN、主轨 = 人工 zh-CN：二级子标签匹配本会顺位退到 ai-zh，必须拦在这里
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "zh-CN", "4")).toBe(null);
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "ai-zh", "1")).toBe(null);
  });

  it("按**轨身份**排除、不按语言：主轨是另一条同语言轨时照常命中", () => {
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "ai-zh", "4")?.id).toBe("1");
    expect(findSecondaryTrackByPreferredLang([ccZh, aiZh], "zh-CN", "1")?.id).toBe("4");
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
