export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST -> {token, url_params}: a single-use ElevenLabs token so the browser can stream microphone
 * audio straight to realtime Scribe (live partial captions, final transcript ~0.5 s after you stop).
 * The API key never leaves the server.
 */
export async function POST() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "ElevenLabs not configured" }, { status: 503 });
  const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
    method: "POST",
    headers: { "xi-api-key": key },
  }).catch((e: unknown) => e as Error);
  if (r instanceof Error) return Response.json({ error: r.message }, { status: 502 });
  if (!r.ok) return Response.json({ error: `ElevenLabs token ${r.status}` }, { status: 502 });
  const j = (await r.json()) as { token?: string };
  if (!j.token) return Response.json({ error: "no token returned" }, { status: 502 });
  return Response.json(
    {
      token: j.token,
      language_code: process.env.ELEVENLABS_STT_LANGUAGE && process.env.ELEVENLABS_STT_LANGUAGE !== "auto" ? process.env.ELEVENLABS_STT_LANGUAGE : "en",
      keyterms: ["Polty", "GHOST", "Caltrans", "NOAA", "Arduino", "Bluetooth", "Wi-Fi"],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
