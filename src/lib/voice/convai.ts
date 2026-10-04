"use client";

import { VoiceConversation } from "@elevenlabs/client";
import { levels, useGhost } from "@/lib/store";
import { executeTool } from "@/lib/agent/execute";
import { TOOL_DEFS, TOOL_LABELS } from "@/lib/agent/tools";

/**
 * Live mode: Polty as an ElevenLabs Agent — always listening, speech-to-speech, with every GHOST
 * tool executed here in the browser (same executor as the text agent: canvas, coordinator,
 * hardware). One tap starts the conversation, another ends it.
 */
const S = () => useGhost.getState();

type JS = Record<string, unknown>;

/** Free-form object params travel as JSON strings (see convai-agent.ts); turn them back. */
function revive(name: string, params: JS): JS {
  const def = TOOL_DEFS.find((t) => t.name === name);
  const props = ((def?.input_schema as JS | undefined)?.properties ?? {}) as Record<string, JS>;
  const out: JS = { ...params };
  for (const [k, schema] of Object.entries(props)) {
    const v = out[k];
    const freeObject = schema.type === "object" && !(schema.properties && Object.keys(schema.properties as JS).length);
    if (freeObject && typeof v === "string") {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = {};
      }
    }
  }
  return out;
}

function toText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content.slice(0, 6000);
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image shown to the user on the canvas]" : ""))
    .join("\n")
    .slice(0, 6000);
}

class LiveSession {
  private conv: VoiceConversation | null = null;
  private raf = 0;
  private abort: AbortController | null = null;
  private asstId: string | null = null;
  starting = false;

  get active() {
    return !!this.conv || this.starting;
  }

  async start(): Promise<boolean> {
    if (this.active) return true;
    this.starting = true;
    this.abort = new AbortController();
    S().set({ activity: "thinking", caption: { who: "polty", text: "Connecting…", interim: true }, error: null, running: false });
    try {
      const r = await fetch("/api/convai/token", { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.token) throw new Error(j.error || `HTTP ${r.status}`);
      const signal = this.abort.signal;
      const clientTools = Object.fromEntries(
        TOOL_DEFS.map((t) => [
          t.name,
          async (params: JS) => {
            const id = `live-${t.name}-${Date.now().toString(36)}`;
            S().set({ activity: "acting", toolStatus: TOOL_LABELS[t.name] ?? t.name });
            this.addTool(id, t.name, params);
            try {
              const out = await executeTool(t.name, revive(t.name, params ?? {}), id, signal);
              const text = toText(out.content as string | { type: string; text?: string }[]);
              this.finishTool(id, out.isError ? "error" : "done", text);
              return out.isError ? `ERROR: ${text}` : text;
            } finally {
              S().set({ toolStatus: null });
            }
          },
        ]),
      );
      this.conv = await VoiceConversation.startSession({
        conversationToken: j.token,
        connectionType: "webrtc",
        clientTools,
        onMessage: ({ message, source }) => this.onMessage(message, source),
        onModeChange: ({ mode }) => {
          if (S().toolStatus) return;
          S().set({ activity: mode === "speaking" ? "speaking" : "listening" });
        },
        onDisconnect: () => this.cleanup(),
        onError: (message: string) => S().set({ error: `Live voice: ${message}` }),
      } as Parameters<typeof VoiceConversation.startSession>[0]);
      this.starting = false;
      S().set({ activity: "listening", caption: { who: "polty", text: "I'm listening — just talk.", interim: true } });
      this.meter();
      return true;
    } catch (e) {
      this.starting = false;
      this.cleanup();
      S().set({ error: `Couldn't start live voice: ${(e as Error).message}` });
      return false;
    }
  }

  async stop() {
    this.abort?.abort();
    const c = this.conv;
    this.conv = null;
    try {
      await c?.endSession();
    } catch {
      /* already closed */
    }
    this.cleanup();
  }

  private cleanup() {
    cancelAnimationFrame(this.raf);
    this.conv = null;
    this.starting = false;
    levels.mic = 0;
    levels.speech = 0;
    S().set({ activity: "idle", toolStatus: null });
  }

  private meter() {
    const tick = () => {
      const c = this.conv;
      if (!c) return;
      try {
        levels.mic = Math.min(1, c.getInputVolume() * 1.6);
        levels.speech = Math.min(1, c.getOutputVolume() * 1.8);
      } catch {
        /* not ready */
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private onMessage(message: string, source: "user" | "ai") {
    const text = message.replace(/\[\[\s*[a-z]+\s*\]\]\s*/gi, "").trim();
    if (!text) return;
    const st = S();
    if (source === "user") {
      this.asstId = null;
      st.set({
        caption: { who: "user", text },
        ui: [...st.ui, { id: `u-${Date.now()}`, role: "user", text, tools: [], createdAt: Date.now() }],
      });
    } else {
      const id = this.ensureAssistant();
      st.set({ caption: { who: "polty", text }, ui: S().ui.map((m) => (m.id === id ? { ...m, text: m.text ? `${m.text}\n\n${text}` : text } : m)) });
    }
  }

  private ensureAssistant(): string {
    if (this.asstId && S().ui.some((m) => m.id === this.asstId)) return this.asstId;
    const id = `a-${Date.now()}`;
    this.asstId = id;
    S().set({ ui: [...S().ui, { id, role: "assistant", text: "", tools: [], createdAt: Date.now() }] });
    return id;
  }

  private addTool(id: string, name: string, args: unknown) {
    const aid = this.ensureAssistant();
    S().set({ ui: S().ui.map((m) => (m.id === aid ? { ...m, tools: [...m.tools, { id, name, args, status: "running" as const }] } : m)) });
  }

  private finishTool(id: string, status: "done" | "error", result: string) {
    S().set({ ui: S().ui.map((m) => ({ ...m, tools: m.tools.map((t) => (t.id === id ? { ...t, status, result } : t)) })) });
    S().addTrace({ kind: "tool", title: `${id.split("-")[1]}${status === "error" ? " ✕" : ""}`, detail: result.slice(0, 300) });
  }
}

export const live = typeof window !== "undefined" ? new LiveSession() : (null as unknown as LiveSession);
