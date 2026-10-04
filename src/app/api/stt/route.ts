export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024;

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/**
 * POST raw audio (Content-Type audio/webm, audio/mp4, …) -> {text} via ElevenLabs Speech-to-Text.
 * The key stays server-side. 503 when not configured so the browser falls back to Web Speech.
 */
export async function POST(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "ElevenLabs not configured" }, { status: 503 });

  const type = (req.headers.get("content-type") || "audio/webm").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("audio/") && type !== "video/webm") return Response.json({ error: "audio body required" }, { status: 415 });
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 800) return Response.json({ text: "" });
  if (buf.byteLength > MAX_BYTES) return Response.json({ error: "audio too large" }, { status: 413 });

  const form = new FormData();
  form.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v2");
  const lang = process.env.ELEVENLABS_STT_LANGUAGE ?? "en";
  if (lang && lang !== "auto") form.append("language_code", lang);
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([buf], { type }), `speech.${EXT[type] ?? "webm"}`);

  const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal: req.signal,
  }).catch((e: unknown) => e as Error);
  if (upstream instanceof Error) return Response.json({ error: upstream.message }, { status: 502 });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return Response.json({ error: `ElevenLabs STT ${upstream.status}`, detail: detail.slice(0, 300) }, { status: 502 });
  }
  const j = (await upstream.json()) as { text?: string; language_code?: string };
  return Response.json({ text: (j.text ?? "").trim(), language: j.language_code ?? null });
}
