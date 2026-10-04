import { randomBytes } from "node:crypto";
import { db } from "../db";

/**
 * Google Workspace OAuth 2.0 (authorization-code flow, offline access) with plain fetch.
 *
 * Env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  — an OAuth client of type "Web application"
 *   GOOGLE_REDIRECT_URI (optional)          — defaults to `${NEXT_PUBLIC_PUBLIC_ORIGIN || http://localhost:3000}/api/v1/google/callback`
 * Tokens are stored per principal in the `google_tokens` table (created idempotently).
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function googleConfigured(): boolean {
  return !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET"));
}

export function publicOrigin(): string {
  return (env("NEXT_PUBLIC_PUBLIC_ORIGIN") ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function redirectUri(): string {
  return env("GOOGLE_REDIRECT_URI") ?? `${publicOrigin()}/api/v1/google/callback`;
}

/* ---------------- state (CSRF), bound to the principal ---------------- */

const pendingStates = new Map<string, { principal_id: string; exp: number }>();

export function newState(principal_id: string): string {
  const now = Date.now();
  for (const [k, v] of pendingStates) if (v.exp < now) pendingStates.delete(k);
  const s = randomBytes(24).toString("base64url");
  pendingStates.set(s, { principal_id, exp: now + 10 * 60_000 });
  return s;
}

/** Consume a state; returns the principal it was issued to, or null. */
export function takeState(state: string | undefined | null): string | null {
  if (!state) return null;
  const v = pendingStates.get(state);
  pendingStates.delete(state);
  if (!v || v.exp < Date.now()) return null;
  return v.principal_id;
}

export function consentUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID") ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p}`;
}

/* ---------------- token storage ---------------- */

export interface GoogleTokenRow {
  principal_id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | Date;
  scope: string | null;
}

let tableReady: Promise<void> | null = null;
export function ensureTable(): Promise<void> {
  tableReady ??= db()
    .query(
      `create table if not exists google_tokens (
         principal_id text primary key,
         email text, name text, picture text,
         access_token text not null,
         refresh_token text,
         expires_at timestamptz not null,
         scope text,
         updated_at timestamptz not null default now()
       )`,
    )
    .then(() => undefined)
    .catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady;
}

export async function getTokens(principal_id: string): Promise<GoogleTokenRow | null> {
  await ensureTable();
  const r = await db().query<GoogleTokenRow>(`select * from google_tokens where principal_id = $1`, [principal_id]);
  return r.rows[0] ?? null;
}

export async function deleteTokens(principal_id: string): Promise<void> {
  await ensureTable();
  const row = await getTokens(principal_id);
  await db().query(`delete from google_tokens where principal_id = $1`, [principal_id]);
  const tok = row?.refresh_token ?? row?.access_token;
  if (tok) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(tok)}`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID") ?? "", client_secret: env("GOOGLE_CLIENT_SECRET") ?? "", ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `token endpoint HTTP ${res.status}`);
  return j;
}

/** Exchange an authorization code and persist the tokens + profile for this principal. */
export async function exchangeCode(principal_id: string, code: string): Promise<GoogleTokenRow> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  let email: string | null = null, name: string | null = null, picture: string | null = null;
  try {
    const u = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${t.access_token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (u.ok) {
      const j = (await u.json()) as { email?: string; name?: string; picture?: string };
      email = j.email ?? null;
      name = j.name ?? null;
      picture = j.picture ?? null;
    }
  } catch {
    /* profile is optional */
  }
  await ensureTable();
  const expires = new Date(Date.now() + (t.expires_in - 60) * 1000);
  const r = await db().query<GoogleTokenRow>(
    `insert into google_tokens (principal_id, email, name, picture, access_token, refresh_token, expires_at, scope, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (principal_id) do update set email = excluded.email, name = excluded.name, picture = excluded.picture,
       access_token = excluded.access_token,
       refresh_token = coalesce(excluded.refresh_token, google_tokens.refresh_token),
       expires_at = excluded.expires_at, scope = excluded.scope, updated_at = now()
     returning *`,
    [principal_id, email, name, picture, t.access_token, t.refresh_token ?? null, expires.toISOString(), t.scope ?? null],
  );
  return r.rows[0];
}

export class GoogleNotConnected extends Error {
  constructor() {
    super("Google not connected — open Connectors and connect Google Workspace");
  }
}

/** A valid access token for this principal, refreshing it when expired. */
export async function accessToken(principal_id: string, force = false): Promise<string> {
  const row = await getTokens(principal_id);
  if (!row) throw new GoogleNotConnected();
  if (!force && new Date(row.expires_at).getTime() > Date.now() + 30_000) return row.access_token;
  if (!row.refresh_token) throw new GoogleNotConnected();
  const t = await tokenRequest({ refresh_token: row.refresh_token, grant_type: "refresh_token" });
  const expires = new Date(Date.now() + (t.expires_in - 60) * 1000);
  await db().query(`update google_tokens set access_token = $2, expires_at = $3, updated_at = now() where principal_id = $1`, [
    principal_id,
    t.access_token,
    expires.toISOString(),
  ]);
  return t.access_token;
}
