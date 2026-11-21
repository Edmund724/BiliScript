import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let explainIntent: typeof import("../../extension/reader/explain-intent.js");

function makeIntentCard(): HTMLDivElement {
  const card = document.createElement("div");
  card.hidden = true;
  card.innerHTML = `
    <span class="biliscript-reading-chat-intent-title"></span>
    <blockquote class="biliscript-reading-chat-intent-quote"></blockquote>
    <span class="biliscript-reading-chat-intent-time"></span>
    <button type="button" data-chat-intent-action="send">发送</button>
    <button type="button" data-chat-intent-action="cancel">取消</button>
  `;
  document.body.appendChild(card);
  return card;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  explainIntent = await import("../../extension/reader/explain-intent.js");
});

describe("待解释意图契约（reader/explain-intent）", () => {
  it("单槽覆盖、快照隔离、clear 清理与消费一次语义", async () => {
    const card = makeIntentCard();
    const sendPrompt = vi.fn().mockResolvedValue(true);
    const controller = explainIntent.createExplainIntentController({ card, sendPrompt });

    await controller.consumeIfPending();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(card.hidden).toBe(true);

    const draft = { from: 12, content: "句子甲", createdAt: 1000 };
    explainIntent.setPendingExplainIntent(draft);
    draft.content = "被外部篡改";

    explainIntent.setPendingExplainIntent({ from: 34, content: "句子乙", createdAt: 2000 });
    await controller.consumeIfPending();

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][0]).toContain("句子乙");
    expect(sendPrompt.mock.calls[0][0]).toContain("0:34");
    expect(card.hidden).toBe(true);

    sendPrompt.mockClear();
    await controller.consumeIfPending();
    expect(sendPrompt).not.toHaveBeenCalled();

    explainIntent.setPendingExplainIntent({ from: 1, content: "待清句", createdAt: 3 });
    explainIntent.clearPendingExplainIntent();
    await controller.consumeIfPending();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(card.hidden).toBe(true);
  });

  it("发送未受理（返回 false）保留待解释意图与引用卡，后续可重试发送", async () => {
    const card = makeIntentCard();
    const sendPrompt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const controller = explainIntent.createExplainIntentController({ card, sendPrompt });

    explainIntent.setPendingExplainIntent({ from: 10, content: "重试句", createdAt: 1000 });
    await controller.consumeIfPending();

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".biliscript-reading-chat-intent-title")?.textContent).toBe("待解释的字幕句");
    expect(card.querySelector(".biliscript-reading-chat-intent-quote")?.textContent).toBe("「重试句」");
    expect(card.querySelector(".biliscript-reading-chat-intent-time")?.textContent).toBe("0:10");

    card.querySelector<HTMLButtonElement>('[data-chat-intent-action="send"]')!.click();
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(card.hidden).toBe(true);
  });

  it("selection 归一化：选中词句进提示词与引用卡；全句选中或纯空白按整句处理", async () => {
    const card = makeIntentCard();
    const sendPrompt = vi.fn().mockResolvedValue(true);
    const controller = explainIntent.createExplainIntentController({ card, sendPrompt });

    explainIntent.setPendingExplainIntent({
      from: 5,
      content: "我们习惯将其视为传递信息的工具",
      selection: "传递信息的工具",
      createdAt: 1000
    });
    sendPrompt.mockResolvedValueOnce(false);
    await controller.consumeIfPending();
    expect(card.querySelector(".biliscript-reading-chat-intent-quote")?.textContent).toBe(
      "「传递信息的工具」｜我们习惯将其视为传递信息的工具"
    );
    expect(sendPrompt.mock.calls[0][0]).toContain("解释我选中的词句：「传递信息的工具」");

    explainIntent.setPendingExplainIntent({ from: 6, content: "同一句", selection: "同一句", createdAt: 1 });
    sendPrompt.mockResolvedValueOnce(false);
    await controller.consumeIfPending();
    expect(card.querySelector(".biliscript-reading-chat-intent-quote")?.textContent).toBe("「同一句」");
    expect(sendPrompt.mock.calls[1][0]).toContain("解释这句字幕：「同一句」");

    explainIntent.setPendingExplainIntent({ from: 7, content: "句", selection: "   ", createdAt: 1 });
    await controller.consumeIfPending();
    expect(card.querySelector(".biliscript-reading-chat-intent-quote")?.textContent).toBe("「句」");
    expect(sendPrompt.mock.calls[2][0]).toContain("解释这句字幕：「句」");
  });

  it("explanation：非空解释不自动发送并供追问拼接，纯空白按普通解释请求处理", async () => {
    const card = makeIntentCard();
    const onFocusInput = vi.fn();
    const sendPrompt = vi.fn().mockResolvedValue(true);
    const controller = explainIntent.createExplainIntentController({
      card,
      sendPrompt,
      onFocusInput
    });

    explainIntent.setPendingExplainIntent({
      from: 8,
      content: "原句",
      selection: "词",
      explanation: "  解释正文  ",
      createdAt: 100
    });
    await controller.consumeIfPending();

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(onFocusInput).toHaveBeenCalledTimes(1);
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".biliscript-reading-chat-intent-title")?.textContent).toBe("基于当前解释继续追问");
    expect(card.querySelector<HTMLButtonElement>('[data-chat-intent-action="send"]')?.hidden).toBe(true);
    expect(controller.buildFollowUpPrompt("再举个例子")).toBe(
      "针对选区「词」（出自字幕「原句」，0:08）的已有解释：\n解释正文\n\n追问：再举个例子"
    );

    controller.completePendingFollowUp();
    expect(card.hidden).toBe(true);
    expect(controller.buildFollowUpPrompt("后续问题")).toBe("后续问题");

    explainIntent.setPendingExplainIntent({
      from: 9,
      content: "无解释句",
      explanation: "   ",
      createdAt: 200
    });
    await controller.consumeIfPending();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][0]).toContain("无解释句");
  });

  it("在途回合守卫与取消按钮直接绑定：忙碌期提示不发，取消清槽隐卡并归还焦点", async () => {
    const card = makeIntentCard();
    const onFocusInput = vi.fn();
    const onNotice = vi.fn();
    const sendPrompt = vi.fn().mockResolvedValue(true);
    let active = true;
    const controller = explainIntent.createExplainIntentController({
      card,
      sendPrompt,
      isTurnActive: () => active,
      onNotice,
      onFocusInput
    });

    explainIntent.setPendingExplainIntent({
      from: 12,
      content: "测试字幕句",
      createdAt: 300
    });
    await controller.consumeIfPending();

    expect(card.hidden).toBe(false);
    expect(onNotice).toHaveBeenCalledWith("当前对话正在生成，待本轮结束后可继续追问或发送。", 4000);
    expect(sendPrompt).not.toHaveBeenCalled();

    card.querySelector<HTMLButtonElement>('[data-chat-intent-action="cancel"]')!.click();
    expect(card.hidden).toBe(true);
    expect(onFocusInput).toHaveBeenCalledTimes(1);
    expect(sendPrompt).not.toHaveBeenCalled();

    active = false;
    explainIntent.setPendingExplainIntent({
      from: 12,
      content: "测试字幕句",
      createdAt: 400
    });
    card.querySelector<HTMLButtonElement>('[data-chat-intent-action="send"]')!.click();
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(card.hidden).toBe(true);
  });
});
