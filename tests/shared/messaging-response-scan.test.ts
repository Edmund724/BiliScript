import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_ROOT = join(process.cwd(), "extension");

function listSourceFiles(dir: string): string[] {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...listSourceFiles(full));
      continue;
    }
    if (/\.(ts|js)$/.test(entry)) {
      result.push(full);
    }
  }
  return result;
}

const sourceFileMap = new Map(
  listSourceFiles(EXTENSION_ROOT).map((file) => [
    relative(EXTENSION_ROOT, file).split(sep).join("/"),
    readFileSync(file, "utf8")
  ])
);
const read = (file: string) => {
  const text = sourceFileMap.get(file);
  if (text === undefined) {
    throw new Error(`扫描目标不存在：${file}`);
  }
  return text;
};

const PROTOCOL = "shared/messaging-protocol.ts";
const BACKGROUND = "entry/background.ts";

const MESSAGE_LITERAL_RE = /export type (\w+) = \{[^}]*?type:\s*"([^"]+)"/g;

function parseUnionMembers(protocolText: string, unionName: string): string[] {
  const block = protocolText.match(new RegExp(`export type ${unionName} =([\\s\\S]*?);`));
  if (!block) {
    throw new Error(`messaging-protocol.ts 缺少 ${unionName} union`);
  }
  const members = [];
  for (const match of block[1].matchAll(/\|\s*(\w+)/g)) {
    members.push(match[1]);
  }
  if (members.length === 0) {
    throw new Error(`${unionName} union 未解析到成员`);
  }
  return members;
}

const protocolText = read(PROTOCOL);

const messageLiterals = new Map();
for (const match of protocolText.matchAll(MESSAGE_LITERAL_RE)) {
  messageLiterals.set(match[1], match[2]);
}

const contentMembers = parseUnionMembers(protocolText, "ContentScriptMessage");
const backgroundMembers = parseUnionMembers(protocolText, "BackgroundMessage");
const allMembers = [...new Set([...contentMembers, ...backgroundMembers])];

describe("消息协议响应半边（arch-slim-2/02）", () => {
  it("extension/ 源码内 as { ok 型响应断言清零", () => {
    const offenders = [];
    for (const [file, text] of sourceFileMap) {
      if (/as\s*\{\s*ok/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("每条消息别名都有并列声明的 XxxResponse 响应类型", () => {
    const missing = allMembers
      .filter((alias) => !messageLiterals.has(alias))
      .map((alias) => `${alias}（缺 type 字面量声明，扫描器无法定位）`);
    expect(missing).toEqual([]);

    const noResponse = allMembers
      .filter((alias) => {
        const responseAlias = alias.replace(/Message$/, "Response");
        return !new RegExp(`export type ${responseAlias}\\b`).test(protocolText);
      })
      .map((alias) => `${alias} → ${alias.replace(/Message$/, "Response")} 缺失`);
    expect(noResponse).toEqual([]);
  });

  it("ResponseOf 由 SW 消息注册表派生且接到传输层入口", () => {
    expect(protocolText).toContain("export type ResponseOf<M>");
    expect(protocolText).toContain("const BACKGROUND_MESSAGE_REGISTRY");
    expect(read("shared/messaging.ts")).toMatch(/Promise<ResponseOf<M>>/);
  });

  it("background 路由表键集与 BackgroundMessage 消息字面量集全等", () => {
    const backgroundLiterals = backgroundMembers.map((alias) => {
      const literal = messageLiterals.get(alias);
      if (!literal) {
        throw new Error(`${alias} 未解析到 type 字面量`);
      }
      return literal;
    });

    const tableText = read(BACKGROUND).match(
      /const messageHandlerTable = \{([\s\S]*?)\} satisfies/
    );
    if (!tableText) {
      throw new Error("background.ts 缺少 messageHandlerTable satisfies 穷尽路由表");
    }
    const routeKeys = [...tableText[1].matchAll(/"([a-z][a-z0-9-]*)"\s*:/g)].map((m) => m[1]);

    expect(routeKeys).toHaveLength(backgroundLiterals.length);
    expect([...routeKeys].sort()).toEqual([...backgroundLiterals].sort());
    expect(read(BACKGROUND)).toContain("handlers: messageHandlerTable");
    expect(read(BACKGROUND)).not.toContain("new Map<BackgroundMessageType");
  });

  it("BACKGROUND_MESSAGE_REGISTRY 键集与 BackgroundMessage 消息字面量集全等", () => {
    const registryBlock = protocolText.match(
      /const BACKGROUND_MESSAGE_REGISTRY = \{([\s\S]*?)\n\} satisfies/
    );
    if (!registryBlock) {
      throw new Error("messaging-protocol.ts 缺少 BACKGROUND_MESSAGE_REGISTRY satisfies 注册表");
    }
    const registryKeys = [...registryBlock[1].matchAll(/^[ \t]*"([a-z][a-z0-9-]*)":/gm)].map((m) => m[1]);

    const backgroundLiterals = backgroundMembers.map((alias) => {
      const literal = messageLiterals.get(alias);
      if (!literal) {
        throw new Error(`${alias} 未解析到 type 字面量`);
      }
      return literal;
    });

    expect(registryKeys).toHaveLength(backgroundLiterals.length);
    expect([...registryKeys].sort()).toEqual([...backgroundLiterals].sort());
  });
});
