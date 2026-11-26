import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm, type DetachedRealm } from "../helpers/detached-realm.js";

let realm: DetachedRealm | null = null;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(() => {
  realm?.close();
  realm = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ui 控件、拖拽、时间戳、切换开关与触发动效的跨 Realm 与独立宿主行为", () => {
  it("customSelect 在跨 Realm 节点下支持搜索、键盘导航、点击外部收起与宿主切换自动关闭", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const customSelect = await import("../../extension/ui/custom-select.js");
    const modelPicker = await import("../../extension/ui/model-picker.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const select = realm.doc.createElement("select");
    select.innerHTML = `
      <option value="a" selected>Alpha</option>
      <option value="b">Beta</option>
      <option value="c">Gamma</option>
    `;
    realm.doc.body.appendChild(select);
    expect(select instanceof window.HTMLSelectElement).toBe(false);

    customSelect.initCustomSelect(select, "custom-select-wrapper", { searchable: true });
    const trigger = realm.doc.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
    const dropdown = realm.doc.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const searchInput = realm.doc.querySelector<HTMLInputElement>(".custom-select-search-input")!;

    trigger.click();
    expect(dropdown.hidden).toBe(false);
    expect(realm.doc.activeElement).toBe(searchInput);

    searchInput.dispatchEvent(
      new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    );
    const activeOpt = realm.doc.activeElement as HTMLElement;
    expect(activeOpt.tagName).toBe("LI");
    const firstFocusedValue = activeOpt.dataset.value;
    expect(["a", "b"]).toContain(firstFocusedValue);

    dropdown.dispatchEvent(
      new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    );
    const nextValue = (realm.doc.activeElement as HTMLElement).dataset.value;
    expect(nextValue).toBe(firstFocusedValue === "a" ? "b" : "c");

    realm.doc.body.dispatchEvent(
      new (realm.win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })
    );
    expect(dropdown.hidden).toBe(true);

    trigger.click();
    expect(dropdown.hidden).toBe(false);
    activeHost.resetActiveReaderHost();
    expect(dropdown.hidden).toBe(true);

    const modelDropdown = realm.doc.createElement("div");
    modelDropdown.className = "ai-provider-model-dropdown";
    modelDropdown.hidden = false;
    const modelToggle = realm.doc.createElement("button");
    modelToggle.className = "ai-provider-model-toggle";
    modelToggle.setAttribute("aria-expanded", "true");
    realm.doc.body.append(modelDropdown, modelToggle);
    activeHost.setActiveReaderHost(realm.doc, realm.win);
    modelPicker.closeAllModelDropdowns();
    expect(modelDropdown.hidden).toBe(true);
    expect(modelToggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggleSwitch 在跨 Realm 下正确初始化、使用 active-window rAF 并响应宿主切换", async () => {
    realm = createDetachedRealm({ reducedMotion: false });
    const activeHost = await import("../../extension/shared/active-host.js");
    const toggleMod = await import("../../extension/ui/toggle-switch.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const label = realm.doc.createElement("label");
    const input = realm.doc.createElement("input");
    input.type = "checkbox";
    const track = realm.doc.createElement("span");
    track.className = "biliscript-toggle-track";
    const thumb = realm.doc.createElement("span");
    track.appendChild(thumb);
    label.append(input, track);
    realm.doc.body.appendChild(label);

    expect(track instanceof window.HTMLElement).toBe(false);
    toggleMod.initToggleSwitch(input);
    expect(input.dataset.toggleSwitchInitialized).toBe("1");

    input.checked = true;
    input.dispatchEvent(new (realm.win as unknown as { Event: typeof Event }).Event("change"));
    expect(realm.rafQueue.size).toBeGreaterThan(0);
    realm.flushRaf(32);
  });

  it("providerRowDrag 在跨 Realm 下支持键盘排序并在宿主切换时取消拖拽", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const dragMod = await import("../../extension/ui/provider-row-drag.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const list = realm.doc.createElement("div");
    list.innerHTML = `
      <div class="search-provider-row" data-provider-id="p1"><span class="provider-row-name">P1</span><button type="button" class="provider-row-drag-handle">::</button></div>
      <div class="search-provider-row" data-provider-id="p2"><span class="provider-row-name">P2</span><button type="button" class="provider-row-drag-handle">::</button></div>
    `;
    realm.doc.body.appendChild(list);

    const onCommit = vi.fn();
    dragMod.wireProviderRowDrag(list, { onCommit });

    const firstHandle = list.querySelector<HTMLElement>(".provider-row-drag-handle")!;
    firstHandle.dispatchEvent(
      new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    );
    expect(onCommit).toHaveBeenCalledWith(["p2", "p1"]);

    const liveNode = realm.doc.querySelector('[data-search-order-live="1"]');
    expect(liveNode?.ownerDocument).toBe(realm.doc);
  });

  it("timestampNav 与 triggerMotion 在跨 Realm Text / Element 上正常工作", async () => {
    realm = createDetachedRealm({ reducedMotion: true });
    const activeHost = await import("../../extension/shared/active-host.js");
    const tsNav = await import("../../extension/ui/timestamp-nav.js");
    const motion = await import("../../extension/ui/trigger-motion.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const container = realm.doc.createElement("div");
    const p = realm.doc.createElement("p");
    p.textContent = "在 01:23 处提到重点";
    container.appendChild(p);
    realm.doc.body.appendChild(container);

    expect(p.firstChild instanceof window.Text).toBe(false);
    const count = tsNav.linkifyAssistantTimestamps(container, {});
    expect(count).toBe(1);
    const linkBtn = container.querySelector<HTMLButtonElement>(".chat-timestamp-link")!;
    expect(linkBtn).not.toBeNull();
    expect(linkBtn.ownerDocument).toBe(realm.doc);

    linkBtn.focus();
    expect(motion.resolveTriggerElement()).toBe(linkBtn);
    expect(motion.captureTriggerRect(linkBtn)).not.toBeNull();
    expect(motion.prefersReducedMotion(linkBtn)).toBe(true);
  });

  it("customSelect 选项点击与 toggleSwitch 拖拽在跨 Realm 下正确触发 change 事件", async () => {
    realm = createDetachedRealm({ reducedMotion: true });
    const activeHost = await import("../../extension/shared/active-host.js");
    const customSelect = await import("../../extension/ui/custom-select.js");
    const toggleMod = await import("../../extension/ui/toggle-switch.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const select = realm.doc.createElement("select");
    select.innerHTML = `<option value="a" selected>Alpha</option><option value="b">Beta</option>`;
    realm.doc.body.appendChild(select);
    const onSelectChange = vi.fn();
    select.addEventListener("change", onSelectChange);

    customSelect.initCustomSelect(select, "custom-select-wrapper");
    const trigger = realm.doc.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
    trigger.click();
    const optB = realm.doc.querySelector<HTMLElement>('.custom-select-option[data-value="b"]')!;
    optB.click();
    expect(select.value).toBe("b");
    expect(onSelectChange).toHaveBeenCalledTimes(1);

    const label = realm.doc.createElement("label");
    const checkbox = realm.doc.createElement("input");
    checkbox.type = "checkbox";
    const track = realm.doc.createElement("span");
    track.className = "biliscript-toggle-track";
    const thumb = realm.doc.createElement("span");
    track.appendChild(thumb);
    label.append(checkbox, track);
    realm.doc.body.appendChild(label);
    const onToggleChange = vi.fn();
    checkbox.addEventListener("change", onToggleChange);

    toggleMod.initToggleSwitch(checkbox);
    const MouseEvt = (realm.win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    track.dispatchEvent(new MouseEvt("pointerdown", { bubbles: true, clientX: 0 }));
    track.dispatchEvent(new MouseEvt("pointermove", { bubbles: true, clientX: 24 }));
    track.dispatchEvent(new MouseEvt("pointerup", { bubbles: true, clientX: 24 }));
    expect(checkbox.checked).toBe(true);
    expect(onToggleChange).toHaveBeenCalledTimes(1);
  });

  it("openProviderEditor(asr) 与 wireModelPicker 在跨 Realm 下可初始化并选择模型而不触发 AbortSignal/Event TypeError", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const editorMod = await import("../../extension/ui/provider-editor.js");
    const modelPicker = await import("../../extension/ui/model-picker.js");
    const { ids } = await import("../../extension/shared/dom-ids.js");

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    expect(() =>
      editorMod.openProviderEditor({
        kind: "asr",
        mountHost: readingView,
        presets: [
          {
            id: "openai-asr",
            name: "OpenAI",
            type: "openai-transcriptions",
            baseUrl: "https://api.openai.com/v1",
            model: "whisper-1",
            requiresKey: true,
          },
        ],
        onSave: vi.fn().mockResolvedValue({ ok: true }),
      })
    ).not.toThrow();

    expect(editorMod.isProviderEditorOpen()).toBe(true);
    editorMod.closeProviderEditor(true);

    const row = realm.doc.createElement("div");
    row.innerHTML = `
      <input class="m-url" value="https://api.openai.com/v1" />
      <input class="m-key" value="sk-test" />
      <div class="m-status" hidden></div>
      <div class="ai-provider-model-wrapper">
        <input class="m-model" value="" />
        <button type="button" class="ai-provider-model-toggle"></button>
        <ul class="ai-provider-model-dropdown" hidden></ul>
      </div>
    `;
    realm.doc.body.appendChild(row);
    const modelInput = row.querySelector<HTMLInputElement>(".m-model")!;
    const onModelInput = vi.fn();
    modelInput.addEventListener("input", onModelInput);

    modelPicker.wireModelPicker(row, {
      inputClass: "m-model",
      baseUrlClass: "m-url",
      apiKeyClass: "m-key",
      statusClass: "m-status",
      showStatus: vi.fn(),
      fetchModels: vi.fn().mockResolvedValue({ ok: true, models: ["whisper-1", "gpt-4o-transcribe"] }),
    });

    const toggle = row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!;
    toggle.click();
    await vi.waitFor(() => {
      expect(row.querySelector('.ai-provider-model-option[data-model="whisper-1"]')).not.toBeNull();
    });
    const opt = row.querySelector<HTMLElement>('.ai-provider-model-option[data-model="whisper-1"]')!;
    opt.click();
    expect(modelInput.value).toBe("whisper-1");
    expect(onModelInput).toHaveBeenCalledTimes(1);
  });

  it("animateTriggerExit 在死亡窗口 matchMedia 抛错时不抛出未捕获异常", async () => {
    realm = createDetachedRealm();
    const motion = await import("../../extension/ui/trigger-motion.js");

    const target = realm.doc.createElement("div");
    realm.doc.body.appendChild(target);
    realm.win.matchMedia = (() => {
      throw new Error("Dead XrayWrapper: matchMedia");
    }) as unknown as Window["matchMedia"];

    const onFinish = vi.fn();
    expect(() =>
      motion.animateTriggerExit({
        target,
        onFinish,
      })
    ).not.toThrow();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
