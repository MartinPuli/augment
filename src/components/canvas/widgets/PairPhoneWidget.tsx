"use client";
/**
 * PairPhoneWidget — shows a one-use QR code that opens /join on a phone, waits for the phone to
 * present the code, then lets the owner Confirm / Reject it. Regenerates the code on expiry.
 */
import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, LoaderCircle, RefreshCw, ShieldAlert, Smartphone, TriangleAlert, X } from "lucide-react";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingResponse } from "@/lib/ghost/contracts";
import { absoluteJoinUrl, confirmPairing, createPairing, rejectPairing, subscribeEvents } from "@/lib/connector/http";
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
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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
          emit(`Phone '${e.device.name}' published ${caps.length} capabilities (device_id ${e.device.device_id}): ${caps.join(", ")}`);
        }
      }
    });
  }, [emit]);

  useEffect(() => {
    report({ status, pairing_id: pairing?.pairing_id ?? null, phone_label: pending?.label ?? null, published_capabilities: published?.caps ?? [] });
  }, [status, pairing?.pairing_id, pending?.label, published, report]);

  const onConfirm = async () => {
    if (!pairing) return;
    setStatus("confirming");
    try {
      await confirmPairing(pairing.pairing_id);
      setStatus("paired");
      emit(`User confirmed phone '${labelRef.current}' — it is now paired`);
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

  return (
    <div className="flex flex-col gap-4 p-1">
      <AnimatePresence mode="wait">
        {(status === "creating" || status === "waiting" || status === "error") && (
          <motion.div key="qr" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} className="flex items-center gap-5">
            <div className="relative shrink-0 rounded-[22px] bg-ink-3 p-3 ring-1 ring-line">
              {pairing && status === "waiting" ? (
                <motion.div key={pairing.code} initial={{ opacity: 0, filter: "blur(6px)" }} animate={{ opacity: 1, filter: "blur(0px)" }}>
                  <QRCodeSVG value={url} size={148} bgColor="#181b22" fgColor="#f4efe4" level="M" marginSize={1} className="rounded-xl" />
                </motion.div>
              ) : (
                <div className="grid h-[148px] w-[148px] place-items-center">
                  {status === "error" ? <TriangleAlert className="h-7 w-7 text-coral" /> : <LoaderCircle className="h-7 w-7 animate-spin text-mute" />}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="hud-label">scan with your phone</p>
              <h3 className="mt-1 font-display text-lg font-semibold leading-tight text-ivory">Lend Polty your phone</h3>
              <p className="mt-1.5 text-[13px] leading-snug text-ivory-dim">
                Open the camera app and point it at the code. You&apos;ll confirm the phone here before anything is shared.
              </p>
              {status === "error" ? (
                <div className="mt-3">
                  <p className="text-[13px] text-coral">Couldn&apos;t create a pairing code: {error}</p>
                  <button onClick={regenerate} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ivory">
                    <RefreshCw className="h-3.5 w-3.5" /> Try again
                  </button>
                </div>
              ) : (
                pairing && (
                  <div className="mt-3 flex items-center gap-3">
                    <svg width="50" height="50" viewBox="0 0 50 50" className="-rotate-90" aria-hidden>
                      <circle cx="25" cy="25" r="21" fill="none" stroke="rgb(244 239 228 / 0.1)" strokeWidth="3" />
                      <circle
                        cx="25"
                        cy="25"
                        r="21"
                        fill="none"
                        stroke={frac < 0.2 ? "#ffb547" : "#5df2b5"}
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeDasharray={RING}
                        strokeDashoffset={RING * (1 - frac)}
                        style={{ transition: "stroke-dashoffset 0.25s linear" }}
                      />
                    </svg>
                    <div>
                      <p className="font-mono text-[22px] font-semibold tracking-[0.22em] text-ivory">{pairing.code}</p>
                      <p className={clsx("font-mono text-[11px]", frac < 0.2 ? "text-amber" : "text-mute")}>
                        expires in {mm}:{ss} · then a new code
                      </p>
                    </div>
                  </div>
                )
              )}
            </div>
          </motion.div>
        )}

        {(status === "pending" || status === "confirming") && pending && (
          <motion.div key="pending" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="flex flex-col gap-4">
            <div className="flex items-center gap-4 rounded-2xl border border-amber/30 bg-amber/[0.07] p-4">
              <div className="relative grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-ink-3 text-amber">
                <span className="absolute inset-0 rounded-xl border border-amber/40 animate-pulse-ring" />
                <Smartphone className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="hud-label text-amber">wants to pair · waiting for you</p>
                <p className="truncate font-display text-lg font-semibold text-ivory">{pending.label}</p>
                <p className="font-mono text-[11px] text-mute">{pending.kind} · code {pairing?.code}</p>
              </div>
            </div>
            <p className="flex items-start gap-2 text-[12.5px] leading-snug text-ivory-dim">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-mute" />
              Only confirm if this is a phone you&apos;re holding. Confirming lets it publish sensors to your account; the phone still chooses which ones.
            </p>
            {error && <p className="text-[12.5px] text-coral">{error}</p>}
            <div className="grid grid-cols-2 gap-2">
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={onReject}
                className="flex items-center justify-center gap-2 rounded-xl border border-line-strong bg-ink-3 py-3 text-sm font-semibold text-ivory-dim hover:text-coral"
              >
                <X className="h-4 w-4" /> Reject
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={onConfirm}
                disabled={status === "confirming"}
                className="flex items-center justify-center gap-2 rounded-xl bg-mint py-3 text-sm font-semibold text-ink shadow-[0_8px_30px_-10px_rgba(93,242,181,0.7)] disabled:opacity-60"
              >
                {status === "confirming" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirm
              </motion.button>
            </div>
          </motion.div>
        )}

        {status === "paired" && (
          <motion.div key="paired" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="flex items-center gap-4 rounded-2xl border border-mint/30 bg-mint/[0.07] p-4">
            <motion.div
              initial={{ scale: 0.4, rotate: -20 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 14 }}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-mint text-ink"
            >
              <Check className="h-6 w-6" strokeWidth={3} />
            </motion.div>
            <div className="min-w-0">
              <p className="hud-label text-mint">paired · confirmed</p>
              <p className="truncate font-display text-lg font-semibold text-ivory">{pending?.label ?? "Phone"}</p>
              <p className="text-[12.5px] text-ivory-dim">
                {published
                  ? `Published ${published.caps.length} capabilities: ${published.caps.join(", ")}`
                  : "Now choose sensors on the phone and tap Publish device."}
              </p>
            </div>
          </motion.div>
        )}

        {status === "rejected" && (
          <motion.div key="rejected" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-between gap-3 rounded-2xl border border-coral/30 bg-coral/[0.07] p-4">
            <p className="text-sm text-coral">Pairing rejected. That phone can&apos;t use this code.</p>
            <button onClick={regenerate} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ivory">
              <RefreshCw className="h-3.5 w-3.5" /> New code
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {(status === "waiting" || status === "creating") && (
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <p className="min-w-0 truncate font-mono text-[11px] text-mute" title={url}>
            {url ? url.replace(/#code=.*/, "#code=••••••") : "…"}
          </p>
          <button
            disabled={!url}
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              });
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] text-ivory-dim hover:text-ivory"
          >
            {copied ? <Check className="h-3 w-3 text-mint" /> : <Copy className="h-3 w-3" />} {copied ? "copied" : "copy link"}
          </button>
        </div>
      )}
      {localhostWarning && (status === "waiting" || status === "creating") && (
        <p className="flex items-start gap-2 rounded-xl border border-amber/25 bg-amber/[0.06] px-3 py-2 text-[12px] leading-snug text-amber">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This QR points at localhost, which your phone can&apos;t reach — and the camera needs HTTPS. Set NEXT_PUBLIC_PUBLIC_ORIGIN to the
          public HTTPS URL (Fly.io / tunnel).
        </p>
      )}
    </div>
  );
}
