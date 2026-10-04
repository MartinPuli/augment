/**
 * Small phone sensors: haptics.vibrate, motion.read, location.read, battery.read.
 * Each enable* function returns a module only when the API exists and permission was granted.
 */
import { InvokeError, type CapabilityModule } from "../types";
import { boolArg, enumArg, numArg, sleep } from "../util";

/* ------------------------------------------------------------------ */
/* Haptics                                                             */
/* ------------------------------------------------------------------ */

export function hapticsSupport(): { supported: boolean; reason?: string } {
  if (typeof navigator === "undefined") return { supported: false, reason: "not in a browser" };
  if (typeof navigator.vibrate !== "function")
    return { supported: false, reason: "Vibration is not available in this browser (iOS Safari does not support it)" };
  return { supported: true };
}

const PRESETS = {
  tap: [40],
  double: [60, 80, 60],
  heartbeat: [80, 120, 80, 600, 80, 120, 80],
  alert: [300, 150, 300, 150, 300],
  boo: [120, 60, 120, 60, 500],
} as const;

export function enableHaptics(): CapabilityModule {
  const s = hapticsSupport();
  if (!s.supported) throw new Error(s.reason);
  // Must run in a user gesture: Chrome only vibrates after user activation.
  try {
    navigator.vibrate(30);
  } catch {}
  let disposed = false;
  return {
    id: "haptics",
    label: "Haptics",
    capabilities: [
      {
        capability_id: "haptics.vibrate",
        kind: "act",
        semantic_type: "haptics.vibrate",
        title: "Vibrate",
        description:
          "Vibrate the phone with a preset (tap, double, heartbeat, alert, boo) or a pattern in ms (≤20 entries, each ≤1000 ms, total ≤5 s). Acknowledgment only.",
        input_schema: {
          type: "object",
          properties: {
            preset: { type: "string", enum: Object.keys(PRESETS) },
            pattern: { type: "array", items: { type: "number", minimum: 0, maximum: 1000 }, maxItems: 20 },
          },
          additionalProperties: false,
        },
        verification: "acknowledgment",
        concurrency_group: "haptics",
        estimated_ms: 800,
      },
    ],
    async handle(capability_id, args, ctx) {
      if (disposed) throw new InvokeError("haptics were turned off by the owner", "failed");
      if (capability_id !== "haptics.vibrate") throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
      const preset = enumArg(args, "preset", Object.keys(PRESETS) as (keyof typeof PRESETS)[]);
      let pattern: number[];
      if (Array.isArray(args.pattern)) {
        if (args.pattern.length > 20) throw new InvokeError("pattern has more than 20 entries", "rejected");
        pattern = args.pattern.map((v) => {
          if (typeof v !== "number" || !Number.isFinite(v)) throw new InvokeError("pattern entries must be numbers", "rejected");
          return Math.max(0, Math.min(1000, Math.round(v)));
        });
      } else {
        pattern = [...PRESETS[preset ?? "double"]];
      }
      let total = 0;
      pattern = pattern.filter((v) => (total += v) <= 5000);
      const ok = navigator.vibrate(pattern);
      if (!ok) throw new InvokeError("the browser refused to vibrate (needs a recent tap on the page)", "failed");
      await sleep(Math.min(total, 5000), ctx.signal).catch((e) => {
        navigator.vibrate(0);
        throw e;
      });
      return { value: true, data: { pattern, total_ms: Math.min(total, 5000) }, captured_at: new Date().toISOString(), note: "Vibration requested; not verified as felt." };
    },
    onRevoke() {
      try {
        navigator.vibrate(0);
      } catch {}
    },
    dispose() {
      disposed = true;
      try {
        navigator.vibrate(0);
      } catch {}
    },
  };
}

/* ------------------------------------------------------------------ */
/* Motion / orientation                                                */
/* ------------------------------------------------------------------ */

type PermissionCapable = { requestPermission?: () => Promise<"granted" | "denied" | "default"> };

export function motionSupport(): { supported: boolean; reason?: string; needsPermission: boolean } {
  if (typeof window === "undefined") return { supported: false, reason: "not in a browser", needsPermission: false };
  if (typeof DeviceMotionEvent === "undefined")
    return { supported: false, reason: "No motion sensors API in this browser", needsPermission: false };
  if (!window.isSecureContext) return { supported: false, reason: "Motion sensors need HTTPS", needsPermission: false };
  const needs = typeof (DeviceMotionEvent as unknown as PermissionCapable).requestPermission === "function";
  return { supported: true, needsPermission: needs };
}

/** Call from a click handler (iOS asks for permission). Probes for real sensor events. */
export async function enableMotion(): Promise<CapabilityModule> {
  const s = motionSupport();
  if (!s.supported) throw new Error(s.reason);
  const DM = DeviceMotionEvent as unknown as PermissionCapable;
  const DO = (typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : null) as unknown as PermissionCapable | null;
  if (typeof DM.requestPermission === "function") {
    const r = await DM.requestPermission();
    if (r !== "granted") throw new Error("Motion permission was denied");
    if (DO && typeof DO.requestPermission === "function") await DO.requestPermission().catch(() => "denied");
  }
  // Probe: desktops expose the API but never fire real events.
  const gotEvent = await new Promise<boolean>((resolve) => {
    const on = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (a && (a.x !== null || a.y !== null || a.z !== null)) {
        window.removeEventListener("devicemotion", on);
        resolve(true);
      }
    };
    window.addEventListener("devicemotion", on);
    setTimeout(() => {
      window.removeEventListener("devicemotion", on);
      resolve(false);
    }, 1500);
  });
  if (!gotEvent) throw new Error("No motion sensor data from this device");
  let disposed = false;
  return {
    id: "motion",
    label: "Motion",
    capabilities: [
      {
        capability_id: "motion.read",
        kind: "measure",
        semantic_type: "motion.read",
        title: "Read motion & orientation",
        description:
          "Sample the accelerometer, gyroscope and orientation for up to 3 s. Value = peak movement (m/s², gravity removed); data includes tilt and whether the phone is face up / moving.",
        input_schema: {
          type: "object",
          properties: { seconds: { type: "number", minimum: 0.2, maximum: 3, default: 1 } },
          additionalProperties: false,
        },
        output: { unit: "m/s²" },
        verification: "observation",
        exclusive: false,
        estimated_ms: 1200,
      },
    ],
    async handle(capability_id, args, ctx) {
      if (disposed) throw new InvokeError("motion access was turned off by the owner", "failed");
      if (capability_id !== "motion.read") throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
      const seconds = Math.min(numArg(args, "seconds", { min: 0.2, max: 3, def: 1 }), ctx.remainingMs() / 1000 - 0.2);
      if (seconds < 0.2) throw new InvokeError("not enough time before the deadline", "rejected");
      const started = new Date();
      let n = 0;
      let peakDyn = 0;
      let peakRot = 0;
      const g = { x: 0, y: 0, z: 0 };
      let orient: { alpha: number | null; beta: number | null; gamma: number | null } | null = null;
      const onMotion = (e: DeviceMotionEvent) => {
        const ag = e.accelerationIncludingGravity;
        const a = e.acceleration;
        if (ag) {
          g.x += ag.x ?? 0;
          g.y += ag.y ?? 0;
          g.z += ag.z ?? 0;
          n++;
        }
        if (a && a.x !== null) {
          const m = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
          if (m > peakDyn) peakDyn = m;
        }
        const r = e.rotationRate;
        if (r) {
          const m = Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);
          if (m > peakRot) peakRot = m;
        }
      };
      const onOrient = (e: DeviceOrientationEvent) => {
        orient = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
      };
      window.addEventListener("devicemotion", onMotion);
      window.addEventListener("deviceorientation", onOrient);
      try {
        await sleep(seconds * 1000, ctx.signal);
      } finally {
        window.removeEventListener("devicemotion", onMotion);
        window.removeEventListener("deviceorientation", onOrient);
      }
      if (n === 0) throw new InvokeError("no motion samples arrived (is the tab in the foreground?)", "failed");
      const mean = { x: g.x / n, y: g.y / n, z: g.z / n };
      const r1 = (v: number) => Math.round(v * 100) / 100;
      return {
        value: r1(peakDyn),
        unit: "m/s²",
        captured_at: started.toISOString(),
        data: {
          samples: n,
          seconds: r1(seconds),
          gravity: { x: r1(mean.x), y: r1(mean.y), z: r1(mean.z) },
          peak_rotation_dps: r1(peakRot),
          orientation: orient,
          face_up: mean.z > 7,
          face_down: mean.z < -7,
          moving: peakDyn > 0.8 || peakRot > 25,
        },
      };
    },
    dispose() {
      disposed = true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

export function locationSupport(): { supported: boolean; reason?: string } {
  if (typeof navigator === "undefined") return { supported: false, reason: "not in a browser" };
  if (!("geolocation" in navigator)) return { supported: false, reason: "No geolocation API" };
  if (typeof window !== "undefined" && !window.isSecureContext) return { supported: false, reason: "Location needs HTTPS" };
  return { supported: true };
}

function getPosition(o: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, o));
}

/** Prompts for location permission; only returns a module if a fix was obtained. */
export async function enableLocation(): Promise<CapabilityModule> {
  const s = locationSupport();
  if (!s.supported) throw new Error(s.reason);
  try {
    await getPosition({ enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
  } catch (e) {
    const err = e as GeolocationPositionError;
    throw new Error(err?.code === 1 ? "Location permission was denied" : `Location unavailable: ${err?.message ?? e}`);
  }
  let disposed = false;
  return {
    id: "location",
    label: "Location",
    capabilities: [
      {
        capability_id: "location.read",
        kind: "measure",
        semantic_type: "location.read",
        title: "Where is this phone?",
        description:
          "Read the phone's current GPS/network position (WGS84) with its accuracy radius in meters. captured_at is the fix timestamp.",
        input_schema: {
          type: "object",
          properties: {
            high_accuracy: { type: "boolean", default: false },
            max_age_s: { type: "number", minimum: 0, maximum: 300, default: 30 },
          },
          additionalProperties: false,
        },
        output: { unit: "WGS84" },
        verification: "observation",
        exclusive: false,
        estimated_ms: 2500,
      },
    ],
    async handle(capability_id, args, ctx) {
      if (disposed) throw new InvokeError("location access was turned off by the owner", "failed");
      if (capability_id !== "location.read") throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
      const high = boolArg(args, "high_accuracy") ?? false;
      const maxAge = numArg(args, "max_age_s", { min: 0, max: 300, def: 30 });
      let pos: GeolocationPosition;
      try {
        pos = await getPosition({
          enableHighAccuracy: high,
          maximumAge: maxAge * 1000,
          timeout: Math.max(1000, Math.min(20_000, ctx.remainingMs() - 300)),
        });
      } catch (e) {
        const err = e as GeolocationPositionError;
        throw new InvokeError(err?.code === 1 ? "location permission revoked" : `no position fix: ${err?.message ?? e}`, "failed");
      }
      const c = pos.coords;
      return {
        value: `${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`,
        unit: "WGS84",
        captured_at: new Date(pos.timestamp).toISOString(),
        data: {
          lat: c.latitude,
          lon: c.longitude,
          accuracy_m: Math.round(c.accuracy),
          altitude_m: c.altitude,
          heading_deg: c.heading,
          speed_mps: c.speed,
        },
        note: `Accuracy ±${Math.round(c.accuracy)} m.`,
      };
    },
    dispose() {
      disposed = true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Battery                                                             */
/* ------------------------------------------------------------------ */

interface BatteryManagerLike {
  level: number;
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
}

export function batterySupport(): { supported: boolean; reason?: string } {
  if (typeof navigator === "undefined") return { supported: false, reason: "not in a browser" };
  if (typeof (navigator as unknown as { getBattery?: unknown }).getBattery !== "function")
    return { supported: false, reason: "Battery status is not exposed by this browser" };
  return { supported: true };
}

export async function enableBattery(): Promise<CapabilityModule> {
  const s = batterySupport();
  if (!s.supported) throw new Error(s.reason);
  const getBattery = () => (navigator as unknown as { getBattery: () => Promise<BatteryManagerLike> }).getBattery();
  await getBattery();
  return {
    id: "battery",
    label: "Battery",
    capabilities: [
      {
        capability_id: "battery.read",
        kind: "measure",
        semantic_type: "battery.read",
        title: "Battery level",
        description: "Read this device's battery level (%) and charging state as reported by the browser.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output: { unit: "%" },
        verification: "observation",
        exclusive: false,
        estimated_ms: 100,
      },
    ],
    async handle(capability_id) {
      if (capability_id !== "battery.read") throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
      const b = await getBattery();
      return {
        value: Math.round(b.level * 100),
        unit: "%",
        captured_at: new Date().toISOString(),
        data: {
          charging: b.charging,
          charging_time_s: Number.isFinite(b.chargingTime) ? b.chargingTime : null,
          discharging_time_s: Number.isFinite(b.dischargingTime) ? b.dischargingTime : null,
        },
      };
    },
  };
}
