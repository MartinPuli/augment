/** Thin MCP client: the agent chooses each tool and its arguments. No scripted actions. */
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const [name, raw = "{}"] = process.argv.slice(2);
  if (!name) throw new Error('Usage: node --import tsx scripts/dot-hardware-client.ts tools/list | <tool-name> \'{"argument":"value"}\'');
  const connection = JSON.parse(await readFile(".ghost/dot-hardware-demo/connection.private.json", "utf8"));
  if (connection.endpoint !== "http://127.0.0.1:4411/mcp") throw new Error("This helper only connects to the isolated local demo");
  const client = new Client({ name: "dot-hardware-demo-client", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.endpoint), { requestInit: { headers: { authorization: `Bearer ${connection.token}` } } }));
    const result = name === "tools/list" ? await client.listTools() : await client.callTool({ name, arguments: JSON.parse(raw) });
    console.log(JSON.stringify(result, null, 2));
  } finally { await client.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Demo client failed"); process.exitCode = 1; });
