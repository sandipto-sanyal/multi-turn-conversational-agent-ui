import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SAMPLE_RATE,
  SILENCE_HANG_BLOCKS,
  SPEECH_RMS_THRESHOLD,
  THRESHOLD_MAX,
  WORKLET_SOURCE,
  concatFloat32,
  rms,
} from "./audio";

export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking" | "error";

/** One complete speech segment, from speech onset to the end of trailing silence. */
export type Utterance = {
  /** Mono samples in [-1, 1] at `sampleRate`. */
  audio: Float32Array;
  sampleRate: number;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

export type VoiceCaptureProps = {
  /** Called once per detected utterance with the full concatenated audio. */
  onUtterance?: (utterance: Utterance) => void;
  /** Called whenever the capture status changes. */
  onStatusChange?: (status: VoiceStatus) => void;
  /**
   * Speech threshold on the block RMS level (0..1). Blocks quieter than this are
   * treated as silence. Controlled: changes from the parent apply immediately.
   */
  speechThreshold?: number;
  /** Set to false to render no built-in UI (status, button, meter) and only run capture. */
  showControls?: boolean;
};

const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: "Stopped",
  connecting: "Connecting...",
  listening: "Listening",
  speaking: "Speech detected",
  error: "Error",
};

/**
 * Captures microphone audio and detects utterances with energy-based VAD.
 * Blocks are buffered in memory while the speaker talks and emitted as one
 * Float32Array when the utterance ends. No network calls are made.
 */
export function VoiceCapture({
  onUtterance,
  onStatusChange,
  speechThreshold = SPEECH_RMS_THRESHOLD,
  showControls = true,
}: VoiceCaptureProps) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [level, setLevel] = useState(0);

  // Latest callbacks and threshold, so the audio handlers never call stale closures.
  const onUtteranceRef = useRef(onUtterance);
  const onStatusChangeRef = useRef(onStatusChange);
  onUtteranceRef.current = onUtterance;
  onStatusChangeRef.current = onStatusChange;
  // Read by the audio handler, so it always sees the current prop value.
  const thresholdRef = useRef(speechThreshold);
  thresholdRef.current = speechThreshold;

  // Mirrors `status` for handlers that must read the latest value synchronously.
  const statusRef = useRef<VoiceStatus>("idle");

  // Live audio resources and per-utterance buffers live in refs.
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const prevBlockRef = useRef<Float32Array | null>(null);
  const speakingRef = useRef(false);
  const silentBlocksRef = useRef(0);
  const chunksRef = useRef<Float32Array[]>([]);
  const startedAtRef = useRef<Date | null>(null);

  function updateStatus(next: VoiceStatus) {
    statusRef.current = next;
    setStatus(next);
    onStatusChangeRef.current?.(next);
  }

  function teardown() {
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    prevBlockRef.current = null;
    speakingRef.current = false;
    silentBlocksRef.current = 0;
    chunksRef.current = [];
    startedAtRef.current = null;
    setLevel(0);
  }

  // Joins the buffered blocks and hands the utterance to the caller.
  function finishUtterance() {
    const startedAt = startedAtRef.current ?? new Date();
    const sampleRate = audioCtxRef.current?.sampleRate ?? SAMPLE_RATE;
    const audio = concatFloat32(chunksRef.current);
    const durationMs = (audio.length / sampleRate) * 1000;

    chunksRef.current = [];
    speakingRef.current = false;
    silentBlocksRef.current = 0;
    startedAtRef.current = null;

    setLastDurationMs(durationMs);
    onUtteranceRef.current?.({
      audio,
      sampleRate,
      startedAt,
      endedAt: new Date(),
      durationMs,
    });
  }

  // Energy-based voice activity detection, run on every audio block.
  function handleBlock(block: Float32Array) {
    const blockLevel = rms(block);
    setLevel(blockLevel);
    const isSpeech = blockLevel >= thresholdRef.current;
    // (threshold is read from the ref so mid-session prop changes take effect)

    if (!speakingRef.current) {
      if (isSpeech) {
        // Speech onset: start a new buffer, with the previous block as pre-roll
        // so the beginning of the word is not clipped.
        speakingRef.current = true;
        silentBlocksRef.current = 0;
        startedAtRef.current = new Date();
        chunksRef.current = prevBlockRef.current
          ? [prevBlockRef.current, block]
          : [block];
        updateStatus("speaking");
      }
    } else {
      // Keep every block while the utterance is open, including trailing silence.
      chunksRef.current.push(block);
      if (isSpeech) {
        silentBlocksRef.current = 0;
      } else if (++silentBlocksRef.current >= SILENCE_HANG_BLOCKS) {
        finishUtterance();
        updateStatus("listening");
      }
    }
    prevBlockRef.current = block;
  }

  async function start() {
    setError(null);
    updateStatus("connecting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = audioCtx;

      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" })
      );
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, "mic-processor");
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => handleBlock(e.data);
      workletRef.current = worklet;

      // Route through a muted gain so the worklet is pulled without playing the mic back.
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      source.connect(worklet);
      worklet.connect(mute).connect(audioCtx.destination);

      updateStatus("listening");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start microphone.");
      updateStatus("error");
      teardown();
    }
  }

  function stop() {
    // Keep speech that was still in progress when the user pressed Stop.
    if (speakingRef.current && chunksRef.current.length > 0) {
      finishUtterance();
    }
    teardown();
    updateStatus("idle");
  }

  // Release the mic and audio context when the component unmounts.
  useEffect(() => {
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = status === "listening" || status === "speaking";
  const busy = status === "connecting";
  const levelPct = Math.min(100, (level / THRESHOLD_MAX) * 100);
  const thresholdPct = Math.min(100, (speechThreshold / THRESHOLD_MAX) * 100);

  if (!showControls) return null;

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <div
          className={`h-4 w-4 rounded-full ${
            status === "speaking"
              ? "animate-pulse bg-green-500"
              : active
                ? "bg-blue-500"
                : "bg-gray-300"
          }`}
          aria-hidden
        />
        <p className="text-sm text-gray-600" role="status">
          {STATUS_TEXT[status]}
        </p>
      </div>

      {/* Live mic level. Green means the block is above the threshold (speech). */}
      <div className="relative h-2 w-full overflow-hidden rounded bg-gray-200" aria-hidden>
        <div
          className={`h-full ${level >= speechThreshold ? "bg-green-500" : "bg-gray-400"}`}
          style={{ width: `${levelPct}%` }}
        />
        <div
          className="absolute top-0 h-full w-0.5 bg-red-500"
          style={{ left: `${thresholdPct}%` }}
        />
      </div>

      {active || busy ? (
        <Button variant="destructive" onClick={stop} disabled={busy}>
          Stop
        </Button>
      ) : (
        <Button onClick={start}>Start</Button>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {lastDurationMs !== null && (
        <p className="text-xs text-gray-500">
          Last utterance: {(lastDurationMs / 1000).toFixed(1)} s
        </p>
      )}
    </div>
  );
}

export default VoiceCapture;
