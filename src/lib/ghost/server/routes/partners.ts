/**
 * /api/v1/partners/* — agent-facing sponsor integrations (all optional).
 *
 *   GET  /partners/status                    which integrations are configured (no secrets)
 *   POST /partners/exa/search                {query, purpose?, num_results?}
 *   POST /partners/exa/discover-webcams      {place, num_results?, publish?}
 *   POST /partners/kernel/observe            {url, wait_ms?, full_page?, title?}
 *   POST /partners/kernel/close              {}
 *   GET  /partners/kernel/status
 *   GET  /partners/mail/status
 *   POST /partners/mail/send                 {to, subject, text, observation_ids?, context?}
 *   GET  /partners/mail/inbox?limit=
 *   GET  /partners/mail/messages/:id
 *   GET  /partners/mcp/tools?server=&refresh=1
 *   POST /partners/mcp/call                  {name, arguments?, server?}
 *
 * Unconfigured integrations answer 503 {error:"<Partner> not configured", setup:"set X in .env.local"}.
 * Every route requires a principal (Bearer owner_token or the ghost_pid cookie).
 */
import type { Context, Hono } from "hono";
import { parseRef, refKey } from "../../contracts";
import { KERNEL_ADAPTER_ID, WEB_OBSERVE, webPageDiscovery, webLocalKey } from "../adapters/kernel";
import type { AdapterDiscovery } from "../adapters/types";
import { getPrincipal } from "../auth";
import { db } from "../db";
import { invoke } from "../invocations";
import { publishFromAdapter } from "../registry";
import { GhostError } from "../util";
import { assertPublicHttpUrl, clampInt, env, errorResponse, readJson, requireEnv, UNTRUSTED_NOTE } from "../partners/common";
import { EXA_SETUP, exaConfigured, exaSearch } from "../partners/exa";
import { closeBrowser, DEFAULT_WAIT_MS, KERNEL_SETUP, kernelConfigured, kernelStatus, MAX_WAIT_MS } from "../partners/kernel";
import { listInbox, MAIL_SETUP, mailConfigured, mailStatus, readMessage, sendReport } from "../partners/mail";
import { callTool, listTools, mcpConfigured, mcpServers } from "../partners/mcp";

type Handler = (c: Context, principal_id: string) => Promise<Response>;

/** Authenticate, run, and map every error (503 not configured, 4xx GhostError, 502 partner failure). */
const route =
  (fn: Handler) =>
  async (c: Context): Promise<Response> => {
    try {
      const principal_id = await getPrincipal(c);
      return await fn(c, principal_id);
    } catch (e) {
      return errorResponse(c, e);
    }
  };

/**
 * Outward-facing or tool-executing actions (sending mail, calling the user's Executor tools)
 * can be restricted to specific principals with PARTNERS_ALLOWED_PRINCIPALS=pr_a,pr_b.
 */
function requireTrusted(principal_id: string, action: string) {
  const allow = env("PARTNERS_ALLOWED_PRINCIPALS");
  if (!allow) return;
  const ids = allow.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.includes(principal_id)) throw new GhostError(403, `${action} is restricted to this GHOST instance's owner`, "forbidden");
}

/** Publish (or refresh) Kernel-backed candidate devices without downgrading ones already verified. */
async function publishWebDevices(discoveries: AdapterDiscovery[]) {
  if (!discoveries.length) return [];
  const keys = discoveries.map((d) => d.manifest.local_key);
  const r = await db().query<{ local_key: string; status: string }>(
    `select local_key, status from devices where connector_id = $1 and local_key = any($2::text[])`,
    [`internal:${KERNEL_ADAPTER_ID}`, keys],
  );
  const prev = new Map(r.rows.map((row) => [row.local_key, row.status]));
  for (const d of discoveries) {
    const p = prev.get(d.manifest.local_key);
    if (p === "verified" || p === "configured") d.status = p;
  }
  return publishFromAdapter(KERNEL_ADAPTER_ID, discoveries);
}

export function mountPartnerRoutes(app: Hono) {
  /* ---------------------------------------------------------------- */
  /* Overview                                                          */
  /* ---------------------------------------------------------------- */
  app.get(
    "/partners/status",
    route(async (c) =>
      c.json({
        exa: { configured: exaConfigured(), ...(exaConfigured() ? {} : { setup: EXA_SETUP }) },
        kernel: { ...kernelStatus(), ...(kernelConfigured() ? {} : { setup: KERNEL_SETUP }) },
        agentmail: { configured: mailConfigured(), ...(mailConfigured() ? {} : { setup: MAIL_SETUP }) },
        executor: {
          configured: mcpConfigured(),
          servers: mcpServers().map((s) => ({ name: s.name, origin: new URL(s.url).origin, has_token: !!s.token })),
          ...(mcpConfigured() ? {} : { setup: "set EXECUTOR_MCP_URL (and EXECUTOR_TOKEN) in .env.local" }),
        },
      }),
    ),
  );

  /* ---------------------------------------------------------------- */
  /* Exa — find public physical sources on the web                     */
  /* ---------------------------------------------------------------- */
  app.post(
    "/partners/exa/search",
    route(async (c) => {
      const body = await readJson<{ query: string; purpose: string; num_results: number }>(c);
      const out = await exaSearch(body);
      return c.json({ ...out, note: UNTRUSTED_NOTE });
    }),
  );

  app.post(
    "/partners/exa/discover-webcams",
    route(async (c) => {
      const body = await readJson<{ place: string; num_results: number; publish: boolean }>(c);
      const place = typeof body.place === "string" ? body.place.replace(/\s+/g, " ").trim() : "";
      if (!place) throw new GhostError(400, "place is required", "bad_request");
      const found = await exaSearch({ query: place, purpose: "webcam", num_results: clampInt(body.num_results, 1, 10, 6) });
      const publish = body.publish !== false;
      // Only public http(s) pages become candidates (SSRF guard resolves DNS).
      const checked = await Promise.all(
        found.results.map(async (r) => {
          try {
            await assertPublicHttpUrl(r.url);
            return r;
          } catch {
            return null;
          }
        }),
      );
      const usable = checked.filter((r): r is NonNullable<typeof r> => !!r);
      const byKey = new Map<string, string>();
      if (publish && usable.length) {
        const discoveries = usable.map((r) =>
          webPageDiscovery({ url: r.url, title: r.title, description: r.snippet, kind: "webcam", discovered_via: "Exa search", query: found.query }),
        );
        const devices = await publishWebDevices(discoveries);
        for (const d of devices) byKey.set(d.local_key, d.device_id);
      }
      return c.json({
        place,
        query: found.query,
        note: `${UNTRUSTED_NOTE} Candidates are NOT verified devices: call web.observe (Kernel screenshot) to check one actually shows a live view.`,
        kernel_configured: kernelConfigured(),
        published: byKey.size,
        candidates: usable.map((r) => {
          const device_id = byKey.get(webLocalKey(r.url));
          return {
            ...r,
            ...(device_id
              ? { device_id, ref: refKey({ device_id, capability_id: WEB_OBSERVE }), status: "candidate" as const }
              : {}),
          };
        }),
      });
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Kernel — cloud browser screenshots of public pages                */
  /* ---------------------------------------------------------------- */
  app.post(
    "/partners/kernel/observe",
    route(async (c, principal_id) => {
      requireEnv("Kernel", "KERNEL_API_KEY");
      const body = await readJson<{ url: string; ref: string; device_id: string; wait_ms: number; full_page: boolean; title: string }>(c);
      if (body.wait_ms !== undefined && (typeof body.wait_ms !== "number" || body.wait_ms < 0 || body.wait_ms > MAX_WAIT_MS))
        throw new GhostError(400, `wait_ms must be a number between 0 and ${MAX_WAIT_MS}`, "bad_request");
      let device_id: string | undefined =
        typeof body.device_id === "string" ? body.device_id : typeof body.ref === "string" ? parseRef(body.ref)?.device_id : undefined;
      if (!device_id) {
        const u = await assertPublicHttpUrl(body.url);
        const [device] = await publishWebDevices([
          webPageDiscovery({
            url: u.toString(),
            title: typeof body.title === "string" ? body.title.slice(0, 110) : null,
            kind: "page",
            discovered_via: "ad-hoc request",
          }),
        ]);
        if (!device) throw new GhostError(400, "could not publish a device for this url", "bad_request");
        device_id = device.device_id;
      }
      const args: Record<string, unknown> = { wait_ms: body.wait_ms ?? DEFAULT_WAIT_MS };
      if (body.full_page === true) args.full_page = true;
      const res = await invoke(principal_id, {
        device_id,
        capability_id: WEB_OBSERVE,
        arguments: args,
        timeout_ms: 75_000,
      });
      const data = (res.observation?.data ?? {}) as Record<string, unknown>;
      return c.json({
        device_id,
        ref: refKey({ device_id, capability_id: WEB_OBSERVE }),
        invocation: res.invocation,
        observation: res.observation ?? null,
        live_view_url: (data.live_view_url as string | null | undefined) ?? kernelStatus().session?.live_view_url ?? null,
      });
    }),
  );

  app.post(
    "/partners/kernel/close",
    route(async (c) => {
      requireEnv("Kernel", "KERNEL_API_KEY");
      return c.json(await closeBrowser("requested"));
    }),
  );

  app.get(
    "/partners/kernel/status",
    route(async (c) => c.json({ ...kernelStatus(), ...(kernelConfigured() ? {} : { setup: KERNEL_SETUP }) })),
  );

  /* ---------------------------------------------------------------- */
  /* AgentMail — Polty's inbox                                         */
  /* ---------------------------------------------------------------- */
  app.get(
    "/partners/mail/status",
    route(async (c) => {
      requireEnv("AgentMail", "AGENTMAIL_API_KEY");
      return c.json(await mailStatus());
    }),
  );

  app.post(
    "/partners/mail/send",
    route(async (c, principal_id) => {
      requireEnv("AgentMail", "AGENTMAIL_API_KEY");
      requireTrusted(principal_id, "sending email");
      const body = await readJson(c);
      return c.json(await sendReport(principal_id, body));
    }),
  );

  app.get(
    "/partners/mail/inbox",
    route(async (c, principal_id) => {
      requireEnv("AgentMail", "AGENTMAIL_API_KEY");
      requireTrusted(principal_id, "reading Polty's inbox");
      return c.json(await listInbox(c.req.query("limit")));
    }),
  );

  app.get(
    "/partners/mail/messages/:id",
    route(async (c, principal_id) => {
      requireEnv("AgentMail", "AGENTMAIL_API_KEY");
      requireTrusted(principal_id, "reading Polty's inbox");
      return c.json(await readMessage(c.req.param("id") ?? ""));
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Executor / MCP bridge                                             */
  /* ---------------------------------------------------------------- */
  app.get(
    "/partners/mcp/tools",
    route(async (c, principal_id) => {
      requireTrusted(principal_id, "using the MCP bridge");
      const out = await listTools({ refresh: c.req.query("refresh") === "1", server: c.req.query("server") || undefined });
      return c.json({ ...out, note: UNTRUSTED_NOTE });
    }),
  );

  app.post(
    "/partners/mcp/call",
    route(async (c, principal_id) => {
      requireTrusted(principal_id, "calling MCP tools");
      const body = await readJson(c);
      return c.json(await callTool(body));
    }),
  );
}
