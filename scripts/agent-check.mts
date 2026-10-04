import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { createClaudeClient } from "../src/lib/agent/claude";
import { SYSTEM_PROMPT } from "../src/lib/agent/prompt";
import { TOOL_DEFS } from "../src/lib/agent/tools";

const { client, provider } = createClaudeClient();
console.log("provider", provider);
const t0 = Date.now();
const s = client.messages.stream({
  model: process.env.GHOST_MODEL || "claude-opus-5-5",
  max_tokens: 4000,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true })),
  thinking: { type: "adaptive" },
  output_config: { effort: "low" },
  cache_control: { type: "ephemeral" },
  messages: [{ role: "user", content: "How high is the tide in San Francisco right now?" }],
});
let first = 0;
s.on("text", (d) => { if (!first) first = Date.now(); process.stdout.write(d); });
const m = await s.finalMessage();
console.log("\nTTFT ms", first ? first - t0 : null, "total ms", Date.now() - t0);
console.log("stop", m.stop_reason, "model", m.model, "usage", JSON.stringify(m.usage));
console.log(JSON.stringify(m.content.map((b) => b.type === "tool_use" ? { tool: b.name, input: b.input } : { type: b.type }), null, 0));
