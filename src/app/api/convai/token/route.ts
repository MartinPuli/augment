import { conversationToken } from "@/lib/agent/convai-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST -> {token}: WebRTC conversation token for the hosted Polty agent (key stays server-side). */
export async function POST() {
  if (!process.env.ELEVENLABS_API_KEY) return Response.json({ error: "ElevenLabs not configured" }, { status: 503 });
  try {
    return Response.json({ token: await conversationToken() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
