// Does the configured Claude endpoint support Anthropic server tools (web search / fetch)?
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { createClaudeClient } from "../src/lib/agent/claude";
const { client, provider } = createClaudeClient();
const cases = [
  { model: "claude-haiku-4-5", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }] },
  { model: "claude-opus-5-5", tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2 }] },
];
for (const c of cases) {
  const t0 = Date.now();
  try {
    const m = await client.messages.create({
      model: c.model,
      max_tokens: 1500,
      tools: c.tools as never,
      ...(c.model.includes("opus") ? { thinking: { type: "adaptive" }, output_config: { effort: "low" } } : {}),
      messages: [{ role: "user", content: "What is the top headline on news today? One sentence, cite the source." }],
    } as never);
    const types = (m as { content: { type: string }[] }).content.map((b) => b.type);
    const text = (m as { content: { type: string; text?: string }[] }).content.filter((b) => b.type === "text").map((b) => b.text).join("").slice(0, 160);
    console.log(provider, c.model, `${Date.now() - t0}ms`, (m as { stop_reason: string }).stop_reason, types.join(","), "|", text);
  } catch (e) {
    console.log(provider, c.model, "ERROR", (e as Error).message.slice(0, 200));
  }
}
