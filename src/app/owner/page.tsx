"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Ban,
  Bot,
  Camera,
  Check,
  CircleDashed,
  CircleDot,
  Copy,
  Cpu,
  Gauge,
  Ghost,
  KeyRound,
  Lightbulb,
  LoaderCircle,
  Mic,
  Monitor,
  OctagonX,
  Plug,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  Router,
  SatelliteDish,
  ServerCrash,
  Smartphone,
  Speaker,
  Thermometer,
  ToggleLeft,
  Wallet,
  Watch,
  X,
} from "lucide";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
import type { IllustrationName } from "@/components/ui/illustrations";
import { duration, ease, haptic, spring } from "@/components/ui/motion";
import type { AccessType, CatalogStatus, Device, Lease, LeaseState, MeResponse, PairingResponse } from "@/lib/ghost/contracts";
import { DEV_LEDGER_LABEL } from "@/lib/ghost/client/api-types";
import type { DevicesResponseItem, LeaseView, LedgerEntry, LedgerResponse, PairingInfo } from "@/lib/ghost/client/api-types";
import {
  GhostApiError,
  absoluteJoinUrl,
  approveLease,
  confirmPairing,
  createPairing,
  formatCents,
  getLedger,
  getMe,
  listDevices,
  listLeases,
  listPairings,
  rejectPairing,
  revokeLease,
  subscribeEvents,
  updateTerms,
} from "@/lib/ghost/client/api";
import type { TermsPatchInput } from "@/lib/ghost/client/api";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const POLL_MS = 10_000;
const ACTIVE_LEASE_STATES: readonly LeaseState[] = ["reserved", "payment_pending", "active"];

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

function errMsg(e: unknown): string {
  if (e instanceof GhostApiError) return e.status === 0 ? "Coordinator unreachable" : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function isActiveLease(l: Pick<Lease, "state">): boolean {
  return ACTIVE_LEASE_STATES.includes(l.state);
}

function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/*
 * One shared 1 Hz clock for every countdown. The snapshot is cached between ticks (as
 * useSyncExternalStore requires); the server snapshot is 0, which renders a placeholder.
 */
let clockNow = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();
function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}
const getClock = () => {
  if (clockNow === 0) clockNow = Date.now();
  return clockNow;
};
const getServerClock = () => 0;
function useNow(): number {
  return useSyncExternalStore(subscribeClock, getClock, getServerClock);
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

type Tone = "mint" | "amber" | "coral" | "violet" | "mute" | "ivory";
type Shape = "filled" | "hollow" | "half" | "square" | "dashed";

const TONE_TEXT: Record<Tone, string> = {
  mint: "text-mint",
  amber: "text-amber",
  coral: "text-coral",
  violet: "text-violet",
  mute: "text-fg-3",
  ivory: "text-fg-2",
};
const TONE_BADGE: Record<Tone, string> = {
  mint: "bg-mint/10 text-mint",
  amber: "bg-amber/10 text-amber",
  coral: "bg-coral/10 text-coral",
  violet: "bg-violet/10 text-violet",
  mute: "bg-tint text-fg-3",
  ivory: "bg-tint text-fg-2",
};

/** State marker: shape AND colour, so state never depends on colour alone. */
function Dot({ shape, tone, className }: { shape: Shape; tone: Tone; className?: string }) {
  const base = cx("inline-block size-2.5 shrink-0", TONE_TEXT[tone], className);
  switch (shape) {
    case "filled":
      return <span aria-hidden className={cx(base, "rounded-full bg-current")} />;
    case "hollow":
      return <span aria-hidden className={cx(base, "rounded-full border-2 border-current")} />;
    case "dashed":
      return <span aria-hidden className={cx(base, "rounded-full border-2 border-dashed border-current")} />;
    case "half":
      return (
        <span
          aria-hidden
          className={cx(base, "rounded-full border-2 border-current")}
          style={{ background: "linear-gradient(90deg, currentColor 50%, transparent 50%)" }}
        />
      );
    case "square":
      return <span aria-hidden className={cx(base, "rounded-[2px] bg-current")} />;
  }
}

function Badge({
  tone,
  children,
  className,
  wrap,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
  /** Long sentences may wrap on narrow screens; short status badges never do. */
  wrap?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-medium",
        wrap ? "text-left" : "whitespace-nowrap",
        TONE_BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Raw identifiers (capability ids): mono, quiet, truncated. */
function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-block max-w-full truncate rounded-full bg-tint px-2.5 py-1 font-mono text-label text-fg-2"
    >
      {children}
    </span>
  );
}

function Countdown({
  to,
  className,
  expiredLabel = "00:00",
  pendingLabel = "—",
}: {
  to: string | null | undefined;
  className?: string;
  expiredLabel?: string;
  pendingLabel?: string;
}) {
  const now = useNow();
  const target = to ? Date.parse(to) : NaN;
  if (!to || Number.isNaN(target) || now === 0) {
    return <span className={cx("tabular-nums", className)}>{pendingLabel}</span>;
  }
  const ms = target - now;
  return (
    <span className={cx("tabular-nums", ms <= 0 && "text-coral", className)}>
      {ms <= 0 ? expiredLabel : formatRemaining(ms)}
    </span>
  );
}

function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-body-sm text-coral">
      <Icon icon={OctagonX} size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Empty state: illustration, a serif title, one quiet line, and an action when there is one. */
function EmptyState({
  illustration,
  fallback,
  title,
  children,
  action,
  size = 56,
}: {
  illustration: IllustrationName;
  fallback: IconNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  size?: number;
}) {
  return (
    <div className="ghost-glass flex flex-col items-center gap-3 rounded-card px-6 py-8 text-center">
      <Illustration name={illustration} size={size} fallback={fallback} />
      <div className="flex max-w-sm flex-col gap-1">
        <p className="font-serif text-heading text-fg">{title}</p>
        {children && <p className="text-body-sm text-fg-3">{children}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Skeleton block (shimmer), shaped by the caller like the content it stands in for. */
function Skel({ className }: { className?: string }) {
  const rounded = className?.includes("rounded-") ? null : "rounded-full";
  return <span aria-hidden className={cx("ghost-skeleton block", rounded, className)} />;
}

/** Placeholder for a device or lease card while the console first connects. */
function CardSkeleton({ tall }: { tall?: boolean }) {
  return (
    <div aria-hidden className="ghost-glass flex flex-col gap-4 rounded-card p-5">
      <div className="flex items-center gap-3">
        <Skel className="size-11 rounded-tile" />
        <div className="flex flex-1 flex-col gap-2">
          <Skel className="h-4 w-1/2" />
          <Skel className="h-3 w-1/3" />
        </div>
      </div>
      <div className="flex gap-2">
        <Skel className="h-6 w-20" />
        <Skel className="h-6 w-24" />
      </div>
      <Skel className={cx("w-full rounded-tile", tall ? "h-48" : "h-24")} />
      {!tall && <Skel className="h-12 w-full" />}
    </div>
  );
}

function PendingSkeleton() {
  return (
    <div aria-hidden className="ghost-glass flex flex-col gap-3 rounded-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <Skel className="h-4 w-1/2" />
          <Skel className="h-3 w-1/3" />
        </div>
        <Skel className="h-6 w-24" />
      </div>
      <Skel className="h-9 w-full rounded-tile" />
      <div className="flex gap-2">
        <Skel className="h-10 flex-1" />
        <Skel className="h-10 flex-1" />
      </div>
    </div>
  );
}

/** Two columns where there is room: beside the sidebar only on wide screens. */
const CARD_GRID = "grid gap-4 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2";

/** List items fade up once, staggered, when they first mount; later re-renders never re-animate. */
function Appear({ index, children }: { index: number; children: ReactNode }) {
  return (
    <motion.div
      className="min-w-0"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring.gentle, delay: Math.min(index, 8) * 0.045 }}
    >
      {children}
    </motion.div>
  );
}

function SectionHeader({ id, title, count, hint }: { id?: string; title: string; count?: number; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
      <h2 id={id} className="flex items-center gap-2.5 font-serif text-heading text-fg">
        {title}
        {typeof count === "number" && (
          <span className="grid h-6 min-w-6 place-items-center rounded-full bg-tint px-2 font-sans text-caption font-medium text-fg-2 tabular-nums">
            {count}
          </span>
        )}
      </h2>
      {hint && <div className="text-caption text-fg-3">{hint}</div>}
    </div>
  );
}

/*
 * Buttons. Primary = dark pill; secondary = glass chip; destructive = coral, and the Stop control
 * is deliberately the largest button on a lease card. All press-scale, all dim when disabled.
 */
// Busy (aria-busy) buttons stay fully opaque: they read as "working", not "unavailable".
const btnBase =
  "inline-flex select-none items-center justify-center gap-2 rounded-full transition-[transform,background-color,color,box-shadow,opacity] duration-100 ease-standard active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 aria-busy:cursor-progress aria-busy:opacity-100";
const btnSm = "min-h-10 px-4 text-body-sm font-medium";
const btnPrimary = cx(btnBase, btnSm, "bg-fg text-fg-inverse shadow-pop hover:bg-fg/85");
const btnPrimaryLg = cx(btnBase, "min-h-12 px-5 text-body font-medium bg-fg text-fg-inverse shadow-pop hover:bg-fg/85");
/** Secondary without horizontal padding, for callers that set their own (no conflicting px-*). */
const btnSecondaryBare = cx(btnBase, "min-h-10 text-body-sm font-medium ghost-chip text-fg hover:bg-white/90");
const btnSecondary = cx(btnSecondaryBare, "px-4");
const btnStop = cx(
  btnBase,
  "min-h-12 px-5 text-body font-semibold bg-coral/10 text-coral ring-1 ring-coral/35 hover:bg-coral hover:text-fg-inverse hover:ring-coral",
);
const btnIconRound =
  "grid size-10 shrink-0 place-items-center rounded-full text-fg-3 transition-[transform,background-color,color] duration-100 ease-standard hover:bg-tint hover:text-fg active:scale-[0.97]";

const inputCls =
  "h-10 w-full rounded-tile bg-surface px-3 text-body-sm text-fg tabular-nums ring-1 ring-line ring-inset transition-shadow duration-100 placeholder:text-fg-3 hover:ring-line-strong";

/** Small sentence-case field label. */
const labelCls = "text-caption text-fg-3";

/* ------------------------------------------------------------------ */
/* Device presentation                                                 */
/* ------------------------------------------------------------------ */

/** Icon data per device class. */
function deviceIcon(device: Pick<Device, "device_class" | "capabilities">): IconNode {
  switch (device.device_class) {
    case "camera":
      return Camera;
    case "light":
      return Lightbulb;
    case "plug":
      return Plug;
    case "switch":
      return ToggleLeft;
    case "sensor":
      return device.capabilities?.some((c) => /temp/i.test(c.semantic_type) || /temp/i.test(c.capability_id))
        ? Thermometer
        : Gauge;
    case "instrument":
      return Gauge;
    case "phone":
      return Smartphone;
    case "computer":
    case "display":
      return Monitor;
    case "speaker":
    case "media":
      return Speaker;
    case "microphone":
      return Mic;
    case "robot":
      return Bot;
    case "printer":
      return Printer;
    case "wearable":
      return Watch;
    case "hub":
      return Router;
    default:
      return Cpu;
  }
}

function DeviceGlyph({
  device,
  className,
  size = 20,
}: {
  device: Pick<Device, "device_class" | "capabilities">;
  className?: string;
  size?: number;
}) {
  return <Icon icon={deviceIcon(device)} size={size} className={className} />;
}

const STATUS_META: Record<CatalogStatus, { label: string; tone: Tone; icon: IconNode }> = {
  verified: { label: "Verified", tone: "mint", icon: Check },
  configured: { label: "Configured", tone: "ivory", icon: CircleDot },
  candidate: { label: "Candidate", tone: "amber", icon: CircleDashed },
  unavailable: { label: "Unavailable", tone: "coral", icon: Ban },
};

const ACCESS_LABEL: Record<AccessType, string> = {
  public_observation: "Public observation",
  own_device: "Own device",
  owner_shared: "Owner shared",
  provider_booked: "Provider booked",
};

function OnlineIndicator({ online }: { online: boolean }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-caption font-medium", online ? "text-mint" : "text-fg-3")}>
      <Dot shape={online ? "filled" : "hollow"} tone={online ? "mint" : "mute"} />
      {online ? "Online" : "Offline"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Terms form                                                          */
/* ------------------------------------------------------------------ */

interface TermsDraft {
  price: string;
  duration: string;
  quota: string;
  floor: string;
  approval: boolean;
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

function draftFromTerms(t: Device["terms"]): TermsDraft {
  return {
    price: (t.price_cents / 100).toFixed(2),
    duration: String(t.max_duration_s),
    quota: t.quota != null ? String(t.quota) : "",
    floor: t.floor_cents != null ? (t.floor_cents / 100).toFixed(2) : "",
    approval: Boolean(t.requires_approval),
  };
}

function termsKey(t: Device["terms"]): string {
  return [t.price_cents, t.max_duration_s, t.quota ?? "", t.floor_cents ?? "", t.requires_approval ? 1 : 0].join("|");
}

function parseDollars(s: string): number | null {
  const n = Number(s.trim().replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function buildPatch(d: TermsDraft, t: Device["terms"]): { patch: TermsPatchInput } | { error: string } {
  const price = parseDollars(d.price);
  if (d.price.trim() === "" || price === null) return { error: "Price must be a dollar amount (0 or more)." };

  const duration = Number(d.duration.trim());
  if (!Number.isInteger(duration) || duration < 1) return { error: "Max duration must be a whole number of seconds." };

  const patch: TermsPatchInput = { price_cents: price, max_duration_s: duration, requires_approval: d.approval };

  if (d.quota.trim() === "") {
    if (t.quota != null) patch.quota = null; // clear → unlimited
  } else {
    const q = Number(d.quota.trim());
    if (!Number.isInteger(q) || q < 1) return { error: "Quota must be a whole number of uses, or blank for unlimited." };
    patch.quota = q;
  }

  if (d.floor.trim() === "") {
    if (t.floor_cents != null) patch.floor_cents = null; // clear → defaults to price
  } else {
    const f = parseDollars(d.floor);
    if (f === null) return { error: "Floor must be a dollar amount." };
    if (f > price) return { error: "Floor can't be higher than the price." };
    patch.floor_cents = f;
  }
  return { patch };
}

function TermsForm({
  device,
  save,
  onSave,
  onEdit,
}: {
  device: Device;
  save: SaveState;
  onSave: (patch: TermsPatchInput) => void;
  onEdit: () => void;
}) {
  const [draft, setDraft] = useState<TermsDraft>(() => draftFromTerms(device.terms));
  const [localError, setLocalError] = useState<string | null>(null);
  const id = device.device_id;

  const set = <K extends keyof TermsDraft>(k: K, v: TermsDraft[K]) => {
    setDraft((prev) => ({ ...prev, [k]: v }));
    setLocalError(null);
    onEdit();
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = buildPatch(draft, device.terms);
    if ("error" in r) {
      setLocalError(r.error);
      return;
    }
    onSave(r.patch);
  };

  const saving = save.kind === "saving";

  return (
    <form onSubmit={submit} className="mt-auto rounded-tile bg-surface-2 p-4" noValidate>
      <div className="mb-3 text-body-sm font-medium text-fg">Terms</div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelCls}>Price (USD)</span>
          <input
            className={inputCls}
            inputMode="decimal"
            name={`price-${id}`}
            value={draft.price}
            onChange={(e) => set("price", e.target.value)}
            placeholder="0.00"
            aria-describedby={`terms-help-${id}`}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelCls}>Max duration (s)</span>
          <input
            className={inputCls}
            inputMode="numeric"
            name={`duration-${id}`}
            value={draft.duration}
            onChange={(e) => set("duration", e.target.value)}
            placeholder="300"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelCls}>Quota (uses)</span>
          <input
            className={inputCls}
            inputMode="numeric"
            name={`quota-${id}`}
            value={draft.quota}
            onChange={(e) => set("quota", e.target.value)}
            placeholder="Unlimited"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelCls}>Floor (USD)</span>
          <input
            className={inputCls}
            inputMode="decimal"
            name={`floor-${id}`}
            value={draft.floor}
            onChange={(e) => set("floor", e.target.value)}
            placeholder="= price"
          />
        </label>
      </div>
      <label className="mt-3 flex min-h-10 cursor-pointer items-center gap-2.5 text-body-sm text-fg-2">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-mint"
          checked={draft.approval}
          onChange={(e) => set("approval", e.target.checked)}
        />
        Require my approval for each lease
      </label>
      <p id={`terms-help-${id}`} className="mt-1 text-caption text-fg-3">
        Blank quota = unlimited. Blank floor = the price is the floor.
      </p>
      <div className="mt-4 flex min-h-10 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1" aria-live="polite">
          {localError ? (
            <InlineError>{localError}</InlineError>
          ) : save.kind === "error" ? (
            <InlineError>{save.message}</InlineError>
          ) : save.kind === "saved" ? (
            <span className="inline-flex items-center gap-1.5 text-body-sm font-medium text-mint">
              <Icon icon={Check} size={16} /> Saved
            </span>
          ) : null}
        </div>
        <button type="submit" className={btnSecondary} disabled={saving} aria-busy={saving || undefined}>
          <Icon icon={saving ? LoaderCircle : Check} size={16} spring="snappy" className={saving ? "animate-spin" : undefined} />
          {saving ? "Saving…" : "Save terms"}
        </button>
      </div>
    </form>
  );
}

function DeviceCard({ device, onUpdated }: { device: DevicesResponseItem; onUpdated: (d: Device) => void }) {
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const status = STATUS_META[device.status] ?? STATUS_META.candidate;
  const activeLeases = device.active_lease_ids?.length ?? 0;

  const onSave = async (patch: TermsPatchInput) => {
    setSave({ kind: "saving" });
    try {
      const updated = await updateTerms(device.device_id, patch);
      onUpdated(updated);
      setSave({ kind: "saved" });
    } catch (e) {
      setSave({ kind: "error", message: errMsg(e) });
    }
  };

  const onEdit = () => setSave((s) => (s.kind === "saved" || s.kind === "error" ? { kind: "idle" } : s));

  return (
    <article className="ghost-glass flex h-full min-w-0 flex-col gap-4 rounded-card p-5">
      <div className="flex items-start gap-3">
        <div className={cx("grid size-11 shrink-0 place-items-center rounded-tile bg-tint", device.online ? "text-fg" : "text-fg-3")}>
          <DeviceGlyph device={device} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-heading text-fg" title={device.name}>
            {device.name}
          </h3>
          <p className="truncate text-caption text-fg-3">
            {humanize(device.device_class)} · {device.transport}
          </p>
        </div>
        <OnlineIndicator online={device.online} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge tone={status.tone}>
          <Icon icon={status.icon} size={14} />
          {status.label}
        </Badge>
        <Badge tone="mute">{ACCESS_LABEL[device.access_type] ?? humanize(device.access_type)}</Badge>
        {activeLeases > 0 && (
          <Badge tone="mint">
            <Dot shape="filled" tone="mint" />
            {activeLeases === 1 ? "1 active lease" : `${activeLeases} active leases`}
          </Badge>
        )}
      </div>

      <div>
        <div className={cx(labelCls, "mb-2")}>Capabilities</div>
        {device.capabilities.length ? (
          <div className="flex flex-wrap gap-1.5">
            {device.capabilities.map((c) => (
              <Chip key={c.capability_id} title={c.title}>
                {c.capability_id}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-body-sm text-fg-3">No capabilities published.</p>
        )}
      </div>

      <TermsForm
        key={termsKey(device.terms)}
        device={device}
        save={save}
        onSave={(p) => void onSave(p)}
        onEdit={onEdit}
      />
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Leases                                                              */
/* ------------------------------------------------------------------ */

const LEASE_STATE_META: Record<LeaseState, { label: string; tone: Tone; shape: Shape }> = {
  active: { label: "Lease active", tone: "mint", shape: "filled" },
  reserved: { label: "Waiting for approval", tone: "amber", shape: "hollow" },
  payment_pending: { label: "Payment pending", tone: "amber", shape: "half" },
  offer: { label: "Offer", tone: "violet", shape: "dashed" },
  released: { label: "Released by visitor", tone: "mute", shape: "hollow" },
  expired: { label: "Expired", tone: "mute", shape: "hollow" },
  revoked: { label: "Access stopped", tone: "coral", shape: "square" },
  failed: { label: "Failed", tone: "coral", shape: "square" },
};

function LeaseStateBadge({ state }: { state: LeaseState }) {
  const m = LEASE_STATE_META[state] ?? { label: humanize(state), tone: "mute" as Tone, shape: "hollow" as Shape };
  return (
    <Badge tone={m.tone}>
      <Dot shape={m.shape} tone={m.tone} />
      {m.label}
    </Badge>
  );
}

type LeaseAction = { busy: "approve" | "revoke" | null; error: string | null; message: string | null };
const NO_ACTION: LeaseAction = { busy: null, error: null, message: null };

function LeaseCard({
  lease,
  deviceNames,
  ended,
  action,
  onApprove,
  onRevoke,
}: {
  lease: LeaseView;
  deviceNames: Map<string, string>;
  ended?: boolean;
  action: LeaseAction;
  onApprove: () => void;
  onRevoke: () => void;
}) {
  const visitor = lease.visitor_display_name || lease.visitor_id;
  const names =
    lease.devices && lease.devices.length > 0
      ? lease.devices.map((d) => d.name)
      : Array.from(new Set(lease.refs.map((r) => deviceNames.get(r.device_id) ?? r.device_id)));
  const uses = lease.quota != null ? `${lease.used} / ${lease.quota} uses` : `${lease.used} uses · unlimited`;
  const busy = action.busy !== null;

  return (
    <article
      className={cx(
        "ghost-glass flex h-full min-w-0 flex-col gap-4 rounded-card p-5",
        ended && "opacity-75",
        lease.state === "active" && !ended && "shadow-card ring-1 ring-mint/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cx(labelCls, "mb-0.5")}>Visitor</div>
          <div className="truncate font-serif text-heading text-fg" title={visitor}>
            {visitor}
          </div>
          {lease.visitor_display_name && (
            <div className="truncate font-mono text-label text-fg-3" title={lease.visitor_id}>
              {lease.visitor_id}
            </div>
          )}
        </div>
        <LeaseStateBadge state={lease.state} />
      </div>

      <div className="min-w-0">
        <div className={cx(labelCls, "mb-1")}>{names.length > 1 ? "Devices" : "Device"}</div>
        <div className="truncate text-body-sm text-fg-2">{names.join(", ") || "—"}</div>
        {lease.refs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lease.refs.map((r) => (
              <Chip key={`${r.device_id}/${r.capability_id}`} title={`${r.device_id}/${r.capability_id}`}>
                {r.capability_id}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-tile bg-surface-2 p-4">
        <div className="col-span-2 min-w-0">
          <dt className={cx(labelCls, "mb-0.5")}>Time remaining</dt>
          <dd className="font-display text-title text-fg">
            {ended ? (
              <span className="text-fg-3">—</span>
            ) : (
              <Countdown
                to={lease.ends_at}
                pendingLabel={lease.state === "reserved" ? "Not started" : "—"}
                className={lease.ends_at ? undefined : "font-sans text-body-sm text-fg-3"}
              />
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={cx(labelCls, "mb-0.5")}>Uses</dt>
          <dd className="truncate text-body-sm font-medium text-fg tabular-nums">{uses}</dd>
        </div>
        <div className="min-w-0">
          <dt className={cx(labelCls, "mb-0.5")}>Price</dt>
          <dd className="text-body-sm font-medium text-fg tabular-nums">
            {lease.price_cents > 0 ? (
              <>
                {formatCents(lease.price_cents)}
                <span className="block text-caption font-normal text-fg-3">Test payment</span>
              </>
            ) : (
              "Free"
            )}
          </dd>
        </div>
      </dl>

      {ended ? (
        <p className="text-body-sm text-fg-2">
          {lease.state === "revoked"
            ? "Access stopped. The visitor's lease is revoked and the device was told to stop."
            : lease.reason || "This lease has ended."}
        </p>
      ) : (
        <div className="mt-auto flex flex-col gap-2 sm:flex-row">
          {lease.state === "reserved" && (
            <button
              type="button"
              className={cx(btnPrimaryLg, "sm:flex-1")}
              onClick={onApprove}
              disabled={busy}
              aria-busy={action.busy === "approve" || undefined}
            >
              <Icon
                icon={action.busy === "approve" ? LoaderCircle : Check}
                size={18}
                spring="snappy"
                className={action.busy === "approve" ? "animate-spin" : undefined}
              />
              {action.busy === "approve" ? "Approving…" : "Approve"}
            </button>
          )}
          <button
            type="button"
            className={cx(btnStop, "sm:flex-1")}
            onClick={() => {
              haptic();
              onRevoke();
            }}
            disabled={busy}
            aria-busy={action.busy === "revoke" || undefined}
          >
            <Icon
              icon={action.busy === "revoke" ? LoaderCircle : OctagonX}
              size={20}
              strokeWidth={2.1}
              spring="snappy"
              className={action.busy === "revoke" ? "animate-spin" : undefined}
            />
            {action.busy === "revoke" ? "Stopping…" : "Stop access"}
          </button>
        </div>
      )}

      <div aria-live="polite" className="empty:-mt-4">
        {action.error && <InlineError>{action.error}</InlineError>}
        {action.message && !action.error && (
          <p className="flex items-center gap-1.5 text-body-sm font-medium text-mint">
            <Icon icon={Check} size={16} /> {action.message}
          </p>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Pairing                                                             */
/* ------------------------------------------------------------------ */

type PublishState =
  | { kind: "closed" }
  | { kind: "creating" }
  | { kind: "error"; message: string }
  | { kind: "open"; pairing: PairingResponse; joinUrl: string; confirmed: boolean };

function PairingCode({ code }: { code: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="sr-only">{code.split("").join(" ")}</span>
      {code.split("").map((ch, i) => (
        <span
          key={i}
          aria-hidden
          className="grid h-14 w-11 place-items-center rounded-tile bg-surface font-mono text-title font-medium text-fg ring-1 ring-line ring-inset sm:h-16 sm:w-12"
        >
          {ch}
        </span>
      ))}
    </div>
  );
}

function PairingDetails({
  pairing,
  joinUrl,
  confirmed,
  presented,
  onNew,
}: {
  pairing: PairingResponse;
  joinUrl: string;
  confirmed: boolean;
  presented: boolean;
  onNew: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const now = useNow();
  const expired = !confirmed && now !== 0 && Date.parse(pairing.expires_at) <= now;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the link stays selectable */
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-8">
      <div
        className={cx(
          "mx-auto rounded-tile bg-white p-3 text-fg shadow-card transition-opacity duration-200 md:mx-0",
          expired && "opacity-30",
        )}
      >
        <QRCodeSVG
          value={joinUrl}
          size={184}
          level="M"
          bgColor="transparent"
          fgColor="currentColor"
          marginSize={1}
          title={`Join link ${joinUrl}`}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-5 md:pr-10">
        <div>
          <h2 className="font-serif text-heading text-fg">Publish a device</h2>
          <p className="mt-1 text-body-sm text-fg-2">
            Scan the QR on the phone or machine that holds the hardware, or open the link and enter the code. You
            confirm it here before anything goes live.
          </p>
        </div>
        <div>
          <div className={cx(labelCls, "mb-2")}>Pairing code</div>
          <PairingCode code={pairing.code} />
        </div>
        <div className="min-w-0">
          <div className={cx(labelCls, "mb-1.5")}>Join link</div>
          <div className="flex items-center gap-2">
            <a
              href={joinUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate font-mono text-body-sm text-fg-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg hover:decoration-fg-3"
            >
              {joinUrl}
            </a>
            <button type="button" onClick={() => void copy()} className={cx(btnSecondaryBare, "shrink-0 px-3.5")}>
              <Icon icon={copied ? Check : Copy} size={15} spring="snappy" className={copied ? "text-mint" : undefined} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-live="polite">
          {confirmed ? (
            <Badge tone="mint">
              <Icon icon={Check} size={14} /> Device connected
            </Badge>
          ) : expired ? (
            <>
              <Badge tone="coral">
                <Dot shape="square" tone="coral" /> Code expired
              </Badge>
              <button type="button" className={btnSecondary} onClick={onNew}>
                <Icon icon={RefreshCw} size={16} /> New code
              </button>
            </>
          ) : (
            <>
              {presented ? (
                <Badge tone="amber" wrap>
                  <Dot shape="half" tone="amber" /> Device presented the code — confirm it under Pending devices
                </Badge>
              ) : (
                <Badge tone="amber">
                  <Dot shape="hollow" tone="amber" /> Waiting for a device to scan
                </Badge>
              )}
              <span className="text-body-sm text-fg-3">
                Expires in{" "}
                <span className="font-medium text-fg-2">
                  <Countdown to={pairing.expires_at} />
                </span>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PublishPanel({
  state,
  presented,
  onClose,
  onNew,
}: {
  state: PublishState;
  presented: boolean;
  onClose: () => void;
  onNew: () => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {state.kind !== "closed" && (
        <motion.section
          key="publish-panel"
          aria-label="Publish a device"
          className="ghost-glass relative rounded-card p-5 sm:p-6"
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: duration.fast, ease: ease.standard } }}
          transition={spring.gentle}
        >
          <button type="button" onClick={onClose} className={cx(btnIconRound, "absolute top-3 right-3")} aria-label="Close publish panel">
            <Icon icon={X} size={18} />
          </button>

          {state.kind === "creating" && (
            <div className="grid gap-6 pr-12 md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-8" aria-busy>
              <Skel className="mx-auto size-52 rounded-tile md:mx-0" />
              <div className="flex flex-col gap-3">
                <p className="flex items-center gap-2 text-body-sm text-fg-2">
                  <Icon icon={LoaderCircle} size={16} className="animate-spin" /> Creating a pairing code…
                </p>
                <div className="flex gap-1.5">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skel key={i} className="h-14 w-11 rounded-tile sm:h-16 sm:w-12" />
                  ))}
                </div>
                <Skel className="h-4 w-3/4" />
              </div>
            </div>
          )}

          {state.kind === "error" && (
            <div className="flex flex-col gap-3 pr-12">
              <InlineError>Couldn&apos;t create a pairing code: {state.message}</InlineError>
              <div>
                <button type="button" className={btnSecondary} onClick={onNew}>
                  <Icon icon={RefreshCw} size={16} /> Try again
                </button>
              </div>
            </div>
          )}

          {state.kind === "open" && (
            <PairingDetails
              key={state.pairing.pairing_id}
              pairing={state.pairing}
              joinUrl={state.joinUrl}
              confirmed={state.confirmed}
              presented={presented}
              onNew={onNew}
            />
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function PendingPairingRow({ pairing, onDone }: { pairing: PairingInfo; onDone: () => void }) {
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: "confirm" | "reject") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "confirm") await confirmPairing(pairing.pairing_id);
      else await rejectPairing(pairing.pairing_id);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.li
      className="ghost-glass flex flex-col gap-3 rounded-card p-4 shadow-card ring-1 ring-amber/25"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.gentle}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-serif text-heading text-fg">{pairing.label || "Unnamed connector"}</div>
          <div className="truncate text-caption text-fg-3">
            {pairing.connector_kind ? humanize(pairing.connector_kind) : "unknown kind"}
          </div>
        </div>
        <Badge tone="amber">
          <Dot shape="hollow" tone="amber" /> Waiting for you
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-tile bg-surface-2 px-3 py-2 text-body-sm">
        <span className="text-fg-3">
          Code <span className="font-mono font-medium tracking-[0.2em] text-fg">{pairing.code}</span>
        </span>
        <span className="text-fg-3">
          Expires in{" "}
          <span className="font-medium text-fg-2">
            <Countdown to={pairing.expires_at} expiredLabel="expired" />
          </span>
        </span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className={cx(btnPrimary, "flex-1")}
          disabled={busy !== null}
          onClick={() => void act("confirm")}
          aria-busy={busy === "confirm" || undefined}
        >
          <Icon
            icon={busy === "confirm" ? LoaderCircle : Check}
            size={16}
            spring="snappy"
            className={busy === "confirm" ? "animate-spin" : undefined}
          />
          Confirm
        </button>
        <button
          type="button"
          className={cx(btnSecondary, "flex-1")}
          disabled={busy !== null}
          onClick={() => void act("reject")}
          aria-busy={busy === "reject" || undefined}
        >
          <Icon
            icon={busy === "reject" ? LoaderCircle : X}
            size={16}
            spring="snappy"
            className={busy === "reject" ? "animate-spin" : undefined}
          />
          Reject
        </button>
      </div>
      {error && <InlineError>{error}</InlineError>}
    </motion.li>
  );
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

const LEDGER_KIND_LABEL: Record<LedgerEntry["kind"], string> = {
  grant: "Test grant",
  lease_payment: "Lease payment",
  lease_income: "Lease income",
  refund: "Refund",
  compensation: "Compensation",
};

function LedgerPanel({
  ledger,
  fallbackBalance,
  loading,
}: {
  ledger: LedgerResponse | null;
  fallbackBalance: number | null;
  /** First load, before the coordinator has answered: show skeletons, not "empty". */
  loading?: boolean;
}) {
  const balance = ledger?.balance_cents ?? fallbackBalance;
  const entries = useMemo(
    () => (ledger ? [...ledger.entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) : []),
    [ledger],
  );
  return (
    <div className="ghost-glass rounded-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cx(labelCls, "mb-1")}>Balance</div>
          {loading && balance == null ? (
            <Skel className="mt-1 h-8 w-32" />
          ) : (
            <div className="truncate font-display text-title text-fg tabular-nums">
              {balance != null ? formatCents(balance) : "—"}
            </div>
          )}
        </div>
        <Badge tone="ivory">
          <Icon icon={Wallet} size={14} /> Test funds
        </Badge>
      </div>
      <p className="mt-4 rounded-tile bg-surface-2 px-3 py-2.5 text-caption text-fg-2">{ledger?.label || DEV_LEDGER_LABEL}</p>
      <div className="mt-5 mb-1 text-body-sm font-medium text-fg">Entries</div>
      {loading && entries.length === 0 ? (
        <ul aria-hidden className="divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skel className="h-3.5 w-28" />
                <Skel className="h-3 w-40 max-w-full" />
              </div>
              <Skel className="h-3.5 w-14" />
            </li>
          ))}
        </ul>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <Illustration name="wallet" size={48} fallback={Wallet} />
          <p className="font-serif text-heading text-fg">No ledger entries yet</p>
          <p className="text-body-sm text-fg-3">Test grants and lease income will show up here.</p>
        </div>
      ) : (
        <ul className="ghost-scroll -mx-1 max-h-96 divide-y divide-line overflow-y-auto px-1">
          {entries.map((e) => (
            <li key={e.entry_id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 text-body-sm font-medium text-fg">
                  <span>{LEDGER_KIND_LABEL[e.kind] ?? humanize(e.kind)}</span>
                  <span className="text-caption font-normal text-fg-3 tabular-nums">{formatTime(e.created_at)}</span>
                </div>
                <div className="truncate text-caption text-fg-3" title={e.label}>
                  {e.label}
                </div>
              </div>
              <div
                className={cx(
                  "shrink-0 text-body-sm font-medium tabular-nums",
                  e.amount_cents > 0 ? "text-mint" : e.amount_cents < 0 ? "text-fg-2" : "text-fg-3",
                )}
              >
                {e.amount_cents > 0 ? "+" : ""}
                {formatCents(e.amount_cents)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

type Reach = "loading" | "ok" | "down";
type SectionKey = "devices" | "pairings" | "leases" | "ledger";

function upsertDevice(list: DevicesResponseItem[], d: Device): DevicesResponseItem[] {
  const i = list.findIndex((x) => x.device_id === d.device_id);
  if (i === -1) return [...list, d];
  const next = list.slice();
  next[i] = { ...list[i], ...d };
  return next;
}

export default function OwnerConsolePage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [devices, setDevices] = useState<DevicesResponseItem[]>([]);
  const [pairings, setPairings] = useState<PairingInfo[]>([]);
  const [leases, setLeases] = useState<LeaseView[]>([]);
  const [ended, setEnded] = useState<LeaseView[]>([]);
  const [leaseActions, setLeaseActions] = useState<Record<string, LeaseAction>>({});
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [reach, setReach] = useState<Reach>("loading");
  const [reachError, setReachError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SectionKey, string>>>({});
  const [stream, setStream] = useState<"connecting" | "open" | "reconnecting">("connecting");
  const [publish, setPublish] = useState<PublishState>({ kind: "closed" });
  const [retrying, setRetrying] = useState(false);

  const meIdRef = useRef<string | null>(null);
  const leasesRef = useRef<LeaseView[]>([]);
  const endedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    leasesRef.current = leases;
  }, [leases]);

  useEffect(() => {
    const timers = endedTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const setSectionError = useCallback((k: SectionKey, v: string | null) => {
    setErrors((prev) => {
      if ((prev[k] ?? null) === v) return prev;
      const next = { ...prev };
      if (v === null) delete next[k];
      else next[k] = v;
      return next;
    });
  }, []);

  /* ---- fetchers ---- */

  const refetchDevices = useCallback(async () => {
    try {
      const d = await listDevices({ mine: true });
      setDevices(d);
      setSectionError("devices", null);
    } catch (e) {
      setSectionError("devices", errMsg(e));
    }
  }, [setSectionError]);

  const refetchPairings = useCallback(async () => {
    try {
      const p = await listPairings({ pending: true });
      setPairings(p);
      setSectionError("pairings", null);
    } catch (e) {
      setSectionError("pairings", errMsg(e));
    }
  }, [setSectionError]);

  const refetchLeases = useCallback(async () => {
    try {
      const l = await listLeases({ role: "owner", active: true });
      setLeases(l.filter(isActiveLease));
      setSectionError("leases", null);
    } catch (e) {
      setSectionError("leases", errMsg(e));
    }
  }, [setSectionError]);

  const refetchLedger = useCallback(async () => {
    try {
      const lg = await getLedger();
      setLedger(lg);
      setSectionError("ledger", null);
    } catch (e) {
      setSectionError("ledger", errMsg(e));
    }
  }, [setSectionError]);

  const loadAll = useCallback(async () => {
    try {
      const m = await getMe();
      meIdRef.current = m.principal_id;
      setMe(m);
      setReach("ok");
      setReachError(null);
    } catch (e) {
      setReach("down");
      setReachError(errMsg(e));
      return;
    }
    await Promise.all([refetchDevices(), refetchPairings(), refetchLeases(), refetchLedger()]);
  }, [refetchDevices, refetchPairings, refetchLeases, refetchLedger]);

  /* ---- initial load + 10 s polling fallback ---- */
  useEffect(() => {
    const kick = setTimeout(() => void loadAll(), 0);
    const t = setInterval(() => void loadAll(), POLL_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [loadAll]);

  /* ---- ended leases linger briefly so the owner sees the outcome ---- */
  const showEnded = useCallback((l: LeaseView) => {
    setEnded((prev) => [l, ...prev.filter((x) => x.lease_id !== l.lease_id)]);
    const timers = endedTimers.current;
    const old = timers.get(l.lease_id);
    if (old) clearTimeout(old);
    timers.set(
      l.lease_id,
      setTimeout(() => {
        timers.delete(l.lease_id);
        setEnded((prev) => prev.filter((x) => x.lease_id !== l.lease_id));
      }, 8000),
    );
  }, []);

  /* ---- live events ---- */
  useEffect(() => {
    const unsubscribe = subscribeEvents(
      (e) => {
        const myId = meIdRef.current;
        switch (e.type) {
          case "device.published":
          case "device.updated":
            if (myId && e.device.owner_id === myId) setDevices((prev) => upsertDevice(prev, e.device));
            break;
          case "device.removed":
            setDevices((prev) => prev.filter((d) => d.device_id !== e.device_id));
            break;
          case "pairing.pending":
            // the publish panel's "presented" state is derived from the pairings list
            if (!myId || e.owner_id === myId) void refetchPairings();
            break;
          case "pairing.confirmed":
            setPublish((p) =>
              p.kind === "open" && p.pairing.pairing_id === e.pairing_id ? { ...p, confirmed: true } : p,
            );
            void refetchPairings();
            void refetchDevices();
            break;
          case "lease.updated": {
            const l = e.lease;
            if (!myId) {
              void refetchLeases();
              break;
            }
            if (l.owner_id !== myId) break;
            const known = leasesRef.current.find((x) => x.lease_id === l.lease_id);
            if (isActiveLease(l)) {
              setLeases((prev) => {
                const i = prev.findIndex((x) => x.lease_id === l.lease_id);
                if (i === -1) return [...prev, l];
                const next = prev.slice();
                next[i] = { ...prev[i], ...l };
                return next;
              });
              if (!known) void refetchLeases(); // pick up display names for new leases
            } else {
              setLeases((prev) => prev.filter((x) => x.lease_id !== l.lease_id));
              if (known) showEnded({ ...known, ...l });
            }
            void refetchDevices(); // active_lease_ids on devices
            break;
          }
          case "ledger.updated":
            if (myId && e.principal_id === myId) {
              setLedger((prev) => (prev ? { ...prev, balance_cents: e.balance_cents } : prev));
              setMe((prev) => (prev ? { ...prev, balance_cents: e.balance_cents } : prev));
              void refetchLedger();
            }
            break;
          default:
            break;
        }
      },
      { onStatus: setStream },
    );
    return unsubscribe;
  }, [refetchDevices, refetchPairings, refetchLeases, refetchLedger, showEnded]);

  /* ---- actions ---- */

  const startPublish = useCallback(async () => {
    setPublish({ kind: "creating" });
    try {
      const p = await createPairing();
      setPublish({ kind: "open", pairing: p, joinUrl: absoluteJoinUrl(p.join_path), confirmed: false });
      void refetchPairings();
    } catch (e) {
      setPublish({ kind: "error", message: errMsg(e) });
    }
  }, [refetchPairings]);

  const setAction = (id: string, a: Partial<LeaseAction>) =>
    setLeaseActions((prev) => ({ ...prev, [id]: { ...(prev[id] ?? NO_ACTION), ...a } }));

  const approve = async (l: LeaseView) => {
    setAction(l.lease_id, { busy: "approve", error: null, message: null });
    try {
      const { lease } = await approveLease(l.lease_id);
      setLeases((prev) => prev.map((x) => (x.lease_id === lease.lease_id ? { ...x, ...lease } : x)));
      setAction(l.lease_id, { busy: null, message: "Approved" });
    } catch (e) {
      setAction(l.lease_id, { busy: null, error: errMsg(e) });
    }
  };

  const revoke = async (l: LeaseView) => {
    setAction(l.lease_id, { busy: "revoke", error: null, message: null });
    try {
      const { lease } = await revokeLease(l.lease_id);
      setAction(l.lease_id, { busy: null });
      if (isActiveLease(lease)) {
        setLeases((prev) => prev.map((x) => (x.lease_id === lease.lease_id ? { ...x, ...lease } : x)));
      } else {
        setLeases((prev) => prev.filter((x) => x.lease_id !== lease.lease_id));
        showEnded({ ...l, ...lease });
      }
      void refetchDevices();
    } catch (e) {
      setAction(l.lease_id, { busy: null, error: errMsg(e) });
    }
  };

  const retryNow = async () => {
    setRetrying(true);
    try {
      await loadAll();
    } finally {
      setRetrying(false);
    }
  };

  /* ---- derived ---- */

  const pendingPairings = useMemo(() => pairings.filter((p) => p.status === "pending"), [pairings]);
  const deviceNames = useMemo(() => new Map(devices.map((d) => [d.device_id, d.name])), [devices]);
  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    [devices],
  );
  const presented =
    publish.kind === "open" && pairings.some((p) => p.pairing_id === publish.pairing.pairing_id && p.status === "pending");
  const balance = ledger?.balance_cents ?? me?.balance_cents ?? null;
  const onDeviceUpdated = useCallback((d: Device) => setDevices((prev) => upsertDevice(prev, d)), []);
  const onPairingDone = useCallback(() => {
    void refetchPairings();
    void refetchDevices();
  }, [refetchPairings, refetchDevices]);

  const streamMeta =
    stream === "open"
      ? { label: "Live", tone: "mint" as Tone, shape: "filled" as Shape }
      : stream === "reconnecting"
        ? { label: "Reconnecting", tone: "amber" as Tone, shape: "half" as Shape }
        : { label: "Connecting", tone: "mute" as Tone, shape: "hollow" as Shape };

  const connecting = reach === "loading" && !me;
  const publishLabel = publish.kind === "open" ? "New pairing code" : "Publish device";
  const publishDisabled = publish.kind === "creating" || reach === "down";

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pt-4 pb-14 sm:px-6 sm:pt-6 lg:px-8 lg:pb-20">
      {/* Header */}
      <header className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className={cx(btnSecondaryBare, "pr-4 pl-3")}>
            <Icon icon={ArrowLeft} size={16} />
            Back to GHOST
          </Link>
          <span
            className={cx(
              "ghost-chip inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-caption font-medium",
              TONE_TEXT[streamMeta.tone],
            )}
          >
            <Dot shape={streamMeta.shape} tone={streamMeta.tone} />
            {streamMeta.label}
          </span>
        </div>

        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <Illustration name="polty" size={64} fallback={Ghost} priority />
            <div className="min-w-0">
              <div className="hud-label mb-1">GHOST</div>
              <h1 className="font-display text-title text-fg">Owner console</h1>
              <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2.5">
                <span className="max-w-full min-w-0 truncate text-body text-fg-2">
                  {me ? me.display_name : reach === "down" ? "Not connected" : "Connecting…"}
                </span>
                {me && (
                  <span className="max-w-full min-w-0 truncate font-mono text-label text-fg-3 sm:max-w-xs" title={me.principal_id}>
                    {me.principal_id}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="ghost-chip inline-flex h-10 items-center gap-2 rounded-full px-4">
              <span className="text-caption text-fg-3">Test balance</span>
              <span className="text-body-sm font-medium text-fg tabular-nums">
                {balance != null ? formatCents(balance) : "—"}
              </span>
            </div>
            <button
              type="button"
              className={btnPrimary}
              onClick={() => void startPublish()}
              disabled={publishDisabled}
              aria-busy={publish.kind === "creating" || undefined}
            >
              <Icon
                icon={publish.kind === "creating" ? LoaderCircle : publish.kind === "open" ? QrCode : Plus}
                size={16}
                spring="snappy"
                className={publish.kind === "creating" ? "animate-spin" : undefined}
              />
              {publishLabel}
            </button>
          </div>
        </div>
      </header>

      {/* Coordinator status */}
      {reach === "down" && (
        <div
          role="alert"
          className="ghost-glass flex flex-col gap-4 rounded-card p-4 shadow-card ring-1 ring-coral/30 sm:flex-row sm:items-center sm:justify-between sm:p-5"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-coral/10 text-coral">
              <Icon icon={ServerCrash} size={20} />
            </span>
            <div className="min-w-0">
              <div className="text-body font-medium text-coral">Coordinator unreachable</div>
              <div className="text-body-sm text-fg-2">
                {reachError && reachError !== "Coordinator unreachable" ? `${reachError}. ` : ""}
                Retrying every {POLL_MS / 1000} s{me ? " — showing the last known state." : "."}
              </div>
            </div>
          </div>
          <button
            type="button"
            className={cx(btnSecondary, "self-start sm:self-auto")}
            onClick={() => void retryNow()}
            disabled={retrying}
            aria-busy={retrying || undefined}
          >
            <Icon icon={RefreshCw} size={16} className={retrying ? "animate-spin" : undefined} />
            Retry now
          </button>
        </div>
      )}
      {connecting && (
        <p className="-mt-2 flex items-center gap-2 px-1 text-body-sm text-fg-3">
          <Icon icon={LoaderCircle} size={16} className="animate-spin" /> Connecting to the coordinator…
        </p>
      )}

      <PublishPanel
        state={publish}
        presented={presented}
        onClose={() => setPublish({ kind: "closed" })}
        onNew={() => void startPublish()}
      />

      <div className="grid gap-x-8 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
        {/* Pending devices — first on mobile, top-right on desktop */}
        <section aria-labelledby="pending-h" className="min-w-0 lg:col-start-2 lg:row-start-1">
          <SectionHeader id="pending-h" title="Pending devices" count={pendingPairings.length} hint="Confirm before it goes live" />
          {errors.pairings && (
            <div className="mb-3 px-1">
              <InlineError>{errors.pairings}</InlineError>
            </div>
          )}
          {connecting ? (
            <PendingSkeleton />
          ) : pendingPairings.length === 0 ? (
            <EmptyState illustration="phone" fallback={Smartphone} size={48} title="Nothing to confirm">
              No devices waiting for confirmation. Use “Publish device” to pair one.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {pendingPairings.map((p) => (
                <PendingPairingRow key={p.pairing_id} pairing={p} onDone={onPairingDone} />
              ))}
            </ul>
          )}
        </section>

        {/* Active leases */}
        <section aria-labelledby="leases-h" className="min-w-0 lg:col-start-1 lg:row-start-1">
          <SectionHeader id="leases-h" title="Active leases" count={leases.length} hint="Visitors using your devices" />
          {errors.leases && (
            <div className="mb-3 px-1">
              <InlineError>{errors.leases}</InlineError>
            </div>
          )}
          {connecting ? (
            <div className={CARD_GRID}>
              <CardSkeleton />
            </div>
          ) : leases.length === 0 && ended.length === 0 ? (
            <EmptyState illustration="key" fallback={KeyRound} title="No active leases">
              No one is using your devices right now.
            </EmptyState>
          ) : (
            <div className={CARD_GRID}>
              {leases.map((l, i) => (
                <Appear key={l.lease_id} index={i}>
                  <LeaseCard
                    lease={l}
                    deviceNames={deviceNames}
                    action={leaseActions[l.lease_id] ?? NO_ACTION}
                    onApprove={() => void approve(l)}
                    onRevoke={() => void revoke(l)}
                  />
                </Appear>
              ))}
              {ended.map((l, i) => (
                <Appear key={`ended-${l.lease_id}`} index={leases.length + i}>
                  <LeaseCard
                    lease={l}
                    deviceNames={deviceNames}
                    ended
                    action={NO_ACTION}
                    onApprove={() => {}}
                    onRevoke={() => {}}
                  />
                </Appear>
              ))}
            </div>
          )}
        </section>

        {/* My devices */}
        <section aria-labelledby="devices-h" className="min-w-0 lg:col-start-1 lg:row-start-2 lg:row-span-2">
          <SectionHeader
            id="devices-h"
            title="My devices"
            count={devices.length}
            hint={`${devices.filter((d) => d.online).length} online`}
          />
          {errors.devices && (
            <div className="mb-3 px-1">
              <InlineError>{errors.devices}</InlineError>
            </div>
          )}
          {connecting ? (
            <div className={CARD_GRID}>
              <CardSkeleton tall />
              <CardSkeleton tall />
            </div>
          ) : sortedDevices.length === 0 ? (
            <EmptyState
              illustration="satellite"
              fallback={SatelliteDish}
              title="No devices yet"
              action={
                <button type="button" className={btnPrimary} onClick={() => void startPublish()} disabled={publishDisabled}>
                  <Icon
                    icon={publish.kind === "creating" ? LoaderCircle : publish.kind === "open" ? QrCode : Plus}
                    size={16}
                    spring="snappy"
                    className={publish.kind === "creating" ? "animate-spin" : undefined}
                  />
                  {publishLabel}
                </button>
              }
            >
              Publish one and scan the code with the phone or computer that holds the hardware.
            </EmptyState>
          ) : (
            <div className={CARD_GRID}>
              {sortedDevices.map((d, i) => (
                <Appear key={d.device_id} index={i}>
                  <DeviceCard device={d} onUpdated={onDeviceUpdated} />
                </Appear>
              ))}
            </div>
          )}
        </section>

        {/* Ledger */}
        <section aria-labelledby="ledger-h" className="min-w-0 lg:col-start-2 lg:row-start-2">
          <SectionHeader id="ledger-h" title="Ledger" hint="Test funds" />
          {errors.ledger && (
            <div className="mb-3 px-1">
              <InlineError>{errors.ledger}</InlineError>
            </div>
          )}
          <LedgerPanel ledger={ledger} fallbackBalance={me?.balance_cents ?? null} loading={connecting} />
        </section>
      </div>
    </main>
  );
}

