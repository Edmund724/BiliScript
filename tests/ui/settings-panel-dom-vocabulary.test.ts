import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import {
  buildSettingsHtml,
  SETTINGS_PANEL_DOM_IDS
} from "../../extension/ui/settings-panel-html.js";

const QUICK_PROMPT_CLASS_SELECTOR = ".ai-initial-quick-prompt";

beforeEach(() => {
  resetModuleState();
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

  installSettingsPanelBus();
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  await vi.waitFor(() => {
    expect(host.dataset.biliscriptSettingsRendered).toBe("1");
  });
  return { host, readIds, classSelectors };
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
