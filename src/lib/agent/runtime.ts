"use client";

import type Anthropic from "@anthropic-ai/sdk";
import { MOODS, type Mood, type UiMessage, useGhost } from "@/lib/store";
import { SentenceChunker, speaker } from "@/lib/voice/speaker";
import { executeTool } from "./execute";
import { TOOL_LABELS } from "./tools";

type MsgParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

const S = () => useGhost.getState();
const MOOD_RE = /\[\[\s*([a-z]+)\s*\]\]\s*/gi;
const MAX_STEPS = 16;

let controller: AbortController | null = null;
let runId = 0;

/** Strip mood tags (and any half-streamed tag at the end) for display/speech. */
function clean(raw: string) {
  return raw.replace(MOOD_RE, "").replace(/\[\[[^\]]*$/, "").replace(/\[$/, "");
}

function applyMood(raw: string) {
  let m: RegExpExecArray | null;
  let last: string | null = null;
  const re = new RegExp(MOOD_RE.source, "gi");
  while ((m = re.exec(raw))) last = m[1].toLowerCase();
  if (last && (MOODS as string[]).includes(last)) S().set({ mood: last as Mood });
}

function contextBlock(): string {
  const s = S();
  const b = s.budget;
  const widgets = s.widgets.map((w) => `${w.id} (${w.type}${w.title ? `: ${w.title}` : ""})`).join(", ") || "empty";
  const online = Object.values(s.devices).filter((d) => d.online && !d.connector_id.startsWith("internal:")).map((d) => d.name);
  return [
    `<context>`,
    `local_time: ${new Date().toLocaleString("en-US", { hour12: false })}`,
    `budget: ${b.goal ? `goal "${b.goal}", ` : ""}${b.spent_cents}¢ spent of ${b.limit_cents}¢ (test funds)`,
    `canvas: ${widgets}`,
    `connected personal devices online: ${online.length ? online.join(", ") : "none"}`,
    `</context>`,
  ].join("\n");
}

function updateAssistantUi(id: string, patch: (m: UiMessage) => UiMessage) {
  const ui = S().ui.map((m) => (m.id === id ? patch(m) : m));
  S().set({ ui });
}

/** If the transcript ends with unanswered tool_use blocks (cancelled run), answer them. */
function pendingToolResults(): Anthropic.Beta.BetaToolResultBlockParam[] {
  const t = S().transcript;
  const last = t[t.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return [];
  return (last.content as ContentBlock[])
    .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
    .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "Cancelled: the user interrupted.", is_error: true }));
}

export function cancelRun() {
  runId++;
  controller?.abort();
  controller = null;
  speaker?.stop();
  S().set({ running: false, toolStatus: null, activity: "idle" });
}

/**
 * Send a user utterance (spoken, typed, or a UI event) and run the agent loop until Polty is done.
 */
export async function sendToPolty(text: string, opts: { event?: boolean } = {}) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (S().running) cancelRun();
  speaker?.stop();

  const myRun = ++runId;
  controller = new AbortController();
  const signal = controller.signal;

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...pendingToolResults(),
    { type: "text", text: `${contextBlock()}\n\n${opts.event ? `[UI event] ${trimmed}` : trimmed}` },
  ];
  const userUi: UiMessage = { id: `u-${Date.now()}`, role: "user", text: trimmed, tools: [], createdAt: Date.now(), event: opts.event };
  const asstId = `a-${Date.now()}`;
  const asstUi: UiMessage = { id: asstId, role: "assistant", text: "", tools: [], createdAt: Date.now() };

  S().set({
    transcript: [...S().transcript, { role: "user", content }],
    ui: [...S().ui, userUi, asstUi],
    running: true,
    activity: "thinking",
    mood: "thinking",
    caption: opts.event ? S().caption : { who: "user", text: trimmed },
    error: null,
  });

  let spokenAny = false;
  let streamRetries = 0;
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (myRun !== runId) return;
      let raw = "";
      const chunker = new SentenceChunker();
      const result = await streamTurn(S().transcript, signal, {
        onText: (d) => {
          raw += d;
          applyMood(raw);
          const shown = clean(raw);
          if (shown.trim()) {
            S().set({ caption: { who: "polty", text: shown } });
            updateAssistantUi(asstId, (m) => ({ ...m, text: joinText(m.text, shown, step) }));
          }
          for (const sentence of chunker.push(shown)) {
            speaker?.enqueue(sentence);
            spokenAny = true;
          }
        },
        onTool: (_id, name) => {
          S().set({ activity: "acting", toolStatus: TOOL_LABELS[name] ?? name });
        },
      });
      if (myRun !== runId) return;

      if (result.error) {
        if (result.code === "stream" && streamRetries++ < 2) {
          step--;
          continue;
        }
        if (result.code === "aborted") return;
        throw new Error(result.error);
      }
      streamRetries = 0;
      const shown = clean(raw);
      const tail = chunker.flush(shown);
      if (tail) {
        speaker?.enqueue(tail);
        spokenAny = true;
      }

      const blocks = result.content as ContentBlock[];
      S().set({ transcript: [...S().transcript, { role: "assistant", content: blocks as unknown as MsgParam["content"] }] });

      if (result.stop_reason === "refusal") {
        S().set({ mood: "sad", caption: { who: "polty", text: "I can't help with that one." } });
        break;
      }
      if (result.stop_reason === "pause_turn") continue;

      const toolUses = blocks.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!toolUses.length) break;

      updateAssistantUi(asstId, (m) => ({
        ...m,
        tools: [...m.tools, ...toolUses.map((t) => ({ id: t.id, name: t.name, args: t.input, status: "running" as const }))],
      }));

      const truncated = result.stop_reason === "max_tokens";
      const results = await Promise.all(
        toolUses.map(async (t) => {
          S().set({ activity: "acting", toolStatus: TOOL_LABELS[t.name] ?? t.name });
          const input = t.input && typeof t.input === "object" ? (t.input as Record<string, unknown>) : null;
          const outcome = truncated || !input
            ? { content: "INVALID_INPUT: the tool input was truncated or not an object; re-issue the call.", isError: true }
            : await executeTool(t.name, input, t.id, signal);
          updateAssistantUi(asstId, (m) => ({
            ...m,
            tools: m.tools.map((x) =>
              x.id === t.id ? { ...x, status: outcome.isError ? "error" : "done", result: summarizeForUi(outcome.content) } : x,
            ),
          }));
          S().addTrace({ kind: "tool", title: `${t.name}${outcome.isError ? " ✕" : ""}`, detail: summarizeForUi(outcome.content).slice(0, 400) });
          return {
            type: "tool_result" as const,
            tool_use_id: t.id,
            content: outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          };
        }),
      );
      if (myRun !== runId) return;
      S().set({ transcript: [...S().transcript, { role: "user", content: results }], toolStatus: null, activity: "thinking" });
    }
  } catch (err) {
    if (myRun !== runId) return;
    const msg = err instanceof Error ? err.message : String(err);
    S().set({ error: msg, mood: "sad", caption: { who: "polty", text: "Something went wrong on my side." } });
    S().addTrace({ kind: "error", title: "Agent error", detail: msg });
    // Keep the transcript valid if the failure happened between a tool_use and its results.
    const pending = pendingToolResults();
    if (pending.length) S().set({ transcript: [...S().transcript, { role: "user", content: pending }] });
  } finally {
    if (myRun === runId) {
      S().set({ running: false, toolStatus: null, activity: speaker?.isSpeaking ? "speaking" : "idle" });
      if (!spokenAny) S().set({ activity: "idle" });
      setTimeout(() => {
        if (myRun === runId && !S().running && !speaker?.isSpeaking) S().set({ mood: "neutral" });
      }, 9000);
    }
  }
}

function joinText(prev: string, current: string, step: number): string {
  // Each step's text is shown after the previous steps' text.
  const parts = prev.split("⁣");
  parts[step] = current;
  return parts.filter((p) => p !== undefined).join("⁣");
}

export function displayText(t: string) {
  return t.split("⁣").filter(Boolean).join("\n\n");
}

function summarizeForUi(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[])
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
    .join(" ");
}

/* ------------------------------------------------------------------ */

interface TurnResult {
  content?: unknown[];
  stop_reason?: string;
  error?: string;
  code?: string;
}

async function streamTurn(
  messages: MsgParam[],
  signal: AbortSignal,
  on: { onText: (d: string) => void; onTool: (id: string, name: string) => void },
): Promise<TurnResult> {
  let res: Response;
  try {
    res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, brain: useGhost.getState().brain }),
      signal,
    });
  } catch (e) {
    if (signal.aborted) return { error: "aborted", code: "aborted" };
    return { error: e instanceof Error ? e.message : String(e), code: "network" };
  }
  if (!res.ok || !res.body) return { error: `Agent route HTTP ${res.status}`, code: "http" };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final: TurnResult = { error: "stream ended unexpectedly", code: "stream" };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.t === "text") on.onText(ev.d);
        else if (ev.t === "tool") on.onTool(ev.id, ev.name);
        else if (ev.t === "done") final = { content: ev.content, stop_reason: ev.stop_reason };
        else if (ev.t === "error") final = { error: ev.message, code: ev.code };
      }
    }
  } catch (e) {
    if (signal.aborted) return { error: "aborted", code: "aborted" };
    return { error: e instanceof Error ? e.message : String(e), code: "stream" };
  }
  return final;
}

/** Start a fresh session (new transcript, cleared canvas). */
export function resetSession() {
  cancelRun();
  S().set({
    transcript: [],
    ui: [],
    widgets: [],
    reports: {},
    focusId: null,
    caption: null,
    mood: "neutral",
    budget: { goal: null, limit_cents: 100, spent_cents: 0 },
    trace: [],
    error: null,
  });
}
