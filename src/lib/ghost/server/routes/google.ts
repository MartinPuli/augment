import type { Hono } from "hono";
import { getPrincipal, getPrincipalOptional, me } from "../auth";
import {
  consentUrl,
  deleteTokens,
  exchangeCode,
  getTokens,
  GOOGLE_SCOPES,
  googleConfigured,
  newState,
  redirectUri,
  takeState,
} from "../google/oauth";

/**
 * Google Workspace OAuth routes (mounted under /api/v1):
 *   GET  /google/status      — { configured, connected, email, name, picture, scopes, redirect_uri }
 *   GET  /google/connect     — 302 to Google consent (state bound to the caller's principal)
 *   GET  /google/callback    — exchanges the code, stores tokens, 302 to /connectors?google=connected
 *   POST /google/disconnect  — revokes + deletes the caller's tokens
 * Setup: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local; authorized redirect URI =
 *   `${NEXT_PUBLIC_PUBLIC_ORIGIN || http://localhost:3000}/api/v1/google/callback` (override: GOOGLE_REDIRECT_URI).
 */
export function mountGoogleRoutes(app: Hono) {
  app.get("/google/status", async (c) => {
    const p = await getPrincipalOptional(c);
    const row = p ? await getTokens(p.principal_id).catch(() => null) : null;
    return c.json({
      configured: googleConfigured(),
      connected: !!row,
      email: row?.email ?? null,
      name: row?.name ?? null,
      picture: row?.picture ?? null,
      scopes: row?.scope ? row.scope.split(" ") : GOOGLE_SCOPES,
      redirect_uri: redirectUri(),
    });
  });

  app.get("/google/connect", async (c) => {
    if (!googleConfigured()) return c.redirect("/connectors?google=not_configured");
    const p = await getPrincipalOptional(c);
    // No principal yet: me() creates one and sets the cookie on this redirect response.
    const pid = p?.principal_id ?? (await me(c)).principal_id;
    return c.redirect(consentUrl(newState(pid)));
  });

  app.get("/google/callback", async (c) => {
    const err = c.req.query("error");
    if (err) return c.redirect(`/connectors?google=error&reason=${encodeURIComponent(err)}`);
    const owner = takeState(c.req.query("state"));
    const p = await getPrincipalOptional(c);
    if (!owner || (p && p.principal_id !== owner)) return c.redirect("/connectors?google=error&reason=state_mismatch");
    const code = c.req.query("code");
    if (!code) return c.redirect("/connectors?google=error&reason=missing_code");
    try {
      await exchangeCode(owner, code);
    } catch (e) {
      return c.redirect(`/connectors?google=error&reason=${encodeURIComponent((e as Error).message.slice(0, 120))}`);
    }
    return c.redirect("/connectors?google=connected");
  });

  app.post("/google/disconnect", async (c) => {
    const pid = await getPrincipal(c);
    await deleteTokens(pid);
    return c.json({ ok: true });
  });
}
