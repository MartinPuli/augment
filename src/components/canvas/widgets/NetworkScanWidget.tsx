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
  CircleHelp,
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
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Device } from "@/lib/ghost/contracts";
import { apiOrigin, getMe } from "@/lib/connector/http";
import type { WidgetComponentProps } from "../types";

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

const ICONS: Record<string, LucideIcon> = {
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
const CLASS_ICONS: Partial<Record<Device["device_class"], LucideIcon>> = {
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

function iconOf(d: Device): LucideIcon {
  return (d.icon && ICONS[d.icon]) || CLASS_ICONS[d.device_class] || CircleHelp;
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
  ready: { text: "text-mint", bg: "bg-mint", ring: "border-mint/50", label: "Ready", glow: "shadow-[0_0_12px_rgb(45_212_191/0.6)]" },
  pair: { text: "text-amber", bg: "bg-amber", ring: "border-amber/50", label: "Needs pairing", glow: "shadow-[0_0_12px_rgb(245_158_11/0.45)]" },
  seen: { text: "text-mute", bg: "bg-mute", ring: "border-line-strong", label: "Unsupported", glow: "" },
} as const;

/** Status mark: shape AND text, never color alone. */
function TierBadge({ tier, offline }: { tier: Tier; offline?: boolean }) {
  const t = TIER[tier];
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]",
        tier === "ready" && "border-mint/30 bg-mint/10 text-mint",
        tier === "pair" && "border-amber/30 bg-amber/10 text-amber",
        tier === "seen" && "border-line-strong bg-ink-4/60 text-ivory-dim",
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* status row */}
      <div className="flex items-center gap-2">
        <span className="hud-label flex min-w-0 flex-1 items-center gap-2 truncate">
          {scanning ? (
            <>
              <LoaderCircle size={11} className="animate-spin text-mint" aria-hidden />
              <span className="text-mint">Scanning</span>
              <span className="tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
              <span className="hidden truncate sm:inline">· {SOURCES.join(" · ")}</span>
            </>
          ) : result ? (
            <>
              <Wifi size={11} aria-hidden />
              <span>
                {devices.length} found · <span className="text-mint">{counts.ready} ready</span>
                {counts.pair ? (
                  <>
                    {" "}
                    · <span className="text-amber">{counts.pair} need pairing</span>
                  </>
                ) : null}
                {counts.seen ? <> · {counts.seen} unsupported</> : null}
              </span>
              <span className="tabular-nums">· {(result.duration_ms / 1000).toFixed(1)}s</span>
              {result.cached && <span>· cached</span>}
            </>
          ) : (
            <span>Local network radar · idle</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-ink-3 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ivory-dim transition hover:border-mint/40 hover:text-mint disabled:opacity-50"
        >
          <RefreshCw size={11} className={clsx(scanning && "animate-spin")} aria-hidden />
          {result || error ? "Rescan" : "Scan"}
        </button>
      </div>

      {/* radar */}
      <div className="relative mx-auto aspect-square w-full max-w-[290px] shrink-0 select-none">
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <radialGradient id="ghost-radar-bg" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgb(45 212 191 / 0.16)" />
              <stop offset="70%" stopColor="rgb(45 212 191 / 0.05)" />
              <stop offset="100%" stopColor="rgb(255 255 255 / 0)" />
            </radialGradient>
          </defs>
          <circle cx="100" cy="100" r="97" fill="url(#ghost-radar-bg)" stroke="rgb(15 23 42 / 0.14)" strokeWidth="0.8" />
          {[24, 48, 72].map((r) => (
            <circle key={r} cx="100" cy="100" r={r} fill="none" stroke="rgb(15 23 42 / 0.09)" strokeWidth="0.6" strokeDasharray={r === 72 ? "1.5 3" : undefined} />
          ))}
          <line x1="3" y1="100" x2="197" y2="100" stroke="rgb(15 23 42 / 0.07)" strokeWidth="0.6" />
          <line x1="100" y1="3" x2="100" y2="197" stroke="rgb(15 23 42 / 0.07)" strokeWidth="0.6" />
          {Array.from({ length: 72 }, (_, i) => {
            const a = (i * 5 * Math.PI) / 180;
            const long = i % 6 === 0;
            const r1 = long ? 90 : 93.5;
            return (
              <line
                key={i}
                x1={100 + Math.cos(a) * r1}
                y1={100 + Math.sin(a) * r1}
                x2={100 + Math.cos(a) * 97}
                y2={100 + Math.sin(a) * 97}
                stroke={long ? "rgb(15 23 42 / 0.25)" : "rgb(15 23 42 / 0.1)"}
                strokeWidth="0.6"
              />
            );
          })}
        </svg>

        {/* rotating sweep: fading conic wedge + leading edge */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-[1.5%] rounded-full"
          style={{
            background: "conic-gradient(from 0deg, rgb(45 212 191 / 0) 0deg, rgb(45 212 191 / 0) 290deg, rgb(45 212 191 / 0.1) 320deg, rgb(20 184 166 / 0.38) 359deg, rgb(45 212 191 / 0) 360deg)",
            opacity: scanning ? 1 : 0.55,
          }}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, ease: "linear", duration: scanning ? 2.4 : 7 }}
        >
          <span className="absolute left-1/2 top-0 h-1/2 w-px -translate-x-1/2 bg-gradient-to-t from-mint/0 via-mint/50 to-mint" />
        </motion.div>

        {/* this computer */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className="absolute inset-0 -m-1 animate-pulse-ring rounded-full border border-mint/40" aria-hidden />
          <span className="grid h-7 w-7 place-items-center rounded-full border border-line-strong bg-ink-2 text-ivory-dim" title="This computer (GHOST coordinator)">
            <Laptop size={13} aria-hidden />
          </span>
        </div>

        {/* blips */}
        <AnimatePresence>
          {blips.map(({ d, tier, angle, x, y }) => {
            const Icon = iconOf(d);
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
                className="group absolute z-10 -translate-x-1/2 -translate-y-1/2 outline-none"
                style={{ left: `${x}%`, top: `${y}%` }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 18, delay: (angle / 360) * 0.9 }}
              >
                {tier === "ready" && <span aria-hidden className="absolute inset-0 animate-pulse-ring rounded-full border border-mint/60" />}
                <span
                  className={clsx(
                    "relative grid h-6 w-6 place-items-center rounded-full border bg-ink-2/90 transition",
                    t.text,
                    t.ring,
                    t.glow,
                    active && "scale-125 bg-ink-3",
                    !d.online && "opacity-50",
                    "group-focus-visible:ring-2 group-focus-visible:ring-mint/60",
                  )}
                >
                  <Icon size={12} aria-hidden />
                </span>
                {(showAllLabels || active) && (
                  <span className="pointer-events-none absolute left-1/2 top-full mt-1 max-w-[96px] -translate-x-1/2 truncate whitespace-nowrap rounded bg-ink/80 px-1 font-mono text-[9px] leading-tight text-ivory-dim">
                    {d.name}
                  </span>
                )}
              </motion.button>
            );
          })}
        </AnimatePresence>

        {/* legend */}
        <div className="pointer-events-none absolute bottom-0 right-0 flex flex-col items-end gap-0.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-mute">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-mint" /> ready
          </span>
          <span className="flex items-center gap-1 text-amber/80">
            <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden>
              <path d="M4 0.5 L7.5 7.5 H0.5 Z" fill="currentColor" />
            </svg>
            pair
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-[1px] border border-current" /> seen
          </span>
        </div>
      </div>

      {/* error / empty / note */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-coral/30 bg-coral/10 px-3 py-2 text-[12px] text-coral" role="alert">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">Scan failed: {error}</span>
        </div>
      )}
      {empty && (
        <div className="rounded-xl border border-line bg-ink-3/60 px-3 py-3 text-[12.5px] leading-relaxed text-ivory-dim">
          No devices answered on this network. Venue Wi-Fi often isolates clients — try a phone hotspot or your home network.
          {result?.note && result.note !== "No devices answered on this network. Venue Wi-Fi often isolates clients — try a phone hotspot or your home network." && (
            <span className="mt-1 block text-[11px] text-mute">{result.note}</span>
          )}
        </div>
      )}
      {!result && !scanning && !error && (
        <p className="text-center text-[12px] text-mute">Scan this computer&apos;s local network for lights, plugs and hubs with documented local APIs.</p>
      )}

      {/* device list */}
      {devices.length > 0 && (
        <ul className="ghost-scroll -mx-1 min-h-0 flex-1 space-y-1 overflow-y-auto px-1" aria-label="Devices found on the local network">
          {devices.map((d, i) => {
            const m = metaOf(d);
            const tier = tierOf(d);
            const Icon = iconOf(d);
            const active = selected === d.device_id;
            return (
              <motion.li key={d.device_id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 + i * 0.03 }}>
                <button
                  type="button"
                  onClick={() => select(d)}
                  onMouseEnter={() => setHovered(d.device_id)}
                  onMouseLeave={() => setHovered((h) => (h === d.device_id ? null : h))}
                  title={m.reason ? `${m.reason}${m.instructions ? `\n${m.instructions}` : ""}` : undefined}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition",
                    active ? "border-mint/40 bg-mint/5" : "border-transparent hover:border-line hover:bg-ink-3/70",
                    focused && active && "ring-1 ring-mint/30",
                  )}
                >
                  <span className={clsx("grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ink-4/80", TIER[tier].text)}>
                    <Icon size={14} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ivory">{d.name}</span>
                    <span className="block truncate text-[11px] text-mute">
                      {[d.vendor, d.model].filter(Boolean).join(" · ") || d.device_class}
                      {tier !== "ready" && m.reason ? ` — ${m.reason}` : ""}
                    </span>
                  </span>
                  <span className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
                    <span className="font-mono text-[10.5px] text-ivory-dim">{m.ip ?? m.entity_id ?? "—"}</span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-mute">{m.driver ?? "—"}</span>
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
