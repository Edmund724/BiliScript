import {
  DEFAULT_WORKLET_QUANTUM_FRAMES,
  PCM_CAPTURE_PROCESSOR_NAME,
  PCM_WORKLET_BATCH_SAMPLES,
  createPcmCaptureCore,
  type PcmCaptureConfig,
  type PcmCaptureMainToWorkletMessage,
  type PcmCaptureWorkletToMainMessage
} from "./pcm-capture-core.js";

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void;

declare const sampleRate: number;

class PcmCaptureWorkletProcessor extends AudioWorkletProcessor {
  private stopped = false;
  private readonly core;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const initialConfig = options?.processorOptions as Partial<PcmCaptureConfig> | undefined;
    const workletRate =
      typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0
        ? sampleRate
        : undefined;

    const post = (msg: PcmCaptureWorkletToMainMessage, transfer?: Transferable[]): void => {
      if (this.stopped) return;
      if (transfer && transfer.length > 0) {
        this.port.postMessage(msg, transfer);
      } else {
        this.port.postMessage(msg);
      }
    };

    this.core = createPcmCaptureCore({
      batchSamples: PCM_WORKLET_BATCH_SAMPLES,
      sampleRate: workletRate,
      initialConfig,
      onVadChange: (active) => {
        post({ type: "vad", active });
      },
      onBargeInChange: (active) => {
        post({ type: "barge_in", active });
      },
      onSpeechHeartbeat: () => {
        post({ type: "speech" });
      },
      onPcmBatch: (pcmBuffer, hadSpeech) => {
        post({ type: "pcm", pcmBuffer, hadSpeech }, [pcmBuffer]);
      }
    });

    this.port.onmessage = (event: MessageEvent<PcmCaptureMainToWorkletMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "stop") {
        this.stopped = true;
        this.core.reset();
        this.port.onmessage = null;
        return;
      }
      if (msg.type === "ai_speaking") {
        this.core.notifyAiSpeaking(Boolean(msg.speaking));
        return;
      }
      if (msg.type === "config") {
        this.core.setConfig(msg);
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) {
      return false;
    }
    const micChannel = inputs[0]?.[0];
    const videoChannels = inputs[1];
    const currentRate =
      typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0
        ? sampleRate
        : undefined;
    const quantumFrames = outputs[0]?.[0]?.length || DEFAULT_WORKLET_QUANTUM_FRAMES;
    this.core.processQuantum(micChannel, videoChannels, currentRate, quantumFrames);
    return true;
  }
}

registerProcessor(PCM_CAPTURE_PROCESSOR_NAME, PcmCaptureWorkletProcessor);
