// Latency benchmark for Polty's first turn through the configured Claude endpoint.
// Usage: pnpm exec tsx scripts/agent-bench.mts
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { createClaudeClient } from "../src/lib/agent/claude";
import { SYSTEM_PROMPT } from "../src/lib/agent/prompt";
import { TOOL_DEFS } from "../src/lib/agent/tools";

const { client, provider } = createClaudeClient();
type Cfg = { label: string; model: string; extra: Record<string, unknown> };
const configs: Cfg[] = [
  { label: "opus-5-5 · adaptive · low", model: "claude-opus-5-5", extra: { thinking: { type: "adaptive" }, output_config: { effort: "low" } } },
  { label: "sonnet-5-5 · adaptive · low", model: "claude-sonnet-5-5", extra: { thinking: { type: "adaptive" }, output_config: { effort: "low" } } },
  { label: "sonnet-5-5 · between_tools · low", model: "claude-sonnet-5-5", extra: { thinking: { type: "between_tools" }, output_config: { effort: "low" } } },
  { label: "haiku-4-5 · no thinking", model: "claude-haiku-4-5", extra: {} },
];
const question = "How high is the tide in San Francisco right now?";
console.log("provider:", provider);
for (const c of configs) {
  for (let run = 1; run <= 2; run++) {
    const t0 = Date.now();
    let firstText = 0;
    let firstTool = 0;
    try {
      const s = client.messages.stream({
        model: c.model,
        max_tokens: 2000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOL_DEFS,
        messages: [{ role: "user", content: `<context>\ncanvas: empty\n</context>\n\n${question}` }],
        ...(c.extra as object),
      } as Parameters<typeof client.messages.stream>[0]);
      s.on("streamEvent", (e) => {
        if (!firstText && e.type === "content_block_delta" && e.delta.type === "text_delta") firstText = Date.now() - t0;
        if (!firstTool && e.type === "content_block_start" && e.content_block.type === "tool_use") firstTool = Date.now() - t0;
      });
      const m = await s.finalMessage();
      const tool = m.content.find((b) => b.type === "tool_use");
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").slice(0, 70);
      console.log(
        `${c.label.padEnd(36)} run${run}  first text ${String(firstText || "-").padStart(5)}ms  first tool ${String(firstTool || "-").padStart(5)}ms  total ${String(Date.now() - t0).padStart(5)}ms  tool=${tool ? (tool as { name: string }).name : "none"}  "${text}"`,
      );
    } catch (e) {
      console.log(`${c.label.padEnd(36)} run${run}  ERROR ${(e as Error).message.slice(0, 160)}`);
    }
  }
}
