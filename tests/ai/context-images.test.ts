// ai/context.ts buildMessages 的图片挂载与历史重发策略（image-input 路线 B，01 号票
// 形状 + 04 号票策略）。
// 本轮用户消息的图片（宿主粘贴 → content 侧压缩成 WebP 的 ImagePart）挂在本函数
// 现造的末条 user 消息上；无图时不带字段——无图消息的请求体逐字节不变是 01 号票
// 的回归护栏，这里锁现行行为。
// 历史重发只保留最近一条用户消息的图片，更早的图片在请求组装时摘掉、换成文本
// 占位（content 仍是 string，路线 B）——重复支付图片 token 的正是这些早期图片。
import { describe, expect, it } from "vitest";
import { buildMessages } from "../../extension/ai/context.js";

const IMAGE = { mime: "image/webp", data: "QUJD" };

describe("buildMessages images", () => {
  it("有图：图片挂在末条 user 消息上（system 与历史不受影响）", () => {
    const messages = buildMessages({
      userPrompt: "这张图里是什么",
      images: [IMAGE],
      history: [{ role: "user", content: "前面的话" }, { role: "assistant", content: "前面的回答" }]
    });

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "这张图里是什么",
      images: [IMAGE]
    });
    expect(messages[0].images).toBeUndefined();
  });

  it("无图 / 空数组：不带 images 字段（线格式与改动前一致）", () => {
    const withoutImages = buildMessages({ userPrompt: "总结一下" });
    expect("images" in withoutImages[withoutImages.length - 1]).toBe(false);

    const emptyImages = buildMessages({ userPrompt: "总结一下", images: [] });
    expect("images" in emptyImages[emptyImages.length - 1]).toBe(false);
  });

  it("历史里最近一条用户消息的图片原样重发（本轮无图）", () => {
    const messages = buildMessages({
      userPrompt: "追问",
      history: [{ role: "user", content: "上一轮的图", images: [IMAGE] }]
    });

    expect(messages[1]).toMatchObject({ role: "user", content: "上一轮的图", images: [IMAGE] });
  });

  it("更早用户消息的图片换成文本占位（content 仍是 string，图片字段摘掉）", () => {
    const other = { mime: "image/webp", data: "WFla" };
    const messages = buildMessages({
      userPrompt: "那这张呢",
      history: [
        { role: "user", content: "第一张图", images: [IMAGE] },
        { role: "assistant", content: "第一张是截图" },
        { role: "user", content: "第二张图", images: [other] },
        { role: "assistant", content: "第二张也是截图" }
      ]
    });

    // 更早的一条：图片字段摘掉、content 尾部追加占位
    expect(messages[1]).toEqual({ role: "user", content: "第一张图\n\n[用户曾发送一张图片]" });
    expect("images" in messages[1]).toBe(false);
    // 最近一条带图用户消息：原样重发
    expect(messages[3]).toEqual({ role: "user", content: "第二张图", images: [other] });
  });

  it("本轮自带图片：历史里的图片全部让位为占位（最近一条用户消息是本轮这条）", () => {
    const messages = buildMessages({
      userPrompt: "看这张",
      images: [IMAGE],
      history: [
        { role: "user", content: "上一轮的图", images: [{ mime: "image/webp", data: "WFla" }] },
        { role: "assistant", content: "上一轮的回答" }
      ]
    });

    expect(messages[1]).toEqual({ role: "user", content: "上一轮的图\n\n[用户曾发送一张图片]" });
    expect(messages[3]).toEqual({ role: "user", content: "看这张", images: [IMAGE] });
  });

  it("一条消息多张图：占位按张数措辞", () => {
    const other = { mime: "image/webp", data: "WFla" };
    const messages = buildMessages({
      userPrompt: "追问",
      history: [
        { role: "user", content: "两张图", images: [IMAGE, other] },
        { role: "assistant", content: "好" },
        { role: "user", content: "最近一轮", images: [other] }
      ]
    });

    expect(messages[1]).toEqual({ role: "user", content: "两张图\n\n[用户曾发送 2 张图片]" });
    expect(messages[3]).toEqual({ role: "user", content: "最近一轮", images: [other] });
  });

  it("带 tool_calls / tool_call_id 的历史消息换占位时其余字段保留", () => {
    const messages = buildMessages({
      userPrompt: "追问",
      includeToolHistory: true,
      history: [
        { role: "user", content: "联网问过", images: [IMAGE] },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "[]" },
        { role: "user", content: "最近一轮", images: [{ mime: "image/webp", data: "WFla" }] }
      ]
    });

    expect(messages[1]).toEqual({ role: "user", content: "联网问过\n\n[用户曾发送一张图片]" });
    expect(messages[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(messages[4]).toEqual({ role: "user", content: "最近一轮", images: [{ mime: "image/webp", data: "WFla" }] });
  });
});
