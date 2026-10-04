/**
 * Mission: inspect-with-actuator
 *
 * A deterministic physical procedure: find a camera and an actuator in the same zone, lease
 * both within budget, take a baseline photo, actuate (e.g. open a cover), take a new photo,
 * then SUSPEND until a verifier (vision model or human) compares the two photos and resumes
 * with a verdict. Leases are always released and the outcome is always recorded as an
 * experience, including failures. "unknown" is never reported as success.
 *
 * Every step passes the same `MissionCtx` forward, so Mastra Studio shows exactly what was
 * known after each step (refs, lease ids, invocation ids, observation ids, failures).
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { CapabilityHit } from "../../lib/ghost/contracts";
import { sleep } from "../coordinator";
import {
  acquireLease,
  invokeCapability,
  recordExperience,
  releaseLease,
  searchCapabilities,
  type InvokeOutcome,
} from "../ghost-ops";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const refPattern = /^[^/\s]+\/[^\s]+$/;

export const inspectInputSchema = z.object({
  goal: z.string().max(500).optional().describe("What the visitor wants to learn, e.g. 'see what is under the cover'"),
  zone_id: z.string().max(120).optional().describe("Zone to search; omitted = any zone that has both a camera and the actuator"),
  camera_ref: z.string().regex(refPattern).optional().describe("Explicit camera ref '<device_id>/<capability_id>'"),
  actuator_ref: z.string().regex(refPattern).optional().describe("Explicit actuator ref '<device_id>/<capability_id>'"),
  action_capability: z.string().max(120).default("cover.open").describe("Capability id to actuate when searching"),
  actuator_capability: z.string().max(120).optional().describe("Alias of action_capability"),
  action_arguments: z.record(z.string(), z.unknown()).default({}),
  restore_capability: z.string().max(120).optional().describe("Optional capability to leave the scene as found, e.g. 'cover.close'"),
  max_spend_cents: z.number().int().min(0).max(100_000).default(0).describe("Hard budget for all leases in this mission"),
  duration_s: z.number().int().min(30).max(3_600).default(300),
  settle_ms: z.number().int().min(0).max(15_000).default(1_500).describe("Wait after actuation before the second photo"),
  approval_wait_s: z.number().int().min(0).max(120).default(30).describe("How long to wait for owner approval of a lease"),
});
export type InspectInput = z.infer<typeof inspectInputSchema>;

const pickedSchema = z.object({
  ref: z.string(),
  device_id: z.string(),
  capability_id: z.string(),
  name: z.string().nullable(),
  owner_id: z.string().nullable(),
  access_type: z.string().nullable(),
  zone_id: z.string().nullable(),
  price_cents: z.number().nullable(),
  online: z.boolean().nullable(),
});
type Picked = z.infer<typeof pickedSchema>;

const leaseSchema = z.object({
  lease_id: z.string(),
  offer_id: z.string().nullable(),
  owner_id: z.string().nullable(),
  refs: z.array(z.string()),
  price_cents: z.number(),
  state: z.string(),
});

const invocationSchema = z.object({
  step: z.string(),
  ref: z.string(),
  invocation_id: z.string().nullable(),
  state: z.string(),
  observation_id: z.string().nullable(),
  media_url: z.string().nullable(),
  captured_at: z.string().nullable(),
  error: z.string().nullable(),
});

export const missionCtxSchema = z.object({
  mission: z.literal("inspect-with-actuator"),
  goal: z.string(),
  started_at: z.string(),
  input: inspectInputSchema,
  zone_id: z.string().nullable(),
  camera: pickedSchema.nullable(),
  actuator: pickedSchema.nullable(),
  leases: z.array(leaseSchema),
  spent_cents: z.number(),
  invocations: z.array(invocationSchema),
  baseline_observation_id: z.string().nullable(),
  after_observation_id: z.string().nullable(),
  actuation_state: z.string().nullable(),
  /** Observation ids collected so far (the evidence trail). */
  evidence: z.array(z.string()),
  failures: z.array(z.string()),
  notes: z.array(z.string()),
  /** Set when a step could not continue safely; later steps skip to release + record. */
  aborted: z.boolean(),
  verdict: z.enum(["verified", "unverified", "failed"]).nullable(),
  verdict_summary: z.string().nullable(),
  verifier: z.string().nullable(),
});
export type MissionCtx = z.infer<typeof missionCtxSchema>;

export const verifyResumeSchema = z.object({
  verdict: z.enum(["verified", "unverified"]),
  summary: z.string().min(1).max(2_000),
  verifier: z.enum(["vision_model", "user", "other"]).default("vision_model"),
  /** Extra observation ids the verifier produced (e.g. a closer photo). */
  evidence: z.array(z.string()).max(20).default([]),
});
export type VerifyResume = z.infer<typeof verifyResumeSchema>;

const photoSchema = z.object({ observation_id: z.string().nullable(), media_url: z.string().nullable(), captured_at: z.string().nullable() });

export const verifySuspendSchema = z.object({
  kind: z.literal("verification_needed"),
  question: z.string(),
  zone_id: z.string().nullable(),
  camera_ref: z.string().nullable(),
  actuator_ref: z.string().nullable(),
  actuation_state: z.string().nullable(),
  baseline: photoSchema,
  after: photoSchema,
  resume_with: z.string(),
});

export const missionResultSchema = z.object({
  mission: z.literal("inspect-with-actuator"),
  outcome: z.enum(["verified", "unverified", "failed"]),
  summary: z.string(),
  experience_id: z.string().nullable(),
  zone_id: z.string().nullable(),
  camera_ref: z.string().nullable(),
  actuator_ref: z.string().nullable(),
  lease_ids: z.array(z.string()),
  cost_cents: z.number(),
  latency_ms: z.number(),
  evidence: z.array(z.string()),
  invocations: z.array(invocationSchema),
  failures: z.array(z.string()),
  notes: z.array(z.string()),
});
export type MissionResult = z.infer<typeof missionResultSchema>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pick(hit: CapabilityHit): Picked {
  return {
    ref: hit.ref ?? `${hit.device.device_id}/${hit.capability.capability_id}`,
    device_id: hit.device.device_id,
    capability_id: hit.capability.capability_id,
    name: hit.device.name ?? null,
    owner_id: hit.device.owner_id ?? null,
    access_type: hit.device.access_type ?? null,
    zone_id: hit.device.zone_id ?? null,
    price_cents: hit.terms?.price_cents ?? null,
    online: typeof hit.device.online === "boolean" ? hit.device.online : null,
  };
}

function pickedFromRef(ref: string): Picked {
  const i = ref.indexOf("/");
  return {
    ref,
    device_id: ref.slice(0, i),
    capability_id: ref.slice(i + 1),
    name: null,
    owner_id: null,
    access_type: null,
    zone_id: null,
    price_cents: null,
    online: null,
  };
}

function isCamera(h: CapabilityHit): boolean {
  const c = h.capability;
  if (c.kind !== "observe") return false;
  return /^image\./.test(c.semantic_type ?? "") || /snapshot|photo|still|image/.test(c.capability_id) || (c.output?.media ?? "").startsWith("image/");
}

/** The actuator's capability declares that it changes what this camera sees (verified configuration). */
function declaresView(actuator: CapabilityHit, camera: CapabilityHit): boolean {
  const d = actuator.capability.affects_view_of;
  return !!d && (d === camera.device.device_id || d === camera.ref || d === camera.device.name);
}

function score(h: CapabilityHit): number {
  const e = h.experience;
  return (h.device.online === false ? -100 : 0) + (e ? e.successes - (e.attempts - e.successes) : 0);
}

function recordInvocation(ctx: MissionCtx, step: string, o: InvokeOutcome): MissionCtx {
  return {
    ...ctx,
    invocations: [
      ...ctx.invocations,
      {
        step,
        ref: o.ref,
        invocation_id: o.invocation_id,
        state: o.state,
        observation_id: o.observation_id,
        media_url: o.media_url,
        captured_at: o.captured_at,
        error: o.error,
      },
    ],
    evidence: o.observation_id && !ctx.evidence.includes(o.observation_id) ? [...ctx.evidence, o.observation_id] : ctx.evidence,
  };
}

function leaseFor(ctx: MissionCtx, ref: string | undefined): string | null {
  if (!ref) return null;
  return ctx.leases.find((l) => l.refs.includes(ref))?.lease_id ?? null;
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

/** 1. Find a camera and an actuator that affect the same zone. */
const discover = createStep({
  id: "discover",
  description: "Find a camera and an actuator in the same zone (prefers actuators whose affects_view_of names the camera)",
  inputSchema: inspectInputSchema,
  outputSchema: missionCtxSchema,
  execute: async ({ inputData, runId }) => {
    const parsed = inspectInputSchema.parse(inputData);
    const input = { ...parsed, action_capability: parsed.actuator_capability ?? parsed.action_capability };
    const ctx: MissionCtx = {
      mission: "inspect-with-actuator",
      goal: input.goal ?? `Inspect ${input.zone_id ?? "zone"} with ${input.action_capability}`,
      started_at: new Date().toISOString(),
      input,
      zone_id: input.zone_id ?? null,
      camera: null,
      actuator: null,
      leases: [],
      spent_cents: 0,
      invocations: [],
      baseline_observation_id: null,
      after_observation_id: null,
      actuation_state: null,
      evidence: [],
      failures: [],
      notes: [],
      aborted: false,
      verdict: null,
      verdict_summary: null,
      verifier: null,
    };

    const { hits, error } = await searchCapabilities(runId, { zone_id: input.zone_id, limit: 200 });
    if (error) return { ...ctx, aborted: true, failures: [error] };

    const byRef = new Map(hits.map((h) => [h.ref ?? `${h.device.device_id}/${h.capability.capability_id}`, h]));
    const cameras = hits.filter(isCamera).sort((a, b) => score(b) - score(a));
    const actuators = hits
      .filter((h) => h.capability.kind === "act" && (input.actuator_ref ? true : h.capability.capability_id === input.action_capability))
      .sort((a, b) => score(b) - score(a));

    let camera: CapabilityHit | null = input.camera_ref ? byRef.get(input.camera_ref) ?? null : null;
    let actuator: CapabilityHit | null = input.actuator_ref ? byRef.get(input.actuator_ref) ?? null : null;

    if (!camera || !actuator) {
      // Prefer a verified configuration: an actuator that declares it changes this camera's view.
      outer: for (const a of actuator ? [actuator] : actuators) {
        for (const c of camera ? [camera] : cameras) {
          if (declaresView(a, c)) {
            camera = c;
            actuator = a;
            break outer;
          }
        }
      }
    }
    if (!camera || !actuator) {
      for (const a of actuator ? [actuator] : actuators) {
        const c = (camera ? [camera] : cameras).find((c) => c.device.zone_id && c.device.zone_id === a.device.zone_id);
        if (c) {
          camera = c;
          actuator = a;
          break;
        }
      }
    }

    const notes: string[] = [];
    let cam: Picked | null = camera ? pick(camera) : null;
    let act: Picked | null = actuator ? pick(actuator) : null;
    // Explicit refs that the search did not return: try them anyway, but say so.
    if (!cam && input.camera_ref) {
      cam = pickedFromRef(input.camera_ref);
      notes.push(`camera ${input.camera_ref} was not in search results; using it as given`);
    }
    if (!act && input.actuator_ref) {
      act = pickedFromRef(input.actuator_ref);
      notes.push(`actuator ${input.actuator_ref} was not in search results; using it as given`);
    }
    if (camera && actuator && !declaresView(actuator, camera)) {
      notes.push("camera/actuator paired by shared zone only; the actuator does not declare affects_view_of for this camera");
    }

    const failures: string[] = [];
    if (!cam) failures.push(`no camera capability found${input.zone_id ? ` in zone ${input.zone_id}` : ""}`);
    if (!act) failures.push(`no '${input.action_capability}' actuator found${input.zone_id ? ` in zone ${input.zone_id}` : ""}`);
    if (cam?.online === false) notes.push(`camera ${cam.ref} is reported offline`);
    if (act?.online === false) notes.push(`actuator ${act.ref} is reported offline`);

    return {
      ...ctx,
      camera: cam,
      actuator: act,
      zone_id: input.zone_id ?? act?.zone_id ?? cam?.zone_id ?? null,
      notes,
      failures,
      aborted: failures.length > 0,
    };
  },
});

/** 2. Quote and accept leases for both devices within the mission budget. */
const lease = createStep({
  id: "lease",
  description: "Quote, negotiate (max 2 counteroffers) and accept leases within max_spend_cents",
  inputSchema: missionCtxSchema,
  outputSchema: missionCtxSchema,
  execute: async ({ inputData: ctx, runId }) => {
    if (ctx.aborted || !ctx.camera || !ctx.actuator) return ctx;
    // Public observation sources need no lease; everything else is leased, grouped by owner.
    const groups = new Map<string, Picked[]>();
    for (const p of [ctx.camera, ctx.actuator]) {
      if (p.access_type === "public_observation") continue;
      const k = p.owner_id ?? `unknown:${p.device_id}`;
      const g = groups.get(k) ?? [];
      if (!g.some((x) => x.ref === p.ref)) g.push(p);
      groups.set(k, g);
    }
    // The restore action (e.g. cover.close) must be covered by the same lease as the actuator.
    const restore = ctx.input.restore_capability;
    if (restore && ctx.actuator.access_type !== "public_observation") {
      const k = ctx.actuator.owner_id ?? `unknown:${ctx.actuator.device_id}`;
      const g = groups.get(k) ?? [];
      const restoreRef = `${ctx.actuator.device_id}/${restore}`;
      if (!g.some((x) => x.ref === restoreRef)) g.push({ ...ctx.actuator, ref: restoreRef, capability_id: restore });
      groups.set(k, g);
    }
    let next: MissionCtx = { ...ctx };
    for (const [owner, refs] of groups) {
      const remaining = ctx.input.max_spend_cents - next.spent_cents;
      const r = await acquireLease(runId, {
        refs: refs.map((p) => ({ device_id: p.device_id, capability_id: p.capability_id })),
        owner_id: owner.startsWith("unknown:") ? null : owner,
        duration_s: ctx.input.duration_s,
        budgetCents: remaining,
        approvalWaitMs: ctx.input.approval_wait_s * 1_000,
      });
      if (r.lease_id) {
        next = {
          ...next,
          leases: [
            ...next.leases,
            { lease_id: r.lease_id, offer_id: r.offer_id, owner_id: r.owner_id, refs: r.refs, price_cents: r.price_cents, state: r.state },
          ],
          spent_cents: next.spent_cents + (r.ok ? r.price_cents : 0),
        };
      }
      if (r.host_message) next = { ...next, notes: [...next.notes, `host (${r.owner_id ?? owner}): ${r.host_message}`] };
      if (!r.ok) {
        return { ...next, aborted: true, failures: [...next.failures, `lease for ${r.refs.join(", ")}: ${r.error}`] };
      }
    }
    return next;
  },
});

/** 3. Baseline photo before touching anything. */
const baseline = createStep({
  id: "baseline-snapshot",
  description: "Capture a baseline observation from the camera",
  inputSchema: missionCtxSchema,
  outputSchema: missionCtxSchema,
  execute: async ({ inputData: ctx, runId }) => {
    if (ctx.aborted || !ctx.camera) return ctx;
    const o = await invokeCapability(runId, {
      device_id: ctx.camera.device_id,
      capability_id: ctx.camera.capability_id,
      lease_id: leaseFor(ctx, ctx.camera.ref),
      idempotency_key: `${runId}:baseline`,
    });
    const next = recordInvocation(ctx, "baseline-snapshot", o);
    if (o.state !== "succeeded" || !o.observation_id) {
      // Without a baseline we cannot verify anything, so we do not actuate the world.
      return {
        ...next,
        aborted: true,
        failures: [...next.failures, `baseline snapshot ${o.state}${o.error ? `: ${o.error}` : " (no observation)"}; not actuating`],
      };
    }
    return { ...next, baseline_observation_id: o.observation_id };
  },
});

/** 4. Actuate. */
const actuate = createStep({
  id: "actuate",
  description: "Invoke the actuator capability (e.g. cover.open) and wait settle_ms",
  inputSchema: missionCtxSchema,
  outputSchema: missionCtxSchema,
  execute: async ({ inputData: ctx, runId }) => {
    if (ctx.aborted || !ctx.actuator) return ctx;
    const o = await invokeCapability(runId, {
      device_id: ctx.actuator.device_id,
      capability_id: ctx.actuator.capability_id,
      arguments: ctx.input.action_arguments,
      lease_id: leaseFor(ctx, ctx.actuator.ref),
      idempotency_key: `${runId}:actuate`,
    });
    let next = recordInvocation(ctx, "actuate", o);
    next = { ...next, actuation_state: o.state };
    if (o.state === "failed" || o.state === "rejected" || o.state === "transport_error") {
      return { ...next, aborted: true, failures: [...next.failures, `actuation ${o.state}${o.error ? `: ${o.error}` : ""}`] };
    }
    if (o.state !== "succeeded") {
      next = { ...next, notes: [...next.notes, `actuation state is '${o.state}': the device did not confirm the action; the photo comparison decides`] };
    }
    if (ctx.input.settle_ms > 0) await sleep(ctx.input.settle_ms);
    return next;
  },
});

/** 5. Second photo after actuation. */
const after = createStep({
  id: "after-snapshot",
  description: "Capture a new observation after actuation",
  inputSchema: missionCtxSchema,
  outputSchema: missionCtxSchema,
  execute: async ({ inputData: ctx, runId }) => {
    if (ctx.aborted || !ctx.camera) return ctx;
    const o = await invokeCapability(runId, {
      device_id: ctx.camera.device_id,
      capability_id: ctx.camera.capability_id,
      lease_id: leaseFor(ctx, ctx.camera.ref),
      idempotency_key: `${runId}:after`,
    });
    const next = recordInvocation(ctx, "after-snapshot", o);
    if (o.state !== "succeeded" || !o.observation_id) {
      // The world may have changed, but we have no evidence: unverified, not failed, not success.
      return { ...next, failures: [...next.failures, `after snapshot ${o.state}${o.error ? `: ${o.error}` : " (no observation)"}`] };
    }
    return { ...next, after_observation_id: o.observation_id };
  },
});

/** 6. Human / vision-model verification (Mastra suspend/resume). */
const verify = createStep({
  id: "verify",
  description: "Suspend until a verifier compares baseline and after photos, then resume with a verdict",
  inputSchema: missionCtxSchema,
  outputSchema: missionCtxSchema,
  suspendSchema: verifySuspendSchema,
  resumeSchema: verifyResumeSchema,
  execute: async ({ inputData: ctx, resumeData, suspend }) => {
    if (ctx.aborted) return { ...ctx, verdict: "failed" as const, verdict_summary: null };
    if (!ctx.after_observation_id || !ctx.baseline_observation_id) {
      return { ...ctx, verdict: "unverified" as const, verdict_summary: "No after-actuation photo, so the result could not be checked." };
    }
    if (!resumeData) {
      const photo = (id: string | null) => {
        const inv = ctx.invocations.find((i) => i.observation_id && i.observation_id === id);
        return { observation_id: id, media_url: inv?.media_url ?? (id ? `/api/v1/observations/${id}/media` : null), captured_at: inv?.captured_at ?? null };
      };
      return await suspend({
        kind: "verification_needed" as const,
        question: `Compare the two photos from ${ctx.camera?.name ?? ctx.camera?.ref}. Goal: ${ctx.goal}. Did '${ctx.actuator?.capability_id}' visibly produce the expected change?`,
        zone_id: ctx.zone_id,
        camera_ref: ctx.camera?.ref ?? null,
        actuator_ref: ctx.actuator?.ref ?? null,
        actuation_state: ctx.actuation_state,
        baseline: photo(ctx.baseline_observation_id),
        after: photo(ctx.after_observation_id),
        resume_with: "POST /api/v1/missions/runs/:id/resume {verdict: 'verified'|'unverified', summary, verifier?, evidence?}",
      });
    }
    const extra = (resumeData.evidence ?? []).filter((e) => !ctx.evidence.includes(e));
    return {
      ...ctx,
      verdict: resumeData.verdict,
      verdict_summary: resumeData.summary,
      verifier: resumeData.verifier ?? "vision_model",
      evidence: [...ctx.evidence, ...extra],
    };
  },
});

/** 7. Optional restore action, then release every lease we hold. Always runs. */
const release = createStep({
  id: "release",
  description: "Optionally restore the scene (e.g. cover.close), then release all leases",
  inputSchema: missionCtxSchema,
  outputSchema: missionCtxSchema,
  execute: async ({ inputData: ctx, runId }) => {
    let next = ctx;
    const restore = ctx.input.restore_capability;
    const acted = ctx.actuation_state === "succeeded" || ctx.actuation_state === "unknown";
    if (restore && ctx.actuator && acted) {
      const o = await invokeCapability(runId, {
        device_id: ctx.actuator.device_id,
        capability_id: restore,
        lease_id: leaseFor(ctx, ctx.actuator.ref),
        idempotency_key: `${runId}:restore`,
      });
      next = recordInvocation(next, "restore", { ...o, ref: `${ctx.actuator.device_id}/${restore}` });
      if (o.state !== "succeeded") next = { ...next, notes: [...next.notes, `restore '${restore}' ${o.state}${o.error ? `: ${o.error}` : ""}`] };
    }
    const leases = [];
    for (const l of next.leases) {
      if (l.state !== "active" && l.state !== "reserved" && l.state !== "payment_pending") {
        leases.push(l);
        continue;
      }
      const r = await releaseLease(runId, l.lease_id);
      if (!r.ok) next = { ...next, notes: [...next.notes, r.error ?? `release ${l.lease_id} failed`] };
      leases.push({ ...l, state: r.ok ? r.state ?? "released" : l.state });
    }
    return { ...next, leases };
  },
});

/** 8. Remember what happened (verified / unverified / failed) as an experience. */
const record = createStep({
  id: "record-experience",
  description: "Record the outcome as an experience with evidence ids, cost and failures",
  inputSchema: missionCtxSchema,
  outputSchema: missionResultSchema,
  execute: async ({ inputData: ctx, runId }) => {
    const outcome: MissionResult["outcome"] = ctx.aborted ? "failed" : ctx.verdict === "verified" ? "verified" : ctx.verdict === "failed" ? "failed" : "unverified";
    const latency_ms = Date.now() - Date.parse(ctx.started_at);
    const summary =
      outcome === "failed"
        ? `Mission failed: ${ctx.failures.join("; ") || "unknown reason"}`
        : `${outcome === "verified" ? "Verified" : "Not verified"}${ctx.verifier ? ` by ${ctx.verifier}` : ""}: ${ctx.verdict_summary ?? "no verifier summary"}`;
    const refs = [ctx.camera, ctx.actuator].filter((p): p is Picked => !!p).map((p) => ({ device_id: p.device_id, capability_id: p.capability_id }));
    let experience_id: string | null = null;
    const notes = [...ctx.notes];
    if (refs.length) {
      const r = await recordExperience(runId, {
        goal: ctx.goal,
        refs,
        zone_id: ctx.zone_id ?? undefined,
        outcome,
        cost_cents: ctx.spent_cents,
        latency_ms,
        failures: ctx.failures,
        evidence: ctx.evidence,
        summary: summary.slice(0, 2_000),
      });
      experience_id = r.experience_id;
      if (r.error) notes.push(r.error);
    } else {
      notes.push("no devices were selected, so no experience was recorded");
    }
    return {
      mission: "inspect-with-actuator" as const,
      outcome,
      summary,
      experience_id,
      zone_id: ctx.zone_id,
      camera_ref: ctx.camera?.ref ?? null,
      actuator_ref: ctx.actuator?.ref ?? null,
      lease_ids: ctx.leases.map((l) => l.lease_id),
      cost_cents: ctx.spent_cents,
      latency_ms,
      evidence: ctx.evidence,
      invocations: ctx.invocations,
      failures: ctx.failures,
      notes,
    };
  },
});

export const inspectWithActuator = createWorkflow({
  id: "inspect-with-actuator",
  description:
    "Find a camera and actuator in one zone, lease both within budget, photograph, actuate, photograph again, wait for a verdict, release and remember the outcome.",
  inputSchema: inspectInputSchema,
  outputSchema: missionResultSchema,
})
  .then(discover)
  .then(lease)
  .then(baseline)
  .then(actuate)
  .then(after)
  .then(verify)
  .then(release)
  .then(record)
  .commit();
