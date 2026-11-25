import { useEffect, useRef, useState } from "react";
import { VoiceCapture, type Utterance } from "@/components/voice/VoiceCapture";
import {
  SAMPLE_RATE,
  SPEECH_RMS_THRESHOLD,
  THRESHOLD_MAX,
  THRESHOLD_STEP,
  encodePcm16Base64,
  formatTimestamp,
  resampleLinear,
  toWsUrl,
} from "@/components/voice/audio";
// import { VoiceRecorder } from "@/components/voice/VoiceRecorder";

type Transcript = { recordStartRef: string; text: string };

export default function VoiceBot() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [connected, setConnected] = useState(false);
  const [speechThreshold, setSpeechThreshold] = useState(SPEECH_RMS_THRESHOLD);
  const wsRef = useRef<WebSocket | null>(null);

  // One transcription socket for the lifetime of the page.
  useEffect(() => {
    const base = import.meta.env.VITE_WS_BASE_URL as string | undefined;
    if (!base) return;

    const ws = new WebSocket(toWsUrl(base));
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "transcribe_audio" && typeof msg.text === "string") {
          setTranscripts((prev) => [...prev, { recordStartRef: msg.recordStartRef, text: msg.text }]);
        }
      } catch {
        // Non-JSON message (e.g. the backend's "bye"); ignore.
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  // Each finished utterance is sent as one message with the complete PCM16 audio.
  function handleUtterance(u: Utterance) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const audio = resampleLinear(u.audio, u.sampleRate, SAMPLE_RATE);
    ws.send(
      JSON.stringify({
        type: "user_audio",
        recordStartRef: formatTimestamp(u.startedAt),
        voice: encodePcm16Base64(audio),
        speech_end: true,
      })
    );
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Voicebot</h1>

      <p className="text-xs text-gray-500" role="status">
        {connected ? "Transcription server connected" : "Transcription server not connected"}
      </p>

      <div className="flex w-full flex-col gap-2">
        <label htmlFor="speech-threshold" className="flex justify-between text-sm text-gray-700">
          <span>Speech threshold</span>
          <span className="font-mono">{speechThreshold.toFixed(3)}</span>
        </label>
        <input
          id="speech-threshold"
          type="range"
          min={0}
          max={THRESHOLD_MAX}
          step={THRESHOLD_STEP}
          value={speechThreshold}
          onChange={(e) => setSpeechThreshold(Number(e.target.value))}
          className="w-full"
        />
        <p className="text-xs text-gray-500">
          Raise this if background noise is being recorded as speech.
        </p>
      </div>

      <VoiceCapture
        speechThreshold={speechThreshold}
        onUtterance={handleUtterance}
      />

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
