// ai/preset-headers.ts — 平台预设额外要求的请求头（查表单点）。
//
// Opencode Go：官方文档「Where can I use it?」要求客户端在 x-opencode-session 里
// 给每个对话一个稳定会话 id（供平台做路由与 prompt 缓存），不带这个头请求不被
// 接受。规则与取值都在本模块，completion.ts（唯一 fetch 点）是唯一消费点；
// 新增「按预设补头」的平台只在此登记一行。
//
// 会话 id 的来源是宿主给的会话身份（provider.sessionId = chat 会话 id，见
// entry/offscreen.ts 的接线与 chat/chat-runtime.ts 的物化）：同一会话跨轮、
// 跨重载映射到同一个 id（确定性派生，不引入随机），新会话得到新 id——正对
// 「每个对话一个稳定会话 id」。没有会话身份的调用（选区解释、连通性探针、
// 旧宿主）现造一个随机 id：这些调用本身就不构成「一个对话」。

// 预设 id → 会话头名（presets.ts 的 AiProviderPreset.id 词表键）。
const SESSION_HEADER_PRESETS: Readonly<Record<string, string>> = {
  opencodego: "x-opencode-session"
};

export interface PresetHeaderInput {
  presetId?: unknown;
  sessionId?: unknown;
}

// 该预设要求的额外请求头；无要求返回空对象（调用方展开合并）。
export function presetRequestHeaders(provider?: PresetHeaderInput | null): Record<string, string> {
  const header = SESSION_HEADER_PRESETS[String(provider?.presetId || "").trim()];
  if (!header) {
    return {};
  }
  return { [header]: sessionIdFor(provider?.sessionId) };
}

// 会话 id：有身份则确定性映射成 UUID 形状，无身份则随机一个。不直接拿会话 id
// 文本当值——平台文档示例与各已适配客户端（Hermes / Codex / Claude Code）给的
// 都是 UUID，形状没对上不值当赌一把。
export function sessionIdFor(identity: unknown): string {
  const normalized = String(identity || "").trim();
  return normalized ? uuidFromSeed(normalized) : randomUuid();
}

// 确定性派生：FNV-1a 取四个不同种子填满 16 字节（同输入恒同输出，不同输入
// 实际不可区分到同一结果），再置 UUIDv4 的版本/变体位收口形状。
const SESSION_SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f] as const;

function fnv1a(input: string, seed: number): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash ^ input.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function uuidFromSeed(input: string): string {
  const bytes = new Uint8Array(16);
  for (let word = 0; word < SESSION_SEEDS.length; word += 1) {
    const value = fnv1a(input, SESSION_SEEDS[word]);
    bytes[word * 4] = value & 0xff;
    bytes[word * 4 + 1] = (value >>> 8) & 0xff;
    bytes[word * 4 + 2] = (value >>> 16) & 0xff;
    bytes[word * 4 + 3] = (value >>> 24) & 0xff;
  }
  return asUuid(bytes);
}

// 随机 id：crypto.getRandomValues 在非安全上下文（页面为 http 的极端情形）仍可用，
// 故不依赖只在安全上下文存在的 crypto.randomUUID；取不到实现时退到 Math.random
// ——会话 id 是标识不是凭据，不需要密码学强度。
function randomUuid(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return asUuid(bytes);
}

function asUuid(bytes: Uint8Array): string {
  // UUIDv4 的版本/变体位（形状对齐平台示例与各已适配客户端）。
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    hex.push(bytes[index].toString(16).padStart(2, "0"));
  }
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
