import { fnv1a32 } from "../shared/text-primitives.js";
import { quirkWireValue } from "./compat-vocab.js";
import { resolvePlatformQuirkId } from "./platform-quirk-id.js";

export interface PresetHeaderInput {
  presetId?: string;
  baseUrl?: string;
  sessionId?: unknown;
}

export function presetRequestHeaders(provider?: PresetHeaderInput | null): Record<string, string> {
  const header = quirkWireValue(resolvePlatformQuirkId(provider?.presetId, provider?.baseUrl), "sessionHeader");
  if (!header) {
    return {};
  }
  return { [header]: sessionIdFor(provider?.sessionId) };
}

export function sessionIdFor(identity: unknown): string {
  const normalized = String(identity || "").trim();
  return normalized ? uuidFromSeed(normalized) : randomUuid();
}

const SESSION_SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f] as const;

function uuidFromSeed(input: string): string {
  const bytes = new Uint8Array(16);
  for (let word = 0; word < SESSION_SEEDS.length; word += 1) {
    const value = fnv1a32(input, SESSION_SEEDS[word]);
    bytes[word * 4] = value & 0xff;
    bytes[word * 4 + 1] = (value >>> 8) & 0xff;
    bytes[word * 4 + 2] = (value >>> 16) & 0xff;
    bytes[word * 4 + 3] = (value >>> 24) & 0xff;
  }
  return asUuid(bytes);
}

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
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    hex.push(bytes[index].toString(16).padStart(2, "0"));
  }
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
