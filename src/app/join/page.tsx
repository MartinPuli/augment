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
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  BatteryMedium,
  Camera,
  Check,
  CircleStop,
  Compass,
  Flashlight,
  Lock,
  LoaderCircle,
  MapPin,
  Mic,
  RefreshCw,
  Smartphone,
  TriangleAlert,
  Vibrate,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
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

const SENSORS: { id: SensorId; label: string; blurb: string; icon: ComponentType<{ className?: string }> }[] = [
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
    <main className="relative min-h-dvh overflow-hidden bg-ink text-ivory">
      <Backdrop possessed={possessed} />
      <div
        className="relative z-10 mx-auto flex min-h-dvh w-full max-w-md flex-col px-5"
        style={{ paddingTop: "max(env(safe-area-inset-top), 18px)", paddingBottom: "max(env(safe-area-inset-bottom), 18px)" }}
      >
        <header className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <span className="font-display text-[15px] font-extrabold tracking-[0.18em]">GHOST</span>
            <span className="hud-label">phone link</span>
          </div>
          {boot === "connector" && <ConnChip status={status} />}
        </header>

        {!secure && <InsecureBanner />}

        <AnimatePresence mode="wait">
          {boot === "loading" && (
            <motion.section key="loading" className="flex flex-1 items-center justify-center" exit={{ opacity: 0 }}>
              <Ghost mood="waiting" size={120} />
            </motion.section>
          )}

          {boot === "no-code" && (
            <Panel key="no-code">
              <Ghost mood="idle" size={132} className="mx-auto" />
              <h1 className="mt-6 text-center font-display text-2xl font-semibold leading-tight">Pair this phone with GHOST</h1>
              <p className="mt-3 text-center text-[15px] leading-relaxed text-ivory-dim">
                On your computer, open GHOST and choose <b className="text-ivory">Pair a phone</b>. Scan the QR code with this phone&apos;s
                camera — or type the 6-character code here.
              </p>
              <form
                className="mt-6 flex gap-2"
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
                  aria-label="Pairing code"
                  className="min-w-0 flex-1 rounded-2xl border border-line-strong bg-ink-3 px-4 py-3.5 text-center font-mono text-xl tracking-[0.35em] text-ivory outline-none placeholder:text-mute/50 focus:border-mint/60"
                />
                <button
                  type="submit"
                  disabled={manualCode.trim().length < 4}
                  className="rounded-2xl bg-mint px-5 font-semibold text-ink transition active:scale-95 disabled:opacity-30"
                >
                  Pair
                </button>
              </form>
            </Panel>
          )}

          {boot === "connector" && !welcomed && status !== "error" && (
            <Panel key="pending">
              <div className="relative mx-auto mt-4 flex w-fit items-center justify-center">
                <span className="absolute h-40 w-40 rounded-full border border-amber/40 animate-pulse-ring" />
                <span className="absolute h-40 w-40 rounded-full border border-amber/25 animate-pulse-ring [animation-delay:0.9s]" />
                <Ghost mood="waiting" size={140} />
              </div>
              <h1 className="mt-8 text-center font-display text-[22px] font-semibold leading-tight">
                {status === "pending_confirmation" ? "Waiting for the owner to confirm…" : "Reaching GHOST…"}
              </h1>
              <p className="mt-3 text-center text-[15px] leading-relaxed text-ivory-dim">
                {status === "pending_confirmation"
                  ? `Your computer should now show "${phoneName()}" asking to pair. Tap Confirm there. Nothing on this phone is shared yet.`
                  : status === "reconnecting"
                    ? `Connection dropped — retrying${snap?.detail ? ` (${snap.detail})` : ""}.`
                    : "Opening a secure channel to the coordinator."}
              </p>
              <div className="mt-6 flex justify-center">
                <span className="inline-flex items-center gap-2 rounded-full border border-amber/30 bg-amber/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-amber">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> {status === "pending_confirmation" ? "awaiting confirmation" : status}
                </span>
              </div>
            </Panel>
          )}

          {boot === "connector" && status === "error" && (
            <Panel key="error">
              <Ghost mood="sad" size={120} className="mx-auto" />
              <h1 className="mt-6 text-center font-display text-xl font-semibold">Couldn&apos;t connect</h1>
              <p className="mt-3 text-center text-[15px] leading-relaxed text-coral">{snap?.detail ?? "The coordinator refused the connection."}</p>
              <p className="mt-3 text-center text-sm text-ivory-dim">Ask the owner for a fresh QR code — codes are single-use and expire after 2 minutes.</p>
              <button
                onClick={forgetPhone}
                className="mx-auto mt-6 flex items-center gap-2 rounded-2xl border border-line-strong px-5 py-3 text-sm font-semibold active:scale-95"
              >
                <RefreshCw className="h-4 w-4" /> Enter a new code
              </button>
            </Panel>
          )}

          {boot === "connector" && welcomed && !published && (
            <Panel key="setup">
              <div className="flex items-center gap-4">
                <Ghost mood="idle" size={74} />
                <div>
                  <p className="hud-label text-mint">paired · confirmed</p>
                  <h1 className="font-display text-xl font-semibold leading-tight">What can Polty borrow?</h1>
                  <p className="mt-1 text-sm text-ivory-dim">Turn on only what you want to lend. Each one asks your permission first.</p>
                </div>
              </div>
              {stoppedNote && (
                <p className="mt-4 rounded-2xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">{stoppedNote}</p>
              )}
              <label className="mt-5 block">
                <span className="hud-label">device name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 60))}
                  className="mt-1.5 w-full rounded-xl border border-line bg-ink-3 px-3.5 py-2.5 text-[15px] outline-none focus:border-mint/50"
                />
              </label>
              <ul className="mt-4 space-y-2">
                {SENSORS.filter((s) => s.id !== "battery" || support.battery?.supported).map((s) => (
                  <SensorRow
                    key={s.id}
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
              {support.microphone?.supported && <div className="mt-3"><MicrophoneInputPicker input={micInput} active={sensors.microphone === "on"} activeLabel={modulesRef.current.get("microphone")?.connection?.input_label} /></div>}
              <div className="sticky bottom-0 -mx-5 mt-5 bg-gradient-to-t from-ink via-ink/95 to-transparent px-5 pb-1 pt-6">
                <button
                  onClick={publishDevice}
                  disabled={enabledCount === 0 || status !== "online"}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-mint py-4 font-display text-[15px] font-semibold text-ink shadow-[0_10px_40px_-10px_rgba(93,242,181,0.6)] transition active:scale-[0.98] disabled:bg-ink-4 disabled:text-mute disabled:shadow-none"
                >
                  {enabledCount === 0 ? "Turn on at least one sensor" : `Publish device · ${enabledCount} sensor${enabledCount > 1 ? "s" : ""}`}
                </button>
                <button onClick={forgetPhone} className="mx-auto mt-3 block text-xs text-mute underline-offset-4 hover:underline">
                  Unpair this phone
                </button>
              </div>
            </Panel>
          )}

          {boot === "connector" && welcomed && published && (
            <motion.section
              key="live"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-1 flex-col"
            >
              <div className="flex flex-1 flex-col items-center justify-center pt-4 text-center">
                <Ghost mood={mood} size={possessed ? 210 : 170} />
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activityText ?? "idle"}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="mt-6 min-h-[88px] px-2"
                  >
                    {possessed ? (
                      <>
                        <p className="hud-label text-violet">possessed</p>
                        <h1 className="mt-1 font-display text-[26px] font-semibold leading-tight text-ivory">{activityText}</h1>
                        {speaking && <p className="mt-2 text-[15px] italic text-ivory-dim">“{speaking}”</p>}
                      </>
                    ) : (
                      <>
                        <p className="hud-label text-mint">{hidden ? "paused" : "haunted & ready"}</p>
                        <h1 className="mt-1 font-display text-[22px] font-semibold leading-tight">
                          {hidden ? "Paused while the screen is off" : "Polty can borrow this phone"}
                        </h1>
                        <p className="mt-2 text-sm text-ivory-dim">Keep this tab open and the screen on. You&apos;ll see here whenever it&apos;s used.</p>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>

              {sensors.camera === "on" && (
                <CameraPeek module={modulesRef.current.get("camera") as CameraModule | undefined} active={!!current?.capability_id.startsWith("camera") || live.length > 0} />
              )}

              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {(phoneDevice?.capabilities ?? []).map((c) => {
                  const busy = active.some((a) => a.capability_id === c.capability_id) || (c.capability_id === "camera.stream" && live.length > 0);
                  return (
                    <span
                      key={c.capability_id}
                      className={clsx(
                        "rounded-full border px-2.5 py-1 font-mono text-[10.5px] transition",
                        busy ? "border-violet/60 bg-violet/15 text-violet" : "border-line bg-ink-3/70 text-ivory-dim",
                      )}
                    >
                      {busy && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet align-middle" />}
                      {c.capability_id}
                    </span>
                  );
                })}
              </div>
              <p className="mt-2 text-center font-mono text-[10.5px] text-mute">
                {phoneDevice?.device_id ? `device ${phoneDevice.device_id} · ${phoneDevice.status}` : "publishing…"}
              </p>

              {(snap?.recent.length ?? 0) > 0 && (
                <ul className="ghost-glass mt-4 space-y-1 rounded-2xl px-4 py-3">
                  {snap!.recent.slice(0, 3).map((r) => (
                    <li key={r.invocation_id} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="flex items-center gap-2 text-ivory-dim">
                        <Activity className="h-3.5 w-3.5 text-mute" />
                        {DONE[r.capability_id] ?? r.capability_id}
                      </span>
                      <span
                        className={clsx(
                          "font-mono text-[11px]",
                          r.state === "succeeded" ? "text-mint" : r.state === "rejected" || r.state === "failed" ? "text-coral" : "text-amber",
                        )}
                      >
                        {r.state} · {new Date(r.finished_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                <StopButton onStop={stopAccess} />
                <button
                  onClick={() => {
                    publishedRef.current = false;
                    setPublished(false);
                    connRef.current?.unpublish([PHONE_KEY]);
                  }}
                  className="rounded-2xl border border-line-strong px-4 text-sm font-semibold text-ivory-dim active:scale-95"
                >
                  Edit
                </button>
              </div>
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

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ type: "spring", stiffness: 220, damping: 26 }}
      className="flex flex-1 flex-col justify-center py-6"
    >
      {children}
    </motion.section>
  );
}

function Backdrop({ possessed }: { possessed: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <motion.div
        className="absolute left-1/2 top-[30%] h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        animate={{
          background: possessed
            ? "radial-gradient(circle, rgba(169,155,255,0.28), rgba(93,242,181,0.12) 45%, transparent 70%)"
            : "radial-gradient(circle, rgba(93,242,181,0.16), rgba(93,242,181,0.04) 45%, transparent 70%)",
          scale: possessed ? [1, 1.08, 1] : 1,
        }}
        transition={{ duration: possessed ? 1.6 : 0.8, repeat: possessed ? Infinity : 0 }}
      />
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage: "radial-gradient(rgba(244,239,228,0.9) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          maskImage: "radial-gradient(ellipse at 50% 30%, black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at 50% 30%, black, transparent 75%)",
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
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em]",
        online && "border-mint/30 bg-mint/10 text-mint",
        waiting && "border-amber/30 bg-amber/10 text-amber",
        !online && !waiting && "border-coral/30 bg-coral/10 text-coral",
      )}
    >
      {online ? <Wifi className="h-3 w-3" /> : waiting ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <WifiOff className="h-3 w-3" />}
      {online ? "online" : status === "pending_confirmation" ? "pending" : status}
    </span>
  );
}

function InsecureBanner() {
  return (
    <div className="mt-2 flex gap-3 rounded-2xl border border-amber/30 bg-amber/10 px-4 py-3 text-[13px] leading-snug text-amber">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <b>Not a secure (HTTPS) page.</b> Browsers block the camera, microphone and motion sensors on plain http — a LAN IP like
        http://192.168.x.x won&apos;t work. Open the GHOST public HTTPS link (Fly.io or tunnel URL) instead.
      </p>
    </div>
  );
}

function SensorRow(props: {
  label: string;
  blurb: string;
  icon: ComponentType<{ className?: string }>;
  state: SensorState;
  error?: string;
  support?: Support;
  onToggle: () => void;
}) {
  const { label, blurb, icon: Icon, state, error, support, onToggle } = props;
  const unsupported = support && !support.supported;
  const on = state === "on";
  return (
    <motion.li layout className={clsx("rounded-2xl border bg-ink-2/80 px-3.5 py-3 transition", on ? "border-mint/35" : "border-line")}>
      <button
        type="button"
        onClick={onToggle}
        disabled={unsupported || state === "asking"}
        className="flex w-full items-center gap-3 text-left disabled:cursor-not-allowed"
        aria-pressed={on}
      >
        <span
          className={clsx(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl border transition",
            on ? "border-mint/40 bg-mint/15 text-mint" : "border-line bg-ink-3 text-ivory-dim",
            unsupported && "opacity-40",
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className={clsx("min-w-0 flex-1", unsupported && "opacity-50")}>
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            {label}
            <span
              className={clsx(
                "font-mono text-[10px] uppercase tracking-[0.12em]",
                on ? "text-mint" : state === "asking" ? "text-amber" : state === "error" ? "text-coral" : "text-mute",
              )}
            >
              {unsupported ? "unavailable" : on ? "shared" : state === "asking" ? "asking…" : state === "error" ? "not shared" : "off"}
            </span>
          </span>
          <span className="block truncate text-[12.5px] text-mute">{unsupported ? support?.reason : blurb}</span>
        </span>
        <span
          className={clsx(
            "relative h-7 w-12 shrink-0 rounded-full border transition",
            on ? "border-mint/50 bg-mint/80" : "border-line-strong bg-ink-4",
            unsupported && "opacity-30",
          )}
        >
          <motion.span
            className={clsx("absolute top-0.5 grid h-[22px] w-[22px] place-items-center rounded-full", on ? "bg-ink" : "bg-ivory-dim")}
            animate={{ left: on ? 22 : 2 }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
          >
            {state === "asking" ? (
              <LoaderCircle className="h-3 w-3 animate-spin text-ink" />
            ) : on ? (
              <Check className="h-3 w-3 text-mint" />
            ) : (
              <X className="h-3 w-3 text-ink/60" />
            )}
          </motion.span>
        </span>
      </button>
      {error && state === "error" && (
        <p className="mt-2 flex items-start gap-1.5 pl-[52px] text-[12.5px] leading-snug text-coral">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </motion.li>
  );
}

function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onStop}
      className="flex items-center justify-center gap-2.5 rounded-2xl border border-coral/40 bg-coral py-[18px] font-display text-[17px] font-semibold text-ink shadow-[0_12px_40px_-12px_rgba(255,107,94,0.7)]"
    >
      <CircleStop className="h-5 w-5" /> Stop access
    </motion.button>
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
    <div className="mx-auto mt-2 flex items-center gap-3">
      <div
        className={clsx(
          "relative h-[72px] w-[96px] overflow-hidden rounded-xl border bg-ink-3 transition",
          active ? "border-violet/70 shadow-[0_0_24px_rgba(169,155,255,0.5)]" : "border-line",
        )}
      >
        <video ref={ref} muted playsInline className="h-full w-full object-cover" />
        {active && <span className="absolute right-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-coral" />}
      </div>
      <p className="max-w-[170px] text-left text-[12px] leading-snug text-mute">
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
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-8 text-center"
      style={{ background: bg, color: fg, paddingBottom: "max(env(safe-area-inset-bottom), 20px)" }}
    >
      {state.mode === "message" && (
        <motion.div initial={{ scale: 0.9, y: 10 }} animate={{ scale: 1, y: 0 }} transition={{ type: "spring", stiffness: 200, damping: 18 }}>
          {state.emoji && <div className="mb-6 text-[96px] leading-none">{state.emoji}</div>}
          <p className="font-display text-[clamp(28px,8vw,46px)] font-semibold leading-[1.1]" style={{ overflowWrap: "anywhere" }}>
            {state.text}
          </p>
        </motion.div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 pb-[max(env(safe-area-inset-bottom),20px)]">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] opacity-70">
          Polty is {state.mode === "flash" ? "flashing" : "showing"} this · {left}s
        </p>
        <button
          onClick={onStop}
          className="rounded-full border px-5 py-2.5 text-sm font-semibold backdrop-blur"
          style={{ borderColor: fg + "55", background: fg === "#0a0b0e" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)" }}
        >
          Stop access
        </button>
      </div>
    </motion.div>
  );
}
