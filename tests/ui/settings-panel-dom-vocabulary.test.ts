import { beforeEach, describe, expect, it } from "vitest";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import {
  buildSettingsHtml,
  SETTINGS_PANEL_DOM_IDS
} from "../../extension/ui/settings-panel-html.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { resetSettingsPanelState } from "../helpers/reset-settings-panel-state.js";
import { NOTE_TEMPLATE_VARIABLES_HELP } from "../../extension/notes/template-defaults.js";

const QUICK_PROMPT_CLASS_SELECTOR = ".ai-initial-quick-prompt";

beforeEach(() => {
  resetSettingsPanelState();
});

function declaredIds(): string[] {
  return Object.values(SETTINGS_PANEL_DOM_IDS);
}

function templateIdAttributes(): string[] {
  return [...buildSettingsHtml().matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

function hostIds(host: HTMLElement): (string | null)[] {
  return declaredIds().map((id) => host.querySelector(`#${id}`)?.id ?? null);
}

async function mountAndRecordCollectorReads(): Promise<{
  host: HTMLElement;
  readIds: Set<string>;
  classSelectors: string[];
}> {
  document.body.innerHTML = '<div id="biliscript-reading-settings-host"></div>';
  const host = document.getElementById("biliscript-reading-settings-host")!;
  const readIds = new Set<string>();
  const classSelectors: string[] = [];
  const querySelector = host.querySelector.bind(host);
  const querySelectorAll = host.querySelectorAll.bind(host);
  const origGetElementById = document.getElementById.bind(document);
  host.querySelector = ((selector: string) => {
    if (typeof selector === "string" && selector.startsWith("#")) {
      readIds.add(selector.slice(1));
    }
    return querySelector(selector);
  }) as typeof host.querySelector;
  host.querySelectorAll = ((selector: string) => {
    if (typeof selector === "string") {
      classSelectors.push(selector);
    }
    return querySelectorAll(selector);
  }) as typeof host.querySelectorAll;
  document.getElementById = ((id: string) => {
    const el = origGetElementById(id);
    if (el && el !== host && host.contains(el)) {
      readIds.add(id);
    }
    return el;
  }) as typeof document.getElementById;

  try {
    installSettingsPanelBus();
    await renderReaderSettingsPanel();
    expect(host.dataset.biliscriptSettingsRendered).toBe("1");
    return { host, readIds, classSelectors };
  } finally {
    document.getElementById = origGetElementById;
  }
}

describe("设置抽屉 DOM 词汇表：声明表 ↔ 模板", () => {
  it("模板 id 属性集合与声明表双向相等（漏登记 / 模板多写即红）", () => {
    const declared = declaredIds();
    const rendered = templateIdAttributes();

    expect(new Set(rendered)).toEqual(new Set(declared));
    expect(rendered).toHaveLength(new Set(rendered).size);
    expect(declared).toHaveLength(new Set(declared).size);
  });

  it("label 的 for= 目标落在声明表内（指向同一份词汇表）", () => {
    const declared = new Set(declaredIds());
    const targets = [...buildSettingsHtml().matchAll(/\bfor="([^"]+)"/g)].map((match) => match[1]);

    expect(targets.length).toBeGreaterThan(0);
    targets.forEach((target) => {
      expect(declared.has(target), `for="${target}" 不在 id 词汇表里`).toBe(true);
    });
  });

  it("笔记导出模板可用变量列表与 NOTE_TEMPLATE_VARIABLES_HELP 保持一致并包含 {{videoId}} 与 {{site}}", () => {
    const host = document.createElement("div");
    host.innerHTML = buildSettingsHtml();
    const renderedVars = Array.from(
      host.querySelectorAll(".biliscript-note-template-vars code")
    ).map((el) => el.textContent?.trim());

    expect(renderedVars).toContain("{{videoId}}");
    expect(renderedVars).toContain("{{site}}");
    expect(renderedVars).toEqual(NOTE_TEMPLATE_VARIABLES_HELP.split(" "));
  });
});

describe("设置抽屉 DOM 词汇表：收集器读取的 id", () => {
  it("收集器读到的 id 集合 = 声明表（模板已建出对应元素）", async () => {
    const { host, readIds } = await mountAndRecordCollectorReads();
    const declared = declaredIds();

    expect([...readIds].sort()).toEqual([...declared].sort());
    expect(hostIds(host)).toEqual(declared);
  });

  it("类选择器不是 id：.ai-initial-quick-prompt 被读取，但不进 id 集合", async () => {
    const { readIds, classSelectors } = await mountAndRecordCollectorReads();

    expect(classSelectors).toContain(QUICK_PROMPT_CLASS_SELECTOR);
    expect(declaredIds()).not.toContain(QUICK_PROMPT_CLASS_SELECTOR);
    expect(readIds.has(QUICK_PROMPT_CLASS_SELECTOR)).toBe(false);
    expect([...readIds].filter((id) => id.includes("."))).toEqual([]);
  });
});
