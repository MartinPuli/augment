"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
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
  ServerCrash,
  Smartphone,
  Speaker,
  Thermometer,
  ToggleLeft,
  Wallet,
  Watch,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
  mute: "text-mute",
  ivory: "text-ivory-dim",
};
const TONE_BADGE: Record<Tone, string> = {
  mint: "border-mint/30 bg-mint/10 text-mint",
  amber: "border-amber/30 bg-amber/10 text-amber",
  coral: "border-coral/35 bg-coral/10 text-coral",
  violet: "border-violet/30 bg-violet/10 text-violet",
  mute: "border-line bg-ink-3 text-mute",
  ivory: "border-line-strong bg-ink-3 text-ivory-dim",
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

function Badge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium",
        TONE_BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-block max-w-full truncate rounded-md border border-line bg-ink-2 px-2 py-0.5 font-mono text-[11px] text-ivory-dim"
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
    return <span className={cx("font-mono tabular-nums", className)}>{pendingLabel}</span>;
  }
  const ms = target - now;
  return (
    <span className={cx("font-mono tabular-nums", ms <= 0 && "text-coral", className)}>
      {ms <= 0 ? expiredLabel : formatRemaining(ms)}
    </span>
  );
}

function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-coral">
      <OctagonX className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong px-5 py-8 text-center text-sm text-mute">
      {children}
    </div>
  );
}

function SectionHeader({ id, title, count, hint }: { id?: string; title: string; count?: number; hint?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 id={id} className="flex items-baseline gap-3 font-display text-base font-semibold tracking-wide text-ivory">
        {title}
        {typeof count === "number" && <span className="font-mono text-xs font-normal text-mute">{count}</span>}
      </h2>
      {hint && <div className="hud-label">{hint}</div>}
    </div>
  );
}

const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:cursor-not-allowed disabled:opacity-60";
const btnSm = "px-4 py-2 text-sm";
const btnMint = cx(btnBase, btnSm, "bg-mint text-ink hover:bg-mint/85 focus-visible:ring-mint/60");
const btnStop = cx(btnBase, "px-5 py-3 text-base bg-coral text-ink hover:bg-coral/85 focus-visible:ring-coral/60");
const btnGhost = cx(btnBase, btnSm, "border border-line-strong bg-ink-3 text-ivory hover:bg-ink-4 focus-visible:ring-line-strong");
const btnIvory = cx(btnBase, btnSm, "bg-ivory text-ink hover:bg-ivory-dim focus-visible:ring-ivory/50");

const inputCls =
  "w-full rounded-lg border border-line bg-ink px-3 py-2 font-mono text-sm text-ivory placeholder:text-mute focus:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-mint/30";

/* ------------------------------------------------------------------ */
/* Device presentation                                                 */
/* ------------------------------------------------------------------ */

/** Static icon per device class (a switch of elements, so no component is created during render). */
function DeviceGlyph({ device, className }: { device: Pick<Device, "device_class" | "capabilities">; className?: string }) {
  const p = { className, "aria-hidden": true } as const;
  switch (device.device_class) {
    case "camera":
      return <Camera {...p} />;
    case "light":
      return <Lightbulb {...p} />;
    case "plug":
      return <Plug {...p} />;
    case "switch":
      return <ToggleLeft {...p} />;
    case "sensor":
      return device.capabilities?.some((c) => /temp/i.test(c.semantic_type) || /temp/i.test(c.capability_id)) ? (
        <Thermometer {...p} />
      ) : (
        <Gauge {...p} />
      );
    case "instrument":
      return <Gauge {...p} />;
    case "phone":
      return <Smartphone {...p} />;
    case "computer":
    case "display":
      return <Monitor {...p} />;
    case "speaker":
    case "media":
      return <Speaker {...p} />;
    case "microphone":
      return <Mic {...p} />;
    case "robot":
      return <Bot {...p} />;
    case "printer":
      return <Printer {...p} />;
    case "wearable":
      return <Watch {...p} />;
    case "hub":
      return <Router {...p} />;
    default:
      return <Cpu {...p} />;
  }
}

const STATUS_META: Record<CatalogStatus, { label: string; tone: Tone; Icon: LucideIcon }> = {
  verified: { label: "Verified", tone: "mint", Icon: Check },
  configured: { label: "Configured", tone: "ivory", Icon: CircleDot },
  candidate: { label: "Candidate", tone: "amber", Icon: CircleDashed },
  unavailable: { label: "Unavailable", tone: "coral", Icon: Ban },
};

const ACCESS_LABEL: Record<AccessType, string> = {
  public_observation: "Public observation",
  own_device: "Own device",
  owner_shared: "Owner shared",
  provider_booked: "Provider booked",
};

function OnlineIndicator({ online }: { online: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium", online ? "text-mint" : "text-mute")}>
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
    <form onSubmit={submit} className="rounded-xl border border-line bg-ink-2/70 p-4" noValidate>
      <div className="hud-label mb-3">Terms</div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ivory-dim">Price (USD)</span>
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
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ivory-dim">Max duration (s)</span>
          <input
            className={inputCls}
            inputMode="numeric"
            name={`duration-${id}`}
            value={draft.duration}
            onChange={(e) => set("duration", e.target.value)}
            placeholder="300"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ivory-dim">Quota (uses)</span>
          <input
            className={inputCls}
            inputMode="numeric"
            name={`quota-${id}`}
            value={draft.quota}
            onChange={(e) => set("quota", e.target.value)}
            placeholder="Unlimited"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ivory-dim">Floor (USD)</span>
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
      <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm text-ivory-dim">
        <input
          type="checkbox"
          className="size-4 accent-mint"
          checked={draft.approval}
          onChange={(e) => set("approval", e.target.checked)}
        />
        Require my approval for each lease
      </label>
      <p id={`terms-help-${id}`} className="mt-2 text-[11px] text-mute">
        Blank quota = unlimited. Blank floor = the price is the floor.
      </p>
      <div className="mt-3 flex min-h-9 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1" aria-live="polite">
          {localError ? (
            <InlineError>{localError}</InlineError>
          ) : save.kind === "error" ? (
            <InlineError>{save.message}</InlineError>
          ) : save.kind === "saved" ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-mint">
              <Check className="size-4" aria-hidden /> Saved
            </span>
          ) : null}
        </div>
        <button type="submit" className={btnGhost} disabled={saving}>
          {saving ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
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
    <article className="ghost-glass flex min-w-0 flex-col gap-4 rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-ink-4">
          <DeviceGlyph device={device} className="size-5 text-ivory" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-ivory" title={device.name}>
            {device.name}
          </h3>
          <p className="truncate font-mono text-xs text-mute">
            {device.device_class} · {device.transport}
          </p>
        </div>
        <OnlineIndicator online={device.online} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge tone={status.tone}>
          <status.Icon className="size-3.5" aria-hidden />
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
        <div className="hud-label mb-2">Capabilities</div>
        {device.capabilities.length ? (
          <div className="flex flex-wrap gap-1.5">
            {device.capabilities.map((c) => (
              <Chip key={c.capability_id} title={c.title}>
                {c.capability_id}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-xs text-mute">No capabilities published.</p>
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
        "ghost-glass flex min-w-0 flex-col gap-4 rounded-2xl p-5",
        ended && "opacity-80",
        lease.state === "active" && !ended && "ring-1 ring-mint/20",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="hud-label mb-1">Visitor</div>
          <div className="truncate font-medium text-ivory" title={visitor}>
            {visitor}
          </div>
          {lease.visitor_display_name && (
            <div className="truncate font-mono text-[11px] text-mute" title={lease.visitor_id}>
              {lease.visitor_id}
            </div>
          )}
        </div>
        <LeaseStateBadge state={lease.state} />
      </div>

      <div className="min-w-0">
        <div className="hud-label mb-1.5">{names.length > 1 ? "Devices" : "Device"}</div>
        <div className="truncate text-sm text-ivory-dim">{names.join(", ") || "—"}</div>
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

      <dl className="grid grid-cols-3 gap-3 rounded-xl border border-line bg-ink-2/70 p-3">
        <div className="min-w-0">
          <dt className="hud-label mb-1">Time remaining</dt>
          <dd className="text-lg text-ivory">
            {ended ? (
              <span className="font-mono text-mute">—</span>
            ) : (
              <Countdown
                to={lease.ends_at}
                pendingLabel={lease.state === "reserved" ? "Not started" : "—"}
                className={lease.ends_at ? undefined : "text-sm text-mute"}
              />
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="hud-label mb-1">Uses</dt>
          <dd className="truncate font-mono text-sm text-ivory">{uses}</dd>
        </div>
        <div className="min-w-0">
          <dt className="hud-label mb-1">Price</dt>
          <dd className="font-mono text-sm text-ivory">
            {lease.price_cents > 0 ? (
              <>
                <span className="block text-[10px] uppercase tracking-wider text-mute">Test payment</span>
                {formatCents(lease.price_cents)}
              </>
            ) : (
              "Free"
            )}
          </dd>
        </div>
      </dl>

      {ended ? (
        <p className="text-sm text-ivory-dim">
          {lease.state === "revoked"
            ? "Access stopped. The visitor's lease is revoked and the device was told to stop."
            : lease.reason || "This lease has ended."}
        </p>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          {lease.state === "reserved" && (
            <button type="button" className={cx(btnMint, "sm:flex-1")} onClick={onApprove} disabled={busy}>
              {action.busy === "approve" ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : (
                <Check className="size-4" aria-hidden />
              )}
              {action.busy === "approve" ? "Approving…" : "Approve"}
            </button>
          )}
          <button
            type="button"
            className={cx(btnStop, "sm:flex-1")}
            onClick={onRevoke}
            disabled={busy}
          >
            {action.busy === "revoke" ? (
              <LoaderCircle className="size-5 animate-spin" aria-hidden />
            ) : (
              <OctagonX className="size-5" aria-hidden />
            )}
            {action.busy === "revoke" ? "Stopping…" : "Stop access"}
          </button>
        </div>
      )}

      <div aria-live="polite">
        {action.error && <InlineError>{action.error}</InlineError>}
        {action.message && !action.error && (
          <p className="flex items-center gap-1.5 text-sm text-mint">
            <Check className="size-4" aria-hidden /> {action.message}
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
          className="grid h-14 w-11 place-items-center rounded-lg border border-line-strong bg-ink font-mono text-3xl font-semibold text-ivory sm:h-16 sm:w-12 sm:text-4xl"
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
    <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
      <div className={cx("mx-auto rounded-2xl bg-ivory p-3 md:mx-0", expired && "opacity-30")}>
        <QRCodeSVG
          value={joinUrl}
          size={184}
          level="M"
          bgColor="#f4efe4"
          fgColor="#0a0b0e"
          marginSize={1}
          title={`Join link ${joinUrl}`}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4 md:pr-8">
        <div>
          <h2 className="font-display text-lg font-semibold text-ivory">Publish a device</h2>
          <p className="mt-1 text-sm text-ivory-dim">
            Scan the QR on the phone or machine that holds the hardware, or open the link and enter the code. You
            confirm it here before anything goes live.
          </p>
        </div>
        <div>
          <div className="hud-label mb-2">Pairing code</div>
          <PairingCode code={pairing.code} />
        </div>
        <div className="min-w-0">
          <div className="hud-label mb-1.5">Join link</div>
          <div className="flex items-center gap-2">
            <a
              href={joinUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate font-mono text-sm text-violet underline-offset-4 hover:underline"
            >
              {joinUrl}
            </a>
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ivory-dim hover:bg-ink-4"
            >
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-live="polite">
          {confirmed ? (
            <Badge tone="mint">
              <Check className="size-3.5" aria-hidden /> Device connected
            </Badge>
          ) : expired ? (
            <>
              <Badge tone="coral">
                <Dot shape="square" tone="coral" /> Code expired
              </Badge>
              <button type="button" className={btnGhost} onClick={onNew}>
                <RefreshCw className="size-4" aria-hidden /> New code
              </button>
            </>
          ) : (
            <>
              {presented ? (
                <Badge tone="amber">
                  <Dot shape="half" tone="amber" /> Device presented the code — confirm it under Pending devices
                </Badge>
              ) : (
                <Badge tone="amber">
                  <Dot shape="hollow" tone="amber" /> Waiting for a device to scan
                </Badge>
              )}
              <span className="text-sm text-mute">
                Expires in <Countdown to={pairing.expires_at} className="text-ivory-dim" />
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
  if (state.kind === "closed") return null;

  return (
    <section aria-label="Publish a device" className="ghost-glass relative rounded-2xl p-5 sm:p-6">
      <button
        type="button"
        onClick={onClose}
        className="absolute top-3 right-3 rounded-lg p-2 text-mute hover:bg-ink-4 hover:text-ivory"
        aria-label="Close publish panel"
      >
        <X className="size-4" />
      </button>

      {state.kind === "creating" && (
        <p className="flex items-center gap-2 text-sm text-ivory-dim">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Creating a pairing code…
        </p>
      )}

      {state.kind === "error" && (
        <div className="flex flex-col gap-3 pr-8">
          <InlineError>Couldn&apos;t create a pairing code: {state.message}</InlineError>
          <div>
            <button type="button" className={btnGhost} onClick={onNew}>
              <RefreshCw className="size-4" aria-hidden /> Try again
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
    </section>
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
    <li className="flex flex-col gap-3 rounded-xl border border-amber/25 bg-ink-2/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-ivory">{pairing.label || "Unnamed connector"}</div>
          <div className="truncate font-mono text-xs text-mute">
            {pairing.connector_kind ? humanize(pairing.connector_kind) : "unknown kind"}
          </div>
        </div>
        <Badge tone="amber">
          <Dot shape="hollow" tone="amber" /> Waiting for you
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <span className="text-mute">
          Code <span className="font-mono tracking-[0.2em] text-ivory">{pairing.code}</span>
        </span>
        <span className="text-mute">
          Expires in <Countdown to={pairing.expires_at} className="text-ivory-dim" expiredLabel="expired" />
        </span>
      </div>
      <div className="flex gap-2">
        <button type="button" className={cx(btnMint, "flex-1")} disabled={busy !== null} onClick={() => void act("confirm")}>
          {busy === "confirm" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
          Confirm
        </button>
        <button type="button" className={cx(btnGhost, "flex-1")} disabled={busy !== null} onClick={() => void act("reject")}>
          {busy === "reject" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <X className="size-4" aria-hidden />}
          Reject
        </button>
      </div>
      {error && <InlineError>{error}</InlineError>}
    </li>
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

function LedgerPanel({ ledger, fallbackBalance }: { ledger: LedgerResponse | null; fallbackBalance: number | null }) {
  const balance = ledger?.balance_cents ?? fallbackBalance;
  const entries = useMemo(
    () => (ledger ? [...ledger.entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) : []),
    [ledger],
  );
  return (
    <div className="ghost-glass rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="hud-label mb-1">Balance</div>
          <div className="font-mono text-3xl text-ivory tabular-nums">{balance != null ? formatCents(balance) : "—"}</div>
        </div>
        <Badge tone="violet">
          <Wallet className="size-3.5" aria-hidden /> Test funds
        </Badge>
      </div>
      <p className="mt-3 rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-xs text-ivory-dim">
        {ledger?.label || DEV_LEDGER_LABEL}
      </p>
      <div className="hud-label mt-5 mb-2">Entries</div>
      {entries.length === 0 ? (
        <p className="text-sm text-mute">No ledger entries yet.</p>
      ) : (
        <ul className="ghost-scroll -mx-1 max-h-96 divide-y divide-line overflow-y-auto px-1">
          {entries.map((e) => (
            <li key={e.entry_id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm text-ivory">
                  <span>{LEDGER_KIND_LABEL[e.kind] ?? humanize(e.kind)}</span>
                  <span className="font-mono text-[11px] text-mute">{formatTime(e.created_at)}</span>
                </div>
                <div className="truncate text-xs text-mute" title={e.label}>
                  {e.label}
                </div>
              </div>
              <div
                className={cx(
                  "shrink-0 font-mono text-sm tabular-nums",
                  e.amount_cents > 0 ? "text-mint" : e.amount_cents < 0 ? "text-ivory-dim" : "text-mute",
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

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      {/* Header */}
      <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-2.5">
              <Ghost className="size-7 text-ivory" aria-hidden />
              <span className="font-display text-2xl font-extrabold tracking-[0.18em] text-ivory">GHOST</span>
            </span>
            <span className="hud-label rounded-full border border-line px-2.5 py-1">Owner console</span>
          </div>
          <div className="mt-4 flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-lg text-ivory">
              {me ? me.display_name : reach === "down" ? "Not connected" : "Connecting…"}
            </span>
            {me && (
              <span className="max-w-xs truncate font-mono text-xs text-mute" title={me.principal_id}>
                {me.principal_id}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={cx("inline-flex items-center gap-1.5 text-xs", TONE_TEXT[streamMeta.tone])}>
            <Dot shape={streamMeta.shape} tone={streamMeta.tone} />
            {streamMeta.label}
          </span>
          <div className="flex items-baseline gap-2 rounded-xl border border-line bg-ink-2 px-3 py-2">
            <span className="hud-label">Test balance</span>
            <span className="font-mono text-sm text-ivory tabular-nums">{balance != null ? formatCents(balance) : "—"}</span>
          </div>
          <button
            type="button"
            className={btnIvory}
            onClick={() => void startPublish()}
            disabled={publish.kind === "creating" || reach === "down"}
          >
            {publish.kind === "creating" ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : publish.kind === "open" ? (
              <QrCode className="size-4" aria-hidden />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
            {publish.kind === "open" ? "New pairing code" : "Publish device"}
          </button>
        </div>
      </header>

      {/* Coordinator status */}
      {reach === "down" && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-2xl border border-coral/35 bg-coral/10 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <ServerCrash className="mt-0.5 size-5 shrink-0 text-coral" aria-hidden />
            <div>
              <div className="font-medium text-coral">Coordinator unreachable</div>
              <div className="text-sm text-ivory-dim">
                {reachError && reachError !== "Coordinator unreachable" ? `${reachError}. ` : ""}
                Retrying every {POLL_MS / 1000} s{me ? " — showing the last known state." : "."}
              </div>
            </div>
          </div>
          <button type="button" className={btnGhost} onClick={() => void retryNow()} disabled={retrying}>
            <RefreshCw className={cx("size-4", retrying && "animate-spin")} aria-hidden />
            Retry now
          </button>
        </div>
      )}
      {reach === "loading" && !me && (
        <p className="flex items-center gap-2 text-sm text-mute">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Connecting to the coordinator…
        </p>
      )}

      <PublishPanel
        state={publish}
        presented={presented}
        onClose={() => setPublish({ kind: "closed" })}
        onNew={() => void startPublish()}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
        {/* Pending devices — first on mobile, top-right on desktop */}
        <section aria-labelledby="pending-h" className="min-w-0 lg:col-start-2 lg:row-start-1">
          <SectionHeader id="pending-h" title="Pending devices" count={pendingPairings.length} hint="Confirm before it goes live" />
          {errors.pairings && <div className="mb-3"><InlineError>{errors.pairings}</InlineError></div>}
          {pendingPairings.length === 0 ? (
            <EmptyState>No devices waiting for confirmation. Use “Publish device” to pair one.</EmptyState>
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
          {errors.leases && <div className="mb-3"><InlineError>{errors.leases}</InlineError></div>}
          {leases.length === 0 && ended.length === 0 ? (
            <EmptyState>No one is using your devices right now.</EmptyState>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {leases.map((l) => (
                <LeaseCard
                  key={l.lease_id}
                  lease={l}
                  deviceNames={deviceNames}
                  action={leaseActions[l.lease_id] ?? NO_ACTION}
                  onApprove={() => void approve(l)}
                  onRevoke={() => void revoke(l)}
                />
              ))}
              {ended.map((l) => (
                <LeaseCard
                  key={`ended-${l.lease_id}`}
                  lease={l}
                  deviceNames={deviceNames}
                  ended
                  action={NO_ACTION}
                  onApprove={() => {}}
                  onRevoke={() => {}}
                />
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
          {errors.devices && <div className="mb-3"><InlineError>{errors.devices}</InlineError></div>}
          {sortedDevices.length === 0 ? (
            <EmptyState>
              You haven&apos;t published any devices yet. Press “Publish device” and scan the code with the phone or
              computer that holds the hardware.
            </EmptyState>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {sortedDevices.map((d) => (
                <DeviceCard key={d.device_id} device={d} onUpdated={onDeviceUpdated} />
              ))}
            </div>
          )}
        </section>

        {/* Ledger */}
        <section aria-labelledby="ledger-h" className="min-w-0 lg:col-start-2 lg:row-start-2">
          <SectionHeader id="ledger-h" title="Ledger" hint="Test funds" />
          {errors.ledger && <div className="mb-3"><InlineError>{errors.ledger}</InlineError></div>}
          <LedgerPanel ledger={ledger} fallbackBalance={me?.balance_cents ?? null} />
        </section>
      </div>
    </main>
  );
}
