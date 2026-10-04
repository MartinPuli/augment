import type { Context, Hono } from "hono";
import { getPrincipalOptional } from "../auth";
import {
  getMission,
  listMissions,
  MissionError,
  missionStorage,
  resumeMission,
  runMission,
  type PrincipalCtx,
} from "./index";

/**
 * Mission routes (mounted under /api/v1 by the coordinator router):
 *
 *   GET  /missions                    list missions with input/resume/output JSON Schemas
 *   POST /missions/:name/run          body = mission input; ?wait=false returns immediately
 *   POST /missions/runs/:id/resume    body = resume data, e.g. {verdict, summary}
 *   GET  /missions/runs/:id           status, steps, suspended payload, evidence ids
 *
 * Auth: Bearer owner_token or the ghost_pid cookie (same as every /api/v1 route). The
 * caller's owner token is forwarded to the mission's loopback calls, so a mission can never
 * do more than the caller could do by hand. Runs are visible only to the principal that
 * started them.
 */
export function mountMissionRoutes(app: Hono) {
  app.get("/missions", (c) =>
    handle(c, async () => ({ missions: await listMissions(), storage: await missionStorage() })),
  );

  app.post("/missions/:name/run", (c) =>
    handle(c, async () => {
      const principal = await requirePrincipal(c);
      const input = await jsonBody(c);
      const wait = c.req.query("wait") !== "false";
      return runMission(c.req.param("name"), input, principal, { wait });
    }),
  );

  app.post("/missions/runs/:id/resume", (c) =>
    handle(c, async () => {
      const principal = await requirePrincipal(c);
      return resumeMission(c.req.param("id"), await jsonBody(c), principal);
    }),
  );

  app.get("/missions/runs/:id", (c) =>
    handle(c, async () => {
      const principal = await requirePrincipal(c);
      const run = await getMission(c.req.param("id"), principal);
      if (!run) throw new MissionError(404, "Mission run not found", "not_found");
      return run;
    }),
  );
}

async function requirePrincipal(c: Context): Promise<PrincipalCtx> {
  const p = await getPrincipalOptional(c);
  if (!p) {
    throw new MissionError(401, "Not authenticated: call GET /api/v1/me first or send Authorization: Bearer <owner_token>", "unauthorized");
  }
  return { principal_id: p.principal_id, owner_token: p.owner_token };
}

async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MissionError(400, "Request body must be JSON", "bad_request");
  }
}

async function handle(c: Context, fn: () => Promise<unknown>) {
  try {
    return c.json(await fn() as object);
  } catch (e) {
    const status = e instanceof MissionError ? e.status : typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 500;
    const code = e instanceof MissionError ? e.code : (e as { code?: string })?.code ?? "internal_error";
    const message = e instanceof Error ? e.message : String(e);
    if (status >= 500) {
      console.error("[missions]", e);
      void import("../../../observability/report").then((r) => r.reportError(e, "missions.route", { path: c.req.path }));
    }
    // Same error shape as the rest of /api/v1: { error: message, code }.
    return c.json({ error: message, code }, status as 400);
  }
}
