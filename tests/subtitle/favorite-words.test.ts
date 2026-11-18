import { describe, expect, it } from "vitest";
import {
  buildFavoriteWordsAnkiTsv,
  buildFavoriteWordsCsv,
  loadFavoriteWords,
  MAX_FAVORITE_WORDS,
  removeFavoriteWord,
  saveFavoriteWord,
  type FavoriteWordsStorageAdapter
} from "../../extension/subtitle/favorite-words.js";

function createMemoryStorage(): FavoriteWordsStorageAdapter {
  const store = new Map<string, unknown>();
  return {
    async get(key: string) {
      return store.get(key);
    },
    async set(key: string, value: unknown) {
      store.set(key, value);
    }
  };
}

describe("favorite-words：生词本收藏、去重、上限与导出", () => {
  it("按小写单词去重，重复收藏更新例句与时间戳并置顶", async () => {
    const storage = createMemoryStorage();
    await saveFavoriteWord(
      {
        word: "Pipeline",
        phonetic: "/ˈpaɪplaɪn/",
        defs: ["n. 流水线"],
        contextMeaning: "渲染管线",
        bvid: "BV1old",
        videoTitle: "旧视频",
        sentence: "GPU pipeline stage",
        translation: "GPU 流水线阶段",
        from: 12,
        now: 1000
      },
      storage
    );
    await saveFavoriteWord(
      {
        word: "Shader",
        defs: ["n. 着色器"],
        bvid: "BV1mid",
        sentence: "Fragment shader",
        from: 30,
        now: 2000
      },
      storage
    );
    const res = await saveFavoriteWord(
      {
        word: "pipeline",
        defs: ["n. 管道；流水线"],
        contextMeaning: "指令流水线",
        bvid: "BV1new",
        videoTitle: "新视频",
        sentence: "CPU instruction pipeline",
        translation: "CPU 指令流水线",
        from: 45,
        now: 3000
      },
      storage
    );

    expect(res.updated).toBe(true);
    expect(res.list).toHaveLength(2);
    expect(res.list[0].id).toBe("pipeline");
    expect(res.list[0].bvid).toBe("BV1new");
    expect(res.list[0].from).toBe(45);
    expect(res.list[0].createdAt).toBe(1000);
    expect(res.list[0].updatedAt).toBe(3000);
    expect(res.list[1].id).toBe("shader");

    const afterRemove = await removeFavoriteWord("Shader", storage);
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0].id).toBe("pipeline");
  });

  it("导出 CSV（含 BOM 与转义）与 Anki TSV", async () => {
    const storage = createMemoryStorage();
    await saveFavoriteWord(
      {
        word: "throughput",
        phonetic: "/ˈθruːpʊt/",
        defs: ["n. 吞吐量", "处理能力"],
        contextMeaning: "数据吞吐率",
        bvid: "BV1xyz",
        videoTitle: 'Tech, "Talk"',
        sentence: "High throughput, low latency.",
        translation: "高吞吐、低延迟。",
        from: 75,
        now: 1700000000000
      },
      storage
    );
    const list = await loadFavoriteWords(storage);
    const csv = buildFavoriteWordsCsv(list);
    expect(csv.startsWith("\uFEFFWord,Phonetic,Definitions")).toBe(true);
    expect(csv).toContain('"Tech, ""Talk"""');
    expect(csv).toContain('"High throughput, low latency."');
    expect(csv).toContain("1:15");

    const tsv = buildFavoriteWordsAnkiTsv(list);
    expect(tsv).toContain("#separator:tab");
    expect(tsv).toContain("throughput\t/ˈθruːpʊt/");
  });

  it("上限 5000 条截断保护", async () => {
    const storage = createMemoryStorage();
    const seed = Array.from({ length: MAX_FAVORITE_WORDS + 10 }, (_, i) => ({
      id: `word${i}`,
      word: `word${i}`,
      phonetic: "",
      defs: ["def"],
      contextMeaning: "",
      bvid: "BV1",
      videoTitle: "V",
      sentence: "s",
      translation: "",
      from: i,
      createdAt: i + 1,
      updatedAt: i + 1
    }));
    await storage.set("biliscript_favorite_words_v1", seed);
    const loaded = await loadFavoriteWords(storage);
    expect(loaded).toHaveLength(MAX_FAVORITE_WORDS);
  });
});
