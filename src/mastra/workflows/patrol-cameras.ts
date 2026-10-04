/**
 * Mission: patrol-cameras
 *
 * Observe a list of capability refs (typically public traffic-camera stills or the visitor's
 * own cameras) in parallel batches and return one observation id per ref. Refs that fail are
 * reported with their error; nothing is retried silently and nothing is invented.
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { invokeCapability, recordExperience } from "../ghost-ops";

const refPattern = /^[^/\s]+\/[^\s]+$/;

export const patrolInputSchema = z.object({
  refs: z.array(z.string().regex(refPattern)).min(1).max(24).describe("Capability refs '<device_id>/<capability_id>' to observe"),
  goal: z.string().max(500).optional(),
  concurrency: z.number().int().min(1).max(8).default(4),
  timeout_ms: z.number().int().min(1_000).max(60_000).default(20_000),
  /** Optional lease ids keyed by ref, for non-public cameras the caller already leased. */
  lease_ids: z.record(z.string(), z.string()).default({}),
  record_experience: z.boolean().default(false),
});
export type PatrolInput = z.infer<typeof patrolInputSchema>;

const itemSchema = z.object({
  index: z.number(),
  ref: z.string(),
  device_id: z.string(),
  capability_id: z.string(),
  lease_id: z.string().nullable(),
  timeout_ms: z.number(),
});

const observedSchema = z.object({
  ref: z.string(),
  status: z.enum(["observed", "failed", "unknown"]),
  invocation_id: z.string().nullable(),
  observation_id: z.string().nullable(),
  media_url: z.string().nullable(),
  captured_at: z.string().nullable(),
  note: z.string().nullable(),
  error: z.string().nullable(),
});

export const patrolResultSchema = z.object({
  mission: z.literal("patrol-cameras"),
  observations: z.array(observedSchema),
  observation_ids: z.array(z.string()),
  observed: z.number(),
  failed: z.number(),
  unknown: z.number(),
  experience_id: z.string().nullable(),
  latency_ms: z.number(),
  notes: z.array(z.string()),
});

const plan = createStep({
  id: "plan",
  description: "Turn refs into observation work items",
  inputSchema: patrolInputSchema,
  outputSchema: z.array(itemSchema),
  execute: async ({ inputData }) => {
    const input = patrolInputSchema.parse(inputData);
    const seen = new Set<string>();
    const items: z.infer<typeof itemSchema>[] = [];
    for (const ref of input.refs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const i = ref.indexOf("/");
      items.push({
        index: items.length,
        ref,
        device_id: ref.slice(0, i),
        capability_id: ref.slice(i + 1),
        lease_id: input.lease_ids[ref] ?? null,
        timeout_ms: input.timeout_ms,
      });
    }
    return items;
  },
});

const observe = createStep({
  id: "observe",
  description: "Invoke one camera capability and keep the observation id",
  inputSchema: itemSchema,
  outputSchema: observedSchema,
  execute: async ({ inputData: item, runId }) => {
    const o = await invokeCapability(runId, {
      device_id: item.device_id,
      capability_id: item.capability_id,
      lease_id: item.lease_id,
      idempotency_key: `${runId}:observe:${item.index}`,
      timeout_ms: item.timeout_ms,
    });
    const status = o.state === "succeeded" && o.observation_id ? "observed" : o.state === "unknown" || o.state === "running" || o.state === "accepted" ? "unknown" : "failed";
    return {
      ref: item.ref,
      status,
      invocation_id: o.invocation_id,
      observation_id: o.observation_id,
      media_url: o.media_url,
      captured_at: o.captured_at,
      note: o.note,
      error: status === "observed" ? null : o.error ?? `invocation ${o.state}`,
    } as const;
  },
});

const summarize = createStep({
  id: "summarize",
  description: "Collect observation ids and optionally record an experience",
  inputSchema: z.array(observedSchema),
  outputSchema: patrolResultSchema,
  execute: async ({ inputData, runId, getInitData }) => {
    const init = patrolInputSchema.parse(getInitData());
    const startedAt = Date.now();
    const observed = inputData.filter((o) => o.status === "observed");
    const failed = inputData.filter((o) => o.status === "failed");
    const unknown = inputData.filter((o) => o.status === "unknown");
    const notes: string[] = [];
    let experience_id: string | null = null;
    if (init.record_experience && inputData.length) {
      const outcome = observed.length === inputData.length ? "verified" : observed.length > 0 ? "unverified" : "failed";
      const r = await recordExperience(runId, {
        goal: init.goal ?? `Patrol ${inputData.length} camera(s)`,
        refs: inputData.map((o) => {
          const i = o.ref.indexOf("/");
          return { device_id: o.ref.slice(0, i), capability_id: o.ref.slice(i + 1) };
        }),
        outcome,
        cost_cents: 0,
        failures: [...failed, ...unknown].map((o) => `${o.ref}: ${o.error ?? o.status}`),
        evidence: observed.map((o) => o.observation_id!).filter(Boolean),
        summary: `Observed ${observed.length}/${inputData.length} camera(s)${failed.length ? `; ${failed.length} failed` : ""}${unknown.length ? `; ${unknown.length} unknown` : ""}.`,
      });
      experience_id = r.experience_id;
      if (r.error) notes.push(r.error);
    }
    return {
      mission: "patrol-cameras" as const,
      observations: inputData,
      observation_ids: observed.map((o) => o.observation_id!).filter(Boolean),
      observed: observed.length,
      failed: failed.length,
      unknown: unknown.length,
      experience_id,
      latency_ms: Date.now() - startedAt,
      notes,
    };
  },
});

export const patrolCameras = createWorkflow({
  id: "patrol-cameras",
  description: "Observe several cameras in parallel and return one observation id per camera (failures reported, never hidden).",
  inputSchema: patrolInputSchema,
  outputSchema: patrolResultSchema,
})
  .then(plan)
  .foreach(observe, { concurrency: 4 })
  .then(summarize)
  .commit();
