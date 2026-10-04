"use client";
/**
 * The desktop page's own connector ("desktop-browser"): one WebSocket per tab, shared by every
 * component that calls useLocalConnector(). It authenticates with the owner's session token
 * (auto-confirmed) and hosts:
 *   - "This laptop": webcam / microphone / speaker as one composite device,
 *   - Bluetooth LE devices (Web Bluetooth) and USB-serial boards (Web Serial) the owner connects.
 * Its socket is also the viewer-side signaling channel for openDeviceStream().
 *
 * Every add… / enable… function opens a browser permission prompt or device chooser, so it MUST be
 * called directly inside a click handler (no awaits before it).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { MeResponse } from "@/lib/ghost/contracts";
import { GhostConnector } from "./client";
import { composeDevice } from "./compose";
import { deviceChannelUrl, getMe } from "./http";
import type { ActiveInvocation, CapabilityModule, ConnectorStatus, PublishedDeviceInfo } from "./types";
import { enableCamera } from "./drivers/camera";
import { enableMicrophone as enableMicModule } from "./drivers/microphone";
import { enableSpeaker as enableSpeakerModule } from "./drivers/speaker";
import { requestBluetoothDevice, type BleProfile } from "./drivers/bluetooth";
import { requestSerialDevice } from "./drivers/serial";
import { errorMessage } from "./util";

export const LAPTOP_KEY = "this-laptop";

export type LaptopModuleId = "camera" | "microphone" | "speaker";

export interface LocalConnectorState {
  status: ConnectorStatus | "loading" | "signed_out";
  detail: string | null;
  me: MeResponse | null;
  connector_id: string | null;
  devices: PublishedDeviceInfo[];
  laptop: Record<LaptopModuleId, boolean>;
  active: ActiveInvocation[];
}

const INITIAL: LocalConnectorState = {
  status: "loading",
  detail: null,
  me: null,
  connector_id: null,
  devices: [],
  laptop: { camera: false, microphone: false, speaker: false },
  active: [],
};

let state: LocalConnectorState = INITIAL;
const listeners = new Set<() => void>();
let connector: GhostConnector | null = null;
let startPromise: Promise<GhostConnector> | null = null;
const laptopModules = new Map<LaptopModuleId, CapabilityModule>();

function setState(patch: Partial<LocalConnectorState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function syncFromConnector() {
  if (!connector) return;
  const s = connector.getSnapshot();
  setState({
    status: s.status,
    detail: s.detail,
    connector_id: s.connector_id,
    devices: s.devices,
    active: s.active,
    laptop: {
      camera: laptopModules.has("camera"),
      microphone: laptopModules.has("microphone"),
      speaker: laptopModules.has("speaker"),
    },
  });
}

function shortLabel(): string {
  if (typeof navigator === "undefined") return "Desktop browser";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

/** Start (once per tab) and return the desktop connector. Resolves once constructed (may still be connecting). */
export function ensureLocalConnector(): Promise<GhostConnector> {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    let me: MeResponse;
    try {
      me = await getMe();
    } catch (e) {
      setState({ status: "signed_out", detail: `Could not load your GHOST session: ${errorMessage(e)}` });
      startPromise = null;
      throw e;
    }
    setState({ me });
    const c = new GhostConnector({
      url: deviceChannelUrl(),
      connectorKind: "desktop-browser",
      label: shortLabel(),
      ownerToken: me.owner_token,
      expectedOwnerId: me.principal_id,
      storageKey: `ghost.connector.desktop-browser.${me.principal_id}.credential`,
    });
    connector = c;
    c.subscribe(syncFromConnector);
    c.start();
    syncFromConnector();
    return c;
  })();
  return startPromise;
}

/** Resolve with the connector once it is online (welcomed), or reject after timeoutMs. */
export async function getLocalConnector(timeoutMs = 10_000): Promise<GhostConnector> {
  const c = await ensureLocalConnector();
  if (c.isOnline) return c;
  return new Promise<GhostConnector>((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error(`GHOST device channel is not connected (${c.getSnapshot().status}${c.getSnapshot().detail ? `: ${c.getSnapshot().detail}` : ""})`));
    }, timeoutMs);
    const unsub = c.subscribe(() => {
      if (c.isOnline) {
        clearTimeout(t);
        unsub();
        resolve(c);
      }
    });
  });
}

function republishLaptop(c: GhostConnector) {
  const modules = [...laptopModules.values()];
  if (!modules.length) {
    void c.removeDevice(LAPTOP_KEY, { dispose: false });
    syncFromConnector();
    return;
  }
  const device = composeDevice(
    {
      local_key: LAPTOP_KEY,
      name: "This laptop",
      device_class: "computer",
      transport: "browser",
      icon: "laptop",
      meta: { browser: shortLabel() },
    },
    modules,
  );
  c.updateDevice(device);
  syncFromConnector();
}

async function addLaptopModule(id: LaptopModuleId, open: () => Promise<CapabilityModule>): Promise<PublishedDeviceInfo> {
  // open() first: it must run inside the click's user activation.
  const pending = open();
  const c = await ensureLocalConnector();
  const mod = await pending;
  laptopModules.get(id)?.dispose?.();
  laptopModules.set(id, mod);
  republishLaptop(c);
  return waitForPublished(LAPTOP_KEY);
}

/** Wait (briefly) until the coordinator assigned a device_id; returns the latest info either way. */
export async function waitForPublished(local_key: string, ms = 4000): Promise<PublishedDeviceInfo> {
  const c = await ensureLocalConnector();
  const find = () => c.getSnapshot().devices.find((d) => d.local_key === local_key);
  const now = find();
  if (now?.device_id && now.status !== "publishing") return now;
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(t);
      unsub();
      const d = find();
      if (d) resolve(d);
      else reject(new Error("device disappeared before it was published"));
    };
    const t = setTimeout(done, ms);
    const unsub = c.subscribe(() => {
      const d = find();
      if (d?.device_id && d.status !== "publishing") done();
    });
  });
}

/* ---------------- actions (call inside click handlers) ---------------- */

export function enableWebcam() {
  return addLaptopModule("camera", () =>
    enableCamera({
      facing: "user",
      label: "Webcam",
      onLive: (sid, did, live) => connector?.setLiveSession(sid, did, live),
    }),
  );
}

export function enableMicrophone() {
  return addLaptopModule("microphone", () => enableMicModule());
}

export function enableSpeaker() {
  return addLaptopModule("speaker", () => enableSpeakerModule());
}

export async function disableLaptopModule(id: LaptopModuleId) {
  const mod = laptopModules.get(id);
  if (!mod) return;
  laptopModules.delete(id);
  const c = await ensureLocalConnector();
  republishLaptop(c);
  await mod.dispose?.();
  syncFromConnector();
}

export async function addBluetooth(profile?: BleProfile): Promise<PublishedDeviceInfo> {
  let key: string | null = null;
  // requestDevice must be the first thing that happens in the gesture.
  const pending = requestBluetoothDevice(profile, {
    onAvailability: (online, detail) => {
      if (key) connector?.setDeviceStatus(key, online, detail);
    },
  });
  const c = await ensureLocalConnector();
  const device = await pending;
  key = device.manifest.local_key;
  c.registerDevice(device);
  return waitForPublished(key);
}

export async function addSerial(opts?: { baudRate?: number }): Promise<PublishedDeviceInfo> {
  let key: string | null = null;
  const pending = requestSerialDevice(opts, {
    onAvailability: (online, detail) => {
      if (key) connector?.setDeviceStatus(key, online, detail);
    },
  });
  const c = await ensureLocalConnector();
  const device = await pending;
  key = device.manifest.local_key;
  c.registerDevice(device);
  return waitForPublished(key);
}

export async function remove(local_key: string) {
  if (local_key === LAPTOP_KEY) {
    const mods = [...laptopModules.values()];
    laptopModules.clear();
    const c = await ensureLocalConnector();
    await c.removeDevice(LAPTOP_KEY, { dispose: false });
    for (const m of mods) await m.dispose?.();
    syncFromConnector();
    return;
  }
  const c = await ensureLocalConnector();
  await c.removeDevice(local_key);
  syncFromConnector();
}

/* ---------------- React hook ---------------- */

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const getState = () => state;
const getServerState = () => INITIAL;

export function useLocalConnector() {
  const s = useSyncExternalStore(subscribe, getState, getServerState);
  useEffect(() => {
    ensureLocalConnector().catch(() => {});
  }, []);
  return {
    ...s,
    addBluetooth,
    addSerial,
    enableWebcam,
    enableMicrophone,
    enableSpeaker,
    disableLaptopModule,
    remove,
  };
}

export type UseLocalConnector = ReturnType<typeof useLocalConnector>;
