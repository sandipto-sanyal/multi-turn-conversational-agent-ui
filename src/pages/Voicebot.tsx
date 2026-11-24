import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// ---- Config -----------------------------------------------------------------

// Audio is captured and streamed as 16 kHz mono 16-bit PCM.
const SAMPLE_RATE = 16000;
// Samples per block posted from the audio worklet (1024 @ 16 kHz = 64 ms).
const BLOCK_SIZE = 1024;
// Block RMS (0..1) above which a block counts as speech.
const SPEECH_RMS_THRESHOLD = 0.02;
// Consecutive silent blocks before the current utterance is closed (~512 ms).
const SILENCE_HANG_BLOCKS = 8;

type Status = "idle" | "connecting" | "listening" | "speaking" | "error";

const STATUS_TEXT: Record<Status, string> = {
  idle: "Not connected",
  connecting: "Connecting...",
  listening: "Listening",
  speaking: "Speaking detected",
  error: "Error",
};

// ---- Helpers ----------------------------------------------------------------

// Audio worklet source, loaded from a Blob URL. It re-chunks the mic input
// into fixed-size Float32 blocks and posts them to the main thread.
const WORKLET_SOURCE = `
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${BLOCK_SIZE});
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset === ${BLOCK_SIZE}) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(${BLOCK_SIZE});
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("mic-processor", MicProcessor);
`;

// "yyyy-mm-dd HH:MM:SS" in local time.
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// Float32 [-1, 1] -> little-endian 16-bit PCM -> base64 string.
function encodePcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// WebSocket needs ws:// or wss://; convert from http(s) if the env var uses those.
function toWsUrl(base: string): string {
  return base.replace(/^http(s?):\/\//i, (_m, s) => `ws${s}://`);
}

// ---- Component --------------------------------------------------------------

export default function VoiceBot() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastUtterance, setLastUtterance] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<
    { recordStartRef: string; text: string }[]
  >([]);
  const [transcription, setTranscription] = useState<string>("");

  // Live resources live in refs so the audio callbacks always see current values.
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const prevBlockRef = useRef<Float32Array | null>(null);
  const speakingRef = useRef(false);
  const silentBlocksRef = useRef(0);
  const recordStartRef = useRef<string | null>(null);

  function teardown() {
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    prevBlockRef.current = null;
    speakingRef.current = false;
    silentBlocksRef.current = 0;
    recordStartRef.current = null;
  }

  // speechEnd is true only for the final chunk of an utterance.
  function sendChunk(block: Float32Array, speechEnd = false) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !recordStartRef.current) return;
    // Key is the recording start timestamp; value is the base64 audio chunk.
    ws.send(
      JSON.stringify({
        type: "user_audio",
        recordStartRef:recordStartRef.current,
        voice: encodePcm16Base64(block),
        speech_end: speechEnd,
      })
    );
  }

  // Energy-based voice activity detection, run on every audio block.
  function handleBlock(block: Float32Array) {
    const isSpeech = rms(block) >= SPEECH_RMS_THRESHOLD;

    if (!speakingRef.current) {
      if (isSpeech) {
        // Speech onset: stamp the recording, send one block of pre-roll so the
        // beginning of the word is not clipped, then the current block.
        speakingRef.current = true;
        silentBlocksRef.current = 0;
        recordStartRef.current = formatTimestamp(new Date());
        setStatus("speaking");
        if (prevBlockRef.current) sendChunk(prevBlockRef.current);
        sendChunk(block);
      }
    } else if (isSpeech) {
      silentBlocksRef.current = 0;
      sendChunk(block, false);
    } else if (++silentBlocksRef.current >= SILENCE_HANG_BLOCKS) {
      // Utterance finished: this block carries speech_end = true.
      sendChunk(block, true);
      speakingRef.current = false;
      setLastUtterance(recordStartRef.current);
      recordStartRef.current = null;
      setStatus("listening");
    } else {
      // Trailing silence inside the same utterance; still speaking.
      sendChunk(block, false);
    }
    prevBlockRef.current = block;
  }

  async function start() {
    setError(null);
    setStatus("connecting");

    const wsBase = import.meta.env.VITE_WS_BASE_URL as string | undefined;
    if (!wsBase) {
      setError("VITE_WS_BASE_URL is not set.");
      setStatus("error");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const ws = new WebSocket(toWsUrl(wsBase));
      wsRef.current = ws;

      ws.onmessage = (event: MessageEvent) => {
        console.log("ws onmessage:", event.data);
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "transcribe_audio" && typeof msg.text === "string") {
            setTranscripts((prev) => [
              ...prev,
              { recordStartRef: msg.recordStartRef, text: msg.text },
            ]);
          }
        } catch {
          // Non-JSON message (e.g. the backend's "bye"); ignore.
        }
      };
      ws.onerror = () => {
        setError("WebSocket connection failed.");
        setStatus("error");
        teardown();
      };
      ws.onclose = () => {
        if (wsRef.current === ws) {
          teardown();
          setStatus((s) => (s === "error" ? s : "idle"));
        }
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
      });

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

      setStatus("listening");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start microphone.");
      setStatus("error");
      teardown();
    }
  }

  function stop() {
    teardown();
    setStatus("idle");
  }

  // Release mic, socket and audio context when leaving the page.
  useEffect(() => {
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2️⃣ Reattach onmessage whenever relevant state changes
  useEffect(() => {
    debugger
    const ws = wsRef.current
    if (!ws) return;

    ws.onmessage = (event: MessageEvent<string>) => {
        debugger
      const data = JSON.parse(event.data)
      console.log(data)
    };
  }, []); // ✅ only reattaches handler, no reconnect


  const active = status === "listening" || status === "speaking";
  const busy = status === "connecting";

  return (
    <main className="mx-auto flex max-w-xl flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Voicebot</h1>

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

      {active || busy ? (
        <Button variant="destructive" onClick={stop} disabled={busy}>
          Stop
        </Button>
      ) : (
        <Button onClick={start}>Start</Button>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {lastUtterance && (
        <p className="text-xs text-gray-500">
          Last utterance started at {lastUtterance}
        </p>
      )}

      {transcripts.length > 0 && (
        <ul className="flex w-full flex-col gap-2">
          {transcripts.map((t, i) => (
            <li key={`${t.recordStartRef}-${i}`} className="rounded border p-3">
              <p className="text-xs text-gray-500">{t.recordStartRef}</p>
              <p className="text-base">{t.text}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
