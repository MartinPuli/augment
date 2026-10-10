import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { CapabilitySpec, Device } from "../contracts";
import { COOKIE_NAME, createPrincipal, getPrincipal, getPrincipalOptional, getPrincipalRow } from "./auth";
import { db } from "./db";
import { listLeases, releaseLease } from "./leases";
import { rateLimit } from "./state";
import { bad, forbidden, GhostError, id, iso, json } from "./util";

export type AgentPermission = "public_read" | "hardware_read" | "hardware_control";
export interface AgentIdentity { agent_id: string; owner_id: string; principal_id: string; name: string; permission: AgentPermission; max_spend_cents: number; revoked_at: string | null; }
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
function session(c: Context, token: string) {
  c.header("Cache-Control", "private, no-store");
  setCookie(c, COOKIE_NAME, token, { httpOnly: true, sameSite: "Lax", path: "/", secure: (c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "")) === "https", maxAge: 60 * 60 * 24 * 365 });
}
async function input(c: Context) {
  if (Number(c.req.header("content-length") || 0) > 4096) throw bad("Request too large");
  try { return await c.req.json<Record<string, unknown>>(); } catch { throw bad("Invalid JSON"); }
}
export async function agentFromToken(token: string): Promise<AgentIdentity | null> {
  if (!token.startsWith("gha_")) return null;
  const r = await db().query<AgentIdentity>("select agent_id,owner_id,principal_id,name,permission,max_spend_cents,revoked_at from agent_credentials where token_hash=$1 and revoked_at is null", [hashToken(token)]);
  return r.rows[0] || null;
}
export function agentAllows(agent: AgentIdentity, device: Pick<Device, "access_type">, capability: Pick<CapabilitySpec, "kind">): boolean {
  if (agent.permission === "public_read" && device.access_type !== "public_observation") return false;
  return capability.kind !== "act" || agent.permission === "hardware_control";
}
export async function assertAgentActive(agent: AgentIdentity) {
  const r = await db().query("select agent_id from agent_credentials where agent_id=$1 and revoked_at is null", [agent.agent_id]);
  if (!r.rows.length) throw forbidden("This agent's access has been revoked");
}
async function requireAccount(c: Context) {
  const principal = await getPrincipal(c);
  const r = await db().query<{ username: string }>("select username from accounts where principal_id=$1", [principal]);
  if (!r.rows.length) throw new GhostError(401, "Create an account or sign in first", "account_required");
  return { principal, username: r.rows[0].username };
}
export function mountAccountRoutes(app: Hono) {
  app.use("/account/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const origin = c.req.header("origin");
    const host = c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host;
    if (c.req.method !== "GET" && origin && new URL(origin).host !== host) throw forbidden("Cross-origin account changes are not allowed");
    await next();
  });
  app.get("/account/session", async c => {
    const p = await getPrincipalOptional(c);
    if (!p) return c.json({ account: null });
    const r = await db().query<{ username: string }>("select username from accounts where principal_id=$1", [p.principal_id]);
    return c.json({ account: r.rows[0] ? { username: r.rows[0].username, principal_id: p.principal_id } : null });
  });
  for (const action of ["register", "login"] as const) app.post(`/account/${action}`, async c => {
    const b = await input(c);
    const username = String(b.username || "").trim().toLowerCase();
    const password = typeof b.password === "string" ? b.password : "";
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad("Use 3–32 letters, numbers or underscores for your username");
    if (password.length < 12 || password.length > 256) throw bad("Use a password between 12 and 256 characters");
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!await rateLimit(`account:${action}:${ip}`, 20, 300_000) || !await rateLimit(`account:${action}:${username}`, 10, 300_000)) throw new GhostError(429, "Too many attempts. Try again later.", "rate_limit");
    if (action === "register") {
      const existing = await db().query("select username from accounts where username=$1", [username]);
      if (existing.rows.length) throw bad("That username is unavailable");
      const current = await getPrincipalOptional(c);
      if (current && (await db().query("select username from accounts where principal_id=$1", [current.principal_id])).rows.length) throw bad("Sign out before creating another account");
      const p = current || await createPrincipal();
      const salt = randomBytes(16).toString("hex");
      const passwordHash = (await derive(password, salt)).toString("hex");
      try {
        await db().tx(async q => {
          await q.query("insert into accounts(principal_id,username,password_salt,password_hash) values($1,$2,$3,$4)", [p.principal_id, username, salt, passwordHash]);
          await q.query("update principals set display_name=$2 where principal_id=$1", [p.principal_id, username]);
        });
      } catch (error) { if ((error as { code?: string }).code === "23505") throw bad("Account already exists"); throw error; }
      session(c, p.owner_token);
      return c.json({ account: { username, principal_id: p.principal_id } }, 201);
    }
    const r = await db().query<{ principal_id: string; password_salt: string; password_hash: string }>("select principal_id,password_salt,password_hash from accounts where username=$1", [username]);
    const account = r.rows[0];
    const supplied = await derive(password, account?.password_salt || "ghost-account-not-found");
    if (!account || !timingSafeEqual(supplied, Buffer.from(account.password_hash, "hex"))) throw new GhostError(401, "Incorrect username or password", "unauthorized");
    const p = await getPrincipalRow(account.principal_id);
    if (!p) throw new GhostError(401, "Account unavailable", "unauthorized");
    session(c, p.owner_token);
    return c.json({ account: { username, principal_id: p.principal_id } });
  });
  app.post("/account/logout", c => { deleteCookie(c, COOKIE_NAME, { path: "/" }); return c.json({ ok: true }); });
  app.get("/account/agents", async c => {
    const { principal } = await requireAccount(c);
    const r = await db().query("select agent_id,name,permission,max_spend_cents,created_at,revoked_at from agent_credentials where owner_id=$1 order by created_at desc", [principal]);
    return c.json(r.rows);
  });
  app.post("/account/agents", async c => {
    const { principal } = await requireAccount(c);
    const b = await input(c);
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
    if (!name) throw bad("Give your agent a name");
    const permission = b.permission as AgentPermission;
    if (!["public_read", "hardware_read", "hardware_control"].includes(permission)) throw bad("Choose an access level");
    const maxSpend = Number(b.max_spend_cents ?? 0);
    if (!Number.isInteger(maxSpend) || maxSpend < 0 || maxSpend > 10000) throw bad("Per-lease test budget must be between 0 and 10000 cents");
    if (!await rateLimit(`agents:create:${principal}`, 10, 60_000)) throw new GhostError(429, "Too many agents created. Try again later.", "rate_limit");
    const agentPrincipal = await createPrincipal();
    const agentId = id("agent");
    const token = `gha_${randomBytes(32).toString("base64url")}`;
    await db().tx(async q => {
      await q.query("update principals set display_name=$2,kind='agent' where principal_id=$1", [agentPrincipal.principal_id, name]);
      await q.query("insert into agent_credentials(agent_id,owner_id,principal_id,name,token_hash,permission,max_spend_cents) values($1,$2,$3,$4,$5,$6,$7)", [agentId, principal, agentPrincipal.principal_id, name, hashToken(token), permission, maxSpend]);
    });
    return c.json({ agent_id: agentId, name, permission, max_spend_cents: maxSpend, token }, 201);
  });
  app.post("/account/agents/:id/revoke", async c => {
    const { principal } = await requireAccount(c);
    const r = await db().query<{ principal_id: string }>("update agent_credentials set revoked_at=coalesce(revoked_at,now()) where agent_id=$1 and owner_id=$2 returning principal_id", [c.req.param("id"), principal]);
    if (!r.rows.length) throw new GhostError(404, "Agent not found", "not_found");
    const leases = await listLeases(r.rows[0].principal_id, { role: "visitor", active: true });
    const results = await Promise.allSettled(leases.map(l => releaseLease(r.rows[0].principal_id, l.lease_id)));
    return c.json({ revoked: true, leases_released: results.filter(r => r.status === "fulfilled").length, leases_pending: results.filter(r => r.status === "rejected").length });
  });
  app.get("/account/activity", async c => {
    const { principal } = await requireAccount(c);
    const r = await db().query(`select i.invocation_id,i.device_id,i.capability_id,i.state,i.error,i.created_at,i.updated_at,
      a.name as agent_name,d.manifest->>'name' as device_name,i.arguments,o.observation_id,o.body as observation
      from invocations i join agent_credentials a on a.principal_id=i.visitor_id
      left join devices d on d.device_id=i.device_id left join observations o on o.observation_id=i.observation_id
      where a.owner_id=$1 order by i.created_at desc limit 50`, [principal]);
    const calls = await db().query(`select t.call_id,t.tool,t.arguments,t.state,t.result,t.created_at,t.finished_at,a.name as agent_name from agent_tool_calls t join agent_credentials a on a.agent_id=t.agent_id where a.owner_id=$1 order by t.created_at desc limit 50`, [principal]);
    return c.json({ calls: calls.rows.map(r => ({ ...r, arguments: json(r.arguments), created_at: iso(r.created_at), finished_at: r.finished_at ? iso(r.finished_at) : null })), invocations: r.rows.map(r => ({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at), observation: r.observation ? json(r.observation) : null })) });
  });
}
