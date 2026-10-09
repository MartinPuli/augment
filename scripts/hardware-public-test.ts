/** Real, read-only public-provider observations. No simulated readings or private devices. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startCoordinator } from "../src/lib/ghost/server";
import { noaaAdapter } from "../src/lib/ghost/server/adapters/noaa";
import { caltransAdapter } from "../src/lib/ghost/server/adapters/caltrans";
import { publishFromAdapter } from "../src/lib/ghost/server/registry";

async function main() {
  process.env.GHOST_DB = "pglite"; delete process.env.DATABASE_URL;
  const base = "http://127.0.0.1:4391";
  const coordinator = await startCoordinator({ dataDir: "memory", skipAdapters: true, listenPort: 4391, hostname: "127.0.0.1" });
  const client = new Client({ name: "ghost-real-public-test", version: "1" });
  const results: Record<string, unknown>[] = [];
  const out = path.resolve(".ghost/hardware-public-evidence");
  await mkdir(out, { recursive: true });
  try {
    await Promise.all([noaaAdapter, caltransAdapter].map(async adapter => {
      const found = await adapter.discover!({ log: console.log });
      await publishFromAdapter(adapter.id, found, { owner_id: adapter.owner_id });
    }));
    const me = await (await fetch(`${base}/api/v1/me`)).json();
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${me.owner_token}` } } }));
    function data(r: CallToolResult) {
      const text = r.content.find(c => c.type === "text");
      assert(text?.type === "text");
      return JSON.parse(text.text.slice(text.text.search(/[\[{]/)));
    }
    for (const [query, semantic] of [["San Francisco", "water_level.read"], ["Bay Bridge", "image.observe"]]) {
      const search = await client.callTool({ name: "search_capabilities", arguments: { q: query, semantic_type: semantic, only_online: true, limit: 5 } }) as CallToolResult;
      const hits = data(search) as { ref: string; device: { name: string } }[];
      assert(hits.length, `No ${semantic} found`);
      let succeeded = false;
      for (const hit of hits) {
        const response = await client.callTool({ name: "invoke_capability", arguments: { ref: hit.ref, arguments: {}, idempotency_key: `live-${hit.ref}-${Date.now()}`, timeout_ms: 20000 } }) as CallToolResult;
        const evidence = data(response);
        if (evidence.state !== "succeeded") { results.push({ device: hit.device.name, state: evidence.state, error: evidence.error }); continue; }
        assert(evidence.observation?.source, "Missing source attribution");
        if (semantic === "water_level.read") assert(typeof evidence.observation.value === "number" && evidence.observation.captured_at);
        else {
          const image = response.content.find(c => c.type === "image");
          assert(image?.type === "image");
          const bytes = Buffer.from(image.data, "base64");
          assert(bytes[0] === 255 && bytes[1] === 216);
          await writeFile(path.join(out, "caltrans.jpg"), bytes);
        }
        results.push({ device: hit.device.name, ...evidence });
        console.log(JSON.stringify({ device: hit.device.name, state: evidence.state, captured_at: evidence.observation.captured_at, value: evidence.observation.value, note: evidence.observation.note }));
        succeeded = true; break;
      }
      assert(succeeded, `No successful observation for ${semantic}`);
    }
    console.log("Two real public-source observations passed through MCP. No private hardware was actuated.");
  } finally {
    await writeFile(path.join(out, "results.json"), JSON.stringify({ tested_at: new Date().toISOString(), results }, null, 2));
    await client.close(); await coordinator.stop();
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
