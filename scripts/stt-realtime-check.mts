// Dev check: stream a 16 kHz mono WAV to ElevenLabs realtime STT and print events with timings.
// Usage: pnpm exec tsx scripts/stt-realtime-check.mts <file16k.wav>
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const wav = readFileSync(process.argv[2]);
const pcm = wav.subarray(44); // canonical WAV header
const tok = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
  method: "POST",
  headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
}).then((r) => r.json());
const qs = new URLSearchParams({
  model_id: "scribe_v2_realtime",
  token: tok.token,
  audio_format: "pcm_16000",
  commit_strategy: "vad",
  vad_silence_threshold_secs: "0.5",
  language_code: "en",
});
qs.append("keyterms", "Polty");
const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`);
const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
ws.on("message", (m) => {
  const j = JSON.parse(String(m));
  console.log(ms(), j.message_type, j.text ?? j.error ?? j.warning ?? "");
  if (j.message_type === "committed_transcript" && j.text) setTimeout(() => process.exit(0), 300);
});
ws.on("error", (e) => console.log("error", e.message));
ws.on("close", (c, r) => console.log(ms(), "close", c, String(r)));
ws.on("open", async () => {
  console.log(ms(), "open");
  const chunk = 3200; // 100 ms of 16 kHz PCM16
  for (let i = 0; i < pcm.length + chunk * 15; i += chunk) {
    const buf = i < pcm.length ? pcm.subarray(i, i + chunk) : Buffer.alloc(chunk); // trailing silence
    ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: buf.toString("base64"), commit: false, sample_rate: 16000 }));
    if (i === pcm.length - (pcm.length % chunk)) console.log(ms(), "-- speech audio finished --");
    await new Promise((r) => setTimeout(r, 100));
  }
});
