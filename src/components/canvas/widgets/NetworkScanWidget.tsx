"use client";
/**
 * NetworkScanWidget — "Polty, what's on my network?"
 * POSTs /api/v1/lan/scan, then draws what answered as blips on a radar (mint = controllable,
 * amber = needs pairing, mute = seen but unsupported) with a list underneath.
 * Props: { autoScan?: boolean; scanKey?: string | number }  (changing scanKey triggers a new scan)
 */
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import {
  Activity,
  Airplay,
  AppWindow,
  Battery,
  Blinds,
  Camera,
  Cast,
  CircleQuestionMark,
  Cpu,
  DoorOpen,
  Droplets,
  Fan,
  Gauge,
  Globe,
  House,
  LampDesk,
  Laptop,
  Lightbulb,
  LoaderCircle,
  Lock,
  Plug,
  Power,
  Printer,
  Radar,
  Radio,
  RefreshCw,
  Router,
  Speaker,
  Sun,
  Thermometer,
  ToggleRight,
  TriangleAlert,
  Tv,
  Wifi,
  Wind,
  Zap,
} from "lucide";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Device } from "@/lib/ghost/contracts";
import { apiOrigin, getMe } from "@/lib/connector/http";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { duration, ease, spring } from "@/components/ui/motion";
import type { WidgetComponentProps } from "../types";
import { EmptyState, SkeletonRows } from "./services/EmptyState";

type Props = { autoScan?: boolean; scanKey?: string | number };

/** Mirrors LanScanResponse in src/lib/ghost/server/routes/lan.ts (kept local: client bundle). */
interface ScanResponse {
  devices: Device[];
  found: number;
  verified: number;
  candidates: number;
  skipped_personal?: number;
  duration_ms: number;
  interfaces: { name: string; address: string; cidr: string | null; family: string }[];
  sources: Record<string, number>;
  errors: string[];
  note?: string;
  scanned_at: string;
  cached?: boolean;
}

type Tier = "ready" | "pair" | "seen";

const ICONS: Record<string, IconNode> = {
  lightbulb: Lightbulb,
  plug: Plug,
  power: Power,
  tv: Tv,
  router: Router,
  camera: Camera,
  speaker: Speaker,
  fan: Fan,
  thermometer: Thermometer,
  printer: Printer,
  cast: Cast,
  airplay: Airplay,
  house: House,
  cpu: Cpu,
  globe: Globe,
  "lamp-desk": LampDesk,
  "toggle-right": ToggleRight,
  blinds: Blinds,
  lock: Lock,
  gauge: Gauge,
  activity: Activity,
  droplets: Droplets,
  zap: Zap,
  sun: Sun,
  battery: Battery,
  "door-open": DoorOpen,
  "app-window": AppWindow,
  wind: Wind,
  radar: Radar,
  radio: Radio,
};
const CLASS_ICONS: Partial<Record<Device["device_class"], IconNode>> = {
  light: Lightbulb,
  plug: Plug,
  switch: ToggleRight,
  camera: Camera,
  speaker: Speaker,
  media: Tv,
  display: Tv,
  printer: Printer,
  hub: Router,
  sensor: Gauge,
  actuator: Fan,
};

type Meta = { driver?: string; support?: string; ip?: string; entity_id?: string; reason?: string; instructions?: string };
const metaOf = (d: Device) => (d.meta ?? {}) as Meta;

function tierOf(d: Device): Tier {
  const m = metaOf(d);
  if (d.status !== "candidate" && m.support !== "needs_pairing" && m.support !== "unsupported") return "ready";
  if (m.support === "needs_pairing") return "pair";
  return "seen";
}

function iconOf(d: Device): IconNode {
  return (d.icon && ICONS[d.icon]) || CLASS_ICONS[d.device_class] || CircleQuestionMark;
}

/** Stable 32-bit hash (FNV-1a) → angle / radius jitter. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const TIER = {
  ready: { text: "text-mint", bg: "bg-mint", ring: "ring-mint/40", label: "Ready" },
  pair: { text: "text-amber", bg: "bg-amber", ring: "ring-amber/40", label: "Needs pairing" },
  seen: { text: "text-fg-3", bg: "bg-fg-3", ring: "ring-line-strong", label: "Unsupported" },
} as const;

/** Status mark: shape AND text, never color alone. */
function TierBadge({ tier, offline }: { tier: Tier; offline?: boolean }) {
  const t = TIER[tier];
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-label font-medium",
        tier === "ready" && "bg-mint/10 text-mint",
        tier === "pair" && "bg-amber/10 text-amber",
        tier === "seen" && "bg-tint text-fg-2",
      )}
    >
      {tier === "ready" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-mint" />}
      {tier === "pair" && (
        <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
          <path d="M4 0.5 L7.5 7.5 H0.5 Z" fill="currentColor" />
        </svg>
      )}
      {tier === "seen" && <span aria-hidden className="h-1.5 w-1.5 rounded-[1px] border border-current" />}
      {offline ? "Offline" : t.label}
    </span>
  );
}

const SOURCES = ["mDNS", "SSDP", "Kasa UDP", "HTTP probes"];

export default function NetworkScanWidget({ props, report, emit, focused }: WidgetComponentProps<Props>) {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const inflight = useRef(false);
  const lastKey = useRef<string | null>(null);
  const reportRef = useRef(report);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  const scan = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setScanning(true);
    setError(null);
    const t0 = performance.now();
    const tick = setInterval(() => setElapsed(performance.now() - t0), 100);
    try {
      const post = () =>
        fetch(`${apiOrigin()}/api/v1/lan/scan`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      let res = await post();
      if (res.status === 401) {
        await getMe(); // sets the session cookie, then retry once
        res = await post();
      }
      const body = (await res.json().catch(() => ({}))) as ScanResponse & { error?: string };
      if (!res.ok) throw new Error(body.error || `scan failed (HTTP ${res.status})`);
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(tick);
      setElapsed(performance.now() - t0);
      setScanning(false);
      inflight.current = false;
    }
  }, []);

  // autoScan on mount (and whenever scanKey changes). Guarded against StrictMode double-mount.
  useEffect(() => {
    if (!props.autoScan && props.scanKey === undefined) return;
    const key = `${props.autoScan}:${props.scanKey ?? ""}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    const t = setTimeout(() => void scan(), 0);
    return () => clearTimeout(t);
  }, [props.autoScan, props.scanKey, scan]);

  const devices = useMemo(() => {
    const order: Record<Tier, number> = { ready: 0, pair: 1, seen: 2 };
    return [...(result?.devices ?? [])].sort((a, b) => order[tierOf(a)] - order[tierOf(b)] || a.name.localeCompare(b.name));
  }, [result]);

  const counts = useMemo(() => {
    const c = { ready: 0, pair: 0, seen: 0 };
    for (const d of devices) c[tierOf(d)]++;
    return c;
  }, [devices]);

  // Structured state for canvas_read (changes rarely; effectively <= 1/s).
  useEffect(() => {
    reportRef.current({
      scanning,
      found: devices.length,
      verified: counts.ready,
      candidates: counts.pair + counts.seen,
      needs_pairing: counts.pair,
      skipped_personal: result?.skipped_personal ?? 0,
      error,
      note: result?.note ?? null,
      duration_ms: result?.duration_ms ?? null,
      devices: devices.map((d) => ({ device_id: d.device_id, name: d.name, status: d.status, tier: tierOf(d), driver: metaOf(d).driver ?? null, online: d.online })),
    });
  }, [scanning, devices, counts, error, result]);

  const select = (d: Device) => {
    setSelected(d.device_id);
    emit(`User selected ${d.name} (${d.device_id})`);
  };

  const blips = useMemo(
    () =>
      devices.map((d) => {
        const key = metaOf(d).ip ?? metaOf(d).entity_id ?? d.local_key;
        const h = hash(`${key}|${d.local_key}`);
        const tier = tierOf(d);
        const angle = (h % 3600) / 10; // degrees
        const band = tier === "ready" ? [0.36, 0.62] : tier === "pair" ? [0.55, 0.78] : [0.7, 0.88];
        const r = band[0] + ((h >>> 12) % 1000) / 1000 * (band[1] - band[0]);
        const rad = ((angle - 90) * Math.PI) / 180;
        return { d, tier, angle, x: 50 + Math.cos(rad) * r * 50, y: 50 + Math.sin(rad) * r * 50 };
      }),
    [devices],
  );
  const showAllLabels = blips.length <= 6;
  const empty = !scanning && !!result && devices.length === 0;

  const idle = !result && !scanning && !error;
  const showRadar = scanning || devices.length > 0;
  const EMPTY_NOTE = "No devices answered on this network. Venue Wi-Fi often isolates clients — try a phone hotspot or your home network.";

  if (idle) {
    return (
      <EmptyState
        illustration="radar"
        fallback={Radar}
        title="What's on your network?"
        subtitle="Scan this computer's local network for lights, plugs and hubs with documented local APIs."
        action={
          <button
            type="button"
            onClick={() => void scan()}
            className="inline-flex min-h-10 items-center gap-2 rounded-full bg-fg px-4 text-body-sm font-medium text-fg-inverse transition-opacity duration-150 ease-standard hover:opacity-90"
          >
            <Icon icon={Radar} size={15} /> Scan network
          </button>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* status row */}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2 text-body-sm text-fg-2">
          <Icon
            icon={scanning ? LoaderCircle : error && !result ? TriangleAlert : Wifi}
            size={15}
            spring="snappy"
            className={clsx("mt-0.5 shrink-0", scanning ? "animate-spin text-mint" : error && !result ? "text-coral" : "text-fg-3")}
          />
          {scanning ? (
            <span className="min-w-0">
              <span className="text-mint">Scanning</span> <span className="tabular-nums text-fg-3">{(elapsed / 1000).toFixed(1)}s</span>
              <span className="hidden text-fg-3 sm:inline"> · {SOURCES.join(" · ")}</span>
            </span>
          ) : result ? (
            <span className="min-w-0">
              <span className="text-fg">{devices.length} found</span> · <span className="text-mint">{counts.ready} ready</span>
              {counts.pair ? (
                <>
                  {" "}
                  · <span className="text-amber">{counts.pair} need pairing</span>
                </>
              ) : null}
              {counts.seen ? <> · {counts.seen} unsupported</> : null}
              <span className="tabular-nums text-fg-3"> · {(result.duration_ms / 1000).toFixed(1)}s</span>
              {result.cached && <span className="text-fg-3"> · cached</span>}
            </span>
          ) : (
            <span className="min-w-0 text-fg-3">No results yet</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning}
          className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full bg-tint px-3.5 text-caption font-medium text-fg-2 transition-colors duration-150 ease-standard enabled:hover:bg-line-strong enabled:hover:text-fg disabled:cursor-wait disabled:opacity-60"
        >
          <Icon icon={RefreshCw} size={14} className={clsx(scanning && "animate-spin")} />
          {error && !scanning ? "Try again" : result || error ? "Rescan" : "Scan"}
        </button>
      </div>

      {/* radar */}
      {showRadar && (
        <div className="relative mx-auto aspect-square w-full max-w-[260px] shrink-0 select-none">
          <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full text-mint-glow" aria-hidden>
            <circle cx="100" cy="100" r="97" fill="currentColor" fillOpacity="0.07" className="stroke-line-strong" strokeWidth="0.8" />
            {[34, 66].map((r) => (
              <circle key={r} cx="100" cy="100" r={r} fill="none" className="stroke-line" strokeWidth="0.8" />
            ))}
          </svg>

          {/* rotating sweep: fading conic wedge + leading edge */}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-[1.5%] rounded-full transition-opacity duration-300 ease-standard"
            style={{
              background:
                "conic-gradient(from 0deg, transparent 0deg 290deg, color-mix(in oklab, var(--color-mint-glow) 10%, transparent) 320deg, color-mix(in oklab, var(--color-mint) 26%, transparent) 359deg, transparent 360deg)",
              opacity: scanning ? 1 : 0.5,
            }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, ease: "linear", duration: scanning ? 2.4 : 7 }}
          >
            <span className="absolute left-1/2 top-0 h-1/2 w-px -translate-x-1/2 bg-linear-to-t from-mint/0 via-mint/30 to-mint/70" />
          </motion.div>

          {/* this computer */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <span className="absolute inset-0 -m-1 animate-pulse-ring rounded-full border border-mint/40" aria-hidden />
            <span className="grid h-8 w-8 place-items-center rounded-full bg-surface text-fg-2 shadow-pop" title="This computer (GHOST coordinator)">
              <Icon icon={Laptop} size={14} />
            </span>
          </div>

          {/* blips */}
          <AnimatePresence>
            {blips.map(({ d, tier, angle, x, y }) => {
              const glyph = iconOf(d);
              const t = TIER[tier];
              const active = selected === d.device_id || hovered === d.device_id;
              return (
                <motion.button
                  key={d.device_id}
                  type="button"
                  onClick={() => select(d)}
                  onMouseEnter={() => setHovered(d.device_id)}
                  onMouseLeave={() => setHovered((h) => (h === d.device_id ? null : h))}
                  aria-label={`${d.name} — ${t.label}`}
                  className="group absolute z-10 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none"
                  style={{ left: `${x}%`, top: `${y}%` }}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ ...spring.snappy, delay: (angle / 360) * 0.9 }}
                >
                  <span
                    className={clsx(
                      "relative grid h-7 w-7 place-items-center rounded-full bg-surface shadow-pop ring-1 transition-transform duration-150 ease-standard",
                      t.text,
                      t.ring,
                      active && "scale-125",
                      !d.online && "opacity-50",
                      "group-focus-visible:ring-2 group-focus-visible:ring-mint/60",
                    )}
                  >
                    {tier === "ready" && <span aria-hidden className="absolute inset-0 animate-pulse-ring rounded-full border border-mint/50" />}
                    <Icon icon={glyph} size={13} />
                  </span>
                  {(showAllLabels || active) && (
                    <span className="pointer-events-none absolute left-1/2 top-[calc(100%-4px)] max-w-[96px] -translate-x-1/2 truncate whitespace-nowrap rounded-full bg-surface px-1.5 py-px text-micro text-fg-2 shadow-pop">
                      {d.name}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </AnimatePresence>

          {/* legend */}
          <div className="pointer-events-none absolute bottom-0 right-0 flex flex-col items-end gap-1 text-micro text-fg-3">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-mint" /> Ready
            </span>
            <span className="flex items-center gap-1">
              <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden className="text-amber">
                <path d="M4 0.5 L7.5 7.5 H0.5 Z" fill="currentColor" />
              </svg>
              Pair
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-[1px] border border-current" /> Seen
            </span>
          </div>
        </div>
      )}

      {/* error / empty / loading */}
      {error && (
        <div className="flex items-start gap-2 rounded-tile bg-coral/10 px-3 py-2.5 text-body-sm text-coral" role="alert">
          <Icon icon={TriangleAlert} size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">Scan failed: {error}</span>
        </div>
      )}
      {empty && (
        <EmptyState
          illustration="router"
          fallback={Router}
          title="No devices answered"
          subtitle={
            <>
              Venue Wi-Fi often isolates clients — try a phone hotspot or your home network.
              {result?.note && result.note !== EMPTY_NOTE && <span className="mt-1 block text-caption">{result.note}</span>}
            </>
          }
          className="py-2"
        />
      )}
      {scanning && devices.length === 0 && <SkeletonRows rows={3} />}

      {/* device list */}
      {devices.length > 0 && (
        <ul className="ghost-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto" aria-label="Devices found on the local network">
          {devices.map((d, i) => {
            const m = metaOf(d);
            const tier = tierOf(d);
            const glyph = iconOf(d);
            const active = selected === d.device_id;
            return (
              <motion.li key={d.device_id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.04, duration: duration.base, ease: ease.standard }}>
                <button
                  type="button"
                  onClick={() => select(d)}
                  onMouseEnter={() => setHovered(d.device_id)}
                  onMouseLeave={() => setHovered((h) => (h === d.device_id ? null : h))}
                  title={m.reason ? `${m.reason}${m.instructions ? `\n${m.instructions}` : ""}` : undefined}
                  className={clsx(
                    "flex w-full min-w-0 items-center gap-3 rounded-tile px-3 py-2.5 text-left transition-colors duration-150 ease-standard",
                    active ? "bg-mint/10" : "hover:bg-tint",
                    focused && active && "ring-1 ring-mint/30",
                  )}
                >
                  <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full bg-tint", TIER[tier].text)}>
                    <Icon icon={glyph} size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-fg">{d.name}</span>
                    <span className="block truncate text-caption text-fg-3">
                      {[d.vendor, d.model].filter(Boolean).join(" · ") || d.device_class}
                      {tier !== "ready" && m.reason ? ` — ${m.reason}` : ""}
                    </span>
                  </span>
                  <span className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
                    <span className="font-mono text-caption text-fg-2">{m.ip ?? m.entity_id ?? "—"}</span>
                    <span className="text-label text-fg-3">{m.driver ?? "—"}</span>
                  </span>
                  <TierBadge tier={tier} offline={!d.online} />
                </button>
              </motion.li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export { NetworkScanWidget };
