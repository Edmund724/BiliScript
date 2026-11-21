import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";

type ScriptButtonModule = typeof import("../../extension/ui/script-button.js");

let loadedScriptButton: ScriptButtonModule | null = null;

async function loadModule(): Promise<ScriptButtonModule> {
  const lazy = await import("../../extension/ui/lazy-script-button.js");
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

describe("script-button 快路径（01）", () => {
  it("装载即注入：不等 settle 链，模块求值后按钮已在锚点①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint")!;

    await loadModule();

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
    expect(button.nextElementSibling).toBe(complaint);
    expect(button.style.background).toBe("rgb(251, 114, 153)");
    expect(button.style.marginRight).toBe("16px");
  });

  it("锚点①：complaint 不在 #arc_toolbar_report 宿主内（稍后再看页形态）仍按多信号命中", async () => {
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

    document.querySelector(".video-complaint")!.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("biliscript-script-button")).toBe(button);

    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("biliscript-script-button")).toBe(button);

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

    setLocationUrl("https://www.bilibili.com/");
    await vi.advanceTimersByTimeAsync(201);
    expect(document.getElementById("biliscript-script-button")).toBeNull();

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
