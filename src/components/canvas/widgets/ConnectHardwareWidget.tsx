"use client";
/**
 * ConnectHardwareWidget — big tactile buttons that open the browser's device chooser / permission
 * prompt (browsers require a real click for Web Bluetooth, Web Serial, camera and microphone).
 * Devices are published through this tab's local connector (useLocalConnector).
 */
import { AnimatePresence, motion } from "motion/react";
import { Bluetooth, Camera, Check, Cpu, Info, LoaderCircle, Mic, Sparkles, TriangleAlert, Unplug, Usb, Volume2, Wifi, WifiOff } from "lucide";
import clsx from "clsx";
import { useState, useSyncExternalStore } from "react";
import { useLocalConnector, LAPTOP_KEY } from "@/lib/connector/local";
import { bluetoothSupport, type BleProfile } from "@/lib/connector/drivers/bluetooth";
import { serialSupport } from "@/lib/connector/drivers/serial";
import { cameraSupport } from "@/lib/connector/drivers/camera";
import { microphoneSupport } from "@/lib/connector/drivers/microphone";
import { speakerSupport } from "@/lib/connector/drivers/speaker";
import type { PublishedDeviceInfo } from "@/lib/connector/types";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
import { duration, ease, haptic, spring } from "@/components/ui/motion";
import type { WidgetComponentProps } from "../types";
import { MicrophoneInputPicker, useMicrophoneInput } from "@/components/devices/MicrophoneInputPicker";

type TransportProp = "bluetooth" | "serial" | "webcam" | "microphone" | "any";
type Action = "bluetooth" | "serial" | "webcam" | "microphone" | "speaker";

export interface ConnectHardwareProps {
  transport?: TransportProp;
  profile?: string;
  reason?: string;
}

const ACTIONS: Record<Action, { label: string; sub: string; icon: IconNode; transport: string }> = {
  bluetooth: { label: "Bluetooth device", sub: "LED strip, bulb, heart-rate strap…", icon: Bluetooth, transport: "bluetooth" },
  serial: { label: "USB serial board", sub: "Arduino / ESP32 speaking GHOST serial", icon: Usb, transport: "serial" },
  webcam: { label: "This laptop's webcam", sub: "Snapshots + live view", icon: Camera, transport: "browser (webcam)" },
  microphone: { label: "Microphone", sub: "Built-in, USB or paired Bluetooth audio input", icon: Mic, transport: "browser (microphone)" },
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
  const micInput = useMicrophoneInput(lc.laptop.microphone);
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
                ? lc.enableMicrophone({ deviceId: micInput.deviceId || undefined })
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

  const single = actions.length === 1;

  return (
    <div className="flex flex-col gap-4">
      {/* intro: what Polty is asking for, or what this card does */}
      <div className="flex items-center gap-3">
        <Illustration name="chip" size={48} fallback={Cpu} />
        <div className="min-w-0">
          {props.reason ? (
            <>
              <p className="flex items-center gap-1.5 text-caption font-medium text-violet">
                <Icon icon={Sparkles} size={13} /> Polty asks
              </p>
              <p className="font-serif text-body-lg text-fg">{props.reason}</p>
            </>
          ) : (
            <>
              <p className="font-serif text-heading text-fg">Share a device with Polty</p>
              <p className="text-body-sm text-fg-3">Your browser asks for permission first. You can stop sharing any time.</p>
            </>
          )}
        </div>
      </div>

      {actions.includes("microphone") && (
        <div className="flex flex-col gap-2">
          <MicrophoneInputPicker input={micInput} active={lc.laptop.microphone} activeLabel={lc.microphone_input_label} />
          {lc.laptop.microphone && (
            <button
              type="button"
              onClick={() => void lc.disableLaptopModule("microphone")}
              className="h-9 self-start rounded-full bg-tint px-3.5 text-caption font-medium text-fg-2 transition-[color,transform] hover:text-fg active:scale-[0.97]"
            >
              Turn off microphone
            </button>
          )}
        </div>
      )}

      <div className={clsx("grid gap-2", !single && "sm:grid-cols-2")}>
        {actions.map((a) => {
          const A = ACTIONS[a];
          const sup = isClient ? supportFor(a) : { supported: true };
          const laptopOn = a === "webcam" ? lc.laptop.camera : a === "microphone" ? lc.laptop.microphone : a === "speaker" ? lc.laptop.speaker : false;
          const disabled = !sup.supported || busy !== null || laptopOn;
          const waiting = busy !== null && busy !== a && sup.supported && !laptopOn;
          return (
            <motion.button
              key={a}
              type="button"
              whileHover={disabled ? undefined : { y: -1 }}
              whileTap={disabled ? undefined : { scale: 0.98 }}
              transition={spring.snappy}
              onClick={() => {
                haptic();
                run(a);
              }}
              disabled={disabled}
              className={clsx(
                "group flex min-w-0 items-center gap-3 rounded-tile px-4 text-left transition-[background-color,box-shadow,opacity] duration-150 ease-standard",
                single ? "py-4" : "py-3",
                laptopOn
                  ? "bg-mint/10"
                  : sup.supported
                    ? "bg-surface-2 shadow-card enabled:hover:bg-surface enabled:hover:shadow-pop"
                    : "cursor-not-allowed bg-surface-2/60",
                waiting && "cursor-wait opacity-50",
              )}
            >
              <span
                className={clsx(
                  "grid shrink-0 place-items-center rounded-full transition-colors duration-150 ease-standard",
                  single ? "h-12 w-12" : "h-10 w-10",
                  laptopOn ? "bg-mint/15 text-mint" : sup.supported ? "bg-tint text-fg group-enabled:group-hover:text-mint" : "bg-tint text-fg-3",
                )}
              >
                <Icon
                  icon={busy === a ? LoaderCircle : laptopOn ? Check : A.icon}
                  size={single ? 22 : 18}
                  spring="snappy"
                  className={clsx(busy === a && "animate-spin")}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className={clsx("block", single ? "font-serif text-heading" : "text-body font-medium", sup.supported ? "text-fg" : "text-fg-3")}>
                  {busy === a ? (a === "bluetooth" || a === "serial" ? "Pick it in the browser chooser…" : "Allow access in the prompt…") : laptopOn ? `${A.label} · shared` : `Connect ${A.label.toLowerCase()}`}
                </span>
                <span className={clsx("block text-body-sm", sup.supported ? "text-fg-3" : "text-coral")}>
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
            transition={{ duration: duration.fast, ease: ease.standard }}
            className={clsx("flex items-start gap-2 text-body-sm", msg.tone === "error" ? "text-coral" : "text-fg-2")}
          >
            <Icon icon={msg.tone === "error" ? TriangleAlert : Info} size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{msg.text}</span>
          </motion.p>
        )}
      </AnimatePresence>

      {lc.devices.length > 0 && (
        <div className="flex flex-col">
          <p className="mb-2 text-caption font-medium text-fg-3">Published from this browser</p>
          <AnimatePresence initial={false}>
            {lc.devices.map((d) => (
              <motion.div
                key={d.local_key}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: duration.base, ease: ease.standard }}
                className="overflow-hidden"
              >
                <div className={clsx("mb-2 rounded-tile py-2.5 pl-3 pr-1.5", d.local_key === lastKey ? "bg-mint/10" : "bg-surface-2")}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-body font-medium text-fg">{d.name}</p>
                      <p className="truncate text-caption text-fg-3">
                        {d.transport} · {d.device_id ? <span className="font-mono">{d.device_id}</span> : "publishing…"} ·{" "}
                        <span className={d.status === "verified" || d.status === "configured" ? "text-mint" : d.status === "candidate" ? "text-amber" : "text-fg-3"}>
                          {d.status}
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => void lc.remove(d.local_key)}
                      title={d.local_key === LAPTOP_KEY ? "Stop sharing this laptop" : "Disconnect & unpublish"}
                      className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-caption font-medium text-fg-3 transition-colors duration-150 ease-standard hover:bg-coral/10 hover:text-coral"
                    >
                      <Icon icon={Unplug} size={14} /> Stop
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1 pr-1.5">
                    {d.capabilities.length ? (
                      d.capabilities.map((c) => {
                        const busyCap = lc.active.some((x) => x.local_key === d.local_key && x.capability_id === c.capability_id);
                        return (
                          <span
                            key={c.capability_id}
                            className={clsx(
                              "rounded-full px-2 py-0.5 font-mono text-label transition-colors duration-150 ease-standard",
                              busyCap ? "bg-violet/10 text-violet" : "bg-tint text-fg-2",
                            )}
                          >
                            {c.capability_id}
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-caption text-amber">Unknown protocol · no capabilities (candidate)</span>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption text-fg-3">
        <span className="inline-flex items-center gap-1.5">
          <Icon icon={online ? Wifi : WifiOff} size={13} spring="snappy" className={online ? "text-mint" : "text-amber"} />
          Device channel: <span className={online ? "text-mint" : "text-amber"}>{statusLabel}</span>
        </span>
        <span>Bluetooth & USB need Chrome/Edge on desktop or Android</span>
      </div>
      {lc.detail && !online && <p className="text-caption text-amber">{lc.detail}</p>}
    </div>
  );
}
