import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { MeResponse } from "../contracts";
import { db } from "./db";
import { addEntry, balanceOf, DEV_LEDGER_LABEL, INITIAL_TEST_FUNDS_CENTS } from "./ledger";
import { S } from "./state";
import { GhostError, id, secretToken } from "./util";

export const COOKIE_NAME = "ghost_pid";

export interface PrincipalRow {
  principal_id: string;
  display_name: string;
  owner_token: string;
  kind: string;
}

/** Resolve a principal from its secret owner token (cookie value or Bearer token). */
export async function principalFromToken(token: string | null | undefined): Promise<PrincipalRow | null> {
  if (!token) return null;
  const key = `tok:${token}`;
  const hit = S().cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value as PrincipalRow;
  const r = await db().query<PrincipalRow>(
    `select principal_id, display_name, owner_token, kind from principals where owner_token = $1`,
    [token],
  );
  const row = r.rows[0] ?? null;
  if (row) S().cache.set(key, { at: Date.now(), value: row });
  return row;
}

export async function getPrincipalRow(principal_id: string): Promise<PrincipalRow | null> {
  const r = await db().query<PrincipalRow>(
    `select principal_id, display_name, owner_token, kind from principals where principal_id = $1`,
    [principal_id],
  );
  return r.rows[0] ?? null;
}

export async function displayNames(ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return m;
  const r = await db().query<{ principal_id: string; display_name: string }>(
    `select principal_id, display_name from principals where principal_id = any($1::text[])`,
    [uniq],
  );
  for (const row of r.rows) m.set(row.principal_id, row.display_name);
  return m;
}

/** Create a new human principal with test funds in the development ledger. */
export async function createPrincipal(): Promise<PrincipalRow> {
  const principal_id = id("pr");
  const tail = principal_id.slice(-4).toUpperCase();
  const row: PrincipalRow = {
    principal_id,
    display_name: `Visitor ${tail}`,
    owner_token: secretToken("gho"),
    kind: "human",
  };
  await db().tx(async (q) => {
    await q.query(
      `insert into principals (principal_id, display_name, owner_token, kind) values ($1, $2, $3, 'human')`,
      [row.principal_id, row.display_name, row.owner_token],
    );
    await addEntry(q, {
      principal_id,
      amount_cents: INITIAL_TEST_FUNDS_CENTS,
      kind: "grant",
      label: `${DEV_LEDGER_LABEL} (starting grant)`,
    });
  });
  return row;
}

/** Provider principals own devices published by internal adapters (e.g. "provider:caltrans"). */
export async function ensureProviderPrincipal(principal_id: string, display_name?: string): Promise<void> {
  await db().query(
    `insert into principals (principal_id, display_name, owner_token, kind) values ($1, $2, $3, 'provider')
     on conflict (principal_id) do nothing`,
    [principal_id, display_name ?? principal_id.replace(/^provider:/, "").toUpperCase(), secretToken("prov")],
  );
}

function bearer(c: Context): string | null {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Resolve the caller (Bearer owner_token first, then the ghost_pid cookie). Null if anonymous. */
export async function getPrincipalOptional(c: Context): Promise<PrincipalRow | null> {
  const b = bearer(c);
  if (b) {
    const p = await principalFromToken(b);
    if (p) return p;
  }
  return principalFromToken(getCookie(c, COOKIE_NAME));
}

/**
 * The calling principal's id. Throws a 401 GhostError if the request carries no valid
 * Bearer owner_token or ghost_pid cookie (call GET /api/v1/me first in a browser).
 */
export async function getPrincipal(c: Context): Promise<string> {
  const p = await getPrincipalOptional(c);
  if (!p) throw new GhostError(401, "Not authenticated: call GET /api/v1/me first or send Authorization: Bearer <owner_token>", "unauthorized");
  return p.principal_id;
}

/** GET /api/v1/me — creates the principal on first visit and sets the httpOnly cookie. */
export async function me(c: Context): Promise<MeResponse> {
  c.header("Cache-Control", "private, no-store");
  let p = await getPrincipalOptional(c);
  if (!p) p = await createPrincipal();
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  setCookie(c, COOKIE_NAME, p.owner_token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: proto === "https",
    maxAge: 60 * 60 * 24 * 365,
  });
  return {
    principal_id: p.principal_id,
    owner_token: p.owner_token,
    balance_cents: await balanceOf(db(), p.principal_id),
    display_name: p.display_name,
  };
}
