// Script 工具栏按钮注入/降级/自查契约（工单 button-injection-stability/02
// 锚点层级收拢 + 01 快路径 + 充电专属视频工具栏右侧槽位）。
//
// 用例走真实模块（不 mock script-button 的任何依赖），完整锁验收项：
// - 快路径（01）：模块求值即寻锚注入，不等 window.load / video 轮询 / settle
//   余量；首次挂载打注入耗时日志；
// - 锚点层级：
//   ①「稿件举报」左侧（多信号判定：类名 + 语义文本，双信号优先）；
//   ② 工具栏右侧槽位（未充电的充电专属视频等场景下 B 站不渲染 .video-toolbar-right，
//     工具栏宿主内仅有 .video-toolbar-left，此时挂在 .video-toolbar-left 之后，
//     margin-left:auto 占右侧槽位）；
//   若①与②均不满足（如 .video-toolbar-right 在场但无举报节点，或工具栏宿主缺席），
//   不注入按钮，绝不浮动挂载到播放器内部（#biliscript-script-overlay 已退役）；
// - 短暂失配宽限：命中过①的页面，①失配后宽限 2 拍不降级/移除、已挂载按钮不动
//   （挡掉 B 站重渲染间隙的闪动），宽限耗尽后按②或摘除收敛；期间①恢复则原地
//   留守；②位挂载后若①出现则升回①位；
// - 宿主即时观察器：工具栏宿主在位后，「稿件举报」插入经 MutationObserver
//   微任务级落位（按钮与它同拍出现），不等 200ms 自查节拍；节拍退为宿主
//   发现的兜底；
// - 幂等（重复注入不重复插按钮）；
// - 非 /video/ 页自查主动移除按钮、回到 /video/ 页补回。
//
// 定时器全文件 fake：模块生命周期含 200ms 自查 interval，真实时钟下用例间
// 残留 interval 会在下一用例的时间窗开火（与
// player-ai-guard.test.js 同一环境问题），fake 后未触发的回调随 afterEach 的
// useRealTimers 一并丢弃。点击消息路径的派发同源断言见
// tests/entry/toolbar-action-script.test.ts（content dispatch == in-page button）。

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

function makeToolbarHtml({ withComplaint = true, withRight = true } = {}) {
  const complaint = withComplaint
    ? '<div class="video-complaint"><span>稿件举报</span></div>'
    : "";
  const right = withRight
    ? `<div class="video-toolbar-right">${complaint}<div class="video-note"></div></div>`
    : "<!---->";
  return `
    <div id="arc_toolbar_report">
      <div class="video-toolbar-left"><div class="video-toolbar-left-main"></div></div>
      ${right}
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
    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("首次挂载打注入耗时日志（默认开启）", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();
    expect(document.getElementById("biliscript-script-button")).not.toBeNull();

    const timingLog = infoSpy.mock.calls.find((args) =>
      args.join(" ").includes("装载→挂载耗时")
    );
    expect(timingLog).toBeDefined();
  });
});

describe("script-button 注入锚点层级（①举报左侧 / ②充电视频工具栏右侧槽位 / 不浮动）", () => {
  it("锚点①：命中「稿件举报」时按钮落在其左侧", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    await loadModule();

    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    // 紧邻「稿件举报」左侧：后一个兄弟就是 complaint 本尊
    expect(button.nextElementSibling).toBe(complaint);
    // 工具栏位：#fb7299 粉底药丸 + margin-right: 16px
    expect(button.style.background).toBe("rgb(251, 114, 153)");
    expect(button.style.marginRight).toBe("16px");
  });

  it("锚点①：complaint 不在 #arc_toolbar_report 宿主内（稍后再看页形态）仍按多信号命中", async () => {
    // 稍后再看等列表播放页的工具栏没有 #arc_toolbar_report 这层 id 宿主，
    // 多信号判定必须兜底命中。
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

    const button = document.getElementById("biliscript-script-button")!;
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

    const button = document.getElementById("biliscript-script-button")!;
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

    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("锚点②（未充电的充电专属视频）：.video-toolbar-right 缺席时按钮挂在 .video-toolbar-left 之后（工具栏右侧槽位）", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withRight: false })}${makePlayerHtml()}<video src="blob:test"></video>`;
    const host = document.getElementById("arc_toolbar_report")!;
    const left = host.querySelector(".video-toolbar-left")!;

    await loadModule();

    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(host);
    expect(button.previousElementSibling).toBe(left);
    expect(button.style.background).toBe("rgb(251, 114, 153)");
    expect(button.style.marginLeft).toBe("auto");
    expect(document.getElementById("biliscript-script-overlay")).toBeNull();
  });

  it("锚点①落空且 .video-toolbar-right 在场：不注入按钮，绝不降级播放器浮动层", async () => {
    // 普通视频水合中（.video-toolbar-right 已在场但举报节点未挂载）或改版失配时：
    // 既不塞进 .video-toolbar-right 尾部，也不插在左右栏之间，更不在播放器内浮窗。
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false, withRight: true })}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();
    expect(document.getElementById("biliscript-script-button")).toBeNull();
    expect(document.getElementById("biliscript-script-overlay")).toBeNull();

    await vi.advanceTimersByTimeAsync(15000);
    expect(document.getElementById("biliscript-script-button")).toBeNull();
    expect(document.getElementById("biliscript-script-overlay")).toBeNull();
  });

  it("工具栏宿主缺席：即使播放器容器在场也不挂浮动按钮", async () => {
    document.body.innerHTML = `${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();
    await vi.advanceTimersByTimeAsync(15000);

    expect(document.getElementById("biliscript-script-button")).toBeNull();
    expect(document.getElementById("biliscript-script-overlay")).toBeNull();
  });
});

describe("script-button 失配宽限与升降级", () => {
  it("①命中后 complaint 被摘走且 .video-toolbar-right 仍在：宽限期内已挂载按钮留守，宽限耗尽后摘除（不挂浮动层）", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    document.body.innerHTML = `${makeToolbarHtml()}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const right = document.querySelector(".video-toolbar-right")!;
    const button = document.getElementById("biliscript-script-button")!;
    expect(button.parentElement).toBe(right);

    // 举报节点被移除（按钮仍在 DOM）：观察器微任务触发首轮自查（进入宽限，beats 2→1）
    document.querySelector(".video-complaint")!.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("biliscript-script-button")).toBe(button);

    // 第 1 拍：宽限中（beats 1→0），按钮仍留守
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("biliscript-script-button")).toBe(button);

    // 第 2 拍：宽限耗尽，因 .video-toolbar-right 仍在（不满足②），孤立按钮被摘除且无浮动层
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("biliscript-script-button")).toBeNull();
    expect(document.getElementById("biliscript-script-overlay")).toBeNull();
    expect(infoSpy.mock.calls.some((args) => args.join(" ").includes("宽限耗尽"))).toBe(true);
  });

  it("工具栏先出壳、举报节点后渲染：按钮直接落①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    expect(document.getElementById("biliscript-script-button")).toBeNull();
    const right = document.querySelector(".video-toolbar-right")!;
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.insertBefore(complaint, right.firstElementChild);
    await vi.advanceTimersByTimeAsync(201);

    const button = document.getElementById("biliscript-script-button")!;
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
    expect(document.getElementById("biliscript-script-overlay")).toBeNull();
  });

  it("宿主在位后「稿件举报」插入：观察器微任务落位，不等 200ms 节拍", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    expect(document.getElementById("biliscript-script-button")).toBeNull();
    const right = document.querySelector(".video-toolbar-right")!;
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.insertBefore(complaint, right.firstElementChild);

    await vi.advanceTimersByTimeAsync(0);

    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("宽限期内 complaint 恢复：按钮留在工具栏①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    // 重渲染：举报节点短暂消失一拍后回来（Vue 重渲染换新节点）
    document.getElementById("biliscript-script-button")!.remove();
    document.querySelector(".video-complaint")!.remove();
    await vi.advanceTimersByTimeAsync(201);
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    const right = document.querySelector(".video-toolbar-right")!;
    right.insertBefore(complaint, right.firstElementChild);

    await vi.advanceTimersByTimeAsync(201);

    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("先落锚点②（无 .video-toolbar-right）后 .video-toolbar-right 与举报节点挂载：0ms 升回①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withRight: false })}${makePlayerHtml()}<video src="blob:test"></video>`;
    const host = document.getElementById("arc_toolbar_report")!;
    const left = host.querySelector(".video-toolbar-left")!;

    await loadModule();

    let button = document.getElementById("biliscript-script-button")!;
    expect(button.previousElementSibling).toBe(left);
    expect(button.style.marginLeft).toBe("auto");

    // 随后 .video-toolbar-right（含稿件举报）挂载：观察器同步感知并把按钮升回①位
    const right = document.createElement("div");
    right.className = "video-toolbar-right";
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.appendChild(complaint);
    host.appendChild(right);

    await vi.advanceTimersByTimeAsync(0);

    button = document.getElementById("biliscript-script-button")!;
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
    expect(button.style.marginRight).toBe("16px");
    expect(button.style.marginLeft).toBe("");
  });
});

describe("script-button 幂等与自查", () => {
  it("幂等：重复注入不重复插按钮（锚点①与锚点②均幂等）", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    const { injectScriptButton } = await loadModule();

    injectScriptButton();
    injectScriptButton();

    expect(document.querySelectorAll("#biliscript-script-button").length).toBe(1);
    expect(complaint.previousElementSibling!.id).toBe("biliscript-script-button");
  });

  it("幂等（锚点②）：充电视频工具栏右侧槽位重复注入不重建按钮", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withRight: false })}<video src="blob:test"></video>`;
    const left = document.querySelector(".video-toolbar-left")!;

    const { injectScriptButton } = await loadModule();
    const first = document.getElementById("biliscript-script-button")!;

    injectScriptButton();
    injectScriptButton();

    expect(document.querySelectorAll("#biliscript-script-button").length).toBe(1);
    expect(document.getElementById("biliscript-script-button")).toBe(first);
    expect(first.previousElementSibling).toBe(left);
  });

  it("自查周期：非 /video/ 页主动移除按钮；回到 /video/ 页补回", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    expect(document.getElementById("biliscript-script-button")).not.toBeNull();

    // SPA 换到非 /video/ 页：下一个自查周期摘除按钮
    setLocationUrl("https://www.bilibili.com/");
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("biliscript-script-button")).toBeNull();

    // 换回播放页：按钮补回（幂等注入）
    setLocationUrl(NORMAL_PAGE_URL);
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("biliscript-script-button")).not.toBeNull();
  });

  it("自查周期：稍后再看页（/list/watchlater?bvid=）是视频播放页，不摘按钮", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    setLocationUrl("https://www.bilibili.com/list/watchlater?bvid=BV1test000000");

    await loadModule();

    expect(document.getElementById("biliscript-script-button")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("biliscript-script-button")).not.toBeNull();
  });

  it("健康态自查零扫描：按钮就位时一拍只 getElementById 一次，不寻锚", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const byId = vi.spyOn(document, "getElementById");
    const docAll = vi.spyOn(document, "querySelectorAll");
    const elementAll = vi.spyOn(Element.prototype, "querySelectorAll");
    await vi.advanceTimersByTimeAsync(201);

    expect(byId.mock.calls.map((args) => args[0])).toEqual(["biliscript-script-button"]);
    expect(docAll).not.toHaveBeenCalled();
    expect(elementAll).not.toHaveBeenCalled();
  });

  it("零扫描早退不豁免失同步：按钮被挪走或席位被换掉的那一拍仍补回①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const right = document.querySelector(".video-toolbar-right")!;
    const button = document.getElementById("biliscript-script-button")!;
    right.appendChild(button);

    await vi.advanceTimersByTimeAsync(201);

    expect(button.nextElementSibling!.className).toBe("video-complaint");
  });
});

describe("script-button 失锚期事件化（02）", () => {
  it("失锚期 tick 只做轻探测：宿主缺席时一拍不跑全树扫描", async () => {
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
    document.body.innerHTML = `${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();
    expect(document.getElementById("biliscript-script-button")).toBeNull();

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

    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("宿主整棵替换：目标失活后下一拍归位新宿主，观察器重挂新宿主子树", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();

    const oldHost = document.getElementById("arc_toolbar_report")!;
    const oldRight = oldHost.querySelector(".video-toolbar-right");
    expect(document.getElementById("biliscript-script-button")!.parentElement).toBe(oldRight);

    const newHost = document.createElement("div");
    newHost.id = "arc_toolbar_report";
    newHost.innerHTML =
      '<div class="video-toolbar-right"><div class="video-complaint"><span>稿件举报</span></div><div class="video-note"></div></div>';
    oldHost.replaceWith(newHost);
    const newRight = newHost.querySelector(".video-toolbar-right");
    const firstComplaint = newHost.querySelector(".video-complaint");

    await vi.advanceTimersByTimeAsync(201);
    const button = document.getElementById("biliscript-script-button")!;
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(newRight);
    expect(button.nextElementSibling).toBe(firstComplaint);

    const secondComplaint = document.createElement("div");
    secondComplaint.className = "video-complaint";
    secondComplaint.textContent = "稿件举报";
    firstComplaint!.replaceWith(secondComplaint);

    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("biliscript-script-button")!.nextElementSibling).toBe(secondComplaint);
  });
});
