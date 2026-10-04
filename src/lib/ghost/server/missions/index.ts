/**
 * Mission runner: the coordinator-facing API over the Mastra workflows in src/mastra.
 *
 *   runMission(name, input, principal, { wait })  -> start a run (waits until done/suspended by default)
 *   resumeMission(runId, data, principal?)         -> resume a suspended run (verification verdict)
 *   getMission(runId, principal?)                  -> current status, steps, evidence
 *   listMissions()                                 -> names, descriptions, JSON Schemas (for agent tools)
 *
 * Mastra is imported lazily so the coordinator boots without loading it until a mission runs.
 * The caller's owner token is kept in an in-memory vault for loopback calls; it is never
 * written to workflow input/state/snapshots. Runs are scoped to the starting principal via
 * Mastra's resourceId, and other principals cannot read or resume them.
 */
import { z } from "zod";
import type { Mastra } from "@mastra/core/mastra";

export type MissionName = "inspect-with-actuator" | "patrol-cameras";
export const MISSION_NAMES: MissionName[] = ["inspect-with-actuator", "patrol-cameras"];

export interface PrincipalCtx {
  principal_id: string;
  /** Owner token forwarded as `Authorization: Bearer` on loopback calls. */
  owner_token: string;
}

export type MissionStatus = "running" | "suspended" | "success" | "failed" | "canceled" | "waiting" | "pending" | "paused" | "tripwire" | "unknown";

export interface MissionStepView {
  id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  /** Observation ids this step contributed (if any). */
  evidence: string[];
  error: string | null;
}

export interface MissionRunView {
  run_id: string;
  mission: MissionName | string;
  status: MissionStatus;
  principal_id: string | null;
  /** When suspended: which step waits and what the verifier needs (photos, question). */
  suspended: { step: string; payload: unknown } | null;
  result: unknown;
  error: string | null;
  steps: MissionStepView[];
  /** All observation ids collected so far, in order. */
  evidence: string[];
  created_at: string | null;
  updated_at: string | null;
}

export class MissionError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "mission_error",
  ) {
    super(message);
  }
}

async function loadMastra(): Promise<{ mastra: Mastra; storageDescription: () => string }> {
  const m = await import("../../../../mastra");
  return { mastra: m.mastra, storageDescription: m.storageDescription };
}

async function loadVault() {
  return import("../../../../mastra/coordinator");
}

function isMissionName(n: string): n is MissionName {
  return (MISSION_NAMES as string[]).includes(n);
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

export interface MissionInfo {
  name: MissionName;
  description: string;
  input_schema: unknown;
  resume_schema: unknown | null;
  output_schema: unknown;
}

export async function listMissions(): Promise<MissionInfo[]> {
  const [inspect, patrol] = await Promise.all([
    import("../../../../mastra/workflows/inspect-with-actuator"),
    import("../../../../mastra/workflows/patrol-cameras"),
  ]);
  const js = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
  return [
    {
      name: "inspect-with-actuator",
      description: inspect.inspectWithActuator.description ?? "",
      input_schema: js(inspect.inspectInputSchema),
      resume_schema: js(inspect.verifyResumeSchema),
      output_schema: js(inspect.missionResultSchema),
    },
    {
      name: "patrol-cameras",
      description: patrol.patrolCameras.description ?? "",
      input_schema: js(patrol.patrolInputSchema),
      resume_schema: null,
      output_schema: js(patrol.patrolResultSchema),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Normalising Mastra results / snapshots                              */
/* ------------------------------------------------------------------ */

type Loose = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = typeof v === "number" ? new Date(v) : v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function evidenceOf(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  if (Array.isArray(output)) return output.flatMap(evidenceOf);
  const o = output as Loose;
  const ids: string[] = [];
  if (Array.isArray(o.evidence)) ids.push(...o.evidence.filter((x): x is string => typeof x === "string"));
  if (typeof o.observation_id === "string") ids.push(o.observation_id);
  if (Array.isArray(o.observation_ids)) ids.push(...o.observation_ids.filter((x): x is string => typeof x === "string"));
  return ids;
}

function errText(e: unknown): string | null {
  if (!e) return null;
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && "message" in (e as Loose)) return String((e as Loose).message);
  return JSON.stringify(e);
}

function view(
  runId: string,
  mission: string,
  raw: Loose,
  meta: { principal_id?: string | null; created_at?: unknown; updated_at?: unknown },
): MissionRunView {
  const stepsRaw = (raw.steps ?? {}) as Record<string, Loose>;
  const steps: MissionStepView[] = [];
  const evidence: string[] = [];
  let suspended: MissionRunView["suspended"] = null;
  for (const [id, s] of Object.entries(stepsRaw)) {
    if (!s || typeof s !== "object" || id === "input") continue;
    const stepEvidence = evidenceOf(s.output);
    for (const e of stepEvidence) if (!evidence.includes(e)) evidence.push(e);
    steps.push({
      id,
      status: String(s.status ?? "unknown"),
      started_at: iso(s.startedAt),
      ended_at: iso(s.endedAt ?? s.suspendedAt),
      evidence: stepEvidence,
      error: errText(s.error),
    });
    if (s.status === "suspended" && !suspended) {
      suspended = { step: id, payload: s.suspendPayload ?? null };
    }
  }
  // Postgres jsonb does not keep key order: present steps in execution order.
  steps.sort((a, b) => (a.started_at ?? "9999").localeCompare(b.started_at ?? "9999"));
  const status = String(raw.status ?? "unknown") as MissionStatus;
  if (status === "suspended" && !suspended) {
    const path = Array.isArray(raw.suspended) ? (raw.suspended as unknown[])[0] : null;
    suspended = {
      step: Array.isArray(path) ? path.join(".") : String(path ?? "verify"),
      payload: (raw.suspendPayload as unknown) ?? null,
    };
  }
  if (status !== "suspended") suspended = null;
  const result = raw.result ?? null;
  for (const e of evidenceOf(result)) if (!evidence.includes(e)) evidence.push(e);
  return {
    run_id: runId,
    mission,
    status,
    principal_id: meta.principal_id ?? null,
    suspended,
    result,
    error: errText(raw.error),
    steps,
    evidence,
    created_at: iso(meta.created_at),
    updated_at: iso(meta.updated_at),
  };
}

const TERMINAL = new Set(["success", "failed", "canceled", "tripwire"]);

/** Surface broken missions in production visibility (Interfere); no-op when not configured. */
async function reportOutcome(v: MissionRunView): Promise<MissionRunView> {
  try {
    const { reportError, reportEvent } = await import("../../../observability/report");
    if (v.status === "failed") {
      reportError(new Error(v.error ?? "mission run failed"), "mission.crashed", { mission: String(v.mission), run_id: v.run_id });
    } else if (v.status === "success") {
      const r = (v.result ?? {}) as { outcome?: string; failures?: string[]; experience_id?: string | null };
      if (r.outcome === "failed" || (r.failures?.length ?? 0) > 0) {
        reportEvent(
          "mission.failed",
          { mission: String(v.mission), run_id: v.run_id, outcome: r.outcome ?? "unknown", failures: (r.failures ?? []).join(" | ").slice(0, 500) },
          { failed: r.outcome === "failed" },
        );
      }
    }
  } catch {
    /* reporting is best effort */
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Run / resume / get                                                  */
/* ------------------------------------------------------------------ */

export async function runMission(
  name: string,
  input: unknown,
  principal: PrincipalCtx,
  opts: { wait?: boolean } = {},
): Promise<MissionRunView> {
  if (!isMissionName(name)) throw new MissionError(404, `Unknown mission '${name}'. Known: ${MISSION_NAMES.join(", ")}`, "not_found");
  if (!principal?.principal_id || !principal.owner_token) throw new MissionError(401, "Missions need an authenticated principal", "unauthorized");

  // Validate up front so callers get a 400 instead of a failed run.
  const schemaMod =
    name === "inspect-with-actuator"
      ? (await import("../../../../mastra/workflows/inspect-with-actuator")).inspectInputSchema
      : (await import("../../../../mastra/workflows/patrol-cameras")).patrolInputSchema;
  const parsed = (schemaMod as z.ZodType).safeParse(input ?? {});
  if (!parsed.success) throw new MissionError(400, `Invalid mission input: ${z.prettifyError(parsed.error)}`, "bad_request");

  const { mastra } = await loadMastra();
  const { setRunCredential, clearRunCredential } = await loadVault();
  const workflow = mastra.getWorkflow(name);
  const run = await workflow.createRun({ resourceId: principal.principal_id });
  setRunCredential(run.runId, principal.owner_token);

  if (opts.wait === false) {
    await run.startAsync({ inputData: parsed.data as never });
    return {
      run_id: run.runId,
      mission: name,
      status: "running",
      principal_id: principal.principal_id,
      suspended: null,
      result: null,
      error: null,
      steps: [],
      evidence: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  const res = (await run.start({ inputData: parsed.data as never })) as unknown as Loose;
  if (TERMINAL.has(String(res.status))) clearRunCredential(run.runId);
  return reportOutcome(view(run.runId, name, res, { principal_id: principal.principal_id, created_at: Date.now(), updated_at: Date.now() }));
}

async function findRun(mastra: Mastra, runId: string): Promise<{ name: MissionName; state: Loose } | null> {
  for (const name of MISSION_NAMES) {
    const wf = mastra.getWorkflow(name);
    const state = (await wf.getWorkflowRunById(runId)) as unknown as Loose | null;
    if (state) return { name, state };
  }
  return null;
}

function assertOwner(state: Loose, principal: PrincipalCtx | undefined) {
  if (!principal) return;
  const owner = state.resourceId as string | undefined;
  // Do not reveal other principals' runs: same 404 as a missing run.
  if (owner && owner !== principal.principal_id) throw new MissionError(404, "Mission run not found", "not_found");
}

export async function getMission(runId: string, principal?: PrincipalCtx): Promise<MissionRunView | null> {
  const { mastra } = await loadMastra();
  const found = await findRun(mastra, runId);
  if (!found) return null;
  assertOwner(found.state, principal);
  return view(runId, found.name, found.state, {
    principal_id: (found.state.resourceId as string) ?? null,
    created_at: found.state.createdAt,
    updated_at: found.state.updatedAt,
  });
}

export async function resumeMission(runId: string, data: unknown, principal?: PrincipalCtx): Promise<MissionRunView> {
  const { mastra } = await loadMastra();
  const { setRunCredential, clearRunCredential } = await loadVault();
  const found = await findRun(mastra, runId);
  if (!found) throw new MissionError(404, "Mission run not found", "not_found");
  assertOwner(found.state, principal);
  if (found.state.status !== "suspended") {
    throw new MissionError(409, `Mission run is '${String(found.state.status)}', not suspended`, "conflict");
  }
  if (found.name === "inspect-with-actuator") {
    const { verifyResumeSchema } = await import("../../../../mastra/workflows/inspect-with-actuator");
    const parsed = verifyResumeSchema.safeParse(data ?? {});
    if (!parsed.success) throw new MissionError(400, `Invalid resume data: ${z.prettifyError(parsed.error)}`, "bad_request");
    data = parsed.data;
  }
  // Fresh credentials from the resuming caller (survives a coordinator restart).
  if (principal) setRunCredential(runId, principal.owner_token);

  const wf = mastra.getWorkflow(found.name);
  const run = await wf.createRun({ runId, resourceId: (found.state.resourceId as string) ?? principal?.principal_id });
  const suspendedStep = view(runId, found.name, found.state, {}).suspended?.step;
  const res = (await run.resume({
    resumeData: data as never,
    ...(suspendedStep ? { step: suspendedStep } : {}),
  })) as unknown as Loose;
  if (TERMINAL.has(String(res.status))) clearRunCredential(runId);
  return reportOutcome(view(runId, found.name, res, {
    principal_id: (found.state.resourceId as string) ?? principal?.principal_id ?? null,
    created_at: found.state.createdAt,
    updated_at: Date.now(),
  }));
}

/** Where mission state lives (for /missions listing and docs). */
export async function missionStorage(): Promise<string> {
  const { storageDescription } = await loadMastra();
  return storageDescription();
}
