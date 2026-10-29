// @ts-check
export const FADE_OUT_TAIL_SECONDS = 0.1;
export const FADE_OUT_TAIL_MAX_DB = -45;

/**
 * @param {ArrayLike<number>} samples
 * @param {number} channels
 * @param {number} startFrame
 * @param {number} endFrame
 */
function pcmRmsDb(samples, channels, startFrame, endFrame) {
  let energy = 0;
  let count = 0;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Number(samples[frame * channels + channel]) / 32768;
      energy += value * value;
      count += 1;
    }
  }
  return count ? 20 * Math.log10(Math.sqrt(energy / count)) : -Infinity;
}

/**
 * 交错 PCM16 采样在指定秒区间的 RMS（dBFS）；空区间返回 -Infinity。
 * @param {ArrayLike<number>} samples
 * @param {{channels: number, sampleRate: number, fromSeconds: number, toSeconds: number}} window
 */
export function windowRmsDb(samples, {channels, sampleRate, fromSeconds, toSeconds}) {
  const frames = Math.floor(samples.length / channels);
  const start = Math.min(frames, Math.max(0, Math.round(fromSeconds * sampleRate)));
  const end = Math.min(frames, Math.max(start, Math.round(toSeconds * sampleRate)));
  return pcmRmsDb(samples, channels, start, end);
}

/**
 * 成片最后 100ms 的 RMS，以及紧邻前 400ms 的 RMS。窗口不足两个采样帧即报错，
 * 避免空窗测出 -Infinity 后被后面的阈值判断静默放过。
 * @param {{samples: ArrayLike<number>, channels: number, sampleRate: number, duration: number, tailSeconds?: number}} input
 */
export function measureFadeOutTail({samples, channels, sampleRate, duration, tailSeconds = FADE_OUT_TAIL_SECONDS}) {
  const frames = Math.floor(samples.length / channels);
  const end = Math.min(frames, Math.round(duration * sampleRate));
  const start = Math.max(0, Math.round((duration - tailSeconds) * sampleRate));
  const previousStart = Math.max(0, Math.round((duration - tailSeconds - 0.4) * sampleRate));
  if (end - start < 2) throw new Error(`淡出尾部测量窗口为空：成片 ${duration.toFixed(3)} 秒`);
  if (start - previousStart < 2) throw new Error(`淡出前段测量窗口为空：成片 ${duration.toFixed(3)} 秒`);
  const tailRmsDb = pcmRmsDb(samples, channels, start, end);
  const previousRmsDb = pcmRmsDb(samples, channels, previousStart, start);
  return {fromSeconds: start / sampleRate, toSeconds: end / sampleRate, tailRmsDb, previousRmsDb};
}
