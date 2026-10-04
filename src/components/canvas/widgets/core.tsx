"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
// Icon *data* from "lucide" (drawn by the morphing <Icon />), not lucide-react components.
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
  WavesHorizontal,
  Bot,
  Printer,
  Monitor,
  Watch,
  Tv,
  Box,
  CircleCheck,
  CircleDashed,
  CircleX,
  Globe,
  ImageOff,
  KeyRound,
  LoaderCircle,
  NotebookText,
  Satellite,
  Search,
} from "lucide";
import type { CapabilityHit, DeviceClass, Lease, Observation, Offer } from "@/lib/ghost/contracts";
import { useGhost } from "@/lib/store";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
import { duration, ease, spring } from "@/components/ui/motion";
import type { WidgetComponentProps } from "../types";
import { Badge } from "../WidgetFrame";
import { EmptyState, SkeletonRows } from "./services/EmptyState";
import { stagger } from "./services/styles";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export const CLASS_ICON: Record<DeviceClass | string, IconNode> = {
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
  instrument: WavesHorizontal,
  wearable: Watch,
  media: Tv,
  hub: Radio,
  other: Box,
};

/** false during SSR and hydration, true on the client: gates portals to document.body. */
const useIsClient = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

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

/** "payment_pending" → "Payment pending" (display only). */
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : s);

/* ------------------------------------------------------------------ */
/* note                                                                */
/* ------------------------------------------------------------------ */

export function NoteWidget({ props }: WidgetComponentProps<{ markdown?: string; text?: string }>) {
  const md = props.markdown ?? props.text ?? "";
  if (!md.trim()) return <EmptyState illustration="notebook" fallback={NotebookText} title="Nothing here yet" subtitle="This note is empty." />;
  return (
    <div className="ghost-scroll max-h-[420px] overflow-auto text-body text-fg-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:text-mint [&_a]:underline-offset-2 hover:[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:font-serif [&_blockquote]:text-fg [&_code]:rounded-md [&_code]:bg-tint [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mb-2 [&_h1]:font-serif [&_h1]:text-heading [&_h1]:text-fg [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:font-serif [&_h2]:text-body-lg [&_h2]:text-fg [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-medium [&_h3]:text-fg [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-tile [&_pre]:bg-tint [&_pre]:p-3 [&_strong]:font-semibold [&_strong]:text-fg [&_table]:w-full [&_table]:text-left [&_table]:text-body-sm [&_td]:border-t [&_td]:border-line [&_td]:py-1.5 [&_td]:pr-3 [&_th]:pb-1.5 [&_th]:pr-3 [&_th]:text-caption [&_th]:font-medium [&_th]:text-fg-3 [&_ul]:list-disc [&_ul]:pl-5">
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
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const isClient = useIsClient();
  const obs = props.observation;
  const src = obs?.media_url ?? (props.observation_id ? `/api/v1/observations/${props.observation_id}/media` : props.url);
  const failed = !!src && failedSrc === src;
  const captured = ago(obs?.captured_at, now);
  const operatorUpdated = (obs?.data?.operator_updated_at as string | undefined) ?? null;
  return (
    <div className="flex flex-col gap-3">
      {src && !failed ? (
        <button
          onClick={() => setZoom(true)}
          className="relative block w-full cursor-zoom-in overflow-hidden rounded-tile bg-surface-2 text-left"
          aria-label="Enlarge image"
        >
          {!loaded && <div aria-hidden className="ghost-skeleton aspect-video w-full" />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={props.caption ?? obs?.note ?? "Observation"}
            onLoad={() => setLoaded(true)}
            onError={() => setFailedSrc(src)}
            className={clsx(
              "max-h-[360px] w-full object-cover transition-[opacity,filter] duration-300 ease-standard",
              loaded ? "opacity-100 blur-0" : "absolute inset-0 h-full opacity-0 blur-md",
            )}
          />
          <span className="absolute left-2.5 top-2.5 flex gap-1.5">
            <Badge tone={obs?.cached ? "amber" : "mint"}>{obs?.cached ? "Cached" : "New observation"}</Badge>
          </span>
        </button>
      ) : (
        <div className="rounded-tile bg-surface-2">
          <EmptyState
            illustration="camera"
            fallback={ImageOff}
            size={48}
            title={failed ? "Couldn't load the image" : "No image yet"}
            subtitle={failed ? "The snapshot didn't arrive. Ask Polty to look again." : "Polty hasn't captured anything here."}
            tone={failed ? "error" : "neutral"}
          />
        </div>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
        <dt className="text-fg-3">Captured</dt>
        <dd className="text-right tabular-nums text-fg-2">{captured ?? (operatorUpdated ? `operator updated ${ago(operatorUpdated, now)}` : "unknown")}</dd>
        {obs?.source?.name && (
          <>
            <dt className="text-fg-3">Source</dt>
            <dd className="truncate text-right text-fg-2">{obs.source.name}</dd>
          </>
        )}
      </dl>
      {(props.caption || obs?.note) && <p className="text-body-sm text-fg-2">{props.caption ?? obs?.note}</p>}
      {/* Portaled to <body>: widgets sit in a transformed (pannable) canvas, where `fixed` would be
          relative to the moving container instead of the viewport. data-no-pan because React events
          still bubble to the canvas through the portal. */}
      {isClient &&
        createPortal(
          <AnimatePresence>
            {zoom && src && !failed && (
              <motion.div
                data-no-pan
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: duration.fast, ease: ease.standard } }}
                transition={{ duration: duration.base, ease: ease.standard }}
                onClick={() => setZoom(false)}
                className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-scrim p-4 backdrop-blur-md sm:p-8"
              >
                <motion.img
                  initial={{ scale: 0.94, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={spring.gentle}
                  src={src}
                  alt=""
                  className="max-h-full max-w-full rounded-card shadow-float"
                />
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
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
  const long = String(display).length > 9;
  return (
    <div className="flex flex-col gap-2">
      {props.label && <div className="text-body-sm text-fg-3">{props.label}</div>}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className={clsx("min-w-0 break-words font-display tabular-nums text-fg", long ? "text-title" : "text-display leading-none")}>{display}</span>
        {props.unit && <span className="text-body-lg text-fg-3">{props.unit}</span>}
      </div>
      {path && (
        <svg viewBox="0 0 100 30" className="h-8 w-full text-mint" preserveAspectRatio="none" aria-hidden>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-3">
        {props.observed_at !== undefined && <span className="tabular-nums">Measured {ago(props.observed_at, now) ?? "at an unknown time"}</span>}
        {props.source && <span className="min-w-0 truncate">{props.source}</span>}
        {quality && <span>Quality {quality === "p" ? "preliminary" : quality}</span>}
      </div>
      {props.note && <p className="text-body-sm text-fg-3">{props.note}</p>}
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
  if (!hits.length) {
    return <EmptyState illustration="satellite" fallback={Satellite} title="Nothing matched" subtitle="No shared device can do that right now. Try a broader request or another place." />;
  }
  return (
    <div className="ghost-scroll grid max-h-[460px] grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
      {hits.map((h, i) => {
        const live = devices[h.device.device_id];
        const online = live?.online ?? h.device.online;
        const glyph = CLASS_ICON[h.device.device_class] ?? Box;
        const access = ACCESS[h.device.access_type] ?? ACCESS.owner_shared;
        return (
          <motion.button
            key={h.ref}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={stagger(i)}
            onClick={() => emit(`User selected ${h.device.name} (${h.ref})`)}
            className="flex min-w-0 items-start gap-3 rounded-tile bg-surface-2 p-3 text-left transition-[background-color,box-shadow] duration-150 ease-standard hover:bg-surface hover:shadow-pop"
          >
            <span className={clsx("relative grid h-10 w-10 shrink-0 place-items-center rounded-full", online ? "bg-mint/10 text-mint" : "bg-tint text-fg-3")}>
              <Icon icon={glyph} size={18} />
              <span className={clsx("absolute right-0 top-0 h-2.5 w-2.5 rounded-full ring-2 ring-page", online ? "bg-mint" : "bg-fg-3")} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium text-fg">{h.device.name}</span>
              <span className="block truncate text-body-sm text-fg-2">{h.capability.title}</span>
              <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone={access.tone}>{access.label}</Badge>
                <span className="font-serif text-body-sm tabular-nums text-fg">{money(h.terms.price_cents)}</span>
                <span className="text-caption text-fg-3">{online ? "Online" : "Offline"}</span>
                {h.distance_km !== undefined && <span className="text-caption tabular-nums text-fg-3">{h.distance_km.toFixed(1)} km</span>}
              </span>
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* lease / offer                                                       */
/* ------------------------------------------------------------------ */

const RING_STROKE = { mint: "stroke-mint", amber: "stroke-amber", coral: "stroke-coral", mute: "stroke-fg-3" } as const;

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

  const terms = [offer ? `${offer.duration_s}s` : total ? `${Math.round(total / 1000)}s` : "", (lease?.quota ?? offer?.quota) ? `${lease ? `${lease.used}/` : ""}${lease?.quota ?? offer?.quota} uses` : ""].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="relative h-16 w-16 shrink-0">
          <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden>
            <circle cx="32" cy="32" r="27" fill="none" className="stroke-line" strokeWidth="4" />
            <motion.circle
              cx="32"
              cy="32"
              r="27"
              fill="none"
              className={RING_STROKE[tone]}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 27}
              animate={{ strokeDashoffset: 2 * Math.PI * 27 * (1 - (state === "active" ? frac : state === "offer" ? 1 : 0)) }}
              transition={{ duration: 0.3, ease: "linear" }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            {remaining !== null && state === "active" ? (
              <span className="text-body-sm font-medium tabular-nums text-fg">{Math.ceil(remaining / 1000)}s</span>
            ) : (
              <Illustration name="key" size={32} fallback={KeyRound} />
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <Badge tone={tone as "mint"} pulse={state === "active"}>
            {labels[state] ?? sentence(state)}
          </Badge>
          <div className="font-serif text-title tabular-nums text-fg">{money(price)}</div>
          {terms && <div className="text-caption tabular-nums text-fg-3">{terms}</div>}
        </div>
      </div>

      {refs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {refs.map((r) => (
            <li key={`${r.device_id}/${r.capability_id}`} className="flex min-w-0 items-center gap-3 rounded-tile bg-surface-2 px-3 py-2 text-body-sm">
              <span className="min-w-0 truncate text-fg">{devices[r.device_id]?.name ?? r.device_id}</span>
              <span className="ml-auto min-w-0 shrink truncate font-mono text-caption text-fg-3">{r.capability_id}</span>
            </li>
          ))}
        </ul>
      )}

      {props.host_message && !lease && (
        <div className="rounded-tile rounded-tl-sm bg-surface-2 px-3.5 py-3">
          <p className="text-caption font-medium text-fg-3">Host</p>
          <p className="mt-0.5 font-serif text-body text-fg">{props.host_message}</p>
        </div>
      )}

      {lease?.payment && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-tile bg-amber/10 px-3 py-2 text-caption">
          <span className="font-medium text-amber">Test payment</span>
          <span className="tabular-nums text-fg-2">{money(lease.payment.amount_cents)}</span>
          <span className="min-w-0 flex-1 truncate text-right text-fg-3" title={lease.payment.label}>
            {lease.payment.label}
          </span>
        </div>
      )}

      {lease && state === "active" && (
        <button
          onClick={release}
          disabled={busy}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-coral/10 px-4 text-body-sm font-medium text-coral transition-colors duration-150 ease-standard hover:bg-coral/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Icon icon={LoaderCircle} size={15} className="animate-spin" />}
          Release device
        </button>
      )}
      {lease?.reason && state !== "active" && <p className={clsx("text-caption", tone === "coral" ? "text-coral" : "text-fg-3")}>{lease.reason}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* web view (e.g. Kernel live browser)                                 */
/* ------------------------------------------------------------------ */

export function WebViewWidget({ props }: WidgetComponentProps<{ url?: string; title?: string }>) {
  const [loaded, setLoaded] = useState(false);
  if (!props.url || !/^https:\/\//.test(props.url)) {
    return <EmptyState illustration="globe" fallback={Globe} title="No live view" subtitle="There's no secure page to show here yet." />;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-tile bg-surface-2">
        {!loaded && <div aria-hidden className="ghost-skeleton absolute inset-0" />}
        <iframe
          src={props.url}
          title={props.title ?? "Live view"}
          onLoad={() => setLoaded(true)}
          className="relative block aspect-video w-full"
          sandbox="allow-scripts allow-same-origin"
          allow="autoplay"
        />
      </div>
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-10 items-center gap-1.5 self-end rounded-full px-3 text-caption font-medium text-fg-2 transition-colors duration-150 ease-standard hover:bg-tint hover:text-fg"
      >
        Open in a new tab <Icon icon={ExternalLink} size={13} />
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* results (Exa)                                                       */
/* ------------------------------------------------------------------ */

export function ResultsWidget({ props }: WidgetComponentProps<{ items?: { title: string; url?: string; snippet?: string }[] }>) {
  const items = props.items ?? [];
  if (!items.length) return <EmptyState illustration="search" fallback={Search} title="No results" subtitle="Nothing came back for that search. Try different words." />;
  return (
    <ul className="ghost-scroll flex max-h-[380px] flex-col gap-0.5 overflow-auto">
      {items.map((it, i) => (
        <motion.li key={it.url ?? i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={stagger(i)}>
          <a
            href={it.url}
            target="_blank"
            rel="noreferrer"
            className="group/row block rounded-tile px-3 py-2.5 transition-colors duration-150 ease-standard hover:bg-tint"
          >
            <span className="block text-body font-medium text-fg transition-colors duration-150 group-hover/row:text-mint">{it.title}</span>
            {it.url && <span className="mt-0.5 block truncate text-caption text-fg-3">{it.url.replace(/^https?:\/\//, "")}</span>}
            {it.snippet && <span className="mt-1 line-clamp-2 block text-body-sm text-fg-2">{it.snippet}</span>}
          </a>
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

function stepGlyph(s: string): { icon: IconNode; className: string } {
  if (s === "success" || s === "succeeded" || s === "done") return { icon: CircleCheck, className: "text-mint" };
  if (s === "failed" || s === "error") return { icon: CircleX, className: "text-coral" };
  if (s === "running") return { icon: LoaderCircle, className: "animate-spin text-violet" };
  if (s === "suspended") return { icon: Gauge, className: "text-amber" };
  return { icon: CircleDashed, className: "text-fg-3" };
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status === "success" ? "mint" : status === "failed" ? "coral" : status === "suspended" ? "amber" : "violet"} pulse={status === "running"}>
          {status === "suspended" ? "Waiting for verdict" : sentence(status)}
        </Badge>
        <span className="text-caption text-fg-3">Mastra workflow</span>
      </div>
      {steps.length > 0 ? (
        <ol className="flex flex-col gap-0.5">
          {steps.map((s, i) => {
            const g = stepGlyph(s.status);
            return (
              <motion.li
                key={s.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={stagger(i)}
                className={clsx(
                  "flex min-w-0 items-center gap-2.5 rounded-tile px-3 py-2 text-body-sm",
                  s.status === "running" ? "bg-violet/10 text-fg" : "text-fg-2",
                )}
              >
                <Icon icon={g.icon} size={16} spring="snappy" className={clsx("shrink-0", g.className)} />
                <span className="min-w-0 truncate">{s.title ?? s.id}</span>
                {s.error && <span className="ml-auto min-w-0 max-w-[50%] truncate text-caption text-coral" title={s.error}>{s.error}</span>}
              </motion.li>
            );
          })}
        </ol>
      ) : (
        <div className="flex flex-col gap-2">
          {status === "running" && <SkeletonRows rows={3} rowClassName="h-9" />}
          <p className="text-caption text-fg-3">
            {props.run_id ? (
              <>
                Run <span className="font-mono">{props.run_id}</span>
              </>
            ) : (
              "Starting…"
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export { Camera };
