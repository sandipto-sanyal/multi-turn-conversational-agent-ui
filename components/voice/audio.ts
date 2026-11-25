// Audio constants and pure helpers used by VoiceCapture.

// Requested capture sample rate (browsers may resample to the device rate).
export const SAMPLE_RATE = 16000;
// Samples per block posted from the audio worklet (1024 @ 16 kHz = 64 ms).
export const BLOCK_SIZE = 1024;
// Block RMS (0..1) above which a block counts as speech.
export const SPEECH_RMS_THRESHOLD = 0.02;
// Consecutive silent blocks before the current utterance is closed (~512 ms).
export const SILENCE_HANG_BLOCKS = 8;
// Range and step for the speech threshold control. Typical speech RMS is ~0.05-0.3,
// so 0.1 is a sensible upper bound.
export const THRESHOLD_MAX = 0.1;
export const THRESHOLD_STEP = 0.001;

// Audio worklet source, loaded from a Blob URL. It re-chunks the mic input
// into fixed-size Float32 blocks and posts them to the main thread.
export const WORKLET_SOURCE = `
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

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// Joins blocks into one contiguous Float32Array.
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Linear resampling. Used when the browser ignores the requested 16 kHz rate,
// because the backend always decodes the audio as 16 kHz.
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const outLength = Math.round((samples.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

// Float32 [-1, 1] -> little-endian 16-bit PCM -> base64 string.
export function encodePcm16Base64(samples: Float32Array): string {
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

// "yyyy-mm-dd HH:MM:SS" in local time.
export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// WebSocket needs ws:// or wss://; convert from http(s) if the URL uses those.
export function toWsUrl(base: string): string {
  return base.replace(/^http(s?):\/\//i, (_m, s) => `ws${s}://`);
}
