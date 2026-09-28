// tests/chat/quick-prompt-cache.test.ts
// 初始快捷问题的内存缓存契约（extension/chat/quick-prompt-cache.ts）：
// 按上下文键读写、只读副本隔离、相同内容不重复通知、超上限 FIFO 淘汰、订阅解绑。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

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
