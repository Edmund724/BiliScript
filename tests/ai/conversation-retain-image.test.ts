// ai/conversation.ts retainLatestImage 的落盘保留策略（image-input 04 号票）：
// 一个会话最多留最近一张图（最后一条带图消息的最后一张），其余整条摘掉——
// 最坏体积被压到每会话 ≤1MB。合法性判定复用 normalizeImageParts（同一份单源）。
// 占位替换不在这里（那是请求组装期 ai/context 的事）：摘掉的图片不写回 content，
// 否则历史消息在界面上会多出一句占位文本。

import { describe, expect, it } from "vitest";
import { retainLatestImage } from "../../extension/ai/conversation.js";

const IMAGE_A = { mime: "image/webp", data: "QUJD" };
const IMAGE_B = { mime: "image/webp", data: "WFla" };

describe("retainLatestImage 每会话最多留最近一张图", () => {
  it("多条带图消息：只留最后一条的最后一张，其余图片字段摘掉、文本不动", () => {
    const messages = [
      { role: "user", content: "第一张图", images: [IMAGE_A] },
      { role: "assistant", content: "第一张是截图" },
      { role: "user", content: "两三张一起发", images: [IMAGE_A, IMAGE_B] },
      { role: "assistant", content: "都看到了" }
    ];

    expect(retainLatestImage(messages)).toEqual([
      { role: "user", content: "第一张图" },
      { role: "assistant", content: "第一张是截图" },
      { role: "user", content: "两三张一起发", images: [IMAGE_B] },
      { role: "assistant", content: "都看到了" }
    ]);
  });

  it("保留的图片与 tool 字段可共存（其余消息的字段一个不丢）", () => {
    const messages = [
      { role: "user", content: "联网问过", images: [IMAGE_A] },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
      { role: "user", content: "看这张", images: [IMAGE_B] }
    ];

    expect(retainLatestImage(messages)).toEqual([
      { role: "user", content: "联网问过" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
      { role: "user", content: "看这张", images: [IMAGE_B] }
    ]);
  });

  it("单条带一张图：原样保留（早期单图会话零变化）", () => {
    const messages = [{ role: "user", content: "这张图里是什么", images: [IMAGE_A] }];

    expect(retainLatestImage(messages)).toEqual([{ role: "user", content: "这张图里是什么", images: [IMAGE_A] }]);
  });

  it("无带图消息：原数组原样返回（同一引用，不做无谓拷贝）", () => {
    const messages = [{ role: "user", content: "纯文本" }, { role: "assistant", content: "好" }];

    expect(retainLatestImage(messages)).toBe(messages);
  });

  it("非法图片项（缺 data / 空数组）不算带图：不占保留位，字段一并摘掉", () => {
    const messages = [
      { role: "user", content: "缺 data", images: [{ mime: "image/webp" }] },
      { role: "user", content: "空数组", images: [] as { mime: string; data: string }[] },
      { role: "user", content: "真图", images: [IMAGE_A] }
    ];

    expect(retainLatestImage(messages)).toEqual([
      { role: "user", content: "缺 data" },
      { role: "user", content: "空数组" },
      { role: "user", content: "真图", images: [IMAGE_A] }
    ]);
  });

  it("只有非法图片项：字段摘掉、无保留位（真图之前不留残渣）", () => {
    const messages = [{ role: "user", content: "坏图", images: [{ mime: "image/webp" }] }];

    expect(retainLatestImage(messages)).toEqual([{ role: "user", content: "坏图" }]);
  });

  it("空会话：原样返回", () => {
    const messages: { role: string; content: string; images?: { mime: string; data: string }[] }[] = [];

    expect(retainLatestImage(messages)).toBe(messages);
  });
});
