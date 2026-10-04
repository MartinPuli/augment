"use client";
/**
 * ConnectHardwareWidget — big tactile buttons that open the browser's device chooser / permission
 * prompt (browsers require a real click for Web Bluetooth, Web Serial, camera and microphone).
 * Devices are published through this tab's local connector (useLocalConnector).
 */
import { AnimatePresence, motion } from "motion/react";
import {
  Bluetooth,
  Camera,
  Check,
  LoaderCircle,
  Mic,
  Sparkles,
  TriangleAlert,
  Unplug,
  Usb,
  Volume2,
  Wifi,
  WifiOff,
} from "lucide-react";
import clsx from "clsx";
import { useState, useSyncExternalStore, type ComponentType } from "react";
import { useLocalConnector, LAPTOP_KEY } from "@/lib/connector/local";
import { bluetoothSupport, type BleProfile } from "@/lib/connector/drivers/bluetooth";
import { serialSupport } from "@/lib/connector/drivers/serial";
import { cameraSupport } from "@/lib/connector/drivers/camera";
import { microphoneSupport } from "@/lib/connector/drivers/microphone";
import { speakerSupport } from "@/lib/connector/drivers/speaker";
import type { PublishedDeviceInfo } from "@/lib/connector/types";
import type { WidgetComponentProps } from "../types";

type TransportProp = "bluetooth" | "serial" | "webcam" | "microphone" | "any";
type Action = "bluetooth" | "serial" | "webcam" | "microphone" | "speaker";

export interface ConnectHardwareProps {
  transport?: TransportProp;
  profile?: string;
  reason?: string;
}

const ACTIONS: Record<Action, { label: string; sub: string; icon: ComponentType<{ className?: string }>; transport: string }> = {
  bluetooth: { label: "Bluetooth device", sub: "LED strip, bulb, heart-rate strap…", icon: Bluetooth, transport: "bluetooth" },
  serial: { label: "USB serial board", sub: "Arduino / ESP32 speaking GHOST serial", icon: Usb, transport: "serial" },
  webcam: { label: "This laptop's webcam", sub: "Snapshots + live view", icon: Camera, transport: "browser (webcam)" },
  microphone: { label: "This laptop's microphone", sub: "Sound level, short clips", icon: Mic, transport: "browser (microphone)" },
  speaker: { label: "This laptop's speaker", sub: "Speech and chimes", icon: Volume2, transport: "browser (speaker)" },
};

const BLE_PROFILES: BleProfile[] = ["light", "heart_rate", "battery", "any"];

const useIsClient = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

function supportFor(a: Action): { supported: boolean; reason?: string } {
  switch (a) {
    case "bluetooth":
      return bluetoothSupport();
    case "serial":
      return serialSupport();
    case "webcam":
      return cameraSupport();
    case "microphone":
      return microphoneSupport();
    case "speaker":
      return speakerSupport();
  }
}

function isCancel(msg: string) {
  return /cancel|No port selected|NotFoundError|chooser/i.test(msg);
}

export default function ConnectHardwareWidget({ props, report, emit }: WidgetComponentProps<ConnectHardwareProps>) {
  const lc = useLocalConnector();
  const isClient = useIsClient();
  const [busy, setBusy] = useState<Action | null>(null);
  const [msg, setMsg] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);

  const transport = props.transport ?? "any";
  const actions: Action[] =
    transport === "any" ? ["bluetooth", "serial", "webcam", "microphone", "speaker"] : [transport as Action];
  const profile = BLE_PROFILES.includes(props.profile as BleProfile) ? (props.profile as BleProfile) : undefined;

  const run = (a: Action) => {
    if (busy) return;
    setMsg(null);
    // Each call opens a chooser / permission prompt: it must start synchronously in this click.
    let p: Promise<PublishedDeviceInfo>;
    try {
      p =
        a === "bluetooth"
          ? lc.addBluetooth(profile)
          : a === "serial"
            ? lc.addSerial()
            : a === "webcam"
              ? lc.enableWebcam()
              : a === "microphone"
                ? lc.enableMicrophone()
                : lc.enableSpeaker();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
      return;
    }
    setBusy(a);
    p.then(
      (dev) => {
        setBusy(null);
        setLastKey(dev.local_key);
        const caps = dev.capabilities.map((c) => c.capability_id);
        const via = ACTIONS[a].transport;
        const text = caps.length
          ? `User connected ${dev.name} via ${via}; capabilities: ${caps.join(", ")}${dev.device_id ? ` (device_id ${dev.device_id})` : ""}`
          : `User connected ${dev.name} via ${via}, but GHOST doesn't know its protocol yet — published as a candidate with no capabilities${dev.device_id ? ` (device_id ${dev.device_id})` : ""}`;
        emit(text);
        report({ status: "connected", transport: a, device_id: dev.device_id, local_key: dev.local_key, name: dev.name, capabilities: caps });
      },
      (e: unknown) => {
        setBusy(null);
        const text = e instanceof Error ? e.message : String(e);
        if (isCancel(text)) setMsg({ tone: "info", text: "No device chosen. Tap again when it's powered on and nearby." });
        else if (/denied|NotAllowed|Permission/i.test(text)) setMsg({ tone: "error", text: "Permission denied — allow it in the browser's site settings, then try again." });
        else setMsg({ tone: "error", text });
        report({ status: "failed", transport: a, error: text });
      },
    );
  };

  const online = lc.status === "online";
  const statusLabel =
    lc.status === "signed_out" ? "not signed in" : lc.status === "pending_confirmation" ? "pending" : lc.status === "loading" ? "connecting" : lc.status;

  return (
    <div className="flex flex-col gap-3 p-1">
      {props.reason && (
        <p className="flex items-start gap-2 rounded-xl border border-violet/25 bg-violet/[0.07] px-3 py-2 text-[13px] leading-snug text-violet">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">Polty asks:</span> {props.reason}
          </span>
        </p>
      )}

      <div className={clsx("grid gap-2", actions.length > 1 ? "sm:grid-cols-2" : "")}>
        {actions.map((a) => {
          const A = ACTIONS[a];
          const sup = isClient ? supportFor(a) : { supported: true };
          const laptopOn = a === "webcam" ? lc.laptop.camera : a === "microphone" ? lc.laptop.microphone : a === "speaker" ? lc.laptop.speaker : false;
          const disabled = !sup.supported || busy !== null || laptopOn;
          return (
            <motion.button
              key={a}
              type="button"
              whileHover={disabled ? undefined : { y: -2 }}
              whileTap={disabled ? undefined : { scale: 0.97, y: 1 }}
              onClick={() => run(a)}
              disabled={disabled}
              className={clsx(
                "group relative flex items-center gap-3 overflow-hidden rounded-2xl border px-4 text-left transition",
                actions.length === 1 ? "py-5" : "py-3.5",
                laptopOn
                  ? "border-mint/35 bg-mint/[0.06]"
                  : sup.supported
                    ? "border-white/80 bg-gradient-to-b from-white/85 to-white/55 shadow-[inset_0_1px_0_rgb(255_255_255),0_10px_24px_-14px_rgb(15_23_42/0.35)] hover:border-mint/40"
                    : "cursor-not-allowed border-line bg-ink-2/60",
              )}
            >
              <span
                className={clsx(
                  "grid shrink-0 place-items-center rounded-xl border transition",
                  actions.length === 1 ? "h-14 w-14" : "h-11 w-11",
                  laptopOn ? "border-mint/40 bg-mint/15 text-mint" : sup.supported ? "border-line-strong bg-ink-4 text-ivory group-hover:text-mint" : "border-line bg-ink-3 text-mute",
                )}
              >
                {busy === a ? <LoaderCircle className="h-6 w-6 animate-spin" /> : laptopOn ? <Check className="h-6 w-6" /> : <A.icon className={actions.length === 1 ? "h-7 w-7" : "h-5 w-5"} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={clsx("block font-semibold", actions.length === 1 ? "font-display text-[17px]" : "text-[14px]", sup.supported ? "text-ivory" : "text-mute")}>
                  {busy === a ? (a === "bluetooth" || a === "serial" ? "Pick it in the browser chooser…" : "Allow access in the prompt…") : laptopOn ? `${A.label} · shared` : `Connect ${A.label.toLowerCase()}`}
                </span>
                <span className={clsx("block text-[12px] leading-snug", sup.supported ? "text-mute" : "text-coral/80")}>
                  {sup.supported ? (a === "bluetooth" && profile ? `${A.sub} · looking for: ${profile.replace("_", " ")}` : A.sub) : sup.reason}
                </span>
              </span>
            </motion.button>
          );
        })}
      </div>

      <AnimatePresence>
        {msg && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={clsx("flex items-start gap-2 text-[12.5px] leading-snug", msg.tone === "error" ? "text-coral" : "text-ivory-dim")}
          >
            {msg.tone === "error" && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {msg.text}
          </motion.p>
        )}
      </AnimatePresence>

      {lc.devices.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <p className="hud-label">published from this browser</p>
          <AnimatePresence initial={false}>
            {lc.devices.map((d) => (
              <motion.div
                key={d.local_key}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className={clsx("rounded-xl border px-3 py-2", d.local_key === lastKey ? "border-mint/30 bg-mint/[0.05]" : "border-line bg-ink-2/60")}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-semibold text-ivory">{d.name}</p>
                    <p className="font-mono text-[10.5px] text-mute">
                      {d.transport} · {d.device_id ?? "publishing…"} ·{" "}
                      <span className={d.status === "verified" || d.status === "configured" ? "text-mint" : d.status === "candidate" ? "text-amber" : "text-mute"}>
                        {d.status}
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => void lc.remove(d.local_key)}
                    title={d.local_key === LAPTOP_KEY ? "Stop sharing this laptop" : "Disconnect & unpublish"}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-mute hover:border-coral/40 hover:text-coral"
                  >
                    <Unplug className="h-3 w-3" /> stop
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {d.capabilities.length ? (
                    d.capabilities.map((c) => {
                      const busyCap = lc.active.some((x) => x.local_key === d.local_key && x.capability_id === c.capability_id);
                      return (
                        <span
                          key={c.capability_id}
                          className={clsx(
                            "rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
                            busyCap ? "border-violet/50 bg-violet/15 text-violet" : "border-line bg-ink-3 text-ivory-dim",
                          )}
                        >
                          {c.capability_id}
                        </span>
                      );
                    })
                  ) : (
                    <span className="text-[11px] text-amber">unknown protocol · no capabilities (candidate)</span>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 font-mono text-[10.5px] text-mute">
        <span className="inline-flex items-center gap-1.5">
          {online ? <Wifi className="h-3 w-3 text-mint" /> : <WifiOff className="h-3 w-3 text-amber" />}
          device channel: <span className={online ? "text-mint" : "text-amber"}>{statusLabel}</span>
        </span>
        <span className="truncate">Bluetooth & USB need Chrome/Edge on desktop or Android</span>
      </div>
      {lc.detail && !online && <p className="text-[11.5px] text-amber">{lc.detail}</p>}
    </div>
  );
}
