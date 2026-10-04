"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import {
  Camera,
  Cctv,
  Cpu,
  ExternalLink,
  Gauge,
  Lightbulb,
  Mic,
  Plug,
  Radio,
  Smartphone,
  Speaker,
  Thermometer,
  Waves,
  Bot,
  Printer,
  Monitor,
  Watch,
  Tv,
  Box,
  CheckCircle2,
  CircleDashed,
  XCircle,
  Loader2,
} from "lucide-react";
import type { CapabilityHit, DeviceClass, Lease, Observation, Offer } from "@/lib/ghost/contracts";
import { useGhost } from "@/lib/store";
import type { WidgetComponentProps } from "../types";
import { Badge } from "../WidgetFrame";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export const CLASS_ICON: Record<DeviceClass | string, typeof Camera> = {
  phone: Smartphone,
  computer: Monitor,
  camera: Cctv,
  microphone: Mic,
  light: Lightbulb,
  plug: Plug,
  switch: Plug,
  sensor: Thermometer,
  actuator: Cpu,
  speaker: Speaker,
  display: Monitor,
  robot: Bot,
  printer: Printer,
  instrument: Waves,
  wearable: Watch,
  media: Tv,
  hub: Radio,
  other: Box,
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const money = (c: number) => (c === 0 ? "Free" : `$${(c / 100).toFixed(2)}`);

/* ------------------------------------------------------------------ */
/* note                                                                */
/* ------------------------------------------------------------------ */

export function NoteWidget({ props }: WidgetComponentProps<{ markdown?: string; text?: string }>) {
  const md = props.markdown ?? props.text ?? "";
  return (
    <div className="ghost-scroll max-h-[420px] overflow-auto text-[13.5px] leading-relaxed text-ivory-dim [&_a]:text-mint [&_a]:underline-offset-2 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-ink-4 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:font-display [&_h1]:text-base [&_h1]:text-ivory [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:font-display [&_h2]:text-sm [&_h2]:text-ivory [&_h3]:mt-2 [&_h3]:font-semibold [&_h3]:text-ivory [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_strong]:text-ivory [&_table]:w-full [&_table]:text-left [&_td]:border-t [&_td]:border-line [&_td]:py-1 [&_th]:hud-label [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* image (observation evidence)                                        */
/* ------------------------------------------------------------------ */

export function ImageWidget({ props }: WidgetComponentProps<{ observation?: Observation; observation_id?: string; url?: string; caption?: string }>) {
  const now = useNow(1000);
  const [zoom, setZoom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const obs = props.observation;
  const src = obs?.media_url ?? (props.observation_id ? `/api/v1/observations/${props.observation_id}/media` : props.url);
  const captured = ago(obs?.captured_at, now);
  const operatorUpdated = (obs?.data?.operator_updated_at as string | undefined) ?? null;
  return (
    <div className="flex flex-col gap-2.5">
      <button
        onClick={() => setZoom(true)}
        className="relative overflow-hidden rounded-2xl border border-line bg-ink-3"
        aria-label="Enlarge image"
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={props.caption ?? obs?.note ?? "Observation"}
            onLoad={() => setLoaded(true)}
            className={clsx("max-h-[360px] w-full object-cover transition duration-700", loaded ? "opacity-100 blur-0" : "opacity-0 blur-md")}
          />
        ) : (
          <div className="grid h-40 place-items-center text-mute">No image</div>
        )}
        {/* scanline sweep on arrival */}
        {loaded && (
          <motion.div
            initial={{ y: "-100%" }}
            animate={{ y: "120%" }}
            transition={{ duration: 1.1, ease: "easeInOut" }}
            className="pointer-events-none absolute inset-x-0 h-16 bg-gradient-to-b from-transparent via-mint-glow/30 to-transparent"
          />
        )}
        <div className="absolute left-2.5 top-2.5 flex gap-1.5">
          <Badge tone={obs?.cached ? "amber" : "mint"}>{obs?.cached ? "cached" : "new observation"}</Badge>
        </div>
      </button>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
        <dt className="text-mute">captured</dt>
        <dd className="text-right text-ivory-dim">{captured ?? (operatorUpdated ? `operator updated ${ago(operatorUpdated, now)}` : "unknown")}</dd>
        {obs?.source?.name && (
          <>
            <dt className="text-mute">source</dt>
            <dd className="truncate text-right text-ivory-dim">{obs.source.name}</dd>
          </>
        )}
      </dl>
      {(props.caption || obs?.note) && <p className="text-[12px] leading-snug text-mute">{props.caption ?? obs?.note}</p>}
      <AnimatePresence>
        {zoom && src && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setZoom(false)}
            className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-ink/90 p-6 backdrop-blur"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <motion.img initial={{ scale: 0.9 }} animate={{ scale: 1 }} src={src} alt="" className="max-h-full max-w-full rounded-2xl" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* metric                                                              */
/* ------------------------------------------------------------------ */

export function MetricWidget({
  props,
}: WidgetComponentProps<{ label?: string; value?: number | string | boolean | null; unit?: string; sublabel?: string; observed_at?: string | null; source?: string; note?: string; trend?: number[]; data?: Record<string, unknown> }>) {
  const now = useNow(1000);
  const v = props.value;
  const display = typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 10 ? 2 : 1)) : v === true ? "On" : v === false ? "Off" : (v ?? "—");
  const trend = props.trend?.filter((n) => Number.isFinite(n)) ?? [];
  const path = useMemo(() => {
    if (trend.length < 2) return null;
    const min = Math.min(...trend);
    const max = Math.max(...trend);
    const span = max - min || 1;
    return trend.map((n, i) => `${i === 0 ? "M" : "L"}${(i / (trend.length - 1)) * 100} ${28 - ((n - min) / span) * 24}`).join(" ");
  }, [trend]);
  const quality = props.data?.quality as string | undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="hud-label">{props.label}</div>
      <div className="flex items-baseline gap-1.5">
        <motion.span key={String(display)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="font-display text-4xl font-semibold tracking-tight text-ivory">
          {display}
        </motion.span>
        {props.unit && <span className="font-mono text-sm text-mute">{props.unit}</span>}
      </div>
      {path && (
        <svg viewBox="0 0 100 30" className="h-8 w-full" preserveAspectRatio="none" aria-hidden>
          <path d={path} fill="none" stroke="#0f766e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-mute">
        {props.observed_at !== undefined && <span>measured {ago(props.observed_at, now) ?? "at unknown time"}</span>}
        {props.source && <span className="truncate">{props.source}</span>}
        {quality && <span>quality {quality === "p" ? "preliminary" : quality}</span>}
      </div>
      {props.note && <p className="mt-1 text-[11.5px] leading-snug text-mute">{props.note}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* device list                                                         */
/* ------------------------------------------------------------------ */

const ACCESS: Record<string, { label: string; tone: "mint" | "amber" | "violet" | "mute" }> = {
  public_observation: { label: "Public", tone: "violet" },
  own_device: { label: "Yours", tone: "mint" },
  owner_shared: { label: "Shared", tone: "amber" },
  provider_booked: { label: "Booked", tone: "amber" },
};

export function DeviceListWidget({ props, emit }: WidgetComponentProps<{ hits?: CapabilityHit[] }>) {
  const devices = useGhost((s) => s.devices);
  const hits = props.hits ?? [];
  return (
    <div className="ghost-scroll grid max-h-[460px] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2">
      {hits.map((h, i) => {
        const live = devices[h.device.device_id];
        const online = live?.online ?? h.device.online;
        const Icon = CLASS_ICON[h.device.device_class] ?? Box;
        const access = ACCESS[h.device.access_type] ?? ACCESS.owner_shared;
        return (
          <motion.button
            key={h.ref}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.035 }}
            onClick={() => emit(`User selected ${h.device.name} (${h.ref})`)}
            className="group/card flex items-start gap-3 rounded-2xl border border-line bg-ink-3/70 p-3 text-left transition hover:border-line-strong hover:bg-ink-4/70"
          >
            <span className={clsx("relative grid h-9 w-9 shrink-0 place-items-center rounded-xl", online ? "bg-mint/10 text-mint" : "bg-ink-4 text-mute")}>
              <Icon size={17} />
              <span className={clsx("absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-3", online ? "bg-mint" : "bg-mute")} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ivory">{h.device.name}</span>
              <span className="block truncate text-[11.5px] text-ivory-dim">{h.capability.title}</span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge tone={access.tone}>{access.label}</Badge>
                <span className="font-mono text-[10.5px] text-ivory-dim">{money(h.terms.price_cents)}</span>
                <span className="font-mono text-[10.5px] text-mute">{online ? "online" : "offline"}</span>
                {h.distance_km !== undefined && <span className="font-mono text-[10.5px] text-mute">{h.distance_km.toFixed(1)} km</span>}
              </span>
            </span>
          </motion.button>
        );
      })}
      {!hits.length && <p className="text-sm text-mute">Nothing matched.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* lease / offer                                                       */
/* ------------------------------------------------------------------ */

export function LeaseWidget({ props, report }: WidgetComponentProps<{ offer?: Offer; lease?: Lease; host_message?: string }>) {
  const now = useNow(250);
  const liveLease = useGhost((s) => (props.lease ? s.leases[props.lease.lease_id] : undefined));
  const lease = liveLease ?? props.lease;
  const offer = props.offer;
  const devices = useGhost((s) => s.devices);
  const [busy, setBusy] = useState(false);

  const state = lease?.state ?? (offer ? (offer.status === "open" ? "offer" : offer.status) : "unknown");
  const ends = lease?.ends_at ? new Date(lease.ends_at).getTime() : null;
  const starts = lease?.starts_at ? new Date(lease.starts_at).getTime() : null;
  const remaining = ends ? Math.max(0, ends - now) : null;
  const total = ends && starts ? ends - starts : null;
  const frac = remaining !== null && total ? remaining / total : 0;
  const refs = lease?.refs ?? offer?.refs ?? [];
  const price = lease?.price_cents ?? offer?.price_cents ?? 0;

  useEffect(() => {
    report({ state, remaining_s: remaining !== null ? Math.round(remaining / 1000) : null, lease_id: lease?.lease_id, offer_id: offer?.offer_id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, lease?.lease_id, offer?.offer_id, remaining !== null ? Math.round(remaining / 5000) : null]);

  const tone = state === "active" ? "mint" : state === "offer" || state === "reserved" || state === "payment_pending" || state === "countered" ? "amber" : state === "revoked" || state === "failed" || state === "rejected" ? "coral" : "mute";
  const labels: Record<string, string> = {
    offer: "Review offer",
    countered: "Counteroffer",
    reserved: "Reserved",
    payment_pending: "Payment pending",
    active: "Lease active",
    released: "Released",
    expired: "Expired",
    revoked: "Access stopped",
    failed: "Failed",
    rejected: "Rejected",
    accepted: "Accepted",
  };

  const release = async () => {
    if (!lease) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/leases/${lease.lease_id}/release`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => null);
      if (j?.lease) useGhost.getState().set({ leases: { ...useGhost.getState().leases, [j.lease.lease_id]: j.lease } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <div className="relative h-16 w-16 shrink-0">
          <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
            <circle cx="32" cy="32" r="27" fill="none" stroke="rgb(15 23 42 / 0.08)" strokeWidth="5" />
            <motion.circle
              cx="32"
              cy="32"
              r="27"
              fill="none"
              stroke={tone === "mint" ? "#0f766e" : tone === "amber" ? "#d97706" : tone === "coral" ? "#c8282d" : "#5b6475"}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 27}
              animate={{ strokeDashoffset: 2 * Math.PI * 27 * (1 - (state === "active" ? frac : state === "offer" ? 1 : 0)) }}
              transition={{ duration: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center font-mono text-[11px] text-ivory">
            {remaining !== null && state === "active" ? `${Math.ceil(remaining / 1000)}s` : money(price)}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <Badge tone={tone as "mint"} pulse={state === "active"}>
            {labels[state] ?? state}
          </Badge>
          <div className="mt-1.5 font-display text-xl font-semibold text-ivory">{money(price)}</div>
          <div className="font-mono text-[10.5px] text-mute">
            {offer ? `${offer.duration_s}s` : total ? `${Math.round(total / 1000)}s` : ""}
            {(lease?.quota ?? offer?.quota) ? ` · ${lease ? `${lease.used}/` : ""}${lease?.quota ?? offer?.quota} uses` : ""}
          </div>
        </div>
      </div>

      <ul className="flex flex-col gap-1">
        {refs.map((r) => (
          <li key={`${r.device_id}/${r.capability_id}`} className="flex items-center gap-2 rounded-xl bg-ink-3/70 px-2.5 py-1.5 text-[12px]">
            <span className="truncate text-ivory-dim">{devices[r.device_id]?.name ?? r.device_id}</span>
            <span className="ml-auto font-mono text-[10.5px] text-mute">{r.capability_id}</span>
          </li>
        ))}
      </ul>

      {props.host_message && !lease && (
        <p className="rounded-2xl rounded-tl-sm border border-line bg-ink-3/60 px-3 py-2 text-[12.5px] leading-snug text-ivory-dim">
          <span className="hud-label mr-1.5">host</span>
          {props.host_message}
        </p>
      )}

      {lease?.payment && (
        <div className="flex items-center justify-between rounded-xl border border-dashed border-line-strong px-3 py-2 font-mono text-[10.5px]">
          <span className="text-amber">Test payment</span>
          <span className="text-ivory-dim">{money(lease.payment.amount_cents)}</span>
          <span className="max-w-[45%] truncate text-mute" title={lease.payment.label}>
            {lease.payment.label}
          </span>
        </div>
      )}

      {lease && state === "active" && (
        <button
          onClick={release}
          disabled={busy}
          className="rounded-xl border border-coral/40 bg-coral/10 px-3 py-2 text-[12px] font-medium text-coral transition hover:bg-coral/20 disabled:opacity-50"
        >
          Release device
        </button>
      )}
      {lease?.reason && state !== "active" && <p className="font-mono text-[10.5px] text-mute">{lease.reason}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* web view (e.g. Kernel live browser)                                 */
/* ------------------------------------------------------------------ */

export function WebViewWidget({ props }: WidgetComponentProps<{ url?: string; title?: string }>) {
  if (!props.url || !/^https:\/\//.test(props.url)) return <p className="text-sm text-mute">No live view URL.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-2xl border border-line bg-ink-3">
        <iframe src={props.url} title={props.title ?? "Live view"} className="aspect-video w-full" sandbox="allow-scripts allow-same-origin" allow="autoplay" />
      </div>
      <a href={props.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-end font-mono text-[10.5px] text-mute hover:text-ivory">
        open <ExternalLink size={11} />
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* results (Exa)                                                       */
/* ------------------------------------------------------------------ */

export function ResultsWidget({ props }: WidgetComponentProps<{ items?: { title: string; url?: string; snippet?: string }[] }>) {
  return (
    <ul className="ghost-scroll flex max-h-[380px] flex-col gap-2 overflow-auto pr-1">
      {(props.items ?? []).map((it, i) => (
        <motion.li key={it.url ?? i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="rounded-xl border border-line bg-ink-3/60 p-2.5">
          <a href={it.url} target="_blank" rel="noreferrer" className="block text-[12.5px] font-medium text-ivory hover:text-mint">
            {it.title}
          </a>
          {it.url && <div className="truncate font-mono text-[10px] text-mute">{it.url.replace(/^https?:\/\//, "")}</div>}
          {it.snippet && <p className="mt-1 line-clamp-2 text-[11.5px] text-ivory-dim">{it.snippet}</p>}
        </motion.li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* mission (Mastra workflow run)                                       */
/* ------------------------------------------------------------------ */

interface MissionStep {
  id: string;
  status: string;
  title?: string;
  output?: unknown;
  error?: string;
}

export function MissionWidget({ props, report }: WidgetComponentProps<{ run_id?: string; initial?: Record<string, unknown> }>) {
  const [run, setRun] = useState<Record<string, unknown> | null>(props.initial ?? null);
  useEffect(() => {
    if (!props.run_id) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/v1/missions/runs/${props.run_id}`, { credentials: "include" });
        if (r.ok) {
          const j = await r.json();
          if (alive) setRun(j);
        }
      } catch {
        /* keep last */
      }
    };
    void poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [props.run_id]);

  const status = String(run?.status ?? "running");
  useEffect(() => {
    report({ status, run_id: props.run_id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const steps = (Array.isArray(run?.steps) ? (run?.steps as MissionStep[]) : []) as MissionStep[];
  const icon = (s: string) =>
    s === "success" || s === "succeeded" || s === "done" ? (
      <CheckCircle2 size={14} className="text-mint" />
    ) : s === "failed" || s === "error" ? (
      <XCircle size={14} className="text-coral" />
    ) : s === "running" ? (
      <Loader2 size={14} className="animate-spin text-violet" />
    ) : s === "suspended" ? (
      <Gauge size={14} className="text-amber" />
    ) : (
      <CircleDashed size={14} className="text-mute" />
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge tone={status === "success" ? "mint" : status === "failed" ? "coral" : status === "suspended" ? "amber" : "violet"} pulse={status === "running"}>
          {status === "suspended" ? "waiting for verdict" : status}
        </Badge>
        <span className="font-mono text-[10px] text-mute">Mastra workflow</span>
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded-lg bg-ink-3/60 px-2.5 py-1.5 text-[12px] text-ivory-dim">
            {icon(s.status)}
            <span className="truncate">{s.title ?? s.id}</span>
            {s.error && <span className="ml-auto truncate font-mono text-[10px] text-coral">{s.error}</span>}
          </li>
        ))}
        {!steps.length && <li className="font-mono text-[11px] text-mute">{props.run_id ? `run ${props.run_id}` : "starting…"}</li>}
      </ol>
    </div>
  );
}

export { Camera };
