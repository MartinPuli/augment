export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";

/** GET: is ElevenLabs configured? (picks voice output and speech-to-text engines in the browser) */
export async function GET() {
  const el = !!process.env.ELEVENLABS_API_KEY;
  return Response.json({ provider: el ? "elevenlabs" : "browser", stt: el ? "elevenlabs" : "browser" });
}

/**
 * POST {text} -> audio/mpeg stream from ElevenLabs (key stays server-side).
 * 503 when not configured so the browser falls back to speechSynthesis.
 */
export async function POST(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "ElevenLabs not configured" }, { status: 503 });

  let text = "";
  try {
    ({ text } = await req.json());
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  text = String(text ?? "").slice(0, 600).trim();
  if (!text) return Response.json({ error: "text required" }, { status: 400 });

  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const model = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
      }),
      signal: req.signal,
    },
  ).catch((e: unknown) => e as Error);

  if (upstream instanceof Error) return Response.json({ error: upstream.message }, { status: 502 });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json({ error: `ElevenLabs ${upstream.status}`, detail: detail.slice(0, 300) }, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
