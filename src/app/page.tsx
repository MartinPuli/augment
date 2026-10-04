"use client";

import { useEffect } from "react";
import type { Device, Lease } from "@/lib/ghost/contracts";
import { subscribeEvents } from "@/lib/ghost/client/api";
import { useGhost } from "@/lib/store";
import { ghost } from "@/lib/agent/http";
import { sendToPolty } from "@/lib/agent/runtime";
import { listener } from "@/lib/voice/listener";
import { speaker } from "@/lib/voice/speaker";
import { Canvas } from "@/components/canvas/Canvas";
import { PoltyStage } from "@/components/mascot/PoltyStage";
import { TopBar } from "@/components/hud/TopBar";
import { VoiceDock } from "@/components/hud/VoiceDock";
import { Hero } from "@/components/hud/Hero";
import { ConversationDrawer } from "@/components/hud/ConversationDrawer";

export default function Home() {
  useCoordinatorSync();
  useDozing();

  const poke = () => {
    speaker?.unlock();
    const s = useGhost.getState();
    if (listener?.listening) {
      if (!s.handsFree) listener.finish();
      return;
    }
    if (s.running || s.activity === "speaking") return;
    s.set({ mood: "surprised" });
    setTimeout(() => useGhost.getState().set({ mood: "happy" }), 500);
    listener?.start("ptt", (t) => void sendToPolty(t));
  };

  return (
    <main className="ghost-world relative min-h-dvh overflow-x-hidden">
      <TopBar />
      <Hero />
      <Canvas />
      <PoltyStage onPoke={poke} />
      <VoiceDock />
      <ConversationDrawer />
    </main>
  );
}

/** Polty dozes off after a quiet spell and wakes with a start when you come back. */
function useDozing() {
  useEffect(() => {
    let last = Date.now();
    const wake = () => {
      last = Date.now();
      const s = useGhost.getState();
      if (s.mood === "sleepy") {
        s.set({ mood: "surprised" });
        setTimeout(() => useGhost.getState().mood === "surprised" && useGhost.getState().set({ mood: "happy" }), 600);
        setTimeout(() => useGhost.getState().mood === "happy" && !useGhost.getState().running && useGhost.getState().set({ mood: "neutral" }), 2600);
      }
    };
    const t = setInterval(() => {
      const s = useGhost.getState();
      if (s.running || s.activity !== "idle") last = Date.now();
      else if (Date.now() - last > 90_000 && s.mood !== "sleepy") s.set({ mood: "sleepy" });
    }, 2000);
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearInterval(t);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);
}

/** Mirror coordinator state (devices, leases, balance) into the store and react to new bodies. */
function useCoordinatorSync() {
  useEffect(() => {
    let alive = true;
    const set = useGhost.getState().set;
    void speaker?.detect();

    // /me creates the session cookie; everything else waits for it.
    ghost<{ principal_id: string; owner_token: string; balance_cents: number; display_name: string }>("/me")
      .then(async (me) => {
        if (!alive) return;
        set({ me });
        const [list, leases] = await Promise.all([
          ghost<Device[]>("/devices").catch(() => []),
          ghost<Lease[]>("/leases?role=visitor&active=1").catch(() => []),
        ]);
        if (!alive) return;
        if (Array.isArray(list)) set({ devices: Object.fromEntries(list.map((d) => [d.device_id, d])) });
        if (Array.isArray(leases)) set({ leases: Object.fromEntries(leases.map((l) => [l.lease_id, l])) });
      })
      .catch(() => set({ error: "Coordinator unreachable. Start it with `pnpm dev`." }));

    // The desktop tab is itself a connector (this laptop's webcam/mic, Bluetooth and USB devices,
    // and the viewer side of phone live streams).
    import("@/lib/connector/local")
      .then((m) => m.ensureLocalConnector?.())
      .catch(() => {});

    const unsub = subscribeEvents((e) => {
      const st = useGhost.getState();
      switch (e.type) {
        case "device.published":
        case "device.updated": {
          const prev = st.devices[e.device.device_id];
          st.set({ devices: { ...st.devices, [e.device.device_id]: e.device } });
          const personal = !e.device.connector_id.startsWith("internal:");
          const meId = st.me?.principal_id;
          // A new body joined (e.g. a phone just paired): let Polty notice it.
          if (personal && !prev && e.type === "device.published" && (!meId || e.device.owner_id === meId)) {
            st.addTrace({ kind: "event", title: `New device: ${e.device.name}`, detail: e.device.capabilities.map((c) => c.capability_id).join(", ") });
            if (!st.running && st.ui.length > 0) {
              void sendToPolty(
                `New device published on GHOST: "${e.device.name}" (${e.device.device_id}) with capabilities ${e.device.capabilities.map((c) => c.capability_id).join(", ")}. Greet it briefly.`,
                { event: true },
              );
            }
          }
          break;
        }
        case "device.removed": {
          const devices = { ...st.devices };
          delete devices[e.device_id];
          st.set({ devices });
          break;
        }
        case "lease.updated": {
          st.set({ leases: { ...st.leases, [e.lease.lease_id]: e.lease } });
          if (e.lease.state === "revoked" && e.lease.visitor_id === st.me?.principal_id) {
            st.addTrace({ kind: "event", title: "Owner stopped access", detail: e.lease.reason });
            st.set({ mood: "surprised" });
          }
          break;
        }
        case "ledger.updated":
          if (st.me && e.principal_id === st.me.principal_id) st.set({ me: { ...st.me, balance_cents: e.balance_cents } });
          break;
        case "log":
          if (e.level === "error") st.addTrace({ kind: "error", title: e.message });
          break;
      }
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);
}
