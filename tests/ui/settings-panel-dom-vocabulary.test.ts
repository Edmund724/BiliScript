// tests/ui/settings-panel-dom-vocabulary.test.ts
// 设置抽屉的 DOM 词汇表对账：模板 id 属性与收集器实际读到的 id 同出一份声明
//（settings-panel-html.ts 的 SETTINGS_PANEL_DOM_IDS），任一侧漏登记或改名即红。
//
// 收集器一侧用真实挂载观察：renderReaderSettingsPanel 首建时 collectElements(host)
// 的每次 host.querySelector("#<id>") 被记录，断言的是收集器真实读到的 id 全集，
// 而不是从源码文本里猜。收集器的类选择器（.ai-initial-quick-prompt）另记一路，
// 按「不是 id」排除在 id 集合之外。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import {
  buildSettingsHtml,
  SETTINGS_PANEL_DOM_IDS
} from "../../extension/ui/settings-panel-html.js";

// 收集器里唯一的类选择器（非 id，不进 id 集合）
const QUICK_PROMPT_CLASS_SELECTOR = ".ai-initial-quick-prompt";

beforeEach(() => {
  resetModuleState();
});

// 声明表的 id 值集
function declaredIds(): string[] {
  return Object.values(SETTINGS_PANEL_DOM_IDS);
}

// 模板里作为 id 属性写出的 id（for= 是另一类引用，单独断言）
function templateIdAttributes(): string[] {
  return [...buildSettingsHtml().matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

// 渲染后宿主里按 id 解析：模板真的建出了声明表的每个元素
function hostIds(host: HTMLElement): (string | null)[] {
  return declaredIds().map((id) => host.querySelector(`#${id}`)?.id ?? null);
}

// 挂载真实面板并记录收集器在宿主上的选择器读取（id 与类分两路）
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
  // 首建分支：模板挂载 → 绑定（collectElements）→ 标记 rendered → 装载（再收集一次）
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
    // 重复 id：模板里同一 id 出现两次、或声明表里两个键写同一个值
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
    // 每个声明的 id 都能在渲染出的宿主里解析到（模板与收集器同一份表）
    expect(hostIds(host)).toEqual(declared);
  });

  it("类选择器不是 id：.ai-initial-quick-prompt 被读取，但不进 id 集合", async () => {
    const { readIds, classSelectors } = await mountAndRecordCollectorReads();

    // 收集器的第三段（快捷问题输入位）走类选择器——本记录确实覆盖到它
    expect(classSelectors).toContain(QUICK_PROMPT_CLASS_SELECTOR);
    // 声明的 id 集合里没有它，收集器的 id 读取里也没有它
    expect(declaredIds()).not.toContain(QUICK_PROMPT_CLASS_SELECTOR);
    expect(readIds.has(QUICK_PROMPT_CLASS_SELECTOR)).toBe(false);
    expect([...readIds].filter((id) => id.includes("."))).toEqual([]);
  });
});
