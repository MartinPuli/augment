"use client";
/**
 * /join — pair a phone with GHOST and lend its sensors to the owner's agent.
 *
 * 1. Reads the one-use pairing code from the URL fragment (#code=XXXXXX) and removes it from the
 *    address bar. Already-paired phones reconnect with their stored credential.
 * 2. Waits for the owner to confirm on the desktop.
 * 3. The user turns sensors on one by one (each asks the browser for permission; nothing is
 *    advertised unless the permission was granted), then publishes the phone as a device.
 * 4. "Possessed" mode: while Polty uses a capability the screen says exactly what it is doing,
 *    and a huge Stop button unpublishes everything and closes every camera/mic track.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Activity,
  ArrowRight,
  BatteryMedium,
  Camera,
  Check,
  CircleStop,
  Compass,
  Flashlight,
  KeyRound,
  Lock,
  LoaderCircle,
  MapPin,
  Mic,
  Pause,
  RefreshCw,
  SatelliteDish,
  SlidersHorizontal,
  Smartphone,
  TriangleAlert,
  Vibrate,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from "lucide";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
import { duration, ease, haptic, spring } from "@/components/ui/motion";
import { GhostConnector } from "@/lib/connector/client";
import { composeDevice } from "@/lib/connector/compose";
import { deviceChannelUrl } from "@/lib/connector/http";
import type { CapabilityModule, ConnectorSnapshot } from "@/lib/connector/types";
import { safeStorage, errorMessage } from "@/lib/connector/util";
import { cameraSupport, enableCamera, type CameraModule } from "@/lib/connector/drivers/camera";
import { enableMicrophone, microphoneSupport } from "@/lib/connector/drivers/microphone";
import { enableSpeaker, speakerSupport } from "@/lib/connector/drivers/speaker";
import { enableDisplay, type DisplayState } from "@/lib/connector/drivers/display";
import {
  batterySupport,
  enableBattery,
  enableHaptics,
  enableLocation,
  enableMotion,
  hapticsSupport,
  locationSupport,
  motionSupport,
} from "@/lib/connector/drivers/sensors";
import { Ghost, type GhostMood } from "./Ghost";
import { MicrophoneInputPicker, useMicrophoneInput } from "@/components/devices/MicrophoneInputPicker";

type SensorId = "camera" | "microphone" | "speaker" | "display" | "haptics" | "motion" | "location" | "torch" | "battery";
type SensorState = "off" | "asking" | "on" | "error";
type Support = { supported: boolean; reason?: string };

const PHONE_KEY = "phone";
const CRED_KEY = "ghost.connector.phone-browser.credential";

const SENSORS: { id: SensorId; label: string; blurb: string; icon: IconNode }[] = [
  { id: "camera", label: "Camera", blurb: "Photos and a live view from the rear camera", icon: Camera },
  { id: "microphone", label: "Microphone", blurb: "Sound level, short clips (≤10 s)", icon: Mic },
  { id: "speaker", label: "Speaker", blurb: "Say short phrases, play chimes", icon: Volume2 },
  { id: "display", label: "Screen", blurb: "Show full-screen messages, gentle flashes", icon: Smartphone },
  { id: "haptics", label: "Haptics", blurb: "Vibrate patterns", icon: Vibrate },
  { id: "motion", label: "Motion", blurb: "Tilt, shake and orientation", icon: Compass },
  { id: "location", label: "Location", blurb: "Where this phone is (with accuracy)", icon: MapPin },
  { id: "torch", label: "Torch", blurb: "Flashlight on/off (needs Camera)", icon: Flashlight },
  { id: "battery", label: "Battery", blurb: "Level and charging state", icon: BatteryMedium },
];

const ACTIVITY: Record<string, string> = {
  "camera.snapshot": "Polty is looking through your camera",
  "camera.stream": "Polty is watching live",
  "torch.set": "Polty is flicking your flashlight",
  "audio.level": "Polty is listening to the room",
  "audio.record": "Polty is recording a short clip",
  "speaker.say": "Polty is speaking through your phone",
  "speaker.chime": "Polty is ringing a chime",
  "display.show": "Polty is writing on your screen",
  "display.flash": "Polty is flashing your screen",
  "haptics.vibrate": "Polty is buzzing your phone",
  "motion.read": "Polty is feeling how your phone moves",
  "location.read": "Polty is checking where this phone is",
  "battery.read": "Polty is peeking at your battery",
};

const DONE: Record<string, string> = {
  "camera.snapshot": "Took a photo",
  "camera.stream": "Opened a live view",
  "torch.set": "Toggled the torch",
  "audio.level": "Measured sound level",
  "audio.record": "Recorded a clip",
  "speaker.say": "Spoke a phrase",
  "speaker.chime": "Played a chime",
  "display.show": "Showed a message",
  "display.flash": "Flashed the screen",
  "haptics.vibrate": "Vibrated",
  "motion.read": "Read motion",
  "location.read": "Read location",
  "battery.read": "Read battery",
};

function phoneName(): string {
  if (typeof navigator === "undefined") return "Phone";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (m && m[1] && !/^K$/.test(m[1].trim())) return m[1].trim();
  if (/Android/.test(ua)) return "Android phone";
  return "Phone browser";
}

function readableOn(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "#0a0b0e" : "#f4efe4";
}

type WakeLockLike = { release(): Promise<void> };

/* Page-lifetime singletons (survive dev StrictMode's double effect run). */
let phoneConnector: GhostConnector | null = null;
let consumedCode: string | null | undefined;

/** Read #code=… once, then scrub it from the address bar (after Next's router has synced the URL). */
function readCodeOnce(): string | null {
  if (consumedCode !== undefined) return consumedCode;
  const m = /(?:^#|[#&?])code=([A-Za-z0-9_-]{3,40})/.exec(window.location.hash);
  consumedCode = m?.[1] ?? null;
  if (window.location.hash) {
    const scrub = () => {
      if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    };
    scrub();
    setTimeout(scrub, 50);
    setTimeout(scrub, 600);
  }
  return consumedCode;
}

export default function JoinPage() {
  const [boot, setBoot] = useState<"loading" | "no-code" | "connector">("loading");
  const [secure, setSecure] = useState(true);
  const [snap, setSnap] = useState<ConnectorSnapshot | null>(null);
  const [support, setSupport] = useState<Partial<Record<SensorId, Support>>>({});
  const [sensors, setSensors] = useState<Partial<Record<SensorId, SensorState>>>({});
  const [sensorErr, setSensorErr] = useState<Partial<Record<SensorId, string>>>({});
  const [published, setPublished] = useState(false);
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  const [display, setDisplay] = useState<DisplayState | null>(null);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [name, setName] = useState("Phone");
  const [manualCode, setManualCode] = useState("");
  const [hidden, setHidden] = useState(false);

  const connRef = useRef<GhostConnector | null>(null);
  const modulesRef = useRef(new Map<SensorId, CapabilityModule>());
  const micInput = useMicrophoneInput(sensors.microphone === "on");
  const publishedRef = useRef(false);
  const nameRef = useRef(name);
  const wakeRef = useRef<WakeLockLike | null>(null);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  /* ---------------- connector ---------------- */

  const unsubRef = useRef<(() => void) | null>(null);

  const attach = useCallback((c: GhostConnector) => {
    unsubRef.current?.();
    connRef.current = c;
    setSnap(c.getSnapshot());
    unsubRef.current = c.subscribe(() => setSnap(c.getSnapshot()));
    setBoot("connector");
  }, []);

  const startConnector = useCallback(
    (code: string | null) => {
      phoneConnector?.stop();
      const c = new GhostConnector({
        url: deviceChannelUrl(),
        connectorKind: "phone-browser",
        label: phoneName(),
        pairingCode: code,
        storageKey: CRED_KEY,
        trackVisibility: true,
      });
      if (code) c.forgetCredential(); // a fresh code means: pair (again) with whoever shared it
      phoneConnector = c;
      c.start();
      attach(c);
    },
    [attach],
  );

  useEffect(() => {
    setSecure(window.isSecureContext);
    setName(phoneName());
    const code = readCodeOnce();
    setSupport({
      camera: cameraSupport(),
      microphone: microphoneSupport(),
      speaker: speakerSupport(),
      display: { supported: true },
      haptics: hapticsSupport(),
      motion: motionSupport(),
      location: locationSupport(),
      torch: cameraSupport().supported
        ? { supported: true }
        : { supported: false, reason: cameraSupport().reason },
      battery: batterySupport(),
    });
    // One connector per page load, even when React (dev StrictMode) mounts effects twice:
    // a pairing code is single-use, so it must be presented exactly once.
    if (phoneConnector) attach(phoneConnector);
    else if (code || safeStorage()?.getItem(CRED_KEY)) startConnector(code);
    else setBoot("no-code");
    const onVis = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    const mods = modulesRef.current;
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      unsubRef.current?.();
      unsubRef.current = null;
      if (publishedRef.current) void phoneConnector?.removeDevice(PHONE_KEY, { dispose: false });
      publishedRef.current = false;
      for (const mod of mods.values()) void mod.dispose?.();
      mods.clear();
    };
  }, [attach, startConnector]);

  /* ---------------- wake lock while published ---------------- */

  const keepAwake = useCallback(async () => {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<WakeLockLike> } }).wakeLock;
      if (wl && !wakeRef.current) wakeRef.current = await wl.request("screen");
    } catch {
      /* not supported / denied: the hint tells the user to keep the screen on */
    }
  }, []);
  useEffect(() => {
    if (!published) {
      void wakeRef.current?.release().catch(() => {});
      wakeRef.current = null;
      return;
    }
    void keepAwake();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        wakeRef.current = null;
        void keepAwake();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [published, keepAwake]);

  /* ---------------- device composition ---------------- */

  const buildDevice = useCallback(() => {
    const mods = [...modulesRef.current.values()];
    return composeDevice(
      {
        local_key: PHONE_KEY,
        name: nameRef.current.trim().slice(0, 60) || "Phone",
        device_class: "phone",
        transport: "browser",
        icon: "smartphone",
        meta: { sensors: [...modulesRef.current.keys()], paired_via: "join-link" },
      },
      mods,
    );
  }, []);

  const republish = useCallback(() => {
    const c = connRef.current;
    if (!c || !publishedRef.current) return;
    if (modulesRef.current.size === 0) {
      void c.removeDevice(PHONE_KEY, { dispose: false });
      publishedRef.current = false;
      setPublished(false);
      return;
    }
    c.updateDevice(buildDevice());
  }, [buildDevice]);

  const disableSensor = useCallback(
    (id: SensorId) => {
      const mod = modulesRef.current.get(id);
      modulesRef.current.delete(id);
      if (id === "camera" && modulesRef.current.has("torch")) {
        modulesRef.current.delete("torch");
        setSensors((s) => ({ ...s, torch: "off" }));
      }
      setSensors((s) => ({ ...s, [id]: "off" }));
      republish();
      void mod?.dispose?.();
    },
    [republish],
  );

  /** Must run synchronously inside the tap: each enable* opens a permission prompt first. */
  const toggleSensor = (id: SensorId) => {
    if (sensors[id] === "on") return disableSensor(id);
    if (sensors[id] === "asking") return;
    let pending: Promise<CapabilityModule>;
    try {
      switch (id) {
        case "camera":
          pending = enableCamera({
            facing: "environment",
            onLive: (sid, did, live) => connRef.current?.setLiveSession(sid, did, live),
          });
          break;
        case "microphone":
          pending = enableMicrophone({ deviceId: micInput.deviceId || undefined });
          break;
        case "speaker":
          pending = enableSpeaker({ onSpeak: setSpeaking });
          break;
        case "display":
          pending = Promise.resolve(enableDisplay({ render: setDisplay }));
          break;
        case "haptics":
          pending = Promise.resolve(enableHaptics());
          break;
        case "motion":
          pending = enableMotion();
          break;
        case "location":
          pending = enableLocation();
          break;
        case "battery":
          pending = enableBattery();
          break;
        case "torch": {
          const cam = modulesRef.current.get("camera") as CameraModule | undefined;
          if (!cam) throw new Error("Turn on Camera first — the torch belongs to the rear camera.");
          const t = cam.torchModule();
          if (!t) throw new Error("This phone's browser doesn't expose the flashlight (iOS Safari never does).");
          pending = Promise.resolve(t);
          break;
        }
      }
    } catch (e) {
      setSensors((s) => ({ ...s, [id]: "error" }));
      setSensorErr((s) => ({ ...s, [id]: errorMessage(e) }));
      return;
    }
    setSensors((s) => ({ ...s, [id]: "asking" }));
    setSensorErr((s) => ({ ...s, [id]: undefined }));
    pending.then(
      (mod) => {
        if (mod.capabilities.length === 0) {
          void mod.dispose?.();
          throw new Error("Nothing usable on this device");
        }
        modulesRef.current.get(id)?.dispose?.();
        modulesRef.current.set(id, mod);
        setSensors((s) => ({ ...s, [id]: "on" }));
        haptic(10); // with the bouncy "Shared" pill: one confirmation, felt and seen
        republish();
      },
      (e) => {
        const msg = errorMessage(e);
        setSensors((s) => ({ ...s, [id]: "error" }));
        setSensorErr((s) => ({
          ...s,
          [id]: /denied|NotAllowed|Permission/i.test(msg) ? "Permission denied — allow it in your browser settings to share." : msg,
        }));
      },
    ).catch((e) => {
      setSensors((s) => ({ ...s, [id]: "error" }));
      setSensorErr((s) => ({ ...s, [id]: errorMessage(e) }));
    });
  };

  const publishDevice = () => {
    const c = connRef.current;
    if (!c || modulesRef.current.size === 0) return;
    publishedRef.current = true;
    setPublished(true);
    setStoppedNote(null);
    c.registerDevice(buildDevice());
    void keepAwake();
  };

  const stopAccess = useCallback(() => {
    const c = connRef.current;
    if (c) void c.removeDevice(PHONE_KEY, { dispose: false });
    for (const mod of modulesRef.current.values()) void mod.dispose?.();
    modulesRef.current.clear();
    publishedRef.current = false;
    setPublished(false);
    setDisplay(null);
    setSpeaking(null);
    setSensors({});
    setSensorErr({});
    setStoppedNote("Access stopped. Camera and microphone are closed and nothing is being shared.");
  }, []);

  const forgetPhone = () => {
    stopAccess();
    connRef.current?.forgetCredential();
    connRef.current?.stop();
    connRef.current = null;
    phoneConnector = null;
    unsubRef.current?.();
    unsubRef.current = null;
    setSnap(null);
    setBoot("no-code");
  };

  /* ---------------- derived ---------------- */

  const status = snap?.status ?? "idle";
  const welcomed = !!snap?.connector_id && (status === "online" || status === "reconnecting" || status === "connecting");
  const active = snap?.active ?? [];
  const live = snap?.live_sessions ?? [];
  const current = active[0];
  const activityText = current
    ? ACTIVITY[current.capability_id] ?? `Polty is using ${current.capability_id}`
    : live.length
      ? "Polty is watching live"
      : speaking
        ? "Polty is speaking through your phone"
        : null;
  const possessed = !!activityText;
  const phoneDevice = snap?.devices.find((d) => d.local_key === PHONE_KEY);
  const enabledCount = Object.values(sensors).filter((v) => v === "on").length;

  const mood: GhostMood =
    status === "error" ? "sad" : possessed ? "possessed" : status === "pending_confirmation" || status === "connecting" ? "waiting" : hidden ? "sleeping" : "idle";

  /* ---------------- render ---------------- */

  return (
    <main className="relative min-h-dvh overflow-clip text-fg">
      <Backdrop possessed={possessed} />
      <div
        className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[440px] flex-col"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 12px)",
          paddingLeft: "max(env(safe-area-inset-left), 16px)",
          paddingRight: "max(env(safe-area-inset-right), 16px)",
        }}
      >
        <header className="flex h-12 items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-display text-heading tracking-[0.14em]">GHOST</span>
            <span className="truncate text-caption text-fg-3">Phone link</span>
          </div>
          {boot === "connector" && <ConnChip status={status} />}
        </header>

        {!secure && <InsecureBanner />}

        <AnimatePresence mode="wait">
          {boot === "loading" && (
            <Panel key="loading">
              <Ghost mood="waiting" size={112} className="mx-auto" />
            </Panel>
          )}

          {boot === "no-code" && (
            <Panel
              key="no-code"
              footer={
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const code = manualCode.trim().toUpperCase();
                    if (code.length >= 4) startConnector(code);
                  }}
                >
                  <input
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 12))}
                    placeholder="ABC123"
                    autoCapitalize="characters"
                    autoComplete="one-time-code"
                    inputMode="text"
                    enterKeyHint="go"
                    aria-label="Pairing code"
                    className="h-14 w-full rounded-tile bg-surface px-4 text-center font-mono text-title uppercase tracking-[0.3em] text-fg shadow-card outline-none ring-1 ring-inset ring-line-strong transition-shadow duration-150 placeholder:text-fg-3/40 focus:ring-2 focus:ring-mint/50"
                  />
                  <button type="submit" disabled={manualCode.trim().length < 4} className={clsx(BTN_PRIMARY, "h-14 w-full text-body-lg")}>
                    Pair
                    <Icon icon={ArrowRight} size={18} strokeWidth={2.1} />
                  </button>
                </form>
              }
            >
              <Illustration name="phone" size={104} fallback={Smartphone} priority className="mx-auto" />
              <h1 className="mt-6 text-center font-display text-title">Pair this phone</h1>
              <p className="mx-auto mt-3 max-w-[34ch] text-center text-body text-fg-2">
                On your computer, open GHOST and choose <span className="font-medium text-fg">Pair a phone</span>. Scan the QR code with
                this phone&apos;s camera, or type the 6-character code below.
              </p>
            </Panel>
          )}

          {boot === "connector" && !welcomed && status !== "error" && (
            <Panel key="pending">
              <div className="relative mx-auto grid size-44 place-items-center">
                <span aria-hidden className="absolute inset-6 rounded-full border border-amber/40 animate-pulse-ring" />
                <span aria-hidden className="absolute inset-6 rounded-full border border-amber/25 animate-pulse-ring [animation-delay:0.9s]" />
                {status === "pending_confirmation" ? (
                  <Illustration key="key" name="key" size={112} fallback={KeyRound} priority />
                ) : (
                  <Illustration key="phone" name="phone" size={112} fallback={Smartphone} priority />
                )}
              </div>
              <h1 className="mt-8 text-center font-display text-title">
                {status === "pending_confirmation" ? "Waiting for the owner to confirm…" : "Reaching GHOST…"}
              </h1>
              <p className="mx-auto mt-3 max-w-[36ch] text-center text-body text-fg-2">
                {status === "pending_confirmation"
                  ? `Your computer should now show "${phoneName()}" asking to pair. Tap Confirm there. Nothing on this phone is shared yet.`
                  : status === "reconnecting"
                    ? `Connection dropped — retrying${snap?.detail ? ` (${snap.detail})` : ""}.`
                    : "Opening a secure channel to the coordinator."}
              </p>
              <div className="mt-6 flex justify-center">
                <StatusPill tone="amber" icon={LoaderCircle} spin>
                  {status === "pending_confirmation" ? "Awaiting confirmation" : `${STATUS_LABEL[status]}…`}
                </StatusPill>
              </div>
            </Panel>
          )}

          {boot === "connector" && status === "error" && (
            <Panel
              key="error"
              footer={
                <button onClick={forgetPhone} className={clsx(BTN_PRIMARY, "h-14 w-full text-body-lg")}>
                  <Icon icon={RefreshCw} size={18} strokeWidth={2.1} />
                  Enter a new code
                </button>
              }
            >
              <Ghost mood="sad" size={112} className="mx-auto" />
              <h1 className="mt-6 text-center font-display text-title">Couldn&apos;t connect</h1>
              <p className="mx-auto mt-3 max-w-[36ch] text-center text-body text-coral">{snap?.detail ?? "The coordinator refused the connection."}</p>
              <p className="mx-auto mt-2 max-w-[36ch] text-center text-body-sm text-fg-2">
                Ask the owner for a fresh QR code. Codes are single-use and expire after 2 minutes.
              </p>
            </Panel>
          )}

          {boot === "connector" && welcomed && !published && (
            <Panel
              key="setup"
              align="start"
              footer={
                <>
                  {enabledCount > 0 && status !== "online" && (
                    <p className="mb-2.5 flex items-center justify-center gap-1.5 text-caption text-amber">
                      <span className="grid place-items-center animate-spin">
                        <Icon icon={LoaderCircle} size={12} strokeWidth={2.2} />
                      </span>
                      Waiting for the connection to publish
                    </p>
                  )}
                  <button
                    onClick={publishDevice}
                    disabled={enabledCount === 0 || status !== "online"}
                    className={clsx(BTN_PRIMARY, "h-14 w-full text-body-lg")}
                  >
                    {enabledCount === 0 ? "Turn on at least one sensor" : `Publish device · ${enabledCount} sensor${enabledCount > 1 ? "s" : ""}`}
                  </button>
                  <button
                    onClick={forgetPhone}
                    className="mx-auto mt-1 flex h-11 items-center rounded-full px-4 text-body-sm text-fg-3 underline-offset-4 transition-transform duration-100 hover:text-fg hover:underline active:scale-[0.97]"
                  >
                    Unpair this phone
                  </button>
                </>
              }
            >
              <div className="flex items-center gap-4">
                <Ghost mood="idle" size={60} className="shrink-0" />
                <div className="min-w-0">
                  <StatusPill tone="mint" icon={Check}>
                    Paired and confirmed
                  </StatusPill>
                  <h1 className="mt-2 font-display text-title">What can Polty borrow?</h1>
                </div>
              </div>
              <p className="mt-3 text-body text-fg-2">Turn on only what you want to lend. Each one asks your permission first.</p>
              {stoppedNote && (
                <p className="mt-4 flex items-start gap-2.5 rounded-tile bg-coral/[0.07] px-4 py-3 text-body-sm text-coral ring-1 ring-inset ring-coral/20">
                  <Icon icon={CircleStop} size={16} className="mt-0.5 shrink-0" />
                  {stoppedNote}
                </p>
              )}
              <label className="mt-6 block">
                <span className="px-1 text-body-sm font-medium text-fg-2">Device name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 60))}
                  className="mt-1.5 h-12 w-full rounded-tile bg-surface px-4 text-body-lg text-fg shadow-card outline-none ring-1 ring-inset ring-line transition-shadow duration-150 focus:ring-2 focus:ring-mint/50"
                />
              </label>
              <div className="mt-6 flex items-baseline justify-between px-1">
                <h2 className="text-body-sm font-medium text-fg-2">Sensors</h2>
                <span className="text-caption tabular-nums text-fg-3">{enabledCount === 0 ? "All off" : `${enabledCount} on`}</span>
              </div>
              <ul className="ghost-glass mt-2 space-y-0.5 rounded-card p-1.5">
                {SENSORS.filter((s) => s.id !== "battery" || support.battery?.supported).map((s, i) => (
                  <SensorRow
                    key={s.id}
                    index={i}
                    label={s.label}
                    blurb={s.blurb}
                    icon={s.icon}
                    state={sensors[s.id] ?? "off"}
                    error={sensorErr[s.id]}
                    support={support[s.id]}
                    onToggle={() => toggleSensor(s.id)}
                  />
                ))}
              </ul>
              {support.microphone?.supported && (
                <div className="mt-3">
                  <MicrophoneInputPicker input={micInput} active={sensors.microphone === "on"} activeLabel={modulesRef.current.get("microphone")?.connection?.input_label} />
                </div>
              )}
            </Panel>
          )}

          {boot === "connector" && welcomed && published && (
            <motion.section key="live" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }} exit={EXIT} className="flex flex-1 flex-col">
              <p aria-live="polite" className="sr-only">
                {activityText ?? ""}
              </p>
              <div className="flex flex-1 flex-col items-center justify-center pb-4 pt-6 text-center">
                <motion.div initial={false} animate={{ scale: possessed ? 1.14 : 1 }} transition={spring.gentle}>
                  <Ghost mood={mood} size={168} />
                </motion.div>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={activityText ?? "idle"}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: spring.gentle }}
                    exit={{ opacity: 0, y: -6, transition: { duration: duration.instant, ease: ease.standard } }}
                    className="mt-7 flex min-h-[116px] flex-col items-center px-2"
                  >
                    {possessed ? (
                      <>
                        <StatusPill tone="violet" pulse>
                          Possessed
                        </StatusPill>
                        <h1 className="mt-3 font-display text-title text-fg">{activityText}</h1>
                        {speaking && <p className="mt-2 max-w-[32ch] font-serif text-body-lg text-fg-2">“{speaking}”</p>}
                      </>
                    ) : (
                      <>
                        <StatusPill tone={hidden ? "amber" : "mint"} icon={hidden ? Pause : Check}>
                          {hidden ? "Paused" : "Haunted and ready"}
                        </StatusPill>
                        <h1 className="mt-3 font-display text-title">{hidden ? "Paused while the screen is off" : "Polty can borrow this phone"}</h1>
                        <p className="mt-2 max-w-[34ch] text-body-sm text-fg-2">Keep this tab open and the screen on. You&apos;ll see here whenever it&apos;s used.</p>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>

              <div className="space-y-3">
                {sensors.camera === "on" && (
                  <CameraPeek module={modulesRef.current.get("camera") as CameraModule | undefined} active={!!current?.capability_id.startsWith("camera") || live.length > 0} />
                )}

                <section className="ghost-glass rounded-card p-4 text-left">
                  <div className="flex items-center gap-3">
                    <Illustration name="satellite" size={44} fallback={SatelliteDish} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium text-fg">{phoneDevice?.name ?? name}</p>
                      {phoneDevice?.device_id ? (
                        <p className="truncate font-mono text-caption text-fg-3">{`device ${phoneDevice.device_id} · ${phoneDevice.status}`}</p>
                      ) : (
                        <p className="flex items-center gap-1.5 text-caption text-amber">
                          <span className="grid place-items-center animate-spin">
                            <Icon icon={LoaderCircle} size={12} strokeWidth={2.2} />
                          </span>
                          Publishing…
                        </p>
                      )}
                    </div>
                  </div>

                  {(phoneDevice?.capabilities.length ?? 0) > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {(phoneDevice?.capabilities ?? []).map((c) => {
                        const busy = active.some((a) => a.capability_id === c.capability_id) || (c.capability_id === "camera.stream" && live.length > 0);
                        return (
                          <span
                            key={c.capability_id}
                            className={clsx(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-label transition-colors duration-200",
                              busy ? "bg-violet/10 text-violet ring-1 ring-inset ring-violet/30" : "bg-tint text-fg-2",
                            )}
                          >
                            {busy && <span className="size-1.5 animate-pulse rounded-full bg-violet" />}
                            {c.capability_id}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {(snap?.recent.length ?? 0) > 0 && (
                    <div className="mt-4 border-t border-line pt-3">
                      <h2 className="text-caption font-medium text-fg-3">Recent</h2>
                      <ul className="mt-2 space-y-1.5">
                        {snap!.recent.slice(0, 3).map((r) => (
                          <li key={r.invocation_id} className="flex items-center justify-between gap-3 text-body-sm">
                            <span className="flex min-w-0 items-center gap-2 text-fg-2">
                              <Icon icon={Activity} size={14} className="shrink-0 text-fg-3" />
                              <span className="truncate">{DONE[r.capability_id] ?? r.capability_id}</span>
                            </span>
                            <span
                              className={clsx(
                                "shrink-0 text-caption tabular-nums",
                                r.state === "succeeded" ? "text-mint" : r.state === "rejected" || r.state === "failed" ? "text-coral" : "text-amber",
                              )}
                            >
                              {r.state} · {new Date(r.finished_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              </div>

              <StickyFooter>
                <StopButton onStop={stopAccess} possessed={possessed} />
                <button
                  onClick={() => {
                    publishedRef.current = false;
                    setPublished(false);
                    connRef.current?.unpublish([PHONE_KEY]);
                  }}
                  className={clsx(BTN_QUIET, "mx-auto mt-2 flex h-11 px-5 text-body-sm")}
                >
                  <Icon icon={SlidersHorizontal} size={16} />
                  Edit sensors
                </button>
              </StickyFooter>
            </motion.section>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>{display && <DisplayTakeover state={display} onStop={stopAccess} />}</AnimatePresence>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-[transform,background-color,opacity] duration-100 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none";
/** One per screen: the thing to do next. */
const BTN_PRIMARY = clsx(BTN_BASE, "bg-fg text-fg-inverse shadow-pop hover:bg-fg/85");
/** Low-emphasis text button (secondary actions under a primary). */
const BTN_QUIET = clsx(BTN_BASE, "text-fg-2 hover:bg-tint hover:text-fg");

/** Steps leave faster than they arrive. */
const EXIT = { opacity: 0, y: -8, transition: { duration: duration.fast, ease: ease.standard } };

const STATUS_LABEL: Record<ConnectorSnapshot["status"], string> = {
  idle: "Idle",
  connecting: "Connecting",
  pending_confirmation: "Pending",
  online: "Online",
  reconnecting: "Reconnecting",
  error: "Error",
  closed: "Closed",
};

type Tone = "mint" | "amber" | "coral" | "violet" | "neutral";
const TONE: Record<Tone, string> = {
  mint: "bg-mint/10 text-mint",
  amber: "bg-amber/10 text-amber",
  coral: "bg-coral/10 text-coral",
  violet: "bg-violet/10 text-violet",
  neutral: "bg-tint text-fg-3",
};

/** Sensor state, always as words and color together. */
const SENSOR_VIEW: Record<SensorState | "unavailable", { text: string; tone: Tone }> = {
  off: { text: "Off", tone: "neutral" },
  asking: { text: "Asking…", tone: "amber" },
  on: { text: "Shared", tone: "mint" },
  error: { text: "Not shared", tone: "coral" },
  unavailable: { text: "Unavailable", tone: "neutral" },
};

/**
 * A step of the flow: content in the middle (or from the top, for long lists) and its primary
 * action pinned near the bottom, within thumb reach.
 */
function Panel({ children, footer, align = "center" }: { children: React.ReactNode; footer?: React.ReactNode; align?: "center" | "start" }) {
  return (
    <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }} exit={EXIT} className="flex flex-1 flex-col">
      <div className={clsx("flex flex-1 flex-col py-6", align === "center" && "justify-center")}>{children}</div>
      {footer ? <StickyFooter>{footer}</StickyFooter> : <div aria-hidden style={{ height: "max(env(safe-area-inset-bottom), 16px)" }} />}
    </motion.section>
  );
}

/** Bottom action area: stays reachable while the content above scrolls under a soft fade. */
function StickyFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 pt-5" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2 bg-gradient-to-t from-page via-page/85 to-transparent"
      />
      {children}
    </div>
  );
}

function StatusPill({
  tone,
  icon,
  spin,
  pulse,
  children,
}: {
  tone: Tone;
  icon?: IconNode;
  spin?: boolean;
  pulse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-medium", TONE[tone])}>
      {pulse && (
        <span aria-hidden className="relative flex size-2">
          <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-60" />
          <span className="relative size-2 rounded-full bg-current" />
        </span>
      )}
      {icon && (
        <span className={clsx("grid place-items-center", spin && "animate-spin")}>
          <Icon icon={icon} size={13} strokeWidth={2.2} spring="snappy" />
        </span>
      )}
      {children}
    </span>
  );
}

function Backdrop({ possessed }: { possessed: boolean }) {
  const reduce = useReducedMotion();
  const glow = "absolute left-1/2 top-[30%] size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div
        className={clsx(glow, "bg-[radial-gradient(circle,var(--color-mint-glow),transparent_68%)] transition-opacity duration-700")}
        style={{ opacity: possessed ? 0 : 0.16 }}
      />
      <motion.div
        className={clsx(glow, "bg-[radial-gradient(circle,var(--color-violet-glow),transparent_68%)]")}
        initial={false}
        animate={{ opacity: possessed ? 0.34 : 0, scale: possessed && !reduce ? [1, 1.08, 1] : 1 }}
        transition={{
          opacity: { duration: duration.deliberate, ease: ease.standard },
          scale: { duration: 1.6, repeat: possessed && !reduce ? Infinity : 0, ease: "easeInOut" },
        }}
      />
    </div>
  );
}

function ConnChip({ status }: { status: ConnectorSnapshot["status"] }) {
  const online = status === "online";
  const waiting = status === "pending_confirmation" || status === "connecting" || status === "reconnecting";
  return (
    <span
      className={clsx(
        "ghost-chip inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-caption font-medium transition-colors duration-200",
        online ? "text-mint" : waiting ? "text-amber" : "text-coral",
      )}
    >
      <span className={clsx("grid place-items-center", waiting && "animate-spin")}>
        <Icon icon={online ? Wifi : waiting ? LoaderCircle : WifiOff} size={14} strokeWidth={2.2} spring="snappy" />
      </span>
      {online ? "Online" : status === "pending_confirmation" ? "Pending" : STATUS_LABEL[status]}
    </span>
  );
}

function InsecureBanner() {
  return (
    <div className="mt-2 flex gap-3 rounded-tile bg-amber/10 px-4 py-3 text-body-sm text-fg-2 ring-1 ring-inset ring-amber/25">
      <Icon icon={Lock} size={16} className="mt-0.5 shrink-0 text-amber" />
      <p>
        <span className="font-semibold text-amber">Not a secure (HTTPS) page.</span> Browsers block the camera, microphone and motion
        sensors on plain http, so a LAN IP like <span className="font-mono text-caption">http://192.168.x.x</span> won&apos;t work. Open
        the GHOST public HTTPS link (Fly.io or tunnel URL) instead.
      </p>
    </div>
  );
}

function SensorRow(props: {
  index: number;
  label: string;
  blurb: string;
  icon: IconNode;
  state: SensorState;
  error?: string;
  support?: Support;
  onToggle: () => void;
}) {
  const { index, label, blurb, icon, state, error, support, onToggle } = props;
  const unsupported = support && !support.supported;
  const on = state === "on";
  const view = SENSOR_VIEW[unsupported ? "unavailable" : state];
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring.gentle, delay: index * 0.035, layout: spring.snappy }}
      className={clsx("rounded-tile transition-colors duration-200", on && "bg-mint/[0.06]", state === "error" && "bg-coral/[0.05]")}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={unsupported || state === "asking"}
        className={clsx(
          "flex min-h-[60px] w-full items-center gap-3 rounded-tile px-3 py-2.5 text-left transition-[transform,background-color] duration-100 active:scale-[0.97] disabled:cursor-not-allowed",
          !unsupported && state !== "asking" && "hover:bg-tint",
        )}
        aria-pressed={on}
      >
        <span
          className={clsx(
            "grid size-10 shrink-0 place-items-center rounded-tile transition-colors duration-200",
            on ? "bg-mint/10 text-mint" : "bg-surface text-fg-2 ring-1 ring-inset ring-line",
            unsupported && "opacity-40",
          )}
        >
          <Icon icon={icon} size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={clsx("text-body font-medium", unsupported ? "text-fg-3" : "text-fg")}>{label}</span>
            <motion.span
              key={view.text}
              initial={on ? { scale: 0.6, opacity: 0 } : { opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={on ? spring.bouncy : { duration: duration.fast, ease: ease.standard }}
              className={clsx("inline-flex items-center rounded-full px-1.5 py-px text-label font-medium", TONE[view.tone])}
            >
              {view.text}
            </motion.span>
          </span>
          <span className={clsx("mt-0.5 block text-body-sm text-fg-3", unsupported ? "line-clamp-2" : "truncate")}>
            {unsupported ? support?.reason : blurb}
          </span>
        </span>
        <Switch state={unsupported ? "off" : state} dim={unsupported} />
      </button>
      {error && state === "error" && (
        <p className="flex items-start gap-1.5 pb-2.5 pl-16 pr-3 text-caption text-coral">
          <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
          {error}
        </p>
      )}
    </motion.li>
  );
}

/** The toggle: its knob slides, and its glyph morphs off (×) → asking (spinner) → on (✓). */
function Switch({ state, dim }: { state: SensorState; dim?: boolean }) {
  const on = state === "on";
  return (
    <span
      aria-hidden
      className={clsx(
        "relative h-7 w-12 shrink-0 rounded-full ring-1 ring-inset transition-colors duration-200",
        on && "bg-mint ring-mint",
        state === "asking" && "bg-amber/15 ring-amber/30",
        state === "error" && "bg-coral/10 ring-coral/30",
        state === "off" && "bg-tint ring-line-strong",
        dim && "opacity-40",
      )}
    >
      <motion.span
        className="absolute left-[3px] top-[3px] grid size-[22px] place-items-center rounded-full bg-fg-inverse shadow-pop"
        initial={false}
        animate={{ x: on ? 20 : 0 }}
        transition={spring.snappy}
      >
        <span className={clsx("grid place-items-center", state === "asking" && "animate-spin")}>
          <Icon
            icon={on ? Check : state === "asking" ? LoaderCircle : state === "error" ? TriangleAlert : X}
            size={13}
            strokeWidth={2.4}
            spring="snappy"
            className={clsx(on ? "text-mint" : state === "asking" ? "text-amber" : state === "error" ? "text-coral" : "text-fg-3")}
          />
        </span>
      </motion.span>
    </span>
  );
}

function StopButton({ onStop, possessed }: { onStop: () => void; possessed: boolean }) {
  const reduce = useReducedMotion();
  return (
    <div className="relative">
      {possessed && !reduce && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-coral/30"
          initial={{ opacity: 0.7, scaleX: 1, scaleY: 1 }}
          animate={{ opacity: 0, scaleX: 1.04, scaleY: 1.22 }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <motion.button
        type="button"
        whileTap={{ scale: 0.95 }}
        transition={spring.snappy}
        onClick={() => {
          haptic(18);
          onStop();
        }}
        className="relative flex h-[76px] w-full items-center justify-center gap-3 rounded-full bg-coral text-title font-semibold text-fg-inverse shadow-pop transition-colors duration-150 hover:bg-coral/90"
      >
        <Icon icon={CircleStop} size={26} strokeWidth={2.2} />
        Stop access
      </motion.button>
    </div>
  );
}

function CameraPeek({ module, active }: { module?: CameraModule; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !module) return;
    const attach = (s: MediaStream) => {
      v.srcObject = s;
      void v.play().catch(() => {});
    };
    attach(module.stream);
    return module.onStreamChange(attach);
  }, [module]);
  return (
    <div className="ghost-glass flex items-center gap-3 rounded-card p-2.5 pr-4 text-left">
      <div
        className={clsx(
          "relative h-[72px] w-24 shrink-0 overflow-hidden rounded-tile transition-shadow duration-300",
          active ? "shadow-float ring-2 ring-violet" : "ring-1 ring-line",
        )}
      >
        <div className="ghost-screen absolute inset-0 bg-page">
          <video ref={ref} muted playsInline className="h-full w-full object-cover" />
          {active && <span className="absolute right-1.5 top-1.5 size-2 animate-pulse rounded-full bg-coral" />}
        </div>
      </div>
      <p className={clsx("text-body-sm", active ? "font-medium text-violet" : "text-fg-2")}>
        {active ? "Polty is looking right now." : "What Polty would see. The camera stays on while shared."}
      </p>
    </div>
  );
}

function DisplayTakeover({ state, onStop }: { state: DisplayState; onStop: () => void }) {
  const [phase, setPhase] = useState(true);
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((state.until - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((state.until - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [state.until]);
  useEffect(() => {
    if (state.mode !== "flash") return;
    const half = 1000 / (2 * Math.min(3, state.hz)); // one flash = on + off → ≤3 flashes/s
    const t = setInterval(() => setPhase((p) => !p), half);
    return () => clearInterval(t);
  }, [state]);
  const bg = state.mode === "flash" ? (phase ? state.color : "#0a0b0e") : state.color;
  const fg = useMemo(() => readableOn(bg), [bg]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: duration.fast, ease: ease.standard } }}
      exit={{ opacity: 0, transition: { duration: duration.instant } }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-8 text-center"
      style={{ background: bg, color: fg, paddingBottom: "max(env(safe-area-inset-bottom), 20px)" }}
    >
      {state.mode === "message" && (
        <motion.div initial={{ scale: 0.92, y: 10 }} animate={{ scale: 1, y: 0 }} transition={spring.gentle}>
          {state.emoji && <div className="mb-6 text-[96px] leading-none">{state.emoji}</div>}
          <p className="font-display text-display" style={{ overflowWrap: "anywhere" }}>
            {state.text}
          </p>
        </motion.div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-6 pb-[max(env(safe-area-inset-bottom),20px)]">
        <p className="text-caption font-medium tabular-nums opacity-75">
          Polty is {state.mode === "flash" ? "flashing" : "showing"} this · {left}s
        </p>
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          transition={spring.snappy}
          onClick={() => {
            haptic(18);
            onStop();
          }}
          className="flex h-16 w-full max-w-xs items-center justify-center gap-2.5 rounded-full bg-coral text-heading font-semibold text-fg-inverse shadow-float ring-2 ring-fg-inverse/70 transition-colors duration-150 hover:bg-coral/90"
        >
          <Icon icon={CircleStop} size={22} strokeWidth={2.2} />
          Stop access
        </motion.button>
      </div>
    </motion.div>
  );
}
