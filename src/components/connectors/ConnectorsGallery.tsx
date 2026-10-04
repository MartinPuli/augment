"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
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
  Search,
  ShieldCheck,
  Smartphone,
  TrainFront,
  Waves,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { BRAND_ICONS } from "@/lib/connectors/brand-icons";
import { CONNECTOR_CATEGORIES, CONNECTORS, type Connector, type ConnectorCategory } from "@/lib/connectors/catalog";

const LUCIDE: Record<string, LucideIcon> = { AtSign, Briefcase, Cctv, Cloud, CloudSun, Globe, Hash, Landmark, Lightbulb, Mail, Search, Smartphone, TrainFront, Waves, Workflow };

const STORE_KEY = "ghost.connectors.v1";
const EASE = [0.23, 1, 0.32, 1] as const;

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

/* ---------------------------------------------------------------- logo */

export function ConnectorLogo({ c, size = 40 }: { c: Connector; size?: number }) {
  const brand = c.icon ? BRAND_ICONS[c.icon] : undefined;
  const Icon = (c.lucide && LUCIDE[c.lucide]) || Plug;
  const inner = Math.round(size * 0.52);
  if (brand) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-tile bg-white shadow-pop"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <svg viewBox="0 0 24 24" width={inner} height={inner} fill={`#${brand.hex}`}>
          <path d={brand.path} />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-tile text-white shadow-pop"
      style={{ width: size, height: size, background: c.color ?? "var(--color-fg)" }}
      aria-hidden
    >
      <Icon size={inner} strokeWidth={1.9} />
    </span>
  );
}

/* ---------------------------------------------------------------- pill */

function StatusPill({ s }: { s: Status }) {
  if (s === "connected")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-mint)_12%,transparent)] px-2 py-0.5 text-label font-medium text-mint">
        <span className="size-1.5 rounded-full bg-mint" /> Connected
      </span>
    );
  if (s === "soon") return <span className="rounded-full bg-tint px-2 py-0.5 text-label font-medium text-fg-3">Coming soon</span>;
  return <span className="rounded-full bg-tint px-2 py-0.5 text-label font-medium text-fg-2">Connect</span>;
}

/* ---------------------------------------------------------------- modal shell */

function Modal({ onClose, children }: { onClose(): void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <motion.div
      className="fixed inset-0 z-[80] grid place-items-center bg-scrim p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal
        className="relative w-full max-w-[420px] rounded-card bg-[var(--color-page)] p-6 text-fg shadow-float"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.32, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 grid size-8 place-items-center rounded-full text-fg-3 hover:bg-tint hover:text-fg" aria-label="Close">
          <X size={16} />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}

function PoltyMark({ size = 40 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-tile bg-fg font-display text-fg-inverse shadow-pop" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      P
    </span>
  );
}

function ConsentModal({ c, onClose, onAllow }: { c: Connector; onClose(): void; onAllow(): void }) {
  const [busy, setBusy] = useState(false);
  const scopes = c.scopes ?? [`Read your ${c.name} data`, `Act on your behalf in ${c.name} when you ask`];
  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-center gap-3 pt-2">
        <PoltyMark size={48} />
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <motion.span key={i} className="size-1.5 rounded-full bg-fg-3" animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }} />
          ))}
        </span>
        <ConnectorLogo c={c} size={48} />
      </div>
      <h3 className="mt-5 text-center font-display text-title">Connect {c.name}</h3>
      <p className="mt-1 text-center text-body-sm text-fg-2">Polty is requesting access to your {c.name} account.</p>
      <ul className="mt-5 space-y-2 rounded-tile bg-tint p-4">
        {scopes.map((s) => (
          <li key={s} className="flex items-start gap-2 text-body-sm text-fg">
            <Check size={16} className="mt-0.5 shrink-0 text-mint" /> {s}
          </li>
        ))}
      </ul>
      <p className="mt-3 flex items-center gap-1.5 text-caption text-fg-3">
        <ShieldCheck size={14} /> You can disconnect at any time. Polty never shares your data.
      </p>
      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className="h-11 flex-1 rounded-full bg-tint text-body font-medium text-fg-2 hover:bg-[var(--color-line-strong)]">
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setTimeout(onAllow, 1100);
          }}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-fg text-body font-medium text-fg-inverse shadow-pop hover:opacity-90 disabled:opacity-80"
        >
          {busy ? (
            <>
              <LoaderCircle size={16} className="animate-spin" /> Authorizing…
            </>
          ) : (
            "Allow access"
          )}
        </button>
      </div>
    </Modal>
  );
}

function GoogleSetupModal({ redirect, onClose }: { redirect: string; onClose(): void }) {
  const steps = [
    <>Open <a className="text-mint underline" href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud console</a> and pick or create a project.</>,
    <>APIs &amp; Services → Library: enable <b>Gmail API</b>, <b>Google Calendar API</b>, <b>Google Drive API</b> and <b>People API</b>.</>,
    <>OAuth consent screen: user type <b>External</b>, fill in the app name, and add your Google account as a <b>test user</b>.</>,
    <>Credentials → Create credentials → <b>OAuth client ID</b> → Web application. Add this authorized redirect URI:</>,
    <>Put the values in <code className="font-mono">.env.local</code> and restart the server:</>,
  ];
  return (
    <Modal onClose={onClose}>
      <div className="flex items-center gap-3">
        <ConnectorLogo c={CONNECTORS[0]} size={44} />
        <div>
          <h3 className="font-display text-heading">Set up Google Workspace</h3>
          <p className="text-caption text-fg-3">One-time OAuth client setup for this server</p>
        </div>
      </div>
      <ol className="mt-5 space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-body-sm text-fg-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-tint text-micro font-semibold text-fg">{i + 1}</span>
            <div className="min-w-0 flex-1">
              {s}
              {i === 3 && <code className="mt-1.5 block rounded-lg bg-tint px-2 py-1.5 font-mono text-caption break-all text-fg select-all">{redirect}</code>}
              {i === 4 && (
                <code className="mt-1.5 block rounded-lg bg-tint px-2 py-1.5 font-mono text-caption whitespace-pre text-fg select-all">
                  {"GOOGLE_CLIENT_ID=…apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=…"}
                </code>
              )}
            </div>
          </li>
        ))}
      </ol>
      <button onClick={onClose} className="mt-6 h-11 w-full rounded-full bg-fg text-body font-medium text-fg-inverse shadow-pop hover:opacity-90">
        Got it
      </button>
    </Modal>
  );
}

/* ---------------------------------------------------------------- card */

function Card({
  c,
  status,
  detail,
  onConnect,
  onDisconnect,
}: {
  c: Connector;
  status: Status;
  detail?: string | null;
  onConnect(): void;
  onDisconnect?: () => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.28, ease: EASE }}
      whileHover={{ y: -3 }}
      className="group ghost-glass flex flex-col gap-3 rounded-card p-4 transition-shadow hover:shadow-float"
    >
      <div className="flex items-start justify-between gap-3">
        <ConnectorLogo c={c} />
        <StatusPill s={status} />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-heading font-medium text-fg">
          {c.name}
          {c.real && <span className="rounded bg-tint px-1 text-micro tracking-wide text-fg-3 uppercase">Live</span>}
        </div>
        <p className="mt-0.5 line-clamp-2 text-body-sm text-fg-2">{detail ?? c.description}</p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-caption text-fg-3">{c.category}</span>
        {status === "soon" ? (
          <button disabled className="h-8 rounded-full bg-tint px-3 text-caption font-medium text-fg-3">
            Notify me
          </button>
        ) : status === "connected" ? (
          onDisconnect ? (
            <button onClick={onDisconnect} className="h-8 rounded-full px-3 text-caption font-medium text-fg-3 hover:bg-tint hover:text-coral">
              Disconnect
            </button>
          ) : (
            <span className="flex h-8 items-center gap-1 px-1 text-caption font-medium text-mint">
              <Check size={14} /> Active
            </span>
          )
        ) : (
          <button onClick={onConnect} className="h-8 rounded-full bg-fg px-3.5 text-caption font-medium text-fg-inverse shadow-pop transition-transform hover:scale-[1.03] active:scale-95">
            Connect
          </button>
        )}
      </div>
    </motion.div>
  );
}

/* ---------------------------------------------------------------- gallery */

export default function ConnectorsGallery({ compact = false }: { compact?: boolean }) {
  const [store, setStore] = useState<Record<string, boolean>>({});
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<ConnectorCategory | "All">("All");
  const [consent, setConsent] = useState<Connector | null>(null);
  const [setup, setSetup] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refreshGoogle = useCallback(async () => {
    try {
      await fetch("/api/v1/me", { credentials: "include" }).catch(() => null);
      const r = await fetch("/api/v1/google/status", { credentials: "include", cache: "no-store" });
      if (r.ok) setGoogle((await r.json()) as GoogleStatus);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount
    setStore(loadStore());
    void refreshGoogle();
    const g = new URLSearchParams(location.search).get("google");
    if (g === "connected") setToast("Google Workspace connected");
    else if (g === "error") setToast(`Google sign-in failed: ${new URLSearchParams(location.search).get("reason") ?? "unknown error"}`);
    else if (g === "not_configured") setSetup(true);
  }, [refreshGoogle]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const statusOf = useCallback(
    (c: Connector): Status => {
      if (c.comingSoon) return "soon";
      if (c.special === "google") return google?.connected ? "connected" : "available";
      if (c.real) return "connected";
      return store[c.id] ? "connected" : "available";
    },
    [google, store],
  );

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of CONNECTORS) m.set(c.category, (m.get(c.category) ?? 0) + 1);
    return m;
  }, []);
  const connectedCount = CONNECTORS.filter((c) => statusOf(c) === "connected").length;

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return CONNECTORS.filter((c) => (cat === "All" || c.category === cat) && (!needle || `${c.name} ${c.description} ${c.category}`.toLowerCase().includes(needle))).sort(
      (a, b) => Number(b.special === "google") - Number(a.special === "google") || Number(statusOf(b) === "connected") - Number(statusOf(a) === "connected") || Number(!!a.comingSoon) - Number(!!b.comingSoon),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- order only on filter change, not on every connect
  }, [q, cat]);

  const setConnected = (id: string, v: boolean) => {
    const next = { ...store, [id]: v };
    setStore(next);
    saveStore(next);
  };

  const connect = (c: Connector) => {
    if (c.special === "google") {
      if (!google?.configured) setSetup(true);
      else window.location.assign(new URL("/api/v1/google/connect", window.location.origin).href);
      return;
    }
    setConsent(c);
  };

  const disconnect = async (c: Connector) => {
    if (c.special === "google") {
      await fetch("/api/v1/google/disconnect", { method: "POST", credentials: "include" }).catch(() => null);
      await refreshGoogle();
      setToast("Google Workspace disconnected");
      return;
    }
    setConnected(c.id, false);
  };

  return (
    <div className="flex min-h-0 flex-col">
      {/* header */}
      <div className={compact ? "px-5 pt-5" : ""}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="hud-label">Connectors</div>
            <h2 className={`${compact ? "text-title" : "text-display"} mt-1 font-display text-fg`}>Connect your world</h2>
            <p className="mt-1 text-body text-fg-2">
              <span className="font-medium text-mint">{connectedCount} connected</span> · {CONNECTORS.length} available apps, services and devices
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-full bg-surface-2 px-4 shadow-card focus-within:shadow-float">
          <Search size={16} className="text-fg-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search Gmail, Spotify, Hue…"
            className="h-11 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-3"
          />
          {q && (
            <button onClick={() => setQ("")} className="text-fg-3 hover:text-fg" aria-label="Clear search">
              <X size={16} />
            </button>
          )}
        </div>
        <div className={`ghost-scroll mt-3 flex gap-1.5 overflow-x-auto pb-1 ${compact ? "" : "flex-wrap"}`}>
          {(["All", ...CONNECTOR_CATEGORIES] as const).map((k) => {
            const active = cat === k;
            const n = k === "All" ? CONNECTORS.length : counts.get(k) ?? 0;
            return (
              <button
                key={k}
                onClick={() => setCat(k)}
                className={`relative h-8 shrink-0 rounded-full px-3 text-caption font-medium whitespace-nowrap transition-colors ${active ? "text-fg-inverse" : "ghost-chip text-fg-2 hover:text-fg"}`}
              >
                {active && <motion.span layoutId={`cat-pill-${compact ? "p" : "f"}`} className="absolute inset-0 rounded-full bg-fg" transition={{ duration: 0.3, ease: EASE }} />}
                <span className="relative">
                  {k} <span className={active ? "opacity-70" : "text-fg-3"}>{n}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* grid */}
      <div className={compact ? "ghost-scroll min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-6" : "mt-5"}>
        <motion.div layout className={`grid gap-3 ${compact ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(250px,1fr))]"}`}>
          <AnimatePresence mode="popLayout">
            {list.map((c) => {
              const s = statusOf(c);
              const isGoogle = c.special === "google";
              return (
                <Card
                  key={c.id}
                  c={c}
                  status={s}
                  detail={isGoogle && google?.connected ? `Signed in as ${google.email ?? google.name ?? "your account"} · Gmail, Calendar, Drive, Contacts` : null}
                  onConnect={() => connect(c)}
                  onDisconnect={s === "connected" && !c.real ? () => void disconnect(c) : undefined}
                />
              );
            })}
          </AnimatePresence>
        </motion.div>
        {!list.length && <p className="py-12 text-center text-body text-fg-3">No connectors match “{q}”.</p>}
      </div>

      <AnimatePresence>
        {consent && (
          <ConsentModal
            key="consent"
            c={consent}
            onClose={() => setConsent(null)}
            onAllow={() => {
              setConnected(consent.id, true);
              setToast(`${consent.name} connected`);
              setConsent(null);
            }}
          />
        )}
        {setup && <GoogleSetupModal key="setup" redirect={google?.redirect_uri ?? "http://localhost:3000/api/v1/google/callback"} onClose={() => setSetup(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            className="ghost-chip fixed bottom-6 left-1/2 z-[90] flex items-center gap-2 rounded-full px-4 py-2.5 text-body-sm font-medium text-fg"
            initial={{ opacity: 0, y: 12, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: 8, x: "-50%" }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <Check size={16} className="text-mint" /> {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
