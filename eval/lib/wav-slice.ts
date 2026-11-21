export interface PcmChunk {
  blob: Blob;
  startSec: number;
  durationSec: number;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataByteLength: number;
  sampleCount: number;
}

export function parseWavHeader(buf: Uint8Array): WavInfo {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (buf.byteLength < 44 || readAscii(buf, 0, 4) !== "RIFF" || readAscii(buf, 8, 4) !== "WAVE") {
    throw new Error("不是合法的 RIFF/WAVE 文件");
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataByteLength = 0;
  let hasFmt = false;
  let offset = 12;

  while (offset + 8 <= buf.byteLength) {
    const chunkId = readAscii(buf, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    const available = buf.byteLength - bodyOffset;
    const size = Math.min(chunkSize, available);

    if (chunkId === "fmt " && available >= 16) {
      const audioFormat = view.getUint16(bodyOffset, true);
      if (audioFormat !== 1 && audioFormat !== 0xfffe) {
        throw new Error(`不支持的音频格式 ${audioFormat}（仅支持 PCM）`);
      }
      channels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
      hasFmt = true;
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataByteLength = size;
    }
    offset = bodyOffset + size + (size % 2);
  }

  if (!hasFmt) throw new Error("WAV 缺少 fmt 块");
  if (dataOffset < 0) throw new Error("WAV 缺少 data 块");
  if (channels !== 1 && channels !== 2) throw new Error(`不支持的声道数 ${channels}（仅支持 1/2）`);
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    throw new Error(`不支持的位深 ${bitsPerSample}（仅支持 8/16 位）`);
  }

  const bytesPerSample = bitsPerSample / 8;
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataByteLength,
    sampleCount: Math.floor(dataByteLength / bytesPerSample)
  };
}

export function sliceWavToChunks(
  buf: Uint8Array,
  chunkSeconds: number,
  opts?: { resampleTo?: number }
): PcmChunk[] {
  const info = parseWavHeader(buf);
  if (chunkSeconds <= 0) throw new Error("chunkSeconds 必须为正数");
  if (info.sampleCount === 0) throw new Error("WAV 无音频数据");

  const targetRate = opts?.resampleTo ?? 16000;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dataStart = buf.byteLength - info.dataByteLength;
  const frames = Math.floor(info.sampleCount / info.channels);
  const mono: Float32Array = new Float32Array(frames);
  const bytesPerSample = info.bitsPerSample / 8;
  const frameBytes = bytesPerSample * info.channels;

  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < info.channels; c++) {
      const pos = dataStart + f * frameBytes + c * bytesPerSample;
      acc += info.bitsPerSample === 16 ? view.getInt16(pos, true) / 32768 : (view.getUint8(pos) - 128) / 128;
    }
    mono[f] = acc / info.channels;
  }

  let samples: Float32Array;
  if (targetRate === info.sampleRate) {
    samples = mono;
  } else {
    const ratio = info.sampleRate / targetRate;
    const outLen = Math.max(1, Math.round(frames / ratio));
    samples = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const frac = src - i0;
      const s0 = mono[i0];
      const s1 = i0 + 1 < frames ? mono[i0 + 1] : s0;
      samples[i] = s0 + (s1 - s0) * frac;
    }
  }

  const samplesPerChunk = Math.max(1, Math.round(chunkSeconds * targetRate));
  const chunks: PcmChunk[] = [];
  for (let start = 0; start < samples.length; start += samplesPerChunk) {
    const slice = samples.subarray(start, Math.min(start + samplesPerChunk, samples.length));
    chunks.push({
      blob: new Blob([encodeStdWav(slice, targetRate)], { type: "audio/wav" }),
      startSec: start / targetRate,
      durationSec: slice.length / targetRate
    });
  }
  return chunks;
}

function encodeStdWav(mono: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataSize = mono.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < mono.length; i++) {
    const q = Math.round(mono[i] * 32768);
    view.setInt16(44 + i * 2, q > 32767 ? 32767 : q < -32768 ? -32768 : q, true);
  }
  return new Uint8Array(buffer);
}

function readAscii(buf: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(buf[offset + i]);
  return out;
}
