import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SYSTEM_PROMPT } from "./prompt";
import { TOOL_DEFS } from "./tools";

/**
 * Polty as an ElevenLabs Agent: always-on speech-to-speech, with every GHOST tool registered as a
 * *client* tool (executed in the browser by the same executor the text agent uses).
 * The agent is created once and its id cached in .ghost/convai.json (or set ELEVENLABS_AGENT_ID).
 */
const API = "https://api.elevenlabs.io/v1/convai";
const CACHE = path.join(process.cwd(), ".ghost", "convai.json");
const VERSION = 3; // bump to push prompt/tool changes to the hosted agent

type JS = Record<string, unknown>;

/** ElevenLabs tool schemas need typed leaves; free-form objects become JSON strings. */
function convert(schema: JS, name = "value"): JS {
  const type = schema.type as string | undefined;
  const description = (schema.description as string | undefined) ?? name.replace(/_/g, " ");
  if (type === "object") {
    const props = schema.properties as Record<string, JS> | undefined;
    if (!props || !Object.keys(props).length) {
      return { type: "string", description: `${description} (JSON object as a string, e.g. {"key":"value"})` };
    }
    const out: JS = { type: "object", description, properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, convert(v, k)])) };
    if (Array.isArray(schema.required)) out.required = schema.required;
    return out;
  }
  if (type === "array") return { type: "array", description, items: convert((schema.items as JS) ?? { type: "string" }, `${name} item`) };
  const out: JS = { type: type === "integer" ? "integer" : type ?? "string", description };
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  return out;
}

function clientTools() {
  return TOOL_DEFS.map((t) => {
    const params = convert(t.input_schema as JS, t.name);
    return {
      type: "client",
      name: t.name,
      description: (t.description ?? "").slice(0, 1000),
      parameters: { type: "object", properties: (params.properties as JS) ?? {}, required: (params.required as string[]) ?? [] },
      expects_response: true,
      response_timeout_secs: 60,
    };
  });
}

const VOICE_PROMPT = `${SYSTEM_PROMPT.replace(/- Begin every reply with exactly one mood tag[^\n]*\n/, "")}

# Live voice mode
You are in a live, always-on voice conversation. Keep turns short and natural; it's fine to say a few words ("One sec…") before calling tools. Tool parameters described as "JSON object as a string" must be passed as a JSON-encoded string. Results that are images are shown to the user on the canvas; you receive a text summary of them.`;

function body() {
  return {
    name: "Polty · GHOST",
    conversation_config: {
      agent: {
        first_message: "Hi, I'm Polty! What can I do for you?",
        language: "en",
        prompt: {
          prompt: VOICE_PROMPT,
          llm: process.env.ELEVENLABS_AGENT_LLM || "claude-haiku-4-5",
          temperature: 0.4,
          tools: clientTools(),
        },
      },
      tts: { voice_id: process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL", model_id: "eleven_flash_v2" },
      turn: { turn_eagerness: "eager" },
    },
  };
}

async function api(pathname: string, init: RequestInit) {
  const r = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

let ensuring: Promise<string> | null = null;

export function ensureAgent(): Promise<string> {
  if (process.env.ELEVENLABS_AGENT_ID) return Promise.resolve(process.env.ELEVENLABS_AGENT_ID);
  ensuring ??= (async () => {
    let cached: { agent_id?: string; version?: number } = {};
    try {
      cached = JSON.parse(await readFile(CACHE, "utf8"));
    } catch {
      /* first run */
    }
    if (cached.agent_id && cached.version === VERSION) return cached.agent_id;
    let agentId = cached.agent_id;
    if (agentId) await api(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(body()) });
    else agentId = (await api(`/agents/create`, { method: "POST", body: JSON.stringify(body()) })).agent_id as string;
    await mkdir(path.dirname(CACHE), { recursive: true });
    await writeFile(CACHE, JSON.stringify({ agent_id: agentId, version: VERSION }));
    return agentId!;
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

export async function conversationToken(): Promise<string> {
  const agentId = await ensureAgent();
  const j = await api(`/conversation/token?agent_id=${encodeURIComponent(agentId)}`, { method: "GET" });
  return j.token as string;
}
