// Script 工具栏按钮注入/降级/自查契约（工单 button-injection-stability/02
// 锚点层级收拢 + 01 快路径后）。
//
// 用例走真实模块（不 mock script-button 的任何依赖），完整锁验收项：
// - 快路径（01）：模块求值即寻锚注入，不等 window.load / video 轮询 / settle
//   余量；首次挂载打注入耗时日志；
// - 锚点层级收拢：只剩两级——①「稿件举报」左侧（多信号判定：类名 + 语义文本，
//   双信号优先）→ ④播放器浮动降级；②（.video-toolbar-right 尾部）与③（旧版
//   .video-toolbar-left-main）已退役，①落空时它们在场也不得收留按钮；
// - 短暂失配宽限：命中过①的页面，①失配后宽限 2 拍（~1.6s）不降级、已挂载
//   按钮不动（挡掉 B 站重渲染间隙的闪漂），宽限耗尽才降④；期间①恢复则原地
//   留守；降④后①恢复则升回①位；
// - 首载等待窗：init 相位（首载/新开页）①未就绪时暂不注入（等工具栏渲染，
//   不闪在视频右上角），窗耗尽（~10s）才降④兜底；期间①就绪则直接落①位；
// - 宿主即时观察器：工具栏宿主在位后，「稿件举报」插入经 MutationObserver
//   微任务级落位（按钮与它同拍出现），不等 200ms 自查节拍；节拍退为宿主
//   发现的兜底；
// - 幂等（重复注入不重复插按钮）；
// - 非 /video/ 页自查主动移除按钮、回到 /video/ 页补回。
//
// 定时器全文件 fake：模块生命周期含 200ms 自查 interval，真实时钟下用例间
// 残留 interval 会在下一用例的时间窗开火（与
// player-ai-guard.test.js 同一环境问题），fake 后未触发的回调随 afterEach 的
// useRealTimers 一并丢弃。点击消息路径断言拆到 script-button-click.test.js
// （那边要 vi.mock 重依赖，独立模块纪元避免污染本文件的真实模块用例）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";

// 本文件最后一个加载的模块实例：afterEach 用它断观察器。失锚期宽档观察器
// 挂在 body 上，不随 innerHTML 清空而失活，不断掉会让上一用例的回调在
// 下一用例的 DOM 里空转（02 失锚期事件化后出现的宽档挂点）。
type ScriptButtonModule = typeof import("../../extension/ui/script-button.js");

let loadedScriptButton: ScriptButtonModule | null = null;

async function loadModule(): Promise<ScriptButtonModule> {
  const lazy = await import("../../extension/ui/lazy-script-button.js");
  // lazy-script-button 的 ScriptButtonDomain 只声明消费方最小面
  //（removeScriptButton）；本文件按模块命名空间取 injectScriptButton 直测注入。
  loadedScriptButton = (await lazy.loadScriptButton()) as ScriptButtonModule;
  return loadedScriptButton;
}

function makeToolbarHtml({ withComplaint = true } = {}) {
  const complaint = withComplaint
    ? '<div class="video-complaint"><span>稿件举报</span></div>'
    : "";
  return `
    <div id="arc_toolbar_report">
      <div class="video-toolbar-left"><div class="video-toolbar-left-main"></div></div>
      <div class="video-toolbar-right">${complaint}<div class="video-note"></div></div>
    </div>`;
}

function makePlayerHtml() {
  return `
    <div id="bilibili-player">
      <div class="bpx-player-primary-area"><div class="bpx-player-container"></div></div>
    </div>`;
}

beforeEach(() => {
  resetModuleState();
  // resetModuleState 内部的 useRealTimers 复位后，本文件统一挂 fake 时钟
  vi.useFakeTimers();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
});

afterEach(() => {
  loadedScriptButton?.removeScriptButton();
  loadedScriptButton = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// 模块求值即启动生命周期（01 快路径）：装载即首轮注入并挂 200ms 自查
// interval，无需推进 settle 定时器。

describe("script-button 快路径（01）", () => {
  it("装载即注入：不等 settle 链，模块求值后按钮已在锚点①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    await loadModule();

    // 不推进任何定时器：settle 链（window.load + video 轮询 + 1200ms 余量）
    // 若还在，按钮此刻必然缺席
    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("首次挂载打注入耗时日志（默认开启）", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();
    expect(document.getElementById("boc-script-button")).not.toBeNull();

    const timingLog = infoSpy.mock.calls.find((args) =>
      args.join(" ").includes("装载→挂载耗时")
    );
    expect(timingLog).toBeDefined();
  });
});

describe("script-button 注入锚点层级（02 收拢：①→④）", () => {
  it("锚点①：命中「稿件举报」时按钮落在其左侧", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    await loadModule();

    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    // 紧邻「稿件举报」左侧：后一个兄弟就是 complaint 本尊
    expect(button.nextElementSibling).toBe(complaint);
    // 工具栏位：#fb7299 粉底药丸
    expect(button.style.background).toBe("rgb(251, 114, 153)");
  });

  it("锚点①：complaint 不在 #arc_toolbar_report 宿主内（稍后再看页形态）仍按多信号命中", async () => {
    // 稍后再看等列表播放页的工具栏没有 #arc_toolbar_report 这层 id 宿主，
    // 多信号判定必须兜底命中，否则按钮落到播放器浮动层。
    document.body.innerHTML = `
      <div class="video-toolbar-container">
        <div class="video-toolbar-right">
          <div class="video-complaint video-toolbar-right-item"><span>稿件举报</span></div>
          <div class="video-note"></div>
        </div>
      </div>
      <video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    await loadModule();

    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("锚点①多信号：类名改版但语义文本在场（aria-label）仍命中", async () => {
    // B 站改版常只动其一：类名换成哈希/新词时，aria-label 或文本信号兜底。
    document.body.innerHTML = `
      <div id="arc_toolbar_report">
        <div class="video-toolbar-right">
          <div class="toolbar-item-x8h2" aria-label="稿件举报"><span>举报</span></div>
          <div class="video-note"></div>
        </div>
      </div>
      <video src="blob:test"></video>`;
    const complaint = document.querySelector('[aria-label="稿件举报"]');

    await loadModule();

    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("锚点①多信号：文本改版但类名信号在场仍命中", async () => {
    // 反向：类名 video-complaint 保留、可见文本/属性被改掉（如改成 icon-only
    // 无文字），类名单信号也要能命中。
    document.body.innerHTML = `
      <div id="arc_toolbar_report">
        <div class="video-toolbar-right">
          <div class="video-complaint"><svg></svg></div>
          <div class="video-note"></div>
        </div>
      </div>
      <video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    await loadModule();

    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("锚点①落空：首载等待窗内不注入，窗耗尽才降④（②③在场也不得收留）", async () => {
    // 02 层级收拢：.video-toolbar-right（旧②）与 .video-toolbar-left-main
    //（旧③）在 DOM 里存在也不能当锚点——它们正是「漂到视频下方最右」的
    // 事故现场，①失配一律落④浮动层（位置自控，语义安全）。
    // 首载等待窗：init 相位①未就绪时暂不注入（页面加载中，浮动按钮会闪现在
    // 视频右上角），窗耗尽才降④。
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;
    const right = document.querySelector(".video-toolbar-right")!;
    const leftMain = document.querySelector(".video-toolbar-left-main")!;

    await loadModule();

    // 等待窗内：宁可按钮缺席也不闪在浮动层
    expect(document.getElementById("boc-script-button")).toBeNull();
    expect(document.getElementById("boc-script-overlay")).toBeNull();

    // 窗口耗尽：降④浮动层兜底（推进量需跨过 10000ms 首载等待窗，200ms
    // 节拍下窗后首个 tick 即 ~10000ms）
    await vi.advanceTimersByTimeAsync(11200);
    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(right.contains(button)).toBe(false);
    expect(leftMain.contains(button)).toBe(false);
    const overlay = document.getElementById("boc-script-overlay")!;
    expect(overlay).not.toBeNull();
    expect(overlay.contains(button)).toBe(true);
    expect(overlay.style.position).toBe("absolute");
    expect(overlay.style.top).toBe("12px");
    expect(overlay.style.right).toBe("12px");
  });

  it("holdsVideoDirectly 守卫：<video> 直接父层不挂浮动按钮，落到外层容器", async () => {
    // 首选候选 .bpx-player-primary-area 不直接持 video，应命中它而非 video
    // 的直接父层 .bpx-player-container（那层归播放器管，插节点会推倒重建）。
    document.body.innerHTML = makePlayerHtml();
    document
      .querySelector(".bpx-player-container")!
      .appendChild(Object.assign(document.createElement("video"), { src: "blob:test" }));

    await loadModule();
    await vi.advanceTimersByTimeAsync(11200);

    const overlay = document.getElementById("boc-script-overlay")!;
    expect(overlay).not.toBeNull();
    expect(overlay.parentElement!.className).toBe("bpx-player-primary-area");
  });

  it("浮动宿主候选全落空：不挂按钮也不报错", async () => {
    document.body.innerHTML = "<video></video>";

    await loadModule();

    expect(document.getElementById("boc-script-button")).toBeNull();
    expect(document.getElementById("boc-script-overlay")).toBeNull();
  });
});

describe("script-button 失配宽限与升降级（02）", () => {
  it("①命中后 complaint 被重渲染摘走：宽限期内按钮留守原位，宽限耗尽降④", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    document.body.innerHTML = `${makeToolbarHtml()}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const right = document.querySelector(".video-toolbar-right")!;
    let button = document.getElementById("boc-script-button")!;
    expect(button.parentElement).toBe(right);

    // B 站重渲染：举报节点（连带按钮）被换掉。移除变更本身经观察器微任务
    // 触发一轮自查（进入宽限，beats 2→1），先冲掉微任务再走节拍。
    button.remove();
    document.querySelector(".video-complaint")!.remove();
    await vi.advanceTimersByTimeAsync(0);

    // 第 1 拍：宽限中，不降级
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("boc-script-overlay")).toBeNull();
    // 第 2 拍：宽限耗尽，降级④浮动层
    await vi.advanceTimersByTimeAsync(201);
    const overlay = document.getElementById("boc-script-overlay")!;
    expect(overlay).not.toBeNull();
    button = document.getElementById("boc-script-button")!;
    expect(overlay.contains(button)).toBe(true);
    expect(right.contains(button)).toBe(false);
    // 可观测：降级事件有 console 日志
    expect(infoSpy.mock.calls.some((args) => args.join(" ").includes("script"))).toBe(true);
  });

  it("首载等待窗内工具栏渲染完成：按钮直接落①位，不落浮动层", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    // 页面加载中：工具栏先出壳、举报节点后渲染（用户看到的正是这个间隙里
    // 按钮闪现在视频右上角）
    expect(document.getElementById("boc-script-button")).toBeNull();
    const right = document.querySelector(".video-toolbar-right")!;
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.insertBefore(complaint, right.firstElementChild);
    await vi.advanceTimersByTimeAsync(201);

    const button = document.getElementById("boc-script-button")!;
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
    expect(document.getElementById("boc-script-overlay")).toBeNull();
  });

  it("宿主在位后「稿件举报」插入：观察器微任务落位，不等 200ms 节拍", async () => {
    // 工具栏宿主先渲染、「稿件举报」由 Vue 水合后插入：bindToolbarObserver
    // 的 MutationObserver 应同步感知，按钮与稿件举报同拍出现（推进 0ms，
    // 200ms 自查 tick 未到）。
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    expect(document.getElementById("boc-script-button")).toBeNull();
    const right = document.querySelector(".video-toolbar-right")!;
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.insertBefore(complaint, right.firstElementChild);

    await vi.advanceTimersByTimeAsync(0);

    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("宽限期内 complaint 恢复：按钮留在工具栏①位，不降级", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    // 重渲染：举报节点短暂消失一拍后回来（Vue 重渲染换新节点）
    document.getElementById("boc-script-button")!.remove();
    document.querySelector(".video-complaint")!.remove();
    await vi.advanceTimersByTimeAsync(201);
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    const right = document.querySelector(".video-toolbar-right")!;
    right.insertBefore(complaint, right.firstElementChild);

    await vi.advanceTimersByTimeAsync(201);

    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
    expect(document.getElementById("boc-script-overlay")).toBeNull();
  });

  it("降④后 complaint 恢复：按钮从浮动层升回①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    // 首载①未就绪 → 等待窗内不注入，窗耗尽降④（推进量需跨过 10000ms 窗口，
    // 200ms 节拍下窗后首个 tick 即 ~10000ms）
    expect(document.getElementById("boc-script-button")).toBeNull();
    await vi.advanceTimersByTimeAsync(11200);
    let button = document.getElementById("boc-script-button")!;
    expect(document.getElementById("boc-script-overlay")!.contains(button)).toBe(true);

    // 工具栏渲染完成，举报节点出现 → 下一自查拍升回①
    const right = document.querySelector(".video-toolbar-right")!;
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.insertBefore(complaint, right.firstElementChild);
    await vi.advanceTimersByTimeAsync(201);

    button = document.getElementById("boc-script-button")!;
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
    expect(button.style.background).toBe("rgb(251, 114, 153)");
  });
});

describe("script-button 幂等与自查", () => {
  it("幂等：重复注入不重复插按钮", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    const { injectScriptButton } = await loadModule();

    injectScriptButton();
    injectScriptButton();

    expect(document.querySelectorAll("#boc-script-button").length).toBe(1);
    expect(complaint.previousElementSibling!.id).toBe("boc-script-button");
  });

  it("自查周期：非 /video/ 页主动移除按钮；回到 /video/ 页补回", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    expect(document.getElementById("boc-script-button")).not.toBeNull();

    // SPA 换到非 /video/ 页：下一个自查周期摘除按钮
    setLocationUrl("https://www.bilibili.com/");
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("boc-script-button")).toBeNull();
    expect(document.getElementById("boc-script-overlay")).toBeNull();

    // 换回播放页：按钮补回（幂等注入）
    setLocationUrl(NORMAL_PAGE_URL);
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("boc-script-button")).not.toBeNull();
  });

  it("自查周期：稍后再看页（/list/watchlater?bvid=）是视频播放页，不摘按钮", async () => {
    // 与 content.ts isSupportedUrl 口径一致：watchlater 由 isWatchlaterPage
    // 覆盖。自查若只认 /video/  pathname，按钮会在装载后一个周期被摘掉
    //（用户症状：刚进页看得到，一两秒后消失）。
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    setLocationUrl("https://www.bilibili.com/list/watchlater?bvid=BV1test000000");

    await loadModule();

    expect(document.getElementById("boc-script-button")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("boc-script-button")).not.toBeNull();
  });

  it("健康态自查零扫描：按钮就位时一拍只 getElementById 一次，不寻锚", async () => {
    // 性能红线（与 reader/script-host 的「一拍一搜」同款锁法）：健康态 200ms
    // 一拍、每页每小时约 18000 拍，寻锚全量扫描（工具栏宿主全体 querySelectorAll
    // + 逐节点文本求和）不能留在热路径上。零扫描早退的判据是「按钮挂着 + 后一
    // 个兄弟仍是上次记下的举报节点」，故这里只该剩 getElementById(SCRIPT_BUTTON_ID)。
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const byId = vi.spyOn(document, "getElementById");
    const docAll = vi.spyOn(document, "querySelectorAll");
    const elementAll = vi.spyOn(Element.prototype, "querySelectorAll");
    await vi.advanceTimersByTimeAsync(201);

    expect(byId.mock.calls.map((args) => args[0])).toEqual(["boc-script-button"]);
    expect(docAll).not.toHaveBeenCalled();
    expect(elementAll).not.toHaveBeenCalled();
  });

  it("零扫描早退不豁免失同步：按钮被挪走或席位被换掉的那一拍仍补回①位", async () => {
    // 早退只认「挂着且席位没变」：按钮被挪到工具栏尾部（仍 connected 但后一
    // 个兄弟不再是席位）时必须落到全量路径把它搬回①位，否则 B 站重渲染带来的
    // 挪位会永久留在错误位置。
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const right = document.querySelector(".video-toolbar-right")!;
    const button = document.getElementById("boc-script-button")!;
    right.appendChild(button);

    await vi.advanceTimersByTimeAsync(201);

    expect(button.nextElementSibling!.className).toBe("video-complaint");
  });
});

describe("script-button 失锚期事件化（02）", () => {
  it("失锚期 tick 只做轻探测：宿主缺席时一拍不跑全树扫描", async () => {
    // 02：失锚期（init 首载窗 / 浮动层期）每拍主线程成本降为一次单选择器
    // 查询——findComplaintNode 的宿主全量 querySelectorAll + 全局
    // [class*='complaint'] 兜底不得运行（它在宿主缺席时必无所获）。
    document.body.innerHTML = `${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const docAll = vi.spyOn(document, "querySelectorAll");
    const elementAll = vi.spyOn(Element.prototype, "querySelectorAll");
    const docQuery = vi.spyOn(document, "querySelector");
    await vi.advanceTimersByTimeAsync(3 * 201);

    expect(docAll).not.toHaveBeenCalled();
    expect(elementAll).not.toHaveBeenCalled();
    // 轻探测：单次 querySelector 直接探工具栏宿主。
    expect(
      docQuery.mock.calls.some((args) => args[0] === "#arc_toolbar_report, .video-toolbar-container")
    ).toBe(true);
  });

  it("宿主晚出现：稳定祖先观察器微任务感知，0ms 落①位不等 200ms 节拍", async () => {
    // 首载加载中：工具栏宿主整个未渲染（init 等待窗内）。宿主出现后感知
    // 走观察器（失锚期挂稳定祖先 body），按钮与宿主同拍落位。
    document.body.innerHTML = `${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();
    expect(document.getElementById("boc-script-button")).toBeNull();

    const right = document.createElement("div");
    right.className = "video-toolbar-right";
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.appendChild(complaint);
    const host = document.createElement("div");
    host.id = "arc_toolbar_report";
    host.appendChild(right);
    document.body.appendChild(host);

    await vi.advanceTimersByTimeAsync(0);

    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("宿主整棵替换：目标失活后下一拍归位新宿主，观察器重挂新宿主子树", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const oldHost = document.getElementById("arc_toolbar_report")!;
    const oldRight = oldHost.querySelector(".video-toolbar-right");
    expect(document.getElementById("boc-script-button")!.parentElement).toBe(oldRight);

    // B 站重渲染：工具栏宿主整棵换新（按钮随旧宿主一并被摘走，窄档观察器
    // 挂点断连，靠下一拍的目标失活检测重挂）。
    const newHost = document.createElement("div");
    newHost.id = "arc_toolbar_report";
    newHost.innerHTML =
      '<div class="video-toolbar-right"><div class="video-complaint"><span>稿件举报</span></div><div class="video-note"></div></div>';
    oldHost.replaceWith(newHost);
    const newRight = newHost.querySelector(".video-toolbar-right");
    const firstComplaint = newHost.querySelector(".video-complaint");

    await vi.advanceTimersByTimeAsync(201);
    const button = document.getElementById("boc-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(newRight);
    expect(button.nextElementSibling).toBe(firstComplaint);

    // 观察器已重挂新宿主子树：新一轮「只换举报节点」的重渲染 0ms 内被
    // 感知（若仍挂在断连的旧宿主上，这一步要等下一拍）。
    const secondComplaint = document.createElement("div");
    secondComplaint.className = "video-complaint";
    secondComplaint.textContent = "稿件举报";
    firstComplaint!.replaceWith(secondComplaint);

    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("boc-script-button")!.nextElementSibling).toBe(secondComplaint);
  });

  it("失锚→归锚迁移：浮动层期宿主整棵出现，观察器 0ms 感知即升回①位", async () => {
    document.body.innerHTML = `${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    // 首载等待窗耗尽 → 降④浮动层（失锚期，宿主一直缺席）。
    await vi.advanceTimersByTimeAsync(11200);
    const floating = document.getElementById("boc-script-button")!;
    expect(document.getElementById("boc-script-overlay")!.contains(floating)).toBe(true);

    // 工具栏水合完成，宿主整棵出现 → 观察器同步感知，升回①位。
    const host = document.createElement("div");
    host.id = "arc_toolbar_report";
    host.innerHTML =
      '<div class="video-toolbar-right"><div class="video-complaint"><span>稿件举报</span></div><div class="video-note"></div></div>';
    document.body.insertBefore(host, document.body.firstElementChild);

    await vi.advanceTimersByTimeAsync(0);

    const button = document.getElementById("boc-script-button")!;
    expect(button.parentElement).toBe(host.querySelector(".video-toolbar-right"));
    expect(button.nextElementSibling!.className).toBe("video-complaint");
    // 从④升回时空浮动层一并收走。
    expect(document.getElementById("boc-script-overlay")).toBeNull();
  });
});
