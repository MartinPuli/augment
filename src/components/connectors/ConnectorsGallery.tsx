"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import {
  ArrowUpRight,
  AtSign,
  Briefcase,
  Cctv,
  Check,
  Cloud,
  CloudSun,
  Globe,
  Hash,
  Landmark,
  Lightbulb,
  LoaderCircle,
  Mail,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Smartphone,
  TrainFront,
  WavesHorizontal,
  Workflow,
  X,
} from "lucide";
import { BRAND_ICONS } from "@/lib/connectors/brand-icons";
import { CONNECTORS, type Connector } from "@/lib/connectors/catalog";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
import { duration, ease, haptic, spring } from "@/components/ui/motion";

/** Catalog `lucide` names → icon data (catalog names predate the lucide 1.x renames). */
const LUCIDE: Record<string, IconNode> = { AtSign, Briefcase, Cctv, Cloud, CloudSun, Globe, Hash, Landmark, Lightbulb, Mail, Search, Smartphone, TrainFront, Waves: WavesHorizontal, Workflow };

const STORE_KEY = "ghost.connectors.v1";
/** Front-end connections that are on until the user turns them off. Google is the one real connector. */
const DEFAULT_CONNECTED = new Set(["weather", "youtube", "exa"]);
const LIMIT = 50;

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  name: string | null;
  picture: string | null;
  redirect_uri: string;
}

type Status = "connected" | "available" | "soon";

function loadStore(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
function saveStore(v: Record<string, boolean>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

/** The 50 shown: Google first, the default connections, then the catalog in order (no "coming soon"). */
const CATALOG: Connector[] = (() => {
  const google = CONNECTORS.filter((c) => c.special === "google");
  const defaults = CONNECTORS.filter((c) => DEFAULT_CONNECTED.has(c.id));
  const rest = CONNECTORS.filter((c) => c.special !== "google" && !DEFAULT_CONNECTED.has(c.id) && !c.comingSoon);
  return [...google, ...defaults, ...rest].slice(0, LIMIT);
})();
const ORDER = new Map(CONNECTORS.map((c, i) => [c.id, i]));

/* ---------------------------------------------------------------- logo */

export function ConnectorLogo({ c, size = 40 }: { c: Connector; size?: number }) {
  const brand = c.icon ? BRAND_ICONS[c.icon] : undefined;
  const inner = Math.round(size * 0.5);
  if (brand) {
    return (
      <span className="grid shrink-0 place-items-center rounded-tile bg-white shadow-[0_0_0_1px_rgb(20_20_18/0.06),0_2px_6px_-2px_rgb(20_20_18/0.18)]" style={{ width: size, height: size }} aria-hidden>
        <svg viewBox="0 0 24 24" width={inner} height={inner} fill={`#${brand.hex}`}>
          <path d={brand.path} />
        </svg>
      </span>
    );
  }
  return (
    <span className="grid shrink-0 place-items-center rounded-tile text-white shadow-[0_2px_6px_-2px_rgb(20_20_18/0.3)]" style={{ width: size, height: size, background: c.color ?? "var(--color-fg)" }} aria-hidden>
      <Icon icon={(c.lucide && LUCIDE[c.lucide]) || Plug} size={inner} strokeWidth={1.9} />
    </span>
  );
}

/* ---------------------------------------------------------------- gallery */

/**
 * Connectors: ~50 apps, services and devices Polty can use. Google Workspace is real (OAuth via the
 * coordinator); everything else is a front-end connection remembered in localStorage, with three on
 * by default. Connecting plays a short choreography: consent → authorize → the row lifts into
 * "Connected" with a pop, a buzz and a toast. Used in the dock's modal (`compact`) and on /connectors.
 */
export default function ConnectorsGallery({ compact = false, onClose }: { compact?: boolean; onClose?: () => void }) {
  const [store, setStore] = useState<Record<string, boolean>>({});
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [googleLoading, setGoogleLoading] = useState(true);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");
  const [consent, setConsent] = useState<Connector | null>(null);
  const [setup, setSetup] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshGoogle = useCallback(async () => {
    try {
      await fetch("/api/v1/me", { credentials: "include" }).catch(() => null);
      const r = await fetch("/api/v1/google/status", { credentials: "include", cache: "no-store" });
      if (r.ok) setGoogle((await r.json()) as GoogleStatus);
    } catch {
      /* offline: Google shows as available */
    } finally {
      setGoogleLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount
    setStore(loadStore());
    void refreshGoogle();
    const params = new URLSearchParams(location.search);
    const g = params.get("google");
    if (g === "connected") {
      setToast({ text: "Google Workspace connected", tone: "ok" });
      setCelebrate("google-workspace");
    } else if (g === "error") setToast({ text: `Google sign-in failed: ${params.get("reason") ?? "unknown error"}`, tone: "error" });
    else if (g === "not_configured") setSetup(true);
  }, [refreshGoogle]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!celebrate) return;
    const t = setTimeout(() => setCelebrate(null), 1400);
    return () => clearTimeout(t);
  }, [celebrate]);

  const statusOf = useCallback(
    (c: Connector): Status => {
      if (c.comingSoon) return "soon";
      if (c.special === "google") return google?.connected ? "connected" : "available";
      return (store[c.id] ?? DEFAULT_CONNECTED.has(c.id)) ? "connected" : "available";
    },
    [google, store],
  );

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of CATALOG) m.set(c.category, (m.get(c.category) ?? 0) + 1);
    return [["All", CATALOG.length] as const, ...[...m.entries()]];
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return CATALOG.filter((c) => (cat === "All" || c.category === cat) && (!needle || `${c.name} ${c.description} ${c.category}`.toLowerCase().includes(needle)));
  }, [q, cat]);
  const byOrder = (a: Connector, b: Connector) => Number(b.special === "google") - Number(a.special === "google") || (ORDER.get(a.id) ?? 0) - (ORDER.get(b.id) ?? 0);
  const connected = filtered.filter((c) => statusOf(c) === "connected").sort(byOrder);
  const available = filtered.filter((c) => statusOf(c) !== "connected").sort(byOrder);
  const connectedCount = CATALOG.filter((c) => statusOf(c) === "connected").length;

  const setConnected = (id: string, v: boolean) => {
    const next = { ...store, [id]: v };
    setStore(next);
    saveStore(next);
  };

  const connect = (c: Connector) => {
    haptic();
    if (c.special === "google") {
      if (!google?.configured) setSetup(true);
      else {
        setGoogleBusy(true);
        window.location.assign(new URL("/api/v1/google/connect", window.location.origin).href);
      }
      return;
    }
    setConsent(c);
  };

  const disconnect = async (c: Connector) => {
    haptic();
    if (c.special === "google") {
      setGoogleBusy(true);
      await fetch("/api/v1/google/disconnect", { method: "POST", credentials: "include" }).catch(() => null);
      await refreshGoogle();
      setGoogleBusy(false);
      setToast({ text: "Google Workspace disconnected", tone: "ok" });
      return;
    }
    setConnected(c.id, false);
    setToast({ text: `${c.name} disconnected`, tone: "ok" });
  };

  const detailOf = (c: Connector) =>
    c.special === "google" && google?.connected ? `Signed in as ${google.email ?? google.name ?? "your account"} · Gmail, Calendar, Drive, Contacts` : c.description;

  const rows = (list: Connector[], offset: number) =>
    list.map((c, i) => (
      <Row
        key={c.id}
        c={c}
        index={offset + i}
        status={statusOf(c)}
        detail={detailOf(c)}
        busy={c.special === "google" && googleBusy}
        loading={c.special === "google" && googleLoading}
        celebrate={celebrate === c.id}
        onConnect={() => connect(c)}
        onDisconnect={() => void disconnect(c)}
      />
    ));

  return (
    <div className={clsx("relative flex min-h-0 flex-col", compact && "h-full")}>
      {/* header */}
      <div className={clsx("shrink-0", compact ? "px-5 pt-5 sm:px-7 sm:pt-7" : "")}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className={clsx("font-display text-fg", compact ? "text-title" : "text-display")}>Connectors</h2>
            <p className="mt-1.5 text-body-sm text-fg-2 sm:text-body">
              Give Polty your apps, services and devices.{" "}
              <span className="whitespace-nowrap text-fg-3">
                <motion.span key={connectedCount} initial={{ scale: 1.35, color: "#0f766e" }} animate={{ scale: 1, color: "#66686d" }} transition={spring.bouncy} className="inline-block tabular-nums">
                  {connectedCount}
                </motion.span>{" "}
                connected · {CATALOG.length} available
              </span>
            </p>
          </div>
          {onClose && (
            <motion.button
              type="button"
              onClick={onClose}
              aria-label="Close connectors"
              whileTap={{ scale: 0.9 }}
              transition={spring.snappy}
              className="-mr-1 -mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-fg-3 transition-colors hover:bg-tint hover:text-fg"
            >
              <Icon icon={X} size={18} />
            </motion.button>
          )}
        </div>

        {/* search */}
        <label className="mt-4 flex h-11 items-center gap-2.5 rounded-full bg-white/70 px-4 shadow-[0_0_0_1px_rgb(20_20_18/0.06)] transition-shadow duration-200 focus-within:shadow-[0_0_0_1px_rgb(20_20_18/0.1),0_0_0_4px_rgb(45_212_191/0.18)]">
          <Icon icon={Search} size={16} className="shrink-0 text-fg-3" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search Gmail, Spotify, Hue…"
            aria-label="Search connectors"
            className="h-full min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-3"
          />
          <AnimatePresence>
            {q && (
              <motion.button
                type="button"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={spring.snappy}
                onClick={() => {
                  setQ("");
                  searchRef.current?.focus();
                }}
                className="-mr-2 grid h-8 w-8 place-items-center rounded-full text-fg-3 hover:bg-tint hover:text-fg"
                aria-label="Clear search"
              >
                <Icon icon={X} size={14} />
              </motion.button>
            )}
          </AnimatePresence>
        </label>

        {/* categories */}
        <div className={clsx("ghost-scroll -mx-1 mt-3 flex gap-1 overflow-x-auto px-1 pb-2", !compact && "sm:flex-wrap")} role="tablist" aria-label="Categories">
          {categories.map(([k, n]) => {
            const active = cat === k;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={active}
                onClick={() => setCat(k)}
                className={clsx("relative h-8 shrink-0 whitespace-nowrap rounded-full px-3 text-caption font-medium transition-colors duration-150", active ? "text-fg-inverse" : "text-fg-2 hover:bg-tint hover:text-fg")}
              >
                {active && <motion.span layoutId={`connector-cat-${compact ? "m" : "p"}`} className="absolute inset-0 rounded-full bg-fg shadow-pop" transition={spring.snappy} />}
                <span className="relative">
                  {k} <span className={clsx("tabular-nums", active ? "opacity-60" : "text-fg-3")}>{n}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* list */}
      <motion.div layoutScroll className={clsx(compact ? "ghost-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-6 sm:px-5" : "mt-2")}>
        {/* One list, headers included: a row that changes section just moves within it. */}
        <ul className={clsx("grid gap-1", compact ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3")}>
          <AnimatePresence initial>
            {connected.length > 0 && <SectionLabel key="h-connected" title="Connected" />}
            {rows(connected, 1)}
            {available.length > 0 && <SectionLabel key="h-available" title={connected.length ? "Add more" : "Available"} />}
            {rows(available, connected.length + 2)}
          </AnimatePresence>
        </ul>
        {!filtered.length && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.base, ease: ease.standard }} className="flex flex-col items-center gap-2 py-14 text-center">
            <Illustration name="search" size={64} fallback={Search} />
            <p className="mt-1 font-serif text-heading text-fg">Nothing called “{q}” yet</p>
            <p className="text-body-sm text-fg-3">Try another name, or browse a category.</p>
            <button
              type="button"
              onClick={() => {
                setQ("");
                setCat("All");
              }}
              className="ghost-chip mt-2 h-9 rounded-full px-4 text-body-sm font-medium text-fg transition-transform active:scale-95"
            >
              Show everything
            </button>
          </motion.div>
        )}
      </motion.div>

      {/* overlays (inside the modal surface) */}
      <AnimatePresence>
        {consent && (
          <ConsentSheet
            key="consent"
            c={consent}
            onClose={() => setConsent(null)}
            onAllow={() => {
              const c = consent;
              setConsent(null);
              setConnected(c.id, true);
              setCelebrate(c.id);
              setToast({ text: `${c.name} connected`, tone: "ok" });
              haptic([10, 40, 14]);
            }}
          />
        )}
        {setup && <GoogleSetupSheet key="setup" redirect={google?.redirect_uri ?? "http://localhost:3000/api/v1/google/callback"} onClose={() => setSetup(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.text}
            role="status"
            className={clsx(
              "ghost-chip pointer-events-none z-30 flex items-center gap-2 rounded-full px-4 py-2.5 text-body-sm font-medium",
              compact ? "absolute bottom-4 left-1/2" : "fixed bottom-6 left-1/2",
              toast.tone === "error" ? "text-coral" : "text-fg",
            )}
            initial={{ opacity: 0, y: 14, x: "-50%", scale: 0.96 }}
            animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
            exit={{ opacity: 0, y: 8, x: "-50%", transition: { duration: duration.fast } }}
            transition={spring.gentle}
          >
            <span className={clsx("grid h-5 w-5 place-items-center rounded-full text-white", toast.tone === "error" ? "bg-coral" : "bg-mint")}>
              <Icon icon={toast.tone === "error" ? X : Check} size={12} strokeWidth={2.6} />
            </span>
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: duration.fast } }}
      transition={{ duration: duration.base, layout: spring.gentle }}
      className="col-span-full px-2 pb-1.5 pt-4 text-caption font-medium text-fg-3 first:pt-1"
    >
      {title}
    </motion.li>
  );
}

/* ---------------------------------------------------------------- row */

function Row({
  c,
  index,
  status,
  detail,
  busy,
  loading,
  celebrate,
  onConnect,
  onDisconnect,
}: {
  c: Connector;
  index: number;
  status: Status;
  detail: string;
  busy: boolean;
  loading: boolean;
  celebrate: boolean;
  onConnect(): void;
  onDisconnect(): void;
}) {
  const isGoogle = c.special === "google";
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: duration.fast } }}
      transition={{ ...spring.gentle, delay: Math.min(index, 14) * 0.022, layout: spring.gentle }}
      className={clsx(
        "group relative flex min-h-[64px] items-center gap-3 rounded-tile px-2.5 py-2 transition-colors duration-200 hover:bg-white/60",
        celebrate && "bg-mint/[0.07]",
      )}
    >
      <motion.span
        className="relative"
        animate={celebrate ? { scale: [1, 0.86, 1.14, 1], rotate: [0, -6, 4, 0] } : { scale: 1, rotate: 0 }}
        transition={celebrate ? { duration: duration.celebratory, ease: ease.standard } : spring.gentle}
      >
        <ConnectorLogo c={c} size={40} />
        <AnimatePresence>
          {celebrate && (
            <motion.span
              key="ring"
              className="pointer-events-none absolute inset-0 rounded-tile border-2 border-mint-glow"
              initial={{ opacity: 0.8, scale: 1 }}
              animate={{ opacity: 0, scale: 1.7 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8, ease: ease.standard }}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {status === "connected" && (
            <motion.span
              className="absolute -bottom-1 -right-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-mint text-white ring-2 ring-[var(--color-page)]"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={spring.bouncy}
            >
              <Icon icon={Check} size={11} strokeWidth={3} />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-body-sm font-medium text-fg">{c.name}</span>
          {isGoogle && <span className="shrink-0 rounded-full bg-mint/10 px-1.5 py-px text-micro font-medium text-mint">Live</span>}
        </div>
        <p className="truncate text-caption text-fg-3" title={detail}>
          {detail}
        </p>
      </div>
      <Action status={status} busy={busy} loading={loading} name={c.name} onConnect={onConnect} onDisconnect={onDisconnect} />
    </motion.li>
  );
}

/** Connect → (Connected ⇄ Disconnect on hover). One morphing icon carries every state change. */
function Action({ status, busy, loading, name, onConnect, onDisconnect }: { status: Status; busy: boolean; loading: boolean; name: string; onConnect(): void; onDisconnect(): void }) {
  const [hover, setHover] = useState(false);
  if (status === "soon") return <span className="shrink-0 rounded-full bg-tint px-2.5 py-1 text-micro font-medium text-fg-3">Soon</span>;
  if (loading) return <span className="ghost-skeleton h-8 w-[5.5rem] shrink-0 rounded-full" aria-hidden />;
  const on = status === "connected";
  const icon = busy ? LoaderCircle : on ? (hover ? X : Check) : Plus;
  const label = busy ? (on ? "Disconnecting" : "Opening Google") : on ? (hover ? "Disconnect" : "Connected") : "Connect";
  return (
    <motion.button
      type="button"
      disabled={busy}
      onClick={on ? onDisconnect : onConnect}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      whileTap={{ scale: 0.94 }}
      transition={spring.snappy}
      aria-label={on ? `Disconnect ${name}` : `Connect ${name}`}
      className={clsx(
        "inline-flex h-8 min-w-[6.25rem] shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-caption font-medium transition-colors duration-150 disabled:cursor-wait",
        on ? (hover ? "bg-coral/10 text-coral" : "bg-mint/10 text-mint") : "bg-fg text-fg-inverse shadow-pop hover:bg-fg/90",
      )}
    >
      <Icon icon={icon} size={13} strokeWidth={2.4} spring="snappy" className={busy ? "animate-spin" : undefined} />
      {label}
    </motion.button>
  );
}

/* ---------------------------------------------------------------- sheets */

function Sheet({ label, onClose, children }: { label: string; onClose(): void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <motion.div
      className="absolute inset-0 z-20 grid place-items-end bg-[rgb(244_243_239/0.55)] p-3 backdrop-blur-[6px] sm:place-items-center sm:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: duration.fast } }}
      transition={{ duration: duration.base }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal
        aria-label={label}
        className="relative w-full max-w-[420px] rounded-card bg-white/95 p-6 text-fg shadow-float"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98, transition: { duration: duration.fast } }}
        transition={spring.gentle}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full text-fg-3 hover:bg-tint hover:text-fg" aria-label="Close">
          <Icon icon={X} size={16} />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}

function PoltyMark({ size = 48 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-tile bg-white shadow-[0_0_0_1px_rgb(20_20_18/0.06),0_2px_6px_-2px_rgb(20_20_18/0.18)]" style={{ width: size, height: size }}>
      <Illustration name="polty" size={Math.round(size * 0.82)} fallback={Plug} />
    </span>
  );
}

/** Mock OAuth consent: Polty ⇄ app handshake, the scopes, then Allow → authorizing → granted. */
function ConsentSheet({ c, onClose, onAllow }: { c: Connector; onClose(): void; onAllow(): void }) {
  const [phase, setPhase] = useState<"ask" | "authorizing" | "granted">("ask");
  const scopes = c.scopes ?? [`Read your ${c.name} data`, `Act in ${c.name} when you ask`];
  // The parent re-renders freely; keep the latest callback without restarting the timers.
  const allow = useRef(onAllow);
  useEffect(() => {
    allow.current = onAllow;
  });
  useEffect(() => {
    if (phase === "authorizing") {
      const t = setTimeout(() => setPhase("granted"), 950);
      return () => clearTimeout(t);
    }
    if (phase === "granted") {
      const t = setTimeout(() => allow.current(), 520);
      return () => clearTimeout(t);
    }
  }, [phase]);
  return (
    <Sheet label={`Connect ${c.name}`} onClose={phase === "ask" ? onClose : () => {}}>
      <div className="flex items-center justify-center gap-3 pt-2">
        <PoltyMark />
        <span className="relative flex w-14 items-center justify-between">
          {[0, 1, 2, 3].map((i) => (
            <motion.span
              key={i}
              className={clsx("h-1.5 w-1.5 rounded-full", phase === "granted" ? "bg-mint" : "bg-fg-3")}
              animate={phase === "granted" ? { opacity: 1, scale: [1, 1.6, 1] } : { opacity: [0.25, 1, 0.25] }}
              transition={phase === "granted" ? { duration: 0.4, delay: i * 0.05 } : { duration: phase === "authorizing" ? 0.6 : 1.3, repeat: Infinity, delay: i * 0.14 }}
            />
          ))}
        </span>
        <motion.span animate={phase === "granted" ? { scale: [1, 1.12, 1] } : { scale: 1 }} transition={{ duration: 0.45 }}>
          <ConnectorLogo c={c} size={48} />
        </motion.span>
      </div>
      <h3 className="mt-5 text-center font-display text-title">Connect {c.name}</h3>
      <p className="mt-1 text-center text-body-sm text-fg-2">Polty would like access to your {c.name} account.</p>
      <motion.ul
        className="mt-5 space-y-2.5 rounded-tile bg-tint/70 p-4"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.12 } } }}
      >
        {scopes.map((s) => (
          <motion.li key={s} variants={{ hidden: { opacity: 0, x: -6 }, show: { opacity: 1, x: 0 } }} className="flex items-start gap-2.5 text-body-sm text-fg">
            <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-mint/15 text-mint">
              <Icon icon={Check} size={10} strokeWidth={3} />
            </span>
            {s}
          </motion.li>
        ))}
      </motion.ul>
      <p className="mt-3 flex items-center gap-1.5 text-caption text-fg-3">
        <Icon icon={ShieldCheck} size={14} /> Disconnect any time. Polty never shares your data.
      </p>
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={phase !== "ask"}
          className="h-11 flex-1 rounded-full bg-tint text-body-sm font-medium text-fg-2 transition-[background-color,transform] hover:bg-line-strong/60 active:scale-[0.97] disabled:opacity-40"
        >
          Cancel
        </button>
        <motion.button
          type="button"
          disabled={phase !== "ask"}
          onClick={() => {
            haptic();
            setPhase("authorizing");
          }}
          animate={{ backgroundColor: phase === "granted" ? "#0f766e" : "#151513" }}
          transition={{ duration: duration.base }}
          whileTap={{ scale: 0.97 }}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-body-sm font-medium text-fg-inverse shadow-pop disabled:cursor-default"
        >
          {phase !== "ask" && <Icon icon={phase === "granted" ? Check : LoaderCircle} size={16} strokeWidth={2.4} spring="bouncy" className={phase === "authorizing" ? "animate-spin" : undefined} />}
          {phase === "ask" ? "Allow access" : phase === "authorizing" ? "Authorizing…" : "Connected"}
        </motion.button>
      </div>
    </Sheet>
  );
}

function GoogleSetupSheet({ redirect, onClose }: { redirect: string; onClose(): void }) {
  const googleConnector = CONNECTORS.find((c) => c.special === "google") ?? CONNECTORS[0];
  const steps = [
    <>
      Open{" "}
      <a className="inline-flex items-center gap-0.5 text-mint underline-offset-2 hover:underline" href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">
        Google Cloud console <Icon icon={ArrowUpRight} size={12} />
      </a>{" "}
      and pick or create a project.
    </>,
    <>
      APIs &amp; Services → Library: enable <b className="font-medium text-fg">Gmail</b>, <b className="font-medium text-fg">Calendar</b>, <b className="font-medium text-fg">Drive</b> and{" "}
      <b className="font-medium text-fg">People</b> APIs.
    </>,
    <>
      OAuth consent screen: <b className="font-medium text-fg">External</b>, add your Google account as a <b className="font-medium text-fg">test user</b>.
    </>,
    <>
      Credentials → <b className="font-medium text-fg">OAuth client ID</b> → Web application, with this redirect URI:
    </>,
    <>
      Put the values in <code className="font-mono text-caption">.env.local</code> and restart the server:
    </>,
  ];
  return (
    <Sheet label="Set up Google Workspace" onClose={onClose}>
      <div className="flex items-center gap-3 pr-8">
        <ConnectorLogo c={googleConnector} size={44} />
        <div>
          <h3 className="font-serif text-heading">Set up Google Workspace</h3>
          <p className="text-caption text-fg-3">A one-time OAuth client for this server</p>
        </div>
      </div>
      <ol className="mt-5 space-y-3">
        {steps.map((s, i) => (
          <motion.li key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.05, duration: duration.base, ease: ease.standard }} className="flex gap-3 text-body-sm text-fg-2">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-tint text-micro font-semibold text-fg">{i + 1}</span>
            <div className="min-w-0 flex-1">
              {s}
              {i === 3 && <code className="mt-1.5 block select-all break-all rounded-lg bg-tint px-2 py-1.5 font-mono text-caption text-fg">{redirect}</code>}
              {i === 4 && (
                <code className="mt-1.5 block select-all whitespace-pre rounded-lg bg-tint px-2 py-1.5 font-mono text-caption text-fg">{"GOOGLE_CLIENT_ID=…apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=…"}</code>
              )}
            </div>
          </motion.li>
        ))}
      </ol>
      <button type="button" onClick={onClose} className="mt-6 h-11 w-full rounded-full bg-fg text-body-sm font-medium text-fg-inverse shadow-pop transition-transform active:scale-[0.98]">
        Got it
      </button>
    </Sheet>
  );
}
