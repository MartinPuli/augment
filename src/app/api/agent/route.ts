import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { createClaudeClient } from "@/lib/agent/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One model turn for Polty. The browser owns the agent loop: it sends the full, append-only
 * transcript, receives streamed text and the final assistant content (including thinking blocks,
 * which it passes back unchanged), executes tool calls, and calls this route again.
 *
 * Wire format: Server-Sent Events, each `data:` line is JSON:
 *   {t:"text", d}                     text delta (spoken + captioned)
 *   {t:"tool", id, name}              a tool call started streaming
 *   {t:"done", content, stop_reason, usage, model}
 *   {t:"error", message, code}
 */
export async function POST(req: Request) {
  let body: { messages?: Anthropic.Beta.BetaMessageParam[]; brain?: "fast" | "deep" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  // Two brains: "fast" (default for voice) and "deep" (multi-step physical tasks).
  const brain = body.brain === "deep" ? "deep" : "fast";
  const model = brain === "deep" ? process.env.GHOST_MODEL || "claude-opus-5-5" : process.env.GHOST_FAST_MODEL || "claude-haiku-4-5";
  const effort = (process.env.GHOST_EFFORT || "low") as Effort;
  // Haiku 4.5 takes neither adaptive thinking nor `effort`; it runs without extended thinking.
  const isHaiku = model.startsWith("claude-haiku-4");
  const { client, provider } = createClaudeClient({ preferDirect: brain === "fast" });
  // Server-side refusal fallback is a Claude API feature; skip it behind a gateway.
  const useFallbacks = provider === "anthropic" && !isHaiku && process.env.GHOST_FALLBACKS !== "0";
  const fast = provider === "anthropic" && !isHaiku && process.env.GHOST_FAST_MODE === "1";

  const betas: Anthropic.Beta.AnthropicBeta[] = [];
  if (useFallbacks) betas.push("server-side-fallback-2026-07-01");
  if (fast) betas.push("fast-mode-2026-02-01");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const base = {
          model,
          max_tokens: 16000,
          system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
          tools: TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true })),
          cache_control: { type: "ephemeral" as const },
          ...(isHaiku ? {} : { thinking: { type: "adaptive" as const }, output_config: { effort } }),
        };
        // Through Neon AI Gateway use the standard Messages endpoint (no beta-only features);
        // direct to Anthropic, opt into server-side refusal fallbacks (and optional fast mode).
        const s = betas.length
          ? client.beta.messages.stream(
              {
                ...base,
                messages,
                ...(useFallbacks ? { fallbacks: "default" as const } : {}),
                ...(fast ? { speed: "fast" as const } : {}),
                betas,
              },
              { signal: req.signal },
            )
          : client.messages.stream({ ...base, messages: messages as Anthropic.MessageParam[] }, { signal: req.signal });

        for await (const event of s) {
          if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            send({ t: "tool", id: event.content_block.id, name: event.content_block.name });
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ t: "text", d: event.delta.text });
          }
        }
        const final = await s.finalMessage();
        send({ t: "done", content: final.content, stop_reason: final.stop_reason, usage: final.usage, model: final.model });
      } catch (err) {
        send({ t: "error", ...describeError(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function describeError(err: unknown): { message: string; code: string } {
  if (err instanceof Anthropic.AuthenticationError) {
    return { code: "auth", message: "Claude credentials are missing or invalid. Set ANTHROPIC_API_KEY in .env.local." };
  }
  if (err instanceof Anthropic.RateLimitError) return { code: "rate_limit", message: "Claude is rate limited — try again in a moment." };
  if (err instanceof Anthropic.BadRequestError) return { code: "bad_request", message: err.message };
  if (err instanceof Anthropic.APIError) return { code: `api_${err.status ?? "error"}`, message: err.message };
  if (err instanceof Error && err.name === "AbortError") return { code: "aborted", message: "aborted" };
  // Unparseable eager-streamed tool input surfaces here; the browser re-issues the turn.
  return { code: "stream", message: err instanceof Error ? err.message : String(err) };
}
