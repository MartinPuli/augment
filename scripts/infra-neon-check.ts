/**
 * Neon checks (each part skips gracefully when not configured):
 *
 *   pnpm infra:neon-check            # Postgres + AI Gateway model list + 1 tiny Claude call
 *   pnpm infra:neon-check --no-llm   # skip the (billed) Claude call
 *
 * 1. Postgres: connects with `pg` using DATABASE_URL, prints server version, pooled/SSL info,
 *    and whether the coordinator tables and the Mastra mission schema exist.
 * 2. AI Gateway: lists models at <branch-host>/v1/models and sends one 16-token message
 *    through createAnthropicClient() (the same client the agent route uses).
 * Secrets are never printed.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import pg from "pg";
import { createAnthropicClient, gatewayInfo } from "../src/lib/llm/anthropic-client";

const noLlm = process.argv.includes("--no-llm");

async function checkPostgres(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("SKIP  Postgres: DATABASE_URL is not set (GHOST uses embedded PGlite in .ghost/pgdata)");
    return true;
  }
  let host = "?";
  let sslmode = "(none)";
  try {
    const u = new URL(url);
    host = u.hostname;
    sslmode = u.searchParams.get("sslmode") ?? "(none)";
  } catch {
    /* pg will report */
  }
  console.log(`      host ${host} · pooled=${host.includes("-pooler") ? "yes" : "no"} · sslmode=${sslmode}`);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  const t0 = Date.now();
  try {
    await client.connect();
    const v = await client.query<{ server_version: string; db: string }>(`select current_setting('server_version') as server_version, current_database() as db`);
    console.log(`PASS  Postgres: connected in ${Date.now() - t0} ms · server ${v.rows[0].server_version} · database ${v.rows[0].db}`);
    const t = await client.query<{ n: string }>(`select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_name in ('principals','devices','leases','experiences')`);
    console.log(`      coordinator tables present: ${t.rows[0].n}/4${t.rows[0].n === "0" ? " (created on first coordinator boot)" : ""}`);
    const m = await client.query<{ n: string }>(`select count(*)::text as n from information_schema.tables where table_schema = 'mastra'`);
    console.log(`      mastra schema tables (mission snapshots/traces): ${m.rows[0].n}${m.rows[0].n === "0" ? " (created on first mission run)" : ""}`);
    if (!host.includes("-pooler")) console.log("WARN  use the pooled connection string (host ends in -pooler) for the server");
    return true;
  } catch (e) {
    console.log(`FAIL  Postgres: ${(e as Error).message}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkGateway(): Promise<boolean> {
  if (gatewayInfo.provider !== "neon-ai-gateway") {
    console.log("SKIP  Neon AI Gateway: NEON_AI_GATEWAY_BASE_URL / NEON_AI_GATEWAY_TOKEN not set (Claude goes direct to Anthropic)");
    return true;
  }
  const anthropicBase = gatewayInfo.baseURL;
  const branchHost = anthropicBase.replace(/\/anthropic$/, "").replace(/\/ai-gateway$/, "");
  console.log(`      gateway ${new URL(anthropicBase).hostname} (Anthropic Messages at ${new URL(anthropicBase).pathname})`);
  let ok = true;
  try {
    const r = await fetch(`${branchHost}/v1/models`, {
      headers: { authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN ?? process.env.NEON_AI_GATEWAY_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as { data?: { id: string }[] };
    if (r.ok) {
      const claude = (j.data ?? []).map((m) => m.id).filter((id) => id.includes("claude"));
      console.log(`PASS  Gateway models: ${claude.length} Claude model(s): ${claude.join(", ") || "(none listed)"}`);
    } else {
      ok = false;
      console.log(`FAIL  Gateway models: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    }
  } catch (e) {
    ok = false;
    console.log(`FAIL  Gateway models: ${(e as Error).message}`);
  }
  if (noLlm) {
    console.log("SKIP  Claude call (--no-llm)");
    return ok;
  }
  const model = process.env.GHOST_GATEWAY_CHECK_MODEL ?? "claude-haiku-4-5";
  try {
    const t0 = Date.now();
    const msg = await createAnthropicClient({ timeout: 30_000, maxRetries: 0 }).messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: GHOST ok" }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    console.log(`PASS  Claude via Neon AI Gateway (${model}): "${text}" in ${Date.now() - t0} ms · usage in=${msg.usage.input_tokens} out=${msg.usage.output_tokens}`);
  } catch (e) {
    ok = false;
    console.log(`FAIL  Claude via Neon AI Gateway (${model}): ${(e as Error).message}`);
  }
  return ok;
}

async function main() {
  console.log("Neon checks");
  const a = await checkPostgres();
  const b = await checkGateway();
  process.exit(a && b ? 0 : 1);
}

void main();
