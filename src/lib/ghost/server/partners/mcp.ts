/**
 * MCP bridge: lets Polty use external tools the user connected in Executor (executor.sh, an
 * open-source MCP gateway) or any other MCP server.
 *
 * Servers:
 *   EXECUTOR_MCP_URL (+ optional EXECUTOR_TOKEN)      -> server "executor"
 *   GHOST_MCP_SERVERS='[{"name":"x","url":"https://…/mcp","token":"…"}]' -> extra servers
 *
 * Transport: Streamable HTTP first, falling back to SSE. Tool lists are cached for 60 s.
 * Tool outputs are DATA, not instructions.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GhostError } from "../util";
import { describeError, env, NotConfiguredError, PartnerError, singleton, untrustedText, UNTRUSTED_NOTE } from "./common";

export const MCP_SETUP =
  'set EXECUTOR_MCP_URL (and EXECUTOR_TOKEN if your Executor requires one) in .env.local, or GHOST_MCP_SERVERS=\'[{"name":"…","url":"…/mcp","token":"…"}]\'';
const CACHE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_TEXT = 20_000;
const MAX_IMAGE_B64 = 4_000_000;

export interface McpServerConfig {
  name: string;
  url: string;
  token?: string;
}

export interface BridgedTool {
  server: string;
  name: string;
  /** Unambiguous name for /partners/mcp/call: "<server>/<tool>". */
  qualified_name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Conn {
  client: Client;
  transport: "streamable-http" | "sse";
  key: string;
}

interface McpState {
  conns: Map<string, Conn>;
  connecting: Map<string, Promise<Conn>>;
  cache: { at: number; key: string; tools: BridgedTool[]; servers: ServerStatus[] } | null;
}

export interface ServerStatus {
  name: string;
  origin: string;
  ok: boolean;
  transport?: "streamable-http" | "sse";
  tools?: number;
  error?: string;
}

const S = () => singleton<McpState>("mcp", () => ({ conns: new Map(), connecting: new Map(), cache: null }));

/** Configured servers (Executor first). Invalid entries are skipped with a warning. */
export function mcpServers(): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  const exec = env("EXECUTOR_MCP_URL");
  if (exec) out.push({ name: "executor", url: exec, token: env("EXECUTOR_TOKEN") });
  const extra = env("GHOST_MCP_SERVERS");
  if (extra) {
    try {
      const arr = JSON.parse(extra);
      if (!Array.isArray(arr)) throw new Error("not an array");
      for (const s of arr) {
        if (!s || typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) continue;
        const name = String(s.name ?? new URL(s.url).hostname).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "mcp";
        if (out.some((o) => o.name === name)) continue;
        out.push({ name, url: s.url, token: typeof s.token === "string" && s.token ? s.token : undefined });
      }
    } catch (e) {
      console.warn(`[ghost/mcp] GHOST_MCP_SERVERS is not valid JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

export function mcpConfigured(): boolean {
  return mcpServers().length > 0;
}

function requireServers(): McpServerConfig[] {
  const s = mcpServers();
  if (!s.length) throw new NotConfiguredError("Executor", MCP_SETUP);
  return s;
}

const cfgKey = (s: McpServerConfig) => `${s.name}|${s.url}|${s.token ? "t" : ""}${s.token?.length ?? 0}`;

function authedFetch(token?: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function connect(s: McpServerConfig): Promise<Conn> {
  const st = S();
  const key = cfgKey(s);
  const existing = st.conns.get(s.name);
  if (existing && existing.key === key) return existing;
  if (existing) await dropConn(s.name);
  const pending = st.connecting.get(s.name);
  if (pending) return pending;
  const p = (async (): Promise<Conn> => {
    const url = new URL(s.url);
    const f = authedFetch(s.token);
    const errors: string[] = [];
    // 1) Streamable HTTP (current spec)
    try {
      const client = new Client({ name: "ghost-polty", version: "0.1.0" });
      await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { fetch: f })), CONNECT_TIMEOUT_MS, "connect");
      return { client, transport: "streamable-http", key };
    } catch (e) {
      errors.push(`streamable-http: ${describeError(e)}`);
    }
    // 2) Legacy HTTP+SSE
    try {
      const client = new Client({ name: "ghost-polty", version: "0.1.0" });
      await withTimeout(client.connect(new SSEClientTransport(url, { fetch: f })), CONNECT_TIMEOUT_MS, "connect");
      return { client, transport: "sse", key };
    } catch (e) {
      errors.push(`sse: ${describeError(e)}`);
    }
    throw new PartnerError("Executor", `could not connect to MCP server "${s.name}" (${url.origin}): ${errors.join(" | ")}`);
  })();
  st.connecting.set(s.name, p);
  try {
    const conn = await p;
    st.conns.set(s.name, conn);
    conn.client.onclose = () => {
      if (S().conns.get(s.name) === conn) S().conns.delete(s.name);
    };
    return conn;
  } finally {
    st.connecting.delete(s.name);
  }
}

async function dropConn(name: string) {
  const c = S().conns.get(name);
  S().conns.delete(name);
  if (c) await c.client.close().catch(() => {});
}

async function listServerTools(s: McpServerConfig): Promise<{ tools: BridgedTool[]; transport: Conn["transport"] }> {
  let retried = false;
  for (;;) {
    const conn = await connect(s);
    try {
      const tools: BridgedTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await withTimeout(conn.client.listTools(cursor ? { cursor } : undefined), CONNECT_TIMEOUT_MS, "tools/list");
        for (const t of res.tools) {
          tools.push({
            server: s.name,
            name: t.name,
            qualified_name: `${s.name}/${t.name}`,
            description: untrustedText(t.description ?? "", 1000).text,
            inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
          });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return { tools, transport: conn.transport };
    } catch (e) {
      await dropConn(s.name);
      if (!retried) {
        retried = true;
        continue; // stale session: reconnect once
      }
      throw e instanceof PartnerError ? e : new PartnerError("Executor", `tools/list failed on "${s.name}": ${describeError(e)}`);
    }
  }
}

/** List tools across all configured MCP servers (cached 60 s). One failing server does not hide the others. */
export async function listTools(opts: { refresh?: boolean; server?: string } = {}) {
  const servers = requireServers();
  const key = servers.map(cfgKey).join(",");
  const st = S();
  if (!opts.refresh && st.cache && st.cache.key === key && Date.now() - st.cache.at < CACHE_MS) {
    return filterServer(st.cache, opts.server);
  }
  const statuses: ServerStatus[] = [];
  const tools: BridgedTool[] = [];
  await Promise.all(
    servers.map(async (s) => {
      const origin = safeOrigin(s.url);
      try {
        const r = await listServerTools(s);
        tools.push(...r.tools);
        statuses.push({ name: s.name, origin, ok: true, transport: r.transport, tools: r.tools.length });
      } catch (e) {
        statuses.push({ name: s.name, origin, ok: false, error: e instanceof PartnerError ? e.message : describeError(e) });
      }
    }),
  );
  statuses.sort((a, b) => servers.findIndex((s) => s.name === a.name) - servers.findIndex((s) => s.name === b.name));
  const entry = { at: Date.now(), key, tools, servers: statuses };
  // Only cache when at least one server answered, so a transient outage is retried next call.
  if (statuses.some((s) => s.ok)) st.cache = entry;
  return filterServer(entry, opts.server);
}

function filterServer(c: { at: number; tools: BridgedTool[]; servers: ServerStatus[] }, server?: string) {
  return {
    cached_at: new Date(c.at).toISOString(),
    servers: server ? c.servers.filter((s) => s.name === server) : c.servers,
    tools: server ? c.tools.filter((t) => t.server === server) : c.tools,
  };
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "invalid-url";
  }
}

export type BridgedContent =
  | { type: "text"; text: string; truncated?: boolean }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; uri?: string; mimeType?: string; text?: string }
  | { type: string; note: string };

/** Call a tool. `name` may be "<server>/<tool>" or a bare tool name (resolved via the tool list). */
export async function callTool(input: { name?: unknown; arguments?: unknown; server?: unknown }) {
  const servers = requireServers();
  const rawName = typeof input.name === "string" ? input.name.trim() : "";
  if (!rawName) throw new GhostError(400, "name is required", "bad_request");
  const args = input.arguments === undefined || input.arguments === null ? {} : input.arguments;
  if (typeof args !== "object" || Array.isArray(args)) throw new GhostError(400, "arguments must be an object", "bad_request");

  let serverName = typeof input.server === "string" && input.server ? input.server : "";
  let toolName = rawName;
  const slash = rawName.indexOf("/");
  if (!serverName && slash > 0 && servers.some((s) => s.name === rawName.slice(0, slash))) {
    serverName = rawName.slice(0, slash);
    toolName = rawName.slice(slash + 1);
  }
  if (!serverName) {
    const { tools } = await listTools();
    const matches = tools.filter((t) => t.name === toolName);
    if (matches.length === 0) throw new GhostError(404, `tool ${toolName} not found on any connected MCP server`, "not_found");
    if (matches.length > 1)
      throw new GhostError(409, `tool ${toolName} exists on several servers; use one of: ${matches.map((m) => m.qualified_name).join(", ")}`, "ambiguous");
    serverName = matches[0].server;
  }
  const server = servers.find((s) => s.name === serverName);
  if (!server) throw new GhostError(404, `MCP server ${serverName} is not configured`, "not_found");

  let retried = false;
  for (;;) {
    const conn = await connect(server);
    try {
      const res = await conn.client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      return shapeResult(server.name, toolName, res as { content?: unknown[]; isError?: boolean; structuredContent?: unknown; toolResult?: unknown });
    } catch (e) {
      const msg = describeError(e);
      // Session expired / connection dropped: reconnect once. Tool-level errors come back as isError results.
      if (!retried && /session|closed|ECONNRESET|socket|fetch failed|404/i.test(msg)) {
        retried = true;
        await dropConn(server.name);
        continue;
      }
      throw new PartnerError("Executor", `tools/call ${server.name}/${toolName} failed: ${msg}`);
    }
  }
}

function shapeResult(
  server: string,
  name: string,
  res: { content?: unknown[]; isError?: boolean; structuredContent?: unknown; toolResult?: unknown },
) {
  const content: BridgedContent[] = [];
  let budget = MAX_TEXT;
  const raw = Array.isArray(res.content) ? res.content : res.toolResult !== undefined ? [{ type: "text", text: JSON.stringify(res.toolResult) }] : [];
  for (const item of raw.slice(0, 50)) {
    const c = item as { type?: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; mimeType?: string; text?: string } };
    if (c.type === "text" && typeof c.text === "string") {
      const t = c.text.slice(0, Math.max(0, budget));
      budget -= t.length;
      content.push({ type: "text", text: t, ...(t.length < c.text.length ? { truncated: true } : {}) });
    } else if (c.type === "image" && typeof c.data === "string" && c.data.length <= MAX_IMAGE_B64) {
      content.push({ type: "image", mimeType: c.mimeType ?? "image/png", data: c.data });
    } else if (c.type === "resource" && c.resource) {
      const t = typeof c.resource.text === "string" ? c.resource.text.slice(0, Math.max(0, budget)) : undefined;
      if (t) budget -= t.length;
      content.push({ type: "resource", uri: c.resource.uri, mimeType: c.resource.mimeType, text: t });
    } else {
      content.push({ type: String(c.type ?? "unknown"), note: "omitted (unsupported or too large)" });
    }
  }
  let structured: unknown = undefined;
  if (res.structuredContent !== undefined) {
    const s = JSON.stringify(res.structuredContent);
    structured = s.length <= MAX_TEXT ? res.structuredContent : { truncated: true, preview: s.slice(0, 2000) };
  }
  return {
    server,
    name,
    isError: res.isError === true,
    note: UNTRUSTED_NOTE,
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

/** Close all MCP connections (tests / shutdown). */
export async function closeMcp(): Promise<void> {
  const st = S();
  await Promise.all([...st.conns.keys()].map((n) => dropConn(n)));
  st.cache = null;
}
