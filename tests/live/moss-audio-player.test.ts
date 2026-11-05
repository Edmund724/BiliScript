import { describe, expect, it } from "vitest";
import { MossAudioPlayer } from "../../extension/live/moss-audio-player.js";
import { encodeFloat32ToPcmS16LE } from "../../extension/live/moss-live-protocol.js";

function createHarness() {
  const gain = {
    value: 1
  };
  const outputGain = {
    gain,
    connect: (_destination: unknown) => {},
    disconnect: () => {}
  };
  let connectedDestination: unknown = null;
  const source = {
    buffer: null,
    onended: null,
    connect: (destination: unknown) => {
      connectedDestination = destination;
    },
    disconnect: () => {},
    start: (_when?: number) => {},
    stop: () => {}
  };
  const audioContext = {
    currentTime: 0,
    state: "running",
    destination: {},
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length)
    }),
    createBufferSource: () => source,
    createGain: () => outputGain
  };
  const player = new MossAudioPlayer({
    volume: 0.8,
    createAudioContext: () => audioContext,
    onTurnFinished: () => {},
    onStateChange: () => {}
  });
  return { player, gain, outputGain, getConnectedDestination: () => connectedDestination };
}

describe("MossAudioPlayer volume", () => {
  it("routes audio through one gain and updates it without restarting playback", () => {
    const { player, gain, outputGain, getConnectedDestination } = createHarness();
    const isCurrent = () => true;
    player.enqueueAudioContext("chunk-1", "run-1", "turn-1", isCurrent);
    player.enqueueAudioFrame(
      encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2)).buffer,
      isCurrent
    );

    expect(getConnectedDestination()).toBe(outputGain);
    expect(gain.value).toBe(0.8);

    player.setVolume(0.25);
    expect(gain.value).toBe(0.25);
    player.setVolume(-1);
    expect(gain.value).toBe(0);
    player.setVolume(2);
    expect(gain.value).toBe(1);
  });
});
