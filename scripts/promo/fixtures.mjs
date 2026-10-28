import {CDP, sleep, waitFor} from "../browser-harness/harness.mjs";
import {click} from "./lib.mjs";

const OVERVIEW = {
  phase: "ready",
  aiChapters: true,
  chapterSourceKind: "auto",
  progressText: "",
  errorText: "",
  analysis: {
    chapters: [
      {
        from: 0,
        title: "机器幻觉的成因：大模型的评分机制与语言本质",
        summary: "通过考试猜题的类比，解释大模型训练机制中“答错不扣分、答对得非零分、不答得零分”的逻辑，说明模型宁可“蒙”也不空着；同时指出对话模型只模仿语言规律，追求“说得像人”而非“事实正确”。"
      },
      {
        from: 152,
        title: "幻觉无法彻底避免：商业价值与数据局限",
        summary: "分析若模型过度谨慎只会回答“不知道”则失去商业价值。即使给出大量精确数据，也无法推测无关联的事实（如知道全班49人生日也猜不出第50个），因此幻觉无法彻底杜绝，只能通过横向比对和多重查证来降低。"
      },
      {
        from: 267,
        title: "人机协作国际象棋实验：适配重于强弱",
        summary: "介绍一项“强AI与弱搭档”协作的下象棋实验，每步由随机机制决定谁落子。结果显示懂得为同伴留后路、注重协作的组合击败了单纯追求最强算力的组合，证明协作中强弱并非决定因素。"
      },
      {
        from: 389,
        title: "挑选AI的法则：相互接得上才是放大器",
        summary: "总结选择AI工具的标准不是越强越好，而是彼此能不能接得上思路与输出。强调AI是能力的“放大器”而非凭空创造的“创造器”，关键在于能否赋能人类完成过去敢想而不敢为的事。"
      }
    ],
    quotes: [
      {
        from: 130,
        content: "他只要去答这个题目，得的就不是零分，但是他如果不答一定是零分。我们训练大模型的时候就是这样训练的，那么在这种情况下，他一定会去蒙。"
      },
      {
        from: 179,
        content: "它模仿的只是语言规律。对于它来说，只要这句话说得像个人说的自然语言就成了，而不在乎它是不是事实，它并不知道什么是事实。"
      },
      {
        from: 396,
        content: "他所做的东西你都能接得上，然后你给他的东西他也能接得上，只有相互之间接得上、能够在很大程度上对齐的才是最好的，不一定是最强的。如果他说的东西你都看不懂，对你来说是毫无价值的。"
      }
    ],
    failedRanges: []
  }
};

export async function restoreRealOverview(cdp, target, {generatedFor, chapterCount = 4, quoteCount = 3}) {
  await click(cdp, `document.getElementById('biliscript-reading-tab-overview')`);
  const isolated = await CDP.connect(target.webSocketDebuggerUrl);
  try {
    const contexts = [];
    isolated.on("Runtime.executionContextCreated", ({context}) => contexts.push(context));
    await isolated.send("Runtime.enable");
    await sleep(100);
    const context = contexts.find((item) => item.origin.startsWith("chrome-extension://") && item.auxData?.type === "isolated");
    if (!context) throw new Error("找不到扩展内容脚本上下文");
    const fixture = {
      ...OVERVIEW,
      generatedFor,
      analysis: {
        ...OVERVIEW.analysis,
        chapters: OVERVIEW.analysis.chapters.slice(0, chapterCount),
        quotes: OVERVIEW.analysis.quotes.slice(0, quoteCount)
      }
    };
    const result = await isolated.send("Runtime.evaluate", {
      contextId: context.id,
      expression: `(async () => {
        const reader = await import(chrome.runtime.getURL('entry/chunks/reader.mjs'));
        reader.closeQuoteShareModal();
        reader.renderReadingOverview(${JSON.stringify(fixture)});
        document.getElementById('biliscript-reading-overview-body').scrollTop = 0;
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  } finally {
    isolated.close();
  }
  await waitFor("真实章节与金句", () => cdp.evaluate(`document.querySelectorAll('#biliscript-reading-overview-body .biliscript-reading-ov-chapter').length === ${chapterCount} && document.querySelectorAll('#biliscript-reading-overview-body [data-overview-action="share-quote"]').length === ${quoteCount}`), {timeoutMs: 15000});
}
