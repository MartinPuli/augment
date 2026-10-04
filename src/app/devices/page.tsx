"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bluetooth, Mic, RefreshCw, Smartphone, Tv } from "lucide-react";
import ConnectHardwareWidget from "@/components/canvas/widgets/ConnectHardwareWidget";
import PairPhoneWidget from "@/components/canvas/widgets/PairPhoneWidget";
import NetworkScanWidget from "@/components/canvas/widgets/NetworkScanWidget";
import { ensureLocalConnector } from "@/lib/connector/local";
import { subscribeEvents } from "@/lib/connector/http";
import { ghost } from "@/lib/agent/http";
import type { DeviceConnectionMemory } from "@/lib/ghost/client/api-types";
import type { InvokeResponse } from "@/lib/ghost/contracts";

/** Device onboarding and memory are available without a model API key. */
export default function DevicesPage() {
  const [ready, setReady] = useState(false);
  const [phone, setPhone] = useState(false);
  const [network, setNetwork] = useState(false);
  const [memory, setMemory] = useState<DeviceConnectionMemory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setMemory(await ghost<DeviceConnectionMemory[]>("/device-connections?limit=30")); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load remembered devices."); }
  }, []);
  useEffect(() => {
    let stopped = false;
    ensureLocalConnector().then(() => {
      if (!stopped) { setReady(true); void refresh(); }
    }).catch((e) => { if (!stopped) setError(String(e)); });
    return () => { stopped = true; };
  }, [refresh]);
  useEffect(() => {
    if (!ready) return;
    return subscribeEvents((e) => {
      if (e.type.startsWith("device.") || e.type === "invocation.updated") void refresh();
    });
  }, [ready, refresh]);

  const testMicrophone = async (device_id: string) => {
    if (testing) return;
    setTesting(device_id);
    setNotice("Measuring sound level for one second…");
    try {
      const result = await ghost<InvokeResponse>("/invoke", { body: {
        device_id, capability_id: "audio.level", arguments: { seconds: 1 }, idempotency_key: crypto.randomUUID(),
      } });
      if (result.invocation.state !== "succeeded") throw new Error(result.invocation.error || `Microphone result: ${result.invocation.state}`);
      setNotice(`Sound level: ${result.observation?.value ?? "unknown"} ${result.observation?.unit ?? ""}. This call is now remembered. No audio clip was recorded.`);
      await refresh();
    } catch (e) { setNotice(e instanceof Error ? e.message : "Microphone test failed."); }
    finally { setTesting(null); }
  };
  const widget = { focused: false, report: () => {}, emit: (text: string) => { setNotice(text); void refresh(); }, update: () => {} };

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-8 text-ivory sm:px-8">
      <Link href="/" className="inline-flex items-center gap-2 text-sm text-ivory-dim"><ArrowLeft size={16} /> Back to GHOST</Link>
      <header className="my-8 max-w-2xl">
        <p className="hud-label text-mint">give your agent a body</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Connect once. Remember how.</h1>
        <p className="mt-3 text-ivory-dim">Lend a phone, choose a microphone, or connect supported hardware. Your agent remembers how each device connects and which calls worked.</p>
      </header>
      {(error || notice) && <p role="status" className="ghost-glass mb-5 rounded-xl p-4 text-sm">{error || notice}</p>}
      {!ready ? <p>Connecting to your device network…</p> : <>
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <section className="ghost-glass rounded-3xl p-5">
            <h2 className="mb-4 flex items-center gap-2 font-display text-lg"><Bluetooth size={19} /> This computer & nearby hardware</h2>
            <ConnectHardwareWidget {...widget} id="device-setup" props={{ transport: "any" }} />
          </section>
          <div className="space-y-5">
            <section className="ghost-glass rounded-3xl p-5">
              <h2 className="flex items-center gap-2 font-display text-lg"><Smartphone size={19} /> Lend a phone</h2>
              <p className="my-3 text-sm text-ivory-dim">Camera, microphone, screen and supported sensors. Phones need an HTTPS address they can reach.</p>
              {phone ? <PairPhoneWidget {...widget} id="phone-setup" props={{}} /> : <button onClick={() => setPhone(true)} className="rounded-xl bg-ivory px-4 py-2 text-sm text-white">Pair a phone</button>}
            </section>
            <section className="ghost-glass rounded-3xl p-5">
              <h2 className="flex items-center gap-2 font-display text-lg"><Tv size={19} /> TVs & home devices</h2>
              <p className="my-3 text-sm text-ivory-dim">Roku TVs and other supported LAN devices need a coordinator on their network. Unknown TV protocols still need an adapter.</p>
              {network ? <NetworkScanWidget {...widget} id="network-setup" props={{ autoScan: false }} /> : <button onClick={() => setNetwork(true)} className="rounded-xl border border-line-strong px-4 py-2 text-sm">Open network discovery</button>}
            </section>
          </div>
        </div>
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-display text-xl">Remembered devices</h2>
            <button onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm"><RefreshCw size={14} /> Refresh</button>
          </div>
          {!memory.length && <p className="ghost-glass rounded-2xl p-5 text-sm text-ivory-dim">Connect a device to start its memory. Successful uses and reconnect instructions will appear here.</p>}
          <div className="grid gap-4 md:grid-cols-2">
            {memory.map((m) => <article key={m.device_id} className="ghost-glass rounded-2xl p-5">
              <div className="flex items-start justify-between gap-3">
                <div><h3 className="font-semibold">{m.name}</h3><p className="mt-1 text-xs text-mute">{m.guide.input_label || m.guide.method}</p></div>
                <span className={m.online ? "text-xs text-mint" : "text-xs text-mute"}>{m.online ? "Online" : "Offline · remembered"}</span>
              </div>
              <p className="mt-3 text-sm text-ivory-dim">{m.history.succeeded} succeeded calls · {m.history.failed} failed · {m.history.unknown} unknown</p>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-medium">How to reconnect</summary>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-ivory-dim">{m.guide.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                {m.guide.limitations.map((s) => <p key={s} className="mt-2 text-xs text-mute">{s}</p>)}
              </details>
              {m.capabilities.some((c) => c.ref.endsWith("/audio.level")) && <button disabled={!m.online || testing !== null} onClick={() => void testMicrophone(m.device_id)} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-line-strong px-3 py-2 text-sm disabled:opacity-40"><Mic size={14} />{testing === m.device_id ? "Measuring…" : "Test sound level"}</button>}
            </article>)}
          </div>
          <p className="mt-4 text-xs text-mute">Remembering a device preserves instructions and evidence. Each use still checks current access and availability.</p>
        </section>
      </>}
    </main>
  );
}
