import type { CapabilityRef, Experience } from "../contracts";
import type { ExperienceSearchResponse, RecordExperienceRequest } from "../client/api-types";
import { db } from "./db";
import { bad, id, iso, json, tokenize } from "./util";

type ExperienceRow = {
  experience_id: string;
  visitor_id: string;
  goal: string;
  refs: unknown;
  zone_id: string | null;
  outcome: Experience["outcome"];
  cost_cents: number;
  latency_ms: number | null;
  failures: unknown;
  evidence: unknown;
  summary: string;
  created_at: unknown;
};

const OUTCOMES: Experience["outcome"][] = ["verified", "unverified", "failed"];

function rowToExperience(r: ExperienceRow): Experience {
  return {
    experience_id: r.experience_id,
    visitor_id: r.visitor_id,
    goal: r.goal,
    refs: json<CapabilityRef[]>(r.refs) ?? [],
    ...(r.zone_id ? { zone_id: r.zone_id } : {}),
    outcome: r.outcome,
    cost_cents: Number(r.cost_cents),
    ...(r.latency_ms !== null && r.latency_ms !== undefined ? { latency_ms: Number(r.latency_ms) } : {}),
    failures: json<string[]>(r.failures) ?? [],
    evidence: json<string[]>(r.evidence) ?? [],
    summary: r.summary,
    created_at: iso(r.created_at),
  };
}

export async function recordExperience(visitor_id: string, req: RecordExperienceRequest): Promise<Experience> {
  if (!req || typeof req.goal !== "string" || !req.goal.trim()) throw bad("goal is required");
  if (typeof req.summary !== "string" || !req.summary.trim()) throw bad("summary is required");
  if (!OUTCOMES.includes(req.outcome)) throw bad("outcome must be one of verified, unverified, failed");
  const refs = Array.isArray(req.refs) ? req.refs : [];
  for (const r of refs) if (!r || typeof r.device_id !== "string" || typeof r.capability_id !== "string") throw bad("invalid ref in refs");
  const cost = Math.max(0, Math.round(Number(req.cost_cents ?? 0)) || 0);
  const latency = req.latency_ms === undefined || req.latency_ms === null ? null : Math.max(0, Math.round(Number(req.latency_ms)) || 0);
  const r = await db().query<ExperienceRow>(
    `insert into experiences (experience_id, visitor_id, goal, refs, zone_id, outcome, cost_cents, latency_ms, failures, evidence, summary)
     values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11) returning *`,
    [
      id("exp"),
      visitor_id,
      req.goal.trim().slice(0, 500),
      JSON.stringify(refs.map((x) => ({ device_id: x.device_id, capability_id: x.capability_id }))),
      req.zone_id ?? null,
      req.outcome,
      cost,
      latency,
      JSON.stringify((req.failures ?? []).map(String).slice(0, 20)),
      JSON.stringify((req.evidence ?? []).map(String).slice(0, 20)),
      req.summary.trim().slice(0, 2000),
    ],
  );
  return rowToExperience(r.rows[0]);
}

/** Token-overlap recall, recent first; counts always report the sample size. */
export async function recallExperience(q?: string, opts: { limit?: number; visitor_id?: string } = {}): Promise<ExperienceSearchResponse> {
  const params: unknown[] = [];
  let where = "";
  if (opts.visitor_id) {
    params.push(opts.visitor_id);
    where = `where visitor_id = $1`;
  }
  const r = await db().query<ExperienceRow>(`select * from experiences ${where} order by created_at desc limit 2000`, params);
  const all = r.rows.map(rowToExperience);
  const qt = q ? [...new Set(tokenize(q))] : [];
  let scored = all.map((e) => ({ e, score: 0 }));
  if (qt.length) {
    scored = all
      .map((e) => {
        const toks = new Set(
          tokenize([e.goal, e.summary, e.zone_id ?? "", ...(e.failures ?? []), ...e.refs.map((x) => `${x.device_id} ${x.capability_id}`)].join(" ")),
        );
        let m = 0;
        for (const t of qt) if (toks.has(t) || [...toks].some((x) => x.startsWith(t) && t.length >= 3)) m++;
        return { e, score: m / qt.length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.e.created_at.localeCompare(a.e.created_at));
  }
  const counts = { total: scored.length, verified: 0, unverified: 0, failed: 0 };
  for (const { e } of scored) counts[e.outcome] += 1;
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  return {
    experiences: scored.slice(0, limit).map(({ e, score }) => (qt.length ? { ...e, score: Math.round(score * 100) / 100 } : e)),
    counts,
  };
}
