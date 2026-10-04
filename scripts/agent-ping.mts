// Minimal-request latency probe for the configured Claude endpoint (gateway/network overhead).
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { createClaudeClient } from "../src/lib/agent/claude";
const { client, provider } = createClaudeClient();
for (const model of ["claude-haiku-4-5", "claude-haiku-4-5", "claude-haiku-4-5"]) {
  const t0 = Date.now();
  let first = 0;
  const s = client.messages.stream({ model, max_tokens: 20, messages: [{ role: "user", content: "Say hi." }] });
  s.on("text", () => { if (!first) first = Date.now() - t0; });
  await s.finalMessage();
  console.log(provider, model, "first token", first, "ms, total", Date.now() - t0, "ms");
}
