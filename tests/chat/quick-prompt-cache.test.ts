import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const ROOT = process.cwd();

let readCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").readCachedQuickPrompts;
let writeCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").writeCachedQuickPrompts;
let subscribeQuickPromptsChange: typeof import("../../extension/chat/quick-prompt-cache.js").subscribeQuickPromptsChange;
let resetQuickPromptCacheForTests: typeof import("../../extension/chat/quick-prompt-cache.js").resetQuickPromptCacheForTests;
let maxEntries: number;

async function importModule() {
  const module = await import("../../extension/chat/quick-prompt-cache.js");
  readCachedQuickPrompts = module.readCachedQuickPrompts;
  writeCachedQuickPrompts = module.writeCachedQuickPrompts;
  subscribeQuickPromptsChange = module.subscribeQuickPromptsChange;
  resetQuickPromptCacheForTests = module.resetQuickPromptCacheForTests;
  maxEntries = module.MAX_QUICK_PROMPT_CACHE_ENTRIES;
}

beforeEach(async () => {
  resetModuleState();
  await importModule();
  resetQuickPromptCacheForTests();
});

describe("读写", () => {
  it("写入后按键读回；未写过的键 / 空键为 null", () => {
    writeCachedQuickPrompts("video:BV1|1", ["一", "二"]);
    expect(readCachedQuickPrompts("video:BV1|1")).toEqual(["一", "二"]);
    expect(readCachedQuickPrompts("video:BV2|2")).toBeNull();
    expect(readCachedQuickPrompts("")).toBeNull();
    expect(readCachedQuickPrompts(undefined)).toBeNull();
  });

  it("读回的是副本：调用方改写不会污染缓存", () => {
    writeCachedQuickPrompts("video:BV1|1", ["一", "二"]);
    const hit = readCachedQuickPrompts("video:BV1|1")!;
    hit.push("三");
    expect(readCachedQuickPrompts("video:BV1|1")).toEqual(["一", "二"]);
  });

  it("非法载荷（空表 / 非字符串项 / 空键）不落缓存", () => {
    writeCachedQuickPrompts("video:BV1|1", []);
    expect(readCachedQuickPrompts("video:BV1|1")).toBeNull();
    writeCachedQuickPrompts("", ["一"]);
    writeCachedQuickPrompts(undefined, ["一"]);
    writeCachedQuickPrompts("video:BV1|1", ["  ", null]);
    expect(readCachedQuickPrompts("video:BV1|1")).toBeNull();
  });
});

describe("变更通知", () => {
  it("内容变化才通知；同内容重写不通知；解绑后不再收到", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQuickPromptsChange(listener);

    writeCachedQuickPrompts("video:BV1|1", ["一", "二"]);
    expect(listener).toHaveBeenCalledTimes(1);

    writeCachedQuickPrompts("video:BV1|1", ["一", "二"]);
    expect(listener).toHaveBeenCalledTimes(1);

    writeCachedQuickPrompts("video:BV1|1", ["一", "三"]);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    writeCachedQuickPrompts("video:BV2|2", ["四"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("容量", () => {
  it("超过上限按写入顺序淘汰最早的键", () => {
    for (let index = 0; index <= maxEntries; index += 1) {
      writeCachedQuickPrompts(`video:BV${index}|${index}`, [`问题${index}`]);
    }
    expect(readCachedQuickPrompts("video:BV0|0")).toBeNull();
    expect(readCachedQuickPrompts(`video:BV${maxEntries}|${maxEntries}`)).toEqual([`问题${maxEntries}`]);
  });
});

describe("测试重置出口不外流（源码守卫）", () => {
  it("extension/ 下除 quick-prompt-cache.ts 定义处外，没有任何文件引用 resetQuickPromptCacheForTests", () => {
    const offenders: string[] = [];
    walk(join(ROOT, "extension"), (file) => {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      if (rel === "extension/chat/quick-prompt-cache.ts") return;
      if (!/\.(ts|js)$/.test(rel)) return;
      if (readFileSync(file, "utf8").includes("resetQuickPromptCacheForTests")) {
        offenders.push(rel);
      }
    });
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else {
      visit(full);
    }
  }
}
