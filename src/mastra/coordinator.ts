/**
 * Loopback HTTP client used by GHOST mission workflows.
 *
 * Missions talk to the coordinator exactly like any external agent would: over the public
 * /api/v1 HTTP API with the caller's owner token. That keeps missions decoupled from
 * coordinator internals and means every mission action goes through the same lease,
 * budget, rate-limit and audit checks as a hand-driven tool call.
 *
 * Credentials are NEVER put in workflow input, state or request context, because Mastra
 * persists those in snapshots and traces. Instead the coordinator registers the caller's
 * token in an in-memory vault keyed by run id (`setRunCredential`). A run resumed after a
 * process restart gets fresh credentials from the resuming caller.
 *
 * For local inspection in Mastra Studio (`pnpm mastra:dev`, separate process, empty vault),
 * set GHOST_MISSION_OWNER_TOKEN to an owner token from GET /api/v1/me.
 */

/** Base URL of the coordinator. Fixed by the operator; never taken from mission input (SSRF). */
export function coordinatorBaseUrl(): string {
  const explicit = process.env.GHOST_COORDINATOR_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

interface VaultEntry {
  authorization: string;
  expires: number;
}

const VAULT_TTL_MS = 6 * 60 * 60 * 1000;

function vault(): Map<string, VaultEntry> {
  const g = globalThis as unknown as { __ghostMissionVault?: Map<string, VaultEntry> };
  if (!g.__ghostMissionVault) g.__ghostMissionVault = new Map();
  return g.__ghostMissionVault;
}

/** Register the bearer credential a run should use for its loopback calls (in memory only). */
export function setRunCredential(runId: string, ownerToken: string): void {
  const now = Date.now();
  for (const [k, v] of vault()) if (v.expires < now) vault().delete(k);
  vault().set(runId, { authorization: `Bearer ${ownerToken}`, expires: now + VAULT_TTL_MS });
}

export function clearRunCredential(runId: string): void {
  vault().delete(runId);
}

function authorizationFor(runId: string): string | null {
  const e = vault().get(runId);
  if (e && e.expires > Date.now()) return e.authorization;
  const dev = process.env.GHOST_MISSION_OWNER_TOKEN?.trim();
  return dev ? `Bearer ${dev}` : null;
}

export type CallResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Call the coordinator. Never throws: transport errors, timeouts and non-2xx responses are
 * returned as `{ ok: false }` so mission steps can record them honestly.
 */
export async function coordinator<T = unknown>(
  runId: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<CallResult<T>> {
  const authorization = authorizationFor(runId);
  if (!authorization) {
    return {
      ok: false,
      status: 401,
      code: "no_credentials",
      error:
        "Mission has no caller credentials (start it through POST /api/v1/missions/:name/run, or set GHOST_MISSION_OWNER_TOKEN for Studio runs)",
    };
  }
  const url = `${coordinatorBaseUrl()}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        "x-ghost-mission-run": runId,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      code: timedOut ? "timeout" : "unreachable",
      error: timedOut ? `${method} ${path} timed out after ${timeoutMs} ms` : `${method} ${path} failed: ${err.message}`,
    };
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  return { ok: false, status: res.status, ...errorFrom(data, res.status) };
}

function errorFrom(data: unknown, status: number): { error: string; code?: string } {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const e = d.error;
    if (e && typeof e === "object") {
      const eo = e as Record<string, unknown>;
      return { error: String(eo.message ?? JSON.stringify(eo)), code: eo.code ? String(eo.code) : undefined };
    }
    if (typeof e === "string") return { error: e, code: d.code ? String(d.code) : undefined };
    if (typeof d.message === "string") return { error: d.message, code: d.code ? String(d.code) : undefined };
  }
  if (typeof data === "string" && data) return { error: data.slice(0, 300) };
  return { error: `HTTP ${status}` };
}

/** Accept a list from either a bare array or a common wrapper key. */
export function listFrom<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
