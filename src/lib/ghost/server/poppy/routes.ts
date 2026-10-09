import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { PoppyAuth, PoppyError, JWT_GRANT, type PoppyOptions } from "./auth";
import { guestMcp } from "./mcp";

export function poppyOptionsFromEnv(): PoppyOptions | undefined {
  if (process.env.GHOST_POPPY_ENABLED !== "1") return undefined;
  if (!process.env.GHOST_POPPY_ORIGIN) throw new Error("GHOST_POPPY_ORIGIN required when enabling Poppy");
  return { origin: process.env.GHOST_POPPY_ORIGIN, allowedClients: new Set((process.env.GHOST_POPPY_CLIENTS ?? "").split(",").map(v => v.trim()).filter(Boolean)) };
}
export function isPoppyPath(path: string): boolean {
  return path.startsWith("/poppy/") || ["/.well-known/poppy.json", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/poppy/mcp"].includes(path);
}
export function createPoppyApp(options: PoppyOptions): Hono {
  const app = new Hono();
  const auth = new PoppyAuth(options);
  const metadataUrl = `${auth.origin}/.well-known/oauth-protected-resource/poppy/mcp`;
  app.use("/poppy/*", bodyLimit({ maxSize: 65536, onError: c => c.json({ error: "invalid_request" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof PoppyError) {
      c.header("Cache-Control", "no-store");
      if (error.status === 429) c.header("Retry-After", "60");
      if (c.req.path === "/poppy/mcp") c.header("WWW-Authenticate", `Bearer error="${error.code}", resource_metadata="${metadataUrl}"`);
      else if (error.code === "invalid_dpop_proof") c.header("WWW-Authenticate", 'DPoP error="invalid_dpop_proof"');
      return c.json({ error: error.code }, error.status);
    }
    // Never put token, provider response or library error detail in the response/log.
    return c.json({ error: "server_error" }, 500);
  });
  app.get("/.well-known/poppy.json", c => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ protocol_version: "0.1", organization: { name: "GHOST", domain: new URL(auth.origin).hostname }, auth: { issuer: auth.origin }, apis: [{ type: "mcp", url: auth.resource, description: "Experimental guest interface: public device observations and hardware guides. No account sign-in, rentals or actuation." }] });
  });
  app.get("/.well-known/oauth-authorization-server", c => c.json({ issuer: auth.origin, token_endpoint: auth.tokenEndpoint, revocation_endpoint: `${auth.origin}/poppy/oauth/revoke`, poppy_domains: [new URL(auth.origin).hostname], grant_types_supported: [JWT_GRANT], token_endpoint_auth_methods_supported: ["private_key_jwt"], token_endpoint_auth_signing_alg_values_supported: ["ES256", "RS256", "PS256", "EdDSA"], scopes_supported: [] }));
  app.get("/.well-known/oauth-protected-resource/poppy/mcp", c => c.json({ resource: auth.resource, authorization_servers: [auth.origin], bearer_methods_supported: ["header"], scopes_supported: [] }));
  async function form(c: Context) {
    if (c.req.header("content-type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") throw new PoppyError("invalid_request");
    const value = new URLSearchParams(await c.req.text());
    for (const key of value.keys()) if (value.getAll(key).length !== 1) throw new PoppyError("invalid_request");
    return value;
  }
  app.post("/poppy/oauth/token", async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await auth.issue(await form(c), c.req.header("dpop")));
  });
  app.post("/poppy/oauth/revoke", async c => {
    c.header("Cache-Control", "no-store");
    await auth.revoke(await form(c));
    return c.body(null, 200);
  });
  // Diagnostic for DPoP clients; intentionally not advertised as an OpenAPI surface.
  app.get("/poppy/session", async c => {
    c.header("Cache-Control", "no-store");
    const identity = await auth.authenticate(c.req.header("authorization") ?? "", c.req.header("dpop"), "GET", "/poppy/session");
    return c.json({ session_id: identity.session_id, signed_in: false, scope: "" });
  });
  app.all("/poppy/mcp", async c => {
    c.header("Cache-Control", "no-store");
    const identity = await auth.authenticate(c.req.header("authorization") ?? "", undefined, c.req.method, "/poppy/mcp");
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);
    const server = guestMcp(identity.principal);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(c.req.raw); }
    finally { await transport.close(); await server.close(); }
  });
  return app;
}
