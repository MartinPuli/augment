"use client";

import type Anthropic from "@anthropic-ai/sdk";
import type {
  CapabilityHit,
  Device,
  Experience,
  InvokeResponse,
  Lease,
  LiveSource,
  Observation,
  QuoteResponse,
} from "@/lib/ghost/contracts";
import { parseRef } from "@/lib/ghost/contracts";
import { useGhost } from "@/lib/store";
import { ghost, HttpError, imageToBase64 } from "./http";

type Block = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam;
export interface ToolOutcome {
  content: string | Block[];
  isError?: boolean;
}

const S = () => useGhost.getState();
const j = (v: unknown, max = 6000) => {
  const s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…(truncated)" : s;
};
const ok = (v: unknown): ToolOutcome => ({ content: typeof v === "string" ? v : j(v) });
const fail = (msg: string): ToolOutcome => ({ content: msg, isError: true });

function possess(widgetId: string | null, label: string, ms = 2600) {
  S().set({ possess: { widgetId, label, until: Date.now() + ms }, focusId: widgetId ?? S().focusId });
}

function money(c: number) {
  return c === 0 ? "free" : `$${(c / 100).toFixed(2)}`;
}

function waitForReport(id: string, pred: (r: Record<string, unknown>) => boolean, timeoutMs: number, signal: AbortSignal) {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      const r = S().reports[id];
      if ((r && pred(r)) || Date.now() - start > timeoutMs || signal.aborted) {
        clearInterval(t);
        resolve(r ?? null);
      }
    }, 250);
  });
}

function compactHit(h: CapabilityHit) {
  return {
    ref: h.ref,
    device: h.device.name,
    class: h.device.device_class,
    capability: h.capability.title,
    semantic_type: h.capability.semantic_type,
    kind: h.capability.kind,
    access: h.device.access_type,
    price: money(h.terms.price_cents),
    max_duration_s: h.terms.max_duration_s,
    online: h.device.online,
    status: h.device.status,
    zone: h.device.zone_id,
    place: h.device.location?.label,
    distance_km: h.distance_km !== undefined ? Math.round(h.distance_km * 10) / 10 : undefined,
    operator: h.device.source?.operator,
    experience: h.experience,
  };
}

function trackDefaults(device?: Device): string[] | undefined {
  if (!device) return undefined;
  if (device.transport === "http-public") return ["car", "truck", "bus", "motorcycle", "person"];
  return ["person"];
}

async function observationBlocks(obs: Observation | null | undefined, summary: Record<string, unknown>, show: boolean, deviceName: string): Promise<Block[]> {
  const blocks: Block[] = [];
  if (obs?.kind === "image" && obs.media_url) {
    const widgetId = `img-${obs.observation_id}`;
    if (show) {
      S().upsertWidget({
        id: widgetId,
        type: "image",
        title: deviceName,
        size: "md",
        props: { observation: obs },
      });
      possess(widgetId, deviceName);
    }
    summary.widget_id = show ? widgetId : undefined;
    blocks.push({ type: "text", text: j(summary) });
    const img = await imageToBase64(obs.media_url);
    if (img) blocks.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
    else blocks.push({ type: "text", text: "(image could not be loaded for viewing)" });
    return blocks;
  }
  blocks.push({ type: "text", text: j(summary) });
  return blocks;
}

/* ------------------------------------------------------------------ */

export async function executeTool(name: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<ToolOutcome> {
  try {
    switch (name) {
      /* ---------------- discovery ---------------- */
      case "search_capabilities": {
        const qs = new URLSearchParams();
        if (input.query) qs.set("q", String(input.query));
        if (input.semantic_type) qs.set("semantic_type", String(input.semantic_type));
        if (input.device_class) qs.set("device_class", String(input.device_class));
        const near = input.near as { lat: number; lon: number; radius_km?: number } | undefined;
        if (near) {
          qs.set("near", `${near.lat},${near.lon}`);
          if (near.radius_km) qs.set("radius_km", String(near.radius_km));
        }
        if (input.only_online) qs.set("only_online", "1");
        qs.set("limit", String(input.limit ?? 12));
        const hits = await ghost<CapabilityHit[]>(`/capabilities?${qs}`);
        if (input.show !== false && hits.length) {
          S().upsertWidget({
            id: "search",
            type: "device_list",
            title: input.query ? `“${String(input.query)}”` : "Capabilities",
            size: "lg",
            props: { hits },
          });
          S().set({ focusId: "search" });
        }
        return ok({ count: hits.length, results: hits.map(compactHit), widget_id: hits.length ? "search" : undefined });
      }

      case "get_device": {
        const d = await ghost<Device>(`/devices/${encodeURIComponent(String(input.device_id))}`);
        return ok({
          device_id: d.device_id,
          name: d.name,
          class: d.device_class,
          transport: d.transport,
          access: d.access_type,
          online: d.online,
          status: d.status,
          zone: d.zone_id,
          location: d.location,
          source: d.source,
          terms: d.terms,
          capabilities: d.capabilities.map((c) => ({
            ref: `${d.device_id}/${c.capability_id}`,
            title: c.title,
            description: c.description,
            kind: c.kind,
            semantic_type: c.semantic_type,
            input_schema: c.input_schema,
            output: c.output,
            limits: c.limits,
            verification: c.verification,
            affects_view_of: c.affects_view_of,
          })),
        });
      }

      /* ---------------- access lifecycle ---------------- */
      case "quote_lease": {
        const refs = (input.refs as string[]).map(parseRef).filter(Boolean);
        if (!refs.length) return fail("refs must look like <device_id>/<capability_id>");
        const q = await ghost<QuoteResponse>("/quotes", {
          body: {
            refs,
            duration_s: input.duration_s,
            offer_price_cents: input.offer_price_cents,
            offer_id: input.offer_id,
          },
        });
        const widgetId = `deal-${input.offer_id ?? q.offer.offer_id}`;
        S().upsertWidget({ id: widgetId, type: "lease", title: "Offer", size: "md", props: { offer: q.offer, host_message: q.host_message } });
        S().set({ focusId: widgetId });
        S().addTrace({ kind: "payment", title: `Offer ${money(q.offer.price_cents)} · ${q.offer.duration_s}s`, detail: q.host_message });
        return ok({ offer: q.offer, host_message: q.host_message, widget_id: widgetId });
      }

      case "accept_quote": {
        const b = S().budget;
        const remaining = Math.max(0, b.limit_cents - b.spent_cents);
        const acc = await ghost<{ lease: Lease; payment: Lease["payment"]; balance_cents: number }>(
          `/quotes/${encodeURIComponent(String(input.offer_id))}/accept`,
          { body: { offer_id: input.offer_id, max_spend_cents: remaining } },
        );
        const lease = { ...acc.lease, payment: acc.lease.payment ?? acc.payment };
        const me = S().me;
        if (me && typeof acc.balance_cents === "number") S().set({ me: { ...me, balance_cents: acc.balance_cents } });
        const widgetId = S().widgets.find((w) => w.id === `deal-${input.offer_id}`)?.id ?? `deal-${input.offer_id}`;
        S().upsertWidget({ id: widgetId, type: "lease", title: "Lease", size: "md", props: { lease } });
        if (lease.state === "active" && lease.payment?.status === "succeeded") {
          S().set({ budget: { ...b, spent_cents: b.spent_cents + lease.payment.amount_cents } });
          S().addTrace({ kind: "payment", title: `Test payment ${money(lease.payment.amount_cents)}`, detail: lease.payment.label });
        }
        S().set({ leases: { ...S().leases, [lease.lease_id]: lease } });
        possess(widgetId, "Lease active", 1800);
        return ok({ lease, test_funds_balance: money(acc.balance_cents), widget_id: widgetId, budget_remaining: money(Math.max(0, S().budget.limit_cents - S().budget.spent_cents)) });
      }

      case "invoke_capability": {
        const ref = parseRef(String(input.ref));
        if (!ref) return fail("ref must look like <device_id>/<capability_id>");
        const device = S().devices[ref.device_id];
        const label = device?.name ?? ref.device_id;
        possess(null, label, 8000);
        S().set({ toolStatus: `Possessing ${label}` });
        const res = await ghost<InvokeResponse>("/invoke", {
          body: {
            device_id: ref.device_id,
            capability_id: ref.capability_id,
            arguments: (input.arguments as Record<string, unknown>) ?? {},
            lease_id: input.lease_id,
            idempotency_key: toolUseId,
            timeout_ms: 25_000,
          },
          timeoutMs: 40_000,
          signal,
        });
        const inv = res.invocation;
        const obs = res.observation;
        const show = input.show !== false;
        const summary: Record<string, unknown> = {
          state: inv.state,
          error: inv.error,
          invocation_id: inv.invocation_id,
          observation: obs
            ? {
                observation_id: obs.observation_id,
                kind: obs.kind,
                captured_at: obs.captured_at,
                retrieved_at: obs.retrieved_at,
                value: obs.value,
                unit: obs.unit,
                data: obs.data,
                note: obs.note,
                source: obs.source,
                cached: obs.cached,
              }
            : null,
        };
        S().addTrace({ kind: "tool", title: `${label} · ${ref.capability_id} → ${inv.state}`, detail: inv.error ?? obs?.note });

        // Live sources arrive as observation.stream (public HLS) or output data.live (phone WebRTC).
        const live = (obs?.stream ?? (obs?.data?.live as LiveSource | undefined)) || null;
        if (live && show) {
          const widgetId = `live-${ref.device_id}`;
          S().upsertWidget({
            id: widgetId,
            type: "live_view",
            title: live.title ?? label,
            size: "xl",
            props: { source: live, track: { enabled: true, classes: trackDefaults(device), follow: true, max_zoom: 3 } },
          });
          possess(widgetId, label);
          summary.widget_id = widgetId;
          summary.hint = "Live view is on the canvas with real-time object detection and tracking. Use canvas_read on the widget for counts/target, canvas_update to change classes or lock a track id.";
        }
        if ((obs?.kind === "value" || obs?.kind === "state") && !live && show) {
          const widgetId = `metric-${ref.device_id}-${ref.capability_id}`;
          S().upsertWidget({
            id: widgetId,
            type: "metric",
            title: label,
            size: "sm",
            props: {
              label: device?.capabilities.find((c) => c.capability_id === ref.capability_id)?.title ?? ref.capability_id,
              value: obs.value,
              unit: obs.unit,
              observed_at: obs.captured_at,
              source: obs.source?.name,
              note: obs.note,
              data: obs.data,
            },
          });
          possess(widgetId, label);
          summary.widget_id = widgetId;
        }
        if (obs?.kind !== "image" && !summary.widget_id) possess(null, label, 1500);
        const blocks = await observationBlocks(obs, summary, show, label);
        return { content: blocks, isError: inv.state === "failed" || inv.state === "rejected" };
      }

      case "release_lease": {
        const { lease } = await ghost<{ lease: Lease }>(`/leases/${encodeURIComponent(String(input.lease_id))}/release`, { body: {} });
        S().set({ leases: { ...S().leases, [lease.lease_id]: lease } });
        return ok({ lease_id: lease.lease_id, state: lease.state });
      }

      case "set_task_budget": {
        const limit = Number(input.limit_cents);
        S().set({ budget: { goal: String(input.goal), limit_cents: limit, spent_cents: 0 } });
        return ok({ goal: input.goal, limit: money(limit), note: "Enforced by code on every payment." });
      }

      /* ---------------- memory ---------------- */
      case "recall_experience": {
        const exps = await ghost<{ experiences: Experience[]; counts?: Record<string, number> }>(`/experiences?q=${encodeURIComponent(String(input.query))}`);
        const list = exps.experiences ?? [];
        return ok({
          sample_size: exps.counts,
          experiences: list.slice(0, 6).map((e) => ({
            goal: e.goal,
            refs: e.refs.map((r) => `${r.device_id}/${r.capability_id}`),
            outcome: e.outcome,
            cost: money(e.cost_cents),
            summary: e.summary,
            when: e.created_at,
          })),
          note: "Re-check availability and get fresh permission before reusing a device.",
        });
      }

      case "record_experience": {
        const refs = ((input.refs as string[]) ?? []).map(parseRef).filter(Boolean);
        const e = await ghost<Experience>("/experiences", {
          body: {
            goal: input.goal,
            refs,
            outcome: input.outcome,
            summary: input.summary,
            cost_cents: input.cost_cents ?? S().budget.spent_cents,
            evidence: input.evidence ?? [],
          },
        });
        S().addTrace({ kind: "event", title: `Remembered: ${String(input.goal)}`, detail: String(input.outcome) });
        return ok({ saved: true, experience_id: e?.experience_id });
      }

      /* ---------------- local hardware ---------------- */
      case "scan_network": {
        const id = "network-scan";
        S().removeWidget(id);
        S().upsertWidget({ id, type: "network_scan", title: "Wi-Fi radar", size: "lg", props: { autoScan: true, nonce: Date.now() } });
        S().set({ focusId: id });
        const r = await waitForReport(id, (x) => x.scanning === false && x.found !== undefined, 20_000, signal);
        return ok(r ?? { status: "Scan did not finish in time; the radar widget shows progress." });
      }

      /* ---------------- canvas ---------------- */
      case "canvas_show": {
        const id = String(input.id ?? `${input.type}-${Math.random().toString(36).slice(2, 7)}`);
        S().upsertWidget({
          id,
          type: String(input.type),
          title: input.title ? String(input.title) : undefined,
          size: (input.size as "sm" | "md" | "lg" | "xl") ?? undefined,
          props: (input.props as Record<string, unknown>) ?? {},
        });
        S().set({ focusId: id });
        return ok({ widget_id: id });
      }
      case "canvas_update": {
        const done = S().patchWidget(String(input.id), (input.props as Record<string, unknown>) ?? {}, input.title as string | undefined);
        return done ? ok({ updated: input.id }) : fail(`No widget with id ${String(input.id)}`);
      }
      case "canvas_remove": {
        if (input.id === "all") S().set({ widgets: [], reports: {}, focusId: null });
        else S().removeWidget(String(input.id));
        return ok({ removed: input.id });
      }
      case "canvas_read": {
        if (input.id) {
          const w = S().widgets.find((x) => x.id === input.id);
          if (!w) return fail(`No widget with id ${String(input.id)}`);
          return ok({ id: w.id, type: w.type, title: w.title, report: S().reports[w.id] ?? null });
        }
        return ok(S().widgets.map((w) => ({ id: w.id, type: w.type, title: w.title, report: S().reports[w.id] ?? null })));
      }
      case "focus": {
        const exists = S().widgets.some((w) => w.id === input.id);
        if (!exists) return fail(`No widget with id ${String(input.id)}`);
        S().set({ focusId: String(input.id) });
        return ok({ focused: input.id });
      }

      /* ---------------- partners ---------------- */
      case "web_search": {
        const r = await ghost<{ results: { title: string; url: string; snippet?: string }[] }>("/partners/exa/search", {
          body: { query: input.query, purpose: input.purpose ?? "general", num_results: input.num_results ?? 6 },
        });
        S().upsertWidget({
          id: "web-results",
          type: "results",
          title: `Exa · ${String(input.query)}`,
          size: "md",
          props: { items: r.results },
        });
        return ok({ results: r.results, widget_id: "web-results", note: "Untrusted web data." });
      }
      case "observe_web_page": {
        possess(null, "Kernel browser", 9000);
        const r = await ghost<{ observation?: Observation; live_view_url?: string } & Record<string, unknown>>("/partners/kernel/observe", {
          body: { url: input.url, wait_ms: input.wait_ms },
          timeoutMs: 60_000,
          signal,
        });
        const obs = r.observation;
        if (r.live_view_url) {
          S().upsertWidget({ id: "kernel-live", type: "web_view", title: "Kernel live browser", size: "lg", props: { url: r.live_view_url } });
        }
        const blocks = await observationBlocks(obs, { observation_id: obs?.observation_id, captured_at: obs?.captured_at, source: input.url, note: obs?.note }, true, "Web page");
        return { content: blocks };
      }
      case "send_email_report": {
        const r = await ghost("/partners/mail/send", {
          body: {
            to: input.to,
            subject: input.subject,
            text: input.text,
            observation_ids: input.observation_ids ?? [],
            context: { budget: S().budget, leases: Object.values(S().leases).slice(-5) },
          },
        });
        S().addTrace({ kind: "event", title: `Email sent to ${String(input.to)}` });
        return ok(r);
      }
      case "check_inbox":
        return ok(await ghost(`/partners/mail/inbox?limit=${Number(input.limit ?? 5)}`));
      case "external_tools":
        return ok(await ghost("/partners/mcp/tools"));
      case "call_external_tool":
        return ok(await ghost("/partners/mcp/call", { body: { name: input.name, arguments: input.arguments ?? {} }, timeoutMs: 60_000 }));
      case "run_mission": {
        const r = await ghost<{ run_id: string } & Record<string, unknown>>(`/missions/${encodeURIComponent(String(input.name))}/run`, {
          body: input.input ?? {},
          timeoutMs: 120_000,
          signal,
        });
        if (r.run_id) {
          S().upsertWidget({ id: `mission-${r.run_id}`, type: "mission", title: `Mission · ${String(input.name)}`, size: "lg", props: { run_id: r.run_id, initial: r } });
        }
        return ok(r);
      }
      case "resume_mission":
        return ok(await ghost(`/missions/runs/${encodeURIComponent(String(input.run_id))}/resume`, { body: input.data ?? {}, timeoutMs: 120_000 }));

      default:
        return fail(`Unknown tool ${name}`);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 503) return fail(`${err.message} (this integration is not configured on this server)`);
      if (err.status === 404) return fail(`Not available: ${err.message}`);
      return fail(`${err.status}: ${err.message}`);
    }
    if (err instanceof Error && err.name === "AbortError") return fail("Timed out or cancelled.");
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (name === "invoke_capability" || name === "observe_web_page") {
      const p = S().possess;
      if (p && !p.widgetId) S().set({ possess: { ...p, until: Math.min(p.until, Date.now() + 800) } });
    }
  }
}
