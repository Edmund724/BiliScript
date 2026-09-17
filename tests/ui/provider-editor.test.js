// tests/ui/provider-editor.test.js
// ui/provider-editor.ts 平台编辑 Modal 的行为契约（provider-master-detail/01）。
// 与 settings-panel-save.test.js 同款手法：真实模块 + DOM 仿真，经
// renderReaderSettingsPanel 挂载面板后从「+ 添加平台」/行「编辑」按钮驱动。
//
// 覆盖：
// - 新增保存链（拍板 Q2/Q4）：权限代申请 → 现查权威列表 → upsert 追加 →
//   整列表落盘（协议零改动）→ Modal 关闭 + 列表重渲；
// - 编辑预填（拍板 Q3）：按 id 现查列表项，Key 占位「已保存」，模型目录全量
//   预填为行；保存按原 id 替换非追加；
// - 模型目录（multi-model-catalog 阶段2，拍板 Q3/Q7/Q9/Q10/Q13）：行增删只改
//   草稿（加行即脏），收集 trim/去空行/去重，空目录合法有空态提示；
// - 行级连通测试（拍板 Q4/Q12）：行内 spinner→✓/✕，多行并发、同行重复点击
//   忽略前一个，测试不落盘（绝无保存与权限消息）；ASR 平台级测试保留；
// - 「获取可用模型」弹窗（拍板 Q5/Q11）：地址/Key 前置校验、权限在点击同步
//   链（先于模型请求）、搜索/全选、已添加置灰、失败原位重试、Esc 逐层退出；
// - dirty 保护（拍板 Q6）：有改动弹面板内确认（ui/confirm-dialog.js），无改
//   动直接关；Esc / 点遮罩同走此保护；弹层打开期间 Esc 只关弹层不关编辑器；
// - 面板外点击 capture 拦截：只关 Modal，bubble 委托（抽屉外点关闭）收不到；
// - 删除二次确认：面板内弹层（ui/confirm-dialog.js）叠在编辑器之上，确认才
//   发删除消息，取消不删且编辑器不关；弹层打开期间编辑器的文档级监听让位；
// - 抽屉收起联动：settingsPanel hidden → 强制关闭（丢改动不弹确认）。
//
// chrome.runtime.sendMessage 换装按 type 分发的消息总线；探针与 ASR 模型列表
// 模块整体 mock，隔离 fetch。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

function installMessageBus(overrides = {}) {
  const responders = {
    "get-settings": () => ({ ok: true, settings: {} }),
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  };
  const sent = [];
  chrome.runtime.sendMessage = vi.fn((message, callback) => {
    sent.push(message);
    const respond = responders[message.type];
    callback?.(respond ? respond(message) : { ok: true });
    return undefined;
  });
  return sent;
}

// 面板 + 编辑 Modal 的挂载环境：Modal 宿主挂 #boc-reading-view 直下
//（provider-editor.ensureHost），设置抽屉 hidden 联动监听挂在
// #boc-reading-settings-panel 上，两者都须在 DOM 里。
async function mountPanel(busOverrides = {}) {
  document.body.innerHTML = `
    <div id="boc-reading-view">
      <section id="boc-reading-settings-panel">
        <div id="boc-reading-settings-host"></div>
      </section>
    </div>
  `;
  const sent = installMessageBus(busOverrides);
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("boc-reading-settings-host");
  await vi.waitFor(() => {
    expect(chrome.runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return { sent, host };
}

async function openEditor(host, buttonSelectorOrElement) {
  const { isProviderEditorOpen } = await import("../../extension/ui/provider-editor.js");
  fireClick(typeof buttonSelectorOrElement === "string" ? host.querySelector(buttonSelectorOrElement) : buttonSelectorOrElement);
  await vi.waitFor(() => {
    expect(document.querySelector(".provider-editor-dialog")).toBeTruthy();
  });
  return { dialog: document.querySelector(".provider-editor-dialog"), isProviderEditorOpen };
}

function editorGone() {
  return document.querySelector(".provider-editor-host") === null;
}

// 单发 click（tests/setup.js 的 click 补丁会双发事件，见 settings-panel-save.test.js 文件头）
function fireClick(node) {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// 纯微任务冲刷：等待事件处理器里 await 消息链走完
async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function messageTypes(sent) {
  return sent.map((message) => message.type);
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  // 部分用例故意断言「取消不删/不关」后半段，编辑器在用例结束时仍开着——
  // 其文档级 capture 监听（Esc/外点）不随 innerHTML 清场摘除，会抢先拦截
  // 后续用例的同名事件。统一强制收尾（幂等，已关的直接返回）。
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("provider-editor：新增保存链（拍板 Q2/Q4）", () => {
  it("AI 新增：权限代申请 → 现查列表 → upsert 追加 → 整列表落盘，成功后关 Modal 并重渲列表", async () => {
    const savedList = [{ id: "p_new1", presetId: "custom", name: "自定义", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true }];
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: savedList })
    });

    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    // 新增默认「自定义」预设（与平铺行空白行一致）：baseUrl 空、Key 必填占位
    expect(dialog.querySelector(".provider-editor-preset").value).toBe("custom");
    expect(dialog.querySelector(".provider-editor-baseurl").value).toBe("");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("API Key");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    // 模型目录：「+ 添加模型」加空白行，行内输入模型 ID
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    dialog.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });

    // 手势同步链：权限代申请先于落盘（零先行 await，见 options-save-gesture 断言）。
    // 用 lastIndexOf：装载阶段（mountPanel）已各发过一次 list 消息，取保存链那趟。
    const types = messageTypes(sent);
    expect(types).toContain("request-provider-origins");
    expect(types.indexOf("request-provider-origins")).toBeLessThan(types.lastIndexOf("ai-providers-list"));
    expect(types.lastIndexOf("ai-providers-list")).toBeLessThan(types.indexOf("ai-providers-save"));
    expect(sent.find((message) => message.type === "request-provider-origins").baseUrls).toEqual(["https://api.example.com/v1"]);

    // 整列表落盘（协议零改动）：权威列表（空）+ upsert 追加，id 由 p_ 前缀生成
    const saveMessage = sent.find((message) => message.type === "ai-providers-save");
    expect(saveMessage.providers).toHaveLength(1);
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "custom",
      name: "自定义",
      baseUrl: "https://api.example.com/v1",
      models: ["gpt-4o-mini"],
      requiresKey: true,
      enabled: true,
      apiKey: "sk-test"
    });
    expect(saveMessage.providers[0].id).toMatch(/^p_/);

    // 保存成功：Modal 关闭 + 用响应列表（含 hasSavedKey）重渲
    expect(editorGone()).toBe(true);
    expect(host.querySelectorAll("#aiProvidersList .ai-provider-row")).toHaveLength(1);
    expect(host.querySelector("#aiProvidersList .ai-provider-row").dataset.hasSavedKey).toBe("1");
  });

  it("ASR 新增：type/presetId 落入报文，保存后重渲", async () => {
    const savedList = [{ id: "asr_new1", presetId: "custom", name: "自定义", type: "openai-transcriptions", baseUrl: "https://asr.example.com/v1", model: "whisper-1", supportsTimestamps: true, enabled: true, hasSavedKey: true }];
    const { sent, host } = await mountPanel({
      "asr-providers-save": () => ({ ok: true, providers: savedList })
    });

    const { dialog } = await openEditor(host, "#addAsrProviderBtn");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("API Key");

    dialog.querySelector(".provider-editor-baseurl").value = "https://asr.example.com/v1";
    dialog.querySelector(".provider-editor-model").value = "whisper-1";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "asr-providers-save")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "asr-providers-save");
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "custom",
      type: "openai-transcriptions",
      name: "自定义",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-1"
    });
    expect(saveMessage.providers[0].id).toMatch(/^asr_/);
    expect(editorGone()).toBe(true);
    expect(host.querySelectorAll("#asrProvidersList .asr-provider-row")).toHaveLength(1);
  });

  it("AI 校验失败（缺 Key）：状态行报错不关 Modal，不落盘", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    dialog.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    const status = dialog.querySelector(".provider-editor-status");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("平台「自定义」需要填写 API Key");
    expect(status.dataset.error).toBe("true");
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(editorGone()).toBe(false);
  });

  it("权限代申请被拒：状态行报错不落盘不关 Modal", async () => {
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => ({ ok: false, error: "未授权 https://api.example.com/*，保存已中止" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    // 模型目录：「+ 添加模型」加空白行，行内输入模型 ID
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    dialog.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog.querySelector(".provider-editor-status").textContent).toContain("未授权");
    });
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(editorGone()).toBe(false);
  });

  it("ai-providers-save 失败：状态行报错、busy 复位、Modal 不关", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: false, error: "sync 配额不足" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    // 模型目录：「+ 添加模型」加空白行，行内输入模型 ID
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    dialog.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog.querySelector(".provider-editor-status").textContent).toBe("sync 配额不足");
    });
    expect(dialog.querySelector(".provider-editor-save").disabled).toBe(false);
    expect(editorGone()).toBe(false);
  });
});

describe("provider-editor：编辑预填与 upsert 替换（拍板 Q3）", () => {
  const aiItem = { id: "p1", presetId: "custom", name: "我的端点", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini", "gpt-4o"], requiresKey: true, enabled: true, hasSavedKey: true };

  it("按 id 现查权威列表项预填（模型目录全量预填行）；Key 占位「已保存」；保存按原 id 替换非追加", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-save": () => ({ ok: true, providers: [{ ...aiItem, models: ["gpt-4o"] }] })
    });

    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit"));

    // 预填：presetId/baseUrl 来自列表项；模型目录全部预填为行；Key 不回传（占位「已保存」）
    expect(dialog.querySelector(".provider-editor-preset").value).toBe("custom");
    expect(dialog.querySelector(".provider-editor-baseurl").value).toBe("https://api.example.com/v1");
    expect(
      Array.from(dialog.querySelectorAll(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(dialog.querySelector(".provider-editor-apikey").value).toBe("");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("已保存");
    // AI 自定义名称（≠预设名）回填实值
    expect(dialog.querySelector(".provider-editor-name").value).toBe("我的端点");

    dialog.querySelector(".provider-editor-model-id").value = "gpt-4";
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "ai-providers-save");
    expect(saveMessage.providers).toHaveLength(1);
    expect(saveMessage.providers[0]).toMatchObject({ id: "p1", name: "我的端点", models: ["gpt-4", "gpt-4o"], baseUrl: "https://api.example.com/v1" });
    expect(editorGone()).toBe(true);
  });

  it("AI 名称留空回落预设名；名称自定义（≠预设名）则随保存落盘", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    // 留空 → 预设名「自定义」
    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    dialog.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";
    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save").providers[0].name).toBe("自定义");
  });
});

describe("provider-editor：协议下拉（multi-protocol-ai 设置 UI 章）", () => {
  it("新增 AI：协议下拉默认 OpenAI、限制点小字隐藏；保存报文写入显式 protocol", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const protocolSelect = dialog.querySelector(".provider-editor-protocol");
    expect(protocolSelect, "AI Modal 应渲染协议下拉").not.toBeNull();
    expect(protocolSelect.value).toBe("openai");
    // openai 的 capabilities.unsupported 为空：限制点小字不露出
    expect(dialog.querySelector(".provider-editor-protocol-notes").hidden).toBe(true);

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    dialog.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save").providers[0].protocol).toBe("openai");
  });

  it("存量记录缺 protocol 字段：编辑显示「OpenAI」（无提示），保存回写显式值", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "我的端点", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };
    const { sent, host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-save": () => ({ ok: true, providers: [aiItem] })
    });

    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit"));

    expect(dialog.querySelector(".provider-editor-protocol").value).toBe("openai");

    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save").providers[0].protocol).toBe("openai");
  });

  it("编辑 anthropic 记录：预填选中且限制点小字露出；切协议小字随之刷新", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "claude", baseUrl: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-5"], requiresKey: true, enabled: true, hasSavedKey: true, protocol: "anthropic" };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] })
    });

    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit"));

    const protocolSelect = dialog.querySelector(".provider-editor-protocol");
    const notes = dialog.querySelector(".provider-editor-protocol-notes");
    expect(protocolSelect.value).toBe("anthropic");
    expect(notes.hidden).toBe(false);
    expect(notes.textContent).toContain("该协议限制");
    expect(notes.textContent).toContain("disable_parallel_tool_use");

    // 切 responses：小字换成 responses 的限制说明
    protocolSelect.value = "responses";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(notes.hidden).toBe(false);
    expect(notes.textContent).toContain("sequence_number");

    // 切回 openai：unsupported 为空，小字收起
    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(notes.hidden).toBe(true);
  });

  it("预设切换联动默认归属、允许用户改：未改跟随新预设默认，改过的选择不覆盖", async () => {
    const presets = [
      { id: "proxied", name: "代理平台", baseUrl: "https://proxy.example.com/v1", requiresKey: true, protocol: "anthropic" },
      { id: "custom", name: "自定义", baseUrl: "", requiresKey: true, protocol: "responses" }
    ];
    const { host } = await mountPanel({
      "ai-presets-list": () => ({ ok: true, presets })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector(".provider-editor-preset");
    const protocolSelect = dialog.querySelector(".provider-editor-protocol");
    // 新增默认 custom 预设：协议回落该预设默认归属
    expect(protocolSelect.value).toBe("responses");

    // 当前值仍是上一预设默认 → 跟随 proxied 的默认 anthropic
    presetSelect.value = "proxied";
    presetSelect.dispatchEvent(new Event("change"));
    expect(protocolSelect.value).toBe("anthropic");

    // 用户手动改成 openai → 切预设不覆盖用户选择
    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    presetSelect.value = "custom";
    presetSelect.dispatchEvent(new Event("change"));
    expect(protocolSelect.value).toBe("openai");
  });

  it("协议下拉选项名为 OpenAI / Anthropic / Responses（统一风格）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const labels = Array.from(dialog.querySelectorAll(".provider-editor-protocol option")).map((option) => option.textContent);
    expect(labels).toEqual(["OpenAI", "Anthropic", "Responses"]);
  });

  it("切协议联动 baseUrl：未改过跟随该预设的协议端点（DeepSeek /v1 ↔ /anthropic），改过的值不覆盖", async () => {
    const presets = [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" } },
      { id: "custom", name: "自定义", baseUrl: "", requiresKey: true }
    ];
    const { host } = await mountPanel({
      "ai-presets-list": () => ({ ok: true, presets })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector(".provider-editor-preset");
    const protocolSelect = dialog.querySelector(".provider-editor-protocol");
    const baseUrlInput = dialog.querySelector(".provider-editor-baseurl");
    presetSelect.value = "deepseek";
    presetSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/v1");

    // 切 Anthropic：默认值跟随登记端点；切回 OpenAI：跟随默认 baseUrl
    protocolSelect.value = "anthropic";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/anthropic");
    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/v1");

    // 用户手改过 baseUrl：切协议不再覆盖
    baseUrlInput.value = "https://my-proxy.example.com/v1";
    protocolSelect.value = "anthropic";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://my-proxy.example.com/v1");
  });


  it("切协议即脏：取消先弹 dirty 确认弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const protocolSelect = dialog.querySelector(".provider-editor-protocol");
    protocolSelect.value = "responses";
    protocolSelect.dispatchEvent(new Event("change"));

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-confirm"), "切协议应触发 dirty 保护").not.toBeNull();
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);
  });
});

describe("provider-editor：头部删除按钮（用户拍板：× 改警示删除，编辑态提供）", () => {
  const aiItem = { id: "p1", presetId: "custom", name: "自定义", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };

  it("编辑态：头部显示删除按钮；面板内确认后发删除消息 + 权限回收现查 + 重渲 + 关 Modal", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-save": () => ({ ok: true, providers: [] }),
      "ai-providers-delete": () => ({ ok: true, providers: [] })
    });

    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit"));

    const deleteBtn = dialog.querySelector(".provider-editor-delete");
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.textContent).toBe("删除");

    // 二次确认走面板内弹层（ui/confirm-dialog.js）：弹层叠在编辑器之上
    //（z-index 50 > 40），点「取消」不删除、编辑器不关
    fireClick(deleteBtn);
    const confirmButton = document.querySelector(".confirm-dialog-confirm");
    expect(confirmButton, "删除二次确认弹层应已打开").not.toBeNull();
    expect(confirmButton.textContent).toBe("删除");
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    });
    expect(sent.some((message) => message.type === "ai-providers-delete")).toBe(false);
    expect(editorGone()).toBe(false);

    // 点「删除」：确认链走通（编辑器的文档级 Esc/外点监听在弹层打开期间让位）
    fireClick(deleteBtn);
    fireClick(document.querySelector(".confirm-dialog-confirm"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-delete")).toBe(true);
    });
    // 回收 orphan origin 需现查两组存活列表（AI 一组在打开时已查，ASR 一组在删除时查）
    expect(sent.some((message) => message.type === "asr-providers-list")).toBe(true);
    expect(sent.find((message) => message.type === "ai-providers-delete").providerId).toBe("p1");
    expect(editorGone()).toBe(true);
  });

  it("新增态：不渲染删除按钮（无可删对象）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    expect(dialog.querySelector(".provider-editor-delete")).toBeNull();
  });
});

describe("provider-editor：dirty 保护与关闭语义（拍板 Q6）", () => {
  it("有改动：取消先弹面板内确认——拒绝不关，放弃更改才关；弹层打开期间 Esc 只关弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";

    // 取消按钮：dirty 确认弹层（ui/confirm-dialog.js，与删除二次确认同源）
    fireClick(dialog.querySelector(".provider-editor-cancel"));
    let confirmBtn = document.querySelector(".confirm-dialog-confirm");
    expect(confirmBtn, "dirty 确认弹层应已打开").not.toBeNull();
    expect(confirmBtn.textContent).toBe("放弃更改");
    expect(document.querySelector(".confirm-dialog-message").textContent).toBe("未保存的更改将丢失，确定关闭？");
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);

    // 弹层再开时按 Esc：编辑器文档级监听让位，Esc 只关弹层不关编辑器
    fireClick(dialog.querySelector(".provider-editor-cancel"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);

    // 放弃更改：确认后关
    fireClick(dialog.querySelector(".provider-editor-cancel"));
    confirmBtn = document.querySelector(".confirm-dialog-confirm");
    fireClick(confirmBtn);
    await vi.waitFor(() => expect(editorGone()).toBe(true));
  });

  it("无改动：取消直接关，不弹确认弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    expect(editorGone()).toBe(true);
  });

  it("Esc 关闭（走 dirty 保护）；点遮罩关闭", async () => {
    const { host } = await mountPanel();
    await openEditor(host, "#addAiProviderBtn");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(editorGone()).toBe(true);

    // 遮罩是 host 直下的 dialog 兄弟节点，从 document 查
    await openEditor(host, "#addAiProviderBtn");
    fireClick(document.querySelector(".provider-editor-mask"));
    expect(editorGone()).toBe(true);
  });

  it("保存成功后直接关（不因字段快照≠初始而弹确认弹层）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    dialog.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => expect(editorGone()).toBe(true));
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });
});

// 拍板 Q10 推论：目录行增删只改草稿——加一行即脏，取消先 confirm
describe("provider-editor：模型目录草稿语义（拍板 Q10/Q7/Q13）", () => {
  it("「+ 添加模型」加空白行、行内删除即移除，全部只改草稿", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    // 新增态 0 行：空态提示可见（Q13）
    const empty = dialog.querySelector(".provider-editor-catalog-empty");
    expect(empty.hidden).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-model-add"));
    expect(dialog.querySelectorAll(".provider-editor-model-row")).toHaveLength(1);
    expect(dialog.querySelector(".provider-editor-catalog-empty").hidden).toBe(true);

    // 加行即脏：取消先弹面板内确认（草稿语义只改 DOM，无任何消息）
    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-message").textContent).toBe("未保存的更改将丢失，确定关闭？");
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-model-remove"));
    expect(dialog.querySelectorAll(".provider-editor-model-row")).toHaveLength(0);
    expect(dialog.querySelector(".provider-editor-catalog-empty").hidden).toBe(false);

    // 删回 0 行后与快照一致：取消直接关
    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(editorGone()).toBe(true);
  });

  it("收集时 trim / 去空行 / 去重（Q7）", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    // 三行：带空白、重复 ID、纯空行
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    const inputs = dialog.querySelectorAll(".provider-editor-model-id");
    inputs[0].value = "  gpt-4o-mini ";
    inputs[1].value = "gpt-4o-mini";
    inputs[2].value = "   ";

    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save").providers[0].models).toEqual(["gpt-4o-mini"]);
  });

  it("空目录合法：0 行保存落盘 models: []（Q13）", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";

    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save").providers[0].models).toEqual([]);
    expect(editorGone()).toBe(true);
  });
});

// 行级连通测试（拍板 Q4/Q12）：每行用该行输入框当前的模型 ID 发 ping（复用
// testAiProviderConnection 探针路径），行内原地反馈（spinner → ✓/✕，失败原因
// 在 title）；多行并发、同行重复点击忽略前一个；测试不落盘（8a5f249 语义保持：
// 绝无保存与权限消息）。平台级测试按钮已被行级替代（AI 侧不渲染）。
describe("provider-editor：行级测试连接（拍板 Q4/Q12，只验证连通性不落盘）", () => {
  function addModelRowWithValue(dialog, value) {
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    const row = dialog.querySelector(".provider-editor-model-row:last-child");
    row.querySelector(".provider-editor-model-id").value = value;
    return row;
  }

  it("AI 不渲染平台级测试按钮；行级测试成功：spinner→✓、探针直调、不落盘", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    expect(dialog.querySelector(".provider-editor-test")).toBeNull();

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));
    // 在飞：loading 态 + 按钮禁用
    expect(row.querySelector(".provider-editor-model-result").dataset.state).toBe("loading");
    expect(row.querySelector(".provider-editor-model-test").disabled).toBe(true);

    // 探针直调（新增 id 为空 → providerId 空串，Key 随参数携带），模型取行内值，
    // 协议取表单下拉当前值（multi-protocol-ai）
    await vi.waitFor(() => {
      expect(testAiProviderConnection).toHaveBeenCalledWith({
        providerId: "",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        protocol: "openai"
      });
    });
    await vi.waitFor(() => {
      expect(row.querySelector(".provider-editor-model-result").dataset.state).toBe("ok");
    });
    // 测试成功不写设置：绝无保存与权限消息，Modal 不关
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
    expect(editorGone()).toBe(false);
    expect(row.querySelector(".provider-editor-model-test").disabled).toBe(false);
  });

  it("行级测试失败：行内 ✕ + title 原因，不落盘", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    testAiProviderConnection.mockImplementationOnce(async () => ({ ok: false, error: "quota exceeded" }));
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));

    await vi.waitFor(() => {
      expect(row.querySelector(".provider-editor-model-result").dataset.state).toBe("error");
    });
    expect(row.querySelector(".provider-editor-model-result").title).toBe("失败：quota exceeded");
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(row.querySelector(".provider-editor-model-test").disabled).toBe(false);
  });

  it("缺模型 ID / 缺 API 地址：行内提示且不调探针", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const row = addModelRowWithValue(dialog, "");
    fireClick(row.querySelector(".provider-editor-model-test"));
    expect(row.querySelector(".provider-editor-model-result").dataset.state).toBe("error");
    expect(row.querySelector(".provider-editor-model-result").title).toBe("请先填写模型 ID");

    row.querySelector(".provider-editor-model-id").value = "gpt-4o-mini";
    fireClick(row.querySelector(".provider-editor-model-test"));
    expect(row.querySelector(".provider-editor-model-result").title).toBe("请先填写 API 地址");
    expect(testAiProviderConnection).not.toHaveBeenCalled();
  });

  it("行级测试随表单协议下拉走：切到 Anthropic 探针带 protocol:anthropic（multi-protocol-ai）", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    const protocolSelect = dialog.querySelector(".provider-editor-protocol");
    protocolSelect.value = "anthropic";
    protocolSelect.dispatchEvent(new Event("change"));
    const row = addModelRowWithValue(dialog, "claude-sonnet-4-5");

    fireClick(row.querySelector(".provider-editor-model-test"));

    await vi.waitFor(() => {
      expect(testAiProviderConnection).toHaveBeenCalledWith(
        expect.objectContaining({ protocol: "anthropic" })
      );
    });
  });

  it("多行并发测试互不阻塞，各行用自己的模型 ID", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    let resolveFirst;
    testAiProviderConnection
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ ok: true }));
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    const rowA = addModelRowWithValue(dialog, "gpt-4o-mini");
    const rowB = addModelRowWithValue(dialog, "gpt-4o");

    fireClick(rowA.querySelector(".provider-editor-model-test"));
    fireClick(rowB.querySelector(".provider-editor-model-test"));

    // B 后点先到终点：多行并发，A 的在飞不阻塞 B
    await vi.waitFor(() => {
      expect(rowB.querySelector(".provider-editor-model-result").dataset.state).toBe("ok");
    });
    expect(rowA.querySelector(".provider-editor-model-result").dataset.state).toBe("loading");
    expect(testAiProviderConnection).toHaveBeenCalledTimes(2);

    resolveFirst({ ok: true });
    await vi.waitFor(() => {
      expect(rowA.querySelector(".provider-editor-model-result").dataset.state).toBe("ok");
    });
  });

  it("同一行重复点击：忽略前一个（后点者的结果落定）", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    let resolveFirst;
    testAiProviderConnection
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ ok: false, error: "model not found" }));
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));
    // 在飞中重复点击：发第二次探针（行内当前值），前一个结果随后被忽略
    row.querySelector(".provider-editor-model-id").value = "gpt-4o";
    fireClick(row.querySelector(".provider-editor-model-test"));
    expect(testAiProviderConnection).toHaveBeenCalledTimes(2);

    // 第一次探针慢返回成功，但已被忽略；行内落定的是第二次的 ✕
    resolveFirst({ ok: true });
    await vi.waitFor(() => {
      expect(row.querySelector(".provider-editor-model-result").dataset.state).toBe("error");
    });
    expect(row.querySelector(".provider-editor-model-result").title).toBe("失败：model not found");
  });

  it("ASR 保留平台级测试按钮且行为不变（ASR 侧不动）", async () => {
    const { testAsrConnection } = await import("../../extension/asr/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    expect(dialog.querySelector(".provider-editor-test")).not.toBeNull();

    dialog.querySelector(".provider-editor-baseurl").value = "https://asr.example.com/v1";
    dialog.querySelector(".provider-editor-model").value = "whisper-1";

    fireClick(dialog.querySelector(".provider-editor-test"));

    await vi.waitFor(() => {
      expect(testAsrConnection).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(dialog.querySelector(".provider-editor-status").textContent).toBe("连接成功");
    });
  });
});

describe("provider-editor：与设置抽屉的层级联动", () => {
  it("面板外点击：capture 拦截，只关 Modal，bubble 委托（抽屉外点关闭）收不到该点击", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const bubbleSpy = vi.fn();
    document.addEventListener("click", bubbleSpy);
    try {
      // 派发到 body（#boc-reading-view 之外）→ Modal 的 capture 监听 stopPropagation
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(bubbleSpy).not.toHaveBeenCalled();
      expect(editorGone()).toBe(true);
    } finally {
      document.removeEventListener("click", bubbleSpy);
    }
  });

  it("Modal 内点击不外传：document bubble 委托（抽屉外点关闭）收不到，Modal 不关", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const bubbleSpy = vi.fn();
    document.addEventListener("click", bubbleSpy);
    try {
      // 模拟 ui-renderer 的抽屉外点关闭委托（document bubble）：Modal 宿主在
      // settingsPanel 判定域之外，放行会把抽屉一起收掉（回归：实施首版正败于此）
      dialog.querySelector(".provider-editor-body").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(bubbleSpy).not.toHaveBeenCalled();
      expect(editorGone()).toBe(false);
    } finally {
      document.removeEventListener("click", bubbleSpy);
    }
  });

  it("Modal 内点下拉组件外收起模型下拉（ASR；settings-panel 文档级委托收不到不外传的点击，语义在 Modal 内自持）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://asr.example.com/v1";
    // 模型下拉已在 DOM（hidden），置开再点组件外空白验证收起
    const dropdown = dialog.querySelector(".ai-provider-model-dropdown");
    dropdown.hidden = false;

    dialog.querySelector(".provider-editor-name").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dropdown.hidden).toBe(true);
  });

  it("设置抽屉收起（hidden）时 Modal 强制关闭：dirty 也不弹确认弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";

    document.getElementById("boc-reading-settings-panel").hidden = true;
    await vi.waitFor(() => {
      expect(editorGone()).toBe(true);
    });
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });
});

describe("provider-editor：预设切换（Modal 内不代申请权限）", () => {
  it("AI：baseUrl 未改过才跟随新预设；名称空则占位符跟随；切预设不发权限消息", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const select = dialog.querySelector(".provider-editor-preset");
    const baseUrlInput = dialog.querySelector(".provider-editor-baseurl");

    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("http://localhost:11434/v1");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("API Key（可选）");

    // 用户改过 baseUrl → 不覆盖
    baseUrlInput.value = "https://my-proxy.example.com/v1";
    select.value = "openai_compat";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://my-proxy.example.com/v1");

    await flushMicrotasks();
    // 拍板 Q5 推论：Modal 内切预设不代申请，权限在保存时统一收口
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
  });

  it("ASR：模型名/名称无条件跟随，Key 清空", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    dialog.querySelector(".provider-editor-apikey").value = "sk-old";
    const select = dialog.querySelector(".provider-editor-preset");

    select.value = "local-whisper";
    select.dispatchEvent(new Event("change"));

    expect(dialog.querySelector(".provider-editor-baseurl").value).toBe("http://localhost:8000/v1");
    expect(dialog.querySelector(".provider-editor-model").value).toBe("whisper-large-v3");
    expect(dialog.querySelector(".provider-editor-name").value).toBe("本地 Whisper 服务");
    expect(dialog.querySelector(".provider-editor-apikey").value).toBe("");
  });
});

// 未保存的新平台没有模型名就存不下去，而没授权时模型列表请求只会 CORS 失败：
// 「获取可用模型」的「先看看有哪些模型」是打破死锁的手势——权限申请落在这次
// 点击上（multi-model-catalog 阶段2，AI 侧弹窗取代了下拉箭头；ASR 仍走
// model-picker 箭头）。
describe("provider-editor：「获取可用模型」弹窗（拍板 Q5/Q11）", () => {
  it("地址/Key 未填：目录区行内红字提示，不申请权限、不发模型请求", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    const error = dialog.querySelector(".provider-editor-catalog-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("请先填写 API 地址和 Key");
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
    expect(sent.some((message) => message.type === "ai-providers-models")).toBe(false);
  });

  it("拉取成功：权限先于模型请求；搜索过滤；全选；勾选追加为目录行（草稿，不落盘）", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini", "gpt-4o", "o1-mini"] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://token.sensenova.cn/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(3);
    });
    const types = messageTypes(sent);
    expect(types.indexOf("request-provider-origins")).toBeLessThan(types.indexOf("ai-providers-models"));
    expect(sent.find((message) => message.type === "request-provider-origins").baseUrls).toEqual(["https://token.sensenova.cn/v1"]);

    // 搜索过滤
    const search = document.querySelector(".provider-editor-fetch-search");
    search.value = "gpt";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(3);

    // 全选 → 计数同步 → 确认追加（草稿态：绝无保存消息）
    fireClick(document.querySelector(".provider-editor-fetch-all"));
    const confirmBtn = document.querySelector(".provider-editor-fetch-confirm");
    expect(confirmBtn.textContent).toBe("添加所选 (3)");
    fireClick(confirmBtn);

    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(
      Array.from(dialog.querySelectorAll(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o", "o1-mini"]);
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
  });

  it("已在目录中的模型置灰标注「已添加」，不可勾选", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "自定义", baseUrl: "https://token.sensenova.cn/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini", "gpt-4o"] })
    });
    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit"));

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    });
    const addedCheck = document.querySelector('.provider-editor-fetch-check[value="gpt-4o-mini"]');
    expect(addedCheck.disabled).toBe(true);
    expect(addedCheck.closest(".provider-editor-fetch-item").textContent).toContain("已添加");

    // 全选不覆盖置灰项：只剩目录外 1 个可勾
    fireClick(document.querySelector(".provider-editor-fetch-all"));
    expect(document.querySelectorAll(".provider-editor-fetch-check:checked")).toHaveLength(1);
    fireClick(document.querySelector(".provider-editor-fetch-confirm"));
    expect(
      Array.from(dialog.querySelectorAll(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("拉取失败：弹窗原位报错可重试；重试成功渲染列表", async () => {
    let modelsResponder = () => ({ ok: false, error: "HTTP 401: unauthorized" });
    const { host } = await mountPanel({
      "ai-providers-models": (message) => modelsResponder(message)
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://token.sensenova.cn/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-fetch-error").hidden).toBe(false);
    });
    expect(document.querySelector(".provider-editor-fetch-error").textContent).toContain("HTTP 401");

    modelsResponder = () => ({ ok: true, models: ["gpt-4o-mini"] });
    fireClick(document.querySelector(".provider-editor-fetch-retry"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    });
    expect(document.querySelector(".provider-editor-fetch-error").hidden).toBe(true);
  });

  it("权限被拒：弹窗原位报错且不发注定 CORS 失败的模型请求", async () => {
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => ({ ok: false, error: "未授权 https://token.sensenova.cn/*，操作已中止：请在权限弹窗中选择允许后重试" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://token.sensenova.cn/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-fetch-error").textContent).toContain("未授权");
    });
    expect(sent.some((message) => message.type === "ai-providers-models")).toBe(false);
    // 取消关弹窗不关 Modal
    fireClick(document.querySelector(".provider-editor-fetch-cancel"));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(editorGone()).toBe(false);
  });

  it("Esc 逐层退出：先关弹窗不关 Modal，再 Esc 弹 dirty 确认，放弃更改后关 Modal", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini"] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://token.sensenova.cn/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(editorGone()).toBe(false);

    // baseUrl/Key 已填（dirty）：第二下 Esc 不直关，弹面板内 dirty 确认
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(editorGone()).toBe(false);
    expect(document.querySelector(".confirm-dialog-message").textContent).toBe("未保存的更改将丢失，确定关闭？");

    fireClick(document.querySelector(".confirm-dialog-confirm"));
    await vi.waitFor(() => expect(editorGone()).toBe(true));
  });
});

describe("provider-editor：ASR 模型下拉箭头先申请域名权限（model-picker，ASR 侧保留）", () => {
  it("ASR：点箭头 → 先申请权限再调 listAsrModels", async () => {
    const { listAsrModels } = await import("../../extension/asr/provider-models.js");
    listAsrModels.mockResolvedValueOnce({ ok: true, models: ["whisper-1"] });
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://asr.example.com/v1";
    fireClick(dialog.querySelector(".ai-provider-model-toggle"));

    await vi.waitFor(() => {
      expect(dialog.querySelector('.ai-provider-model-option[data-model="whisper-1"]')).toBeTruthy();
    });
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(true);
    expect(listAsrModels).toHaveBeenCalled();
  });
});

// M9 校验态现代化：字段级错误态不再走手写 input-error 类，改为原生约束
//（required / pattern）+ reader-settings-providers.css 的 :user-invalid/:user-valid
// CSS 校验态——浏览器只在用户提交过值（blur）或尝试提交后才进入
// :user-invalid，天然满足「仅在用户交互后展示错误」。这里锁定属性面：
// 保存链报文语义与校验口径零改动（JS validators 仍是权威，上方用例覆盖）。
describe("provider-editor：原生约束校验属性（:user-invalid CSS 校验态的属性面）", () => {
  it("新增 AI（custom 预设）：baseUrl required+pattern、Key required；模型目录行无原生必填（空目录合法 Q13）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const baseUrl = dialog.querySelector(".provider-editor-baseurl");
    expect(baseUrl.required).toBe(true);
    expect(baseUrl.getAttribute("pattern")).toBe("https?://.+");
    expect(dialog.querySelector(".provider-editor-model")).toBeNull();
    expect(dialog.querySelector(".provider-editor-apikey").required).toBe(true);
  });

  it("切换到免 Key 预设（ollama）：Key required 摘除，切回必填预设恢复", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    const select = dialog.querySelector(".provider-editor-preset");
    const apikey = dialog.querySelector(".provider-editor-apikey");

    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    expect(apikey.required).toBe(false);

    select.value = "openai_compat";
    select.dispatchEvent(new Event("change"));
    expect(apikey.required).toBe(true);
  });

  it("编辑已存 Key 的平台：Key 不 required（空值沿用已存 Key）", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "自定义", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] })
    });
    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit"));

    expect(dialog.querySelector(".provider-editor-apikey").required).toBe(false);
  });

  it("ASR Modal：baseUrl required+pattern、模型名 required 同样就位", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    expect(dialog.querySelector(".provider-editor-baseurl").required).toBe(true);
    expect(dialog.querySelector(".provider-editor-baseurl").getAttribute("pattern")).toBe("https?://.+");
    expect(dialog.querySelector(".provider-editor-model").required).toBe(true);
    expect(dialog.querySelector(".provider-editor-apikey").required).toBe(true);
  });

  it("可达性桥：blur/input 同步 aria-invalid 不抛错；jsdom 无 :user-invalid 判定时属性面保持干净", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    const baseUrl = dialog.querySelector(".provider-editor-baseurl");

    // 有效值 input + blur：桥照常运行（Chrome 上 matches(":user-invalid") 为 false
    // → 摘属性；jsdom 恒 false，负向路径一致）
    baseUrl.value = "https://api.example.com/v1";
    baseUrl.dispatchEvent(new Event("input", { bubbles: true }));
    baseUrl.dispatchEvent(new FocusEvent("blur"));
    expect(baseUrl.getAttribute("aria-invalid")).toBeNull();

    // 非输入控件（dialog 本身、按钮）不进桥
    expect(() => dialog.dispatchEvent(new FocusEvent("blur"))).not.toThrow();
    expect(() => dialog.querySelector(".provider-editor-save").dispatchEvent(new Event("input", { bubbles: true }))).not.toThrow();
    expect(dialog.querySelector(".provider-editor-save").getAttribute("aria-invalid")).toBeNull();
  });
});

// ADR-0007（设置页下拉统一下拉组件）覆盖 AI 与 ASR 两侧：AI 侧曾漏接，
// 原生 select 在三方站点上由浏览器绘制弹层（直角 + 系统高亮），与 Modal 内
// 其余 8px 框割裂——用户报告的正是这一处。
describe("provider-editor：平台预设走 custom-select（AI/ASR 两侧）", () => {
  it.each([
    ["AI", "#addAiProviderBtn", "ollama", "http://localhost:11434/v1"],
    ["ASR", "#addAsrProviderBtn", "local-whisper", "http://localhost:8000/v1"]
  ])("%s：原生 select 被组件接管，选项点击写回值并派生 change", async (_label, button, optionValue, expectedBaseUrl) => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, button);

    const select = dialog.querySelector(".provider-editor-preset");
    const wrapper = select.closest(".custom-select-wrapper");
    expect(wrapper).toBeTruthy();
    expect(select.dataset.customSelectInitialized).toBe("1");
    expect(select.classList.contains("custom-select-hidden")).toBe(true);
    expect(select.closest(".provider-editor-host")).toBeTruthy();

    const trigger = wrapper.querySelector(".custom-select-trigger");
    const option = wrapper.querySelector(`.custom-select-option[data-value="${optionValue}"]`);
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(option).toBeTruthy();

    fireClick(option);
    expect(select.value).toBe(optionValue);
    expect(trigger.querySelector(".custom-select-value").textContent).toBe(option.textContent);
    // change 由组件派生：预设切换的既有接线（baseUrl/名称/Key 跟随）照常生效
    expect(dialog.querySelector(".provider-editor-baseurl").value).toBe(expectedBaseUrl);
  });
});
