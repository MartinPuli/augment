/** Hosted account + delegated MCP smoke: public catalog reads only, token revoked afterward. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
async function main() {
  const base = process.argv[2]?.replace(/\/$/, "");
  assert(base?.startsWith("https://"));
  const extra: Record<string,string> = {};
  if (process.env.GHOST_VERCEL_BYPASS_FILE) {
    const project = JSON.parse(fs.readFileSync(process.env.GHOST_VERCEL_BYPASS_FILE, "utf8"));
    const tokens = project.protectionBypass || project.project?.protectionBypass || {};
    const key = Object.keys(tokens).find(key => tokens[key].scope === "automation-bypass");
    assert(key, "No automation bypass present in the private project metadata"); extra["x-vercel-protection-bypass"] = key;
  }
  const username = `smoke_${Date.now().toString(36)}`;
  const password = randomBytes(24).toString("base64url");
  let cookie = "";
  let agentId = "";
  async function request(path: string, body?: unknown) {
    return fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...extra, ...(cookie ? { cookie } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  try {
    const page = await request("/dashboard"); assert.equal(page.status, 200); assert((await page.text()).includes("Your agents"));
    assert.equal((await request("/api/agent", {})).status, 410);
    assert.equal((await request("/api/v1/partners/status")).status, 404);
    console.log("PASS dashboard and retired software endpoints");
    const created = await request("/api/v1/account/register", { username, password }); assert.equal(created.status, 201); cookie = created.headers.get("set-cookie")!.split(";")[0];
    const ownerId = (await created.json()).account.principal_id;
    const made = await request("/api/v1/account/agents", { name: "Deployment test (public reads)", permission: "public_read" }); assert.equal(made.status, 201);
    const agent = await made.json(); agentId = agent.agent_id;
    async function rpc(method: string, params: unknown) {
      return fetch(base + "/mcp", { method: "POST", headers: { ...extra, authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    }
    const list = await rpc("tools/list", {}); assert.equal(list.status, 200); const tools = (await list.json()).result.tools;
    assert(!tools.some((t: { name: string }) => t.name === "update_offer"));
    const search = await rpc("tools/call", { name: "search_capabilities", arguments: { q: "Bay Bridge", limit: 3 } }); assert.equal(search.status, 200); const result = await search.json(); assert(!result.result.isError);
    const activity = await request("/api/v1/account/activity"); const saved = await activity.json(); assert(saved.calls.some((c: { tool: string; state: string }) => c.tool === "search_capabilities" && c.state === "completed"));
    console.log("PASS account, delegated MCP and persisted activity across hosted requests");
    await request("/api/v1/account/logout", {}); cookie = "";
    const login = await request("/api/v1/account/login", { username, password }); assert.equal(login.status, 200); assert.equal((await login.json()).account.principal_id, ownerId); cookie = login.headers.get("set-cookie")!.split(";")[0];
    const revoked = await request(`/api/v1/account/agents/${agentId}/revoke`, {}); assert.equal(revoked.status, 200); assert.equal((await rpc("tools/list", {})).status, 401);
    console.log("PASS account sign-in and immediate token revocation");
  } finally {
    if (cookie && agentId) await request(`/api/v1/account/agents/${agentId}/revoke`, {}).catch(() => {});
    if (cookie) await request("/api/v1/account/logout", {}).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
