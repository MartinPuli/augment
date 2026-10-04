"use client";
/**
 * PairPhoneWidget — shows a one-use QR code that opens /join on a phone, waits for the phone to
 * present the code, then lets the owner Confirm / Reject it. Regenerates the code on expiry.
 */
import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, LoaderCircle, RefreshCw, ShieldAlert, Smartphone, TriangleAlert, X } from "lucide";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingResponse } from "@/lib/ghost/contracts";
import { absoluteJoinUrl, confirmPairing, createPairing, rejectPairing, subscribeEvents } from "@/lib/connector/http";
import { Icon } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
import { duration, ease, haptic, spring } from "@/components/ui/motion";
import type { WidgetComponentProps } from "../types";

type Status = "creating" | "waiting" | "pending" | "confirming" | "paired" | "rejected" | "error";

const RING = 2 * Math.PI * 21;

export default function PairPhoneWidget({ report, emit }: WidgetComponentProps<Record<string, never>>) {
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [status, setStatus] = useState<Status>("creating");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ label: string; kind: string } | null>(null);
  const [published, setPublished] = useState<{ name: string; caps: string[] } | null>(null);
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState(false);
  const [localhostWarning, setLocalhostWarning] = useState(false);
  const connectorRef = useRef<string | null>(null);
  const pairingRef = useRef<PairingResponse | null>(null);
  const labelRef = useRef<string>("phone");
  const emittedPublish = useRef(false);
  const statusRef = useRef<Status>("creating");
  // emit/report may change identity every render: keep them in refs so the SSE stream isn't resubscribed.
  const emitRef = useRef(emit);
  const reportRef = useRef(report);
  useEffect(() => {
    statusRef.current = status;
    emitRef.current = emit;
    reportRef.current = report;
  });

  const regenerate = useCallback(() => {
    setStatus("creating");
    setError(null);
    setPending(null);
    createPairing().then(
      (p) => {
        pairingRef.current = p;
        setPairing(p);
        setStatus("waiting");
        setNow(Date.now());
      },
      (e: unknown) => {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, []);

  // initial pairing + environment checks (async → no synchronous setState in the effect body)
  useEffect(() => {
    const t = setTimeout(() => {
      const host = window.location.hostname;
      const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
      setLocalhostWarning(local && !process.env.NEXT_PUBLIC_PUBLIC_ORIGIN);
      regenerate();
    }, 0);
    return () => clearTimeout(t);
  }, [regenerate]);

  // countdown tick + regenerate on expiry while nobody has scanned it
  useEffect(() => {
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      const p = pairingRef.current;
      if (p && statusRef.current === "waiting" && Date.parse(p.expires_at) <= n) regenerate();
    }, 250);
    return () => clearInterval(t);
  }, [regenerate]);

  // coordinator events
  useEffect(() => {
    return subscribeEvents((e) => {
      const p = pairingRef.current;
      if (e.type === "pairing.pending" && p && e.pairing_id === p.pairing_id) {
        labelRef.current = e.label || "phone";
        setPending({ label: e.label || "Unnamed phone", kind: e.connector_kind });
        setStatus((s) => (s === "confirming" || s === "paired" ? s : "pending"));
      } else if (e.type === "pairing.confirmed" && p && e.pairing_id === p.pairing_id) {
        connectorRef.current = e.connector_id;
        setStatus("paired");
      } else if ((e.type === "device.published" || e.type === "device.updated") && connectorRef.current && e.device.connector_id === connectorRef.current) {
        const caps = e.device.capabilities.map((c) => c.capability_id);
        setPublished({ name: e.device.name, caps });
        if (!emittedPublish.current && caps.length) {
          emittedPublish.current = true;
          emitRef.current(`Phone '${e.device.name}' published ${caps.length} capabilities (device_id ${e.device.device_id}): ${caps.join(", ")}`);
        }
      }
    });
  }, []);

  useEffect(() => {
    reportRef.current({ status, pairing_id: pairing?.pairing_id ?? null, phone_label: pending?.label ?? null, published_capabilities: published?.caps ?? [] });
  }, [status, pairing?.pairing_id, pending?.label, published]);

  const onConfirm = async () => {
    if (!pairing) return;
    setStatus("confirming");
    try {
      await confirmPairing(pairing.pairing_id);
      setStatus("paired");
      emitRef.current(`User confirmed phone '${labelRef.current}' — it is now paired`);
    } catch (e) {
      setStatus("pending");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onReject = async () => {
    if (!pairing) return;
    try {
      await rejectPairing(pairing.pairing_id);
    } catch {}
    setStatus("rejected");
    setPending(null);
  };

  const url = pairing ? absoluteJoinUrl(pairing.join_path) : "";
  const remainingMs = pairing && now ? Math.max(0, Date.parse(pairing.expires_at) - now) : 0;
  const frac = pairing ? Math.min(1, remainingMs / 120_000) : 0;
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000)
    .toString()
    .padStart(2, "0");

  const fade = { duration: duration.base, ease: ease.standard };
  const primaryBtn =
    "inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-fg px-4 text-body-sm font-medium text-fg-inverse transition-opacity duration-150 ease-standard hover:opacity-90";

  return (
    <div className="flex flex-col gap-4">
      <AnimatePresence mode="wait" initial={false}>
        {(status === "creating" || status === "waiting" || status === "error") && (
          <motion.div
            key="qr"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={fade}
            className="flex flex-col items-center gap-5 sm:flex-row sm:items-center"
          >
            <div className="relative shrink-0 rounded-card bg-white p-3 shadow-card">
              {pairing && status === "waiting" ? (
                <motion.div key={pairing.code} initial={{ opacity: 0, filter: "blur(6px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} transition={fade}>
                  <QRCodeSVG value={url} size={148} bgColor="#ffffff" fgColor="#151513" level="M" marginSize={1} className="rounded-tile" />
                </motion.div>
              ) : status === "error" ? (
                <div className="grid h-[148px] w-[148px] place-items-center rounded-tile bg-coral/10 text-coral">
                  <Icon icon={TriangleAlert} size={28} />
                </div>
              ) : (
                <div aria-hidden className="ghost-skeleton h-[148px] w-[148px] rounded-tile" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-center text-center sm:items-start sm:text-left">
              <Illustration name="phone" size={48} fallback={Smartphone} className="mb-2" />
              <h3 className="font-serif text-heading text-fg">Lend Polty your phone</h3>
              <p className="mt-1 text-body-sm text-fg-2">
                Open the camera app and point it at the code. You&apos;ll confirm the phone here before anything is shared.
              </p>
              {status === "error" ? (
                <div className="mt-3 flex flex-col items-center gap-3 sm:items-start">
                  <p className="text-body-sm text-coral">Couldn&apos;t create a pairing code: {error}</p>
                  <button onClick={regenerate} className={primaryBtn}>
                    <Icon icon={RefreshCw} size={15} /> Try again
                  </button>
                </div>
              ) : pairing ? (
                <div className="mt-4 flex items-center gap-3">
                  <svg width="44" height="44" viewBox="0 0 50 50" className="shrink-0 -rotate-90" aria-hidden>
                    <circle cx="25" cy="25" r="21" fill="none" className="stroke-line-strong" strokeWidth="3" />
                    <circle
                      cx="25"
                      cy="25"
                      r="21"
                      fill="none"
                      className={clsx("transition-[stroke-dashoffset,stroke] duration-200 ease-linear", frac < 0.2 ? "stroke-amber" : "stroke-mint")}
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeDasharray={RING}
                      strokeDashoffset={RING * (1 - frac)}
                    />
                  </svg>
                  <div className="min-w-0 text-left">
                    <p className="font-mono text-title font-medium tracking-[0.2em] text-fg">{pairing.code}</p>
                    <p className={clsx("text-caption tabular-nums", frac < 0.2 ? "text-amber" : "text-fg-3")}>
                      Expires in {mm}:{ss}, then a new code appears
                    </p>
                  </div>
                </div>
              ) : (
                <div aria-hidden className="mt-4 flex items-center gap-3">
                  <span className="ghost-skeleton h-11 w-11 rounded-full" />
                  <span className="flex flex-col gap-1.5">
                    <span className="ghost-skeleton h-6 w-28 rounded-full" />
                    <span className="ghost-skeleton h-3 w-40 rounded-full" />
                  </span>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {(status === "pending" || status === "confirming") && pending && (
          <motion.div key="pending" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={fade} className="flex flex-col gap-4">
            <div className="flex items-center gap-4 rounded-tile bg-amber/10 p-4">
              <div className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full bg-surface text-amber">
                <span className="absolute inset-0 animate-pulse-ring rounded-full border border-amber/40" />
                <Icon icon={Smartphone} size={22} />
              </div>
              <div className="min-w-0">
                <p className="text-caption font-medium text-amber">Wants to pair · waiting for you</p>
                <p className="truncate font-serif text-title text-fg">{pending.label}</p>
                <p className="truncate text-caption text-fg-3">
                  {pending.kind} · code <span className="font-mono">{pairing?.code}</span>
                </p>
              </div>
            </div>
            <p className="flex items-start gap-2 text-body-sm text-fg-2">
              <Icon icon={ShieldAlert} size={16} className="mt-0.5 shrink-0 text-fg-3" />
              <span>
                Only confirm if this is a phone you&apos;re holding. Confirming lets it publish sensors to your account; the phone still chooses which ones.
              </span>
            </p>
            {error && <p className="text-body-sm text-coral">{error}</p>}
            <div className="grid grid-cols-2 gap-2">
              <motion.button
                whileTap={{ scale: 0.97 }}
                transition={spring.snappy}
                onClick={() => {
                  haptic();
                  void onReject();
                }}
                className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-tint text-body font-medium text-fg-2 transition-colors duration-150 ease-standard hover:bg-coral/10 hover:text-coral"
              >
                <Icon icon={X} size={16} /> Reject
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.97 }}
                transition={spring.snappy}
                onClick={() => {
                  haptic();
                  void onConfirm();
                }}
                disabled={status === "confirming"}
                className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-mint text-body font-medium text-fg-inverse shadow-pop transition-colors duration-150 ease-standard hover:bg-mint-deep disabled:cursor-wait disabled:opacity-60"
              >
                <Icon icon={status === "confirming" ? LoaderCircle : Check} size={16} spring="snappy" className={clsx(status === "confirming" && "animate-spin")} />
                Confirm
              </motion.button>
            </div>
          </motion.div>
        )}

        {status === "paired" && (
          <motion.div key="paired" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={fade} className="flex items-center gap-4 rounded-tile bg-mint/10 p-4">
            <motion.div
              initial={{ scale: 0.4, rotate: -20 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={spring.bouncy}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-mint text-fg-inverse"
            >
              <Icon icon={Check} size={24} strokeWidth={2.6} />
            </motion.div>
            <div className="min-w-0">
              <p className="text-caption font-medium text-mint">Paired · confirmed</p>
              <p className="truncate font-serif text-title text-fg">{pending?.label ?? "Phone"}</p>
              <p className="break-words text-body-sm text-fg-2">
                {published
                  ? `Published ${published.caps.length} capabilities: ${published.caps.join(", ")}`
                  : "Now choose sensors on the phone and tap Publish device."}
              </p>
            </div>
          </motion.div>
        )}

        {status === "rejected" && (
          <motion.div
            key="rejected"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={fade}
            className="flex flex-col items-start gap-3 rounded-tile bg-coral/10 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-body-sm text-coral">Pairing rejected. That phone can&apos;t use this code.</p>
            <button onClick={regenerate} className={primaryBtn}>
              <Icon icon={RefreshCw} size={15} /> New code
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {(status === "waiting" || status === "creating") && (
        <div className="flex min-w-0 items-center gap-2 rounded-full bg-tint py-1 pl-4 pr-1">
          <p className="min-w-0 flex-1 truncate font-mono text-caption text-fg-3" title={url}>
            {url ? url.replace(/#code=.*/, "#code=••••••") : "…"}
          </p>
          <button
            disabled={!url}
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => {
                haptic();
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              });
            }}
            className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full bg-surface px-3.5 text-caption font-medium text-fg-2 shadow-pop transition-colors duration-150 ease-standard hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon icon={copied ? Check : Copy} size={14} spring="snappy" className={clsx(copied && "text-mint")} />
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {localhostWarning && (status === "waiting" || status === "creating") && (
        <p className="flex items-start gap-2 rounded-tile bg-amber/10 px-3 py-2.5 text-body-sm text-amber">
          <Icon icon={TriangleAlert} size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            This QR points at localhost, which your phone can&apos;t reach — and the camera needs HTTPS. Set{" "}
            <code className="break-all font-mono text-caption">NEXT_PUBLIC_PUBLIC_ORIGIN</code> to the public HTTPS URL (Fly.io / tunnel).
          </span>
        </p>
      )}
    </div>
  );
}
