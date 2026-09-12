// shared/bytes.ts — 字节缓冲拼接（shared 叶子，零依赖）。
//
// 02 复制粘贴收口：此前 concatBytes 在 asr/adts.ts 与 entry/offscreen-asr.ts
// 各有一份逐字相同的实现——两者都是把新到的字节块接到既有残包缓冲后面：
//   - asr/adts.ts：fMP4 增量解析器跨 push 的残包缓冲拼接；
//   - entry/offscreen-asr.ts：fMP4 头部判定缓冲累积（上限 HEAD_PROBE_LIMIT，
//     约 4MB 级别的小缓冲，达标即判定，不会无限增长）。
// 收口为单份实现，两侧经 import 消费。

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
