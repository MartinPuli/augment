"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bluetooth, LoaderCircle, Mic, RefreshCw, Smartphone, Tv } from "lucide";
import { Icon } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
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
    <main className="mx-auto min-h-dvh max-w-6xl px-4 pb-16 pt-[max(24px,env(safe-area-inset-top))] text-fg sm:px-8 sm:pt-10">
      <Link href="/" className="ghost-chip inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-caption font-medium text-fg-2 transition-colors hover:text-fg">
        <Icon icon={ArrowLeft} size={14} /> Back to Polty
      </Link>
      <header className="my-8 max-w-2xl">
        <p className="text-caption font-medium text-mint">Give your agent a body</p>
        <h1 className="mt-2 font-display text-display">Connect once. Remember how.</h1>
        <p className="mt-3 text-body-lg text-fg-2">Lend a phone, choose a microphone, or connect supported hardware. Your agent remembers how each device connects and which calls worked.</p>
      </header>
      {(error || notice) && (
        <p role="status" className="ghost-glass mb-5 rounded-tile p-4 text-body-sm">
          {error || notice}
        </p>
      )}
      {!ready ? (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]" aria-busy="true">
          <div className="ghost-skeleton h-72 rounded-card" />
          <div className="ghost-skeleton h-72 rounded-card" />
        </div>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <section className="ghost-glass rounded-card p-5 sm:p-6">
              <h2 className="mb-4 flex items-center gap-2.5 font-serif text-heading">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-tint text-fg-2"><Icon icon={Bluetooth} size={16} /></span> This computer & nearby hardware
              </h2>
              <ConnectHardwareWidget {...widget} id="device-setup" props={{ transport: "any" }} />
            </section>
            <div className="space-y-5">
              <section className="ghost-glass rounded-card p-5 sm:p-6">
                <h2 className="flex items-center gap-2.5 font-serif text-heading">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-tint text-fg-2"><Icon icon={Smartphone} size={16} /></span> Lend a phone
                </h2>
                <p className="my-3 text-body-sm text-fg-2">Camera, microphone, screen and supported sensors. Phones need an HTTPS address they can reach.</p>
                {phone ? (
                  <PairPhoneWidget {...widget} id="phone-setup" props={{}} />
                ) : (
                  <button onClick={() => setPhone(true)} className="h-10 rounded-full bg-fg px-4 text-body-sm font-medium text-fg-inverse shadow-pop transition-transform active:scale-[0.97]">
                    Pair a phone
                  </button>
                )}
              </section>
              <section className="ghost-glass rounded-card p-5 sm:p-6">
                <h2 className="flex items-center gap-2.5 font-serif text-heading">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-tint text-fg-2"><Icon icon={Tv} size={16} /></span> TVs & home devices
                </h2>
                <p className="my-3 text-body-sm text-fg-2">Roku TVs and other supported LAN devices need a coordinator on their network. Unknown TV protocols still need an adapter.</p>
                {network ? (
                  <NetworkScanWidget {...widget} id="network-setup" props={{ autoScan: false }} />
                ) : (
                  <button onClick={() => setNetwork(true)} className="ghost-chip h-10 rounded-full px-4 text-body-sm font-medium text-fg transition-transform active:scale-[0.97]">
                    Open network discovery
                  </button>
                )}
              </section>
            </div>
          </div>
          <section className="mt-10">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-display text-title">Remembered devices</h2>
              <button onClick={() => void refresh()} className="ghost-chip inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-caption font-medium text-fg-2 transition-colors hover:text-fg active:scale-[0.97]">
                <Icon icon={RefreshCw} size={13} /> Refresh
              </button>
            </div>
            {!memory.length && (
              <div className="ghost-glass flex flex-col items-center gap-2 rounded-card px-5 py-10 text-center">
                <Illustration name="satellite" size={56} fallback={Smartphone} />
                <p className="mt-1 font-serif text-heading">No remembered devices yet</p>
                <p className="max-w-md text-body-sm text-fg-3">Connect a device to start its memory. Successful uses and reconnect instructions will appear here.</p>
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {memory.map((m) => (
                <article key={m.device_id} className="ghost-glass rounded-card p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-serif text-heading">{m.name}</h3>
                      <p className="mt-0.5 text-caption text-fg-3">{m.guide.input_label || m.guide.method}</p>
                    </div>
                    <span className={m.online ? "shrink-0 rounded-full bg-mint/10 px-2 py-0.5 text-label font-medium text-mint" : "shrink-0 rounded-full bg-tint px-2 py-0.5 text-label font-medium text-fg-3"}>
                      {m.online ? "Online" : "Offline · remembered"}
                    </span>
                  </div>
                  <p className="mt-3 text-body-sm tabular-nums text-fg-2">
                    {m.history.succeeded} succeeded calls · {m.history.failed} failed · {m.history.unknown} unknown
                  </p>
                  <details className="mt-3 text-body-sm">
                    <summary className="cursor-pointer font-medium text-fg">How to reconnect</summary>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-fg-2">
                      {m.guide.steps.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ol>
                    {m.guide.limitations.map((s) => (
                      <p key={s} className="mt-2 text-caption text-fg-3">
                        {s}
                      </p>
                    ))}
                  </details>
                  {m.capabilities.some((c) => c.ref.endsWith("/audio.level")) && (
                    <button
                      disabled={!m.online || testing !== null}
                      onClick={() => void testMicrophone(m.device_id)}
                      className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full bg-tint px-3.5 text-caption font-medium text-fg transition-transform active:scale-[0.97] disabled:opacity-40"
                    >
                      <Icon icon={testing === m.device_id ? LoaderCircle : Mic} size={13} spring="snappy" className={testing === m.device_id ? "animate-spin" : undefined} />
                      {testing === m.device_id ? "Measuring…" : "Test sound level"}
                    </button>
                  )}
                </article>
              ))}
            </div>
            <p className="mt-4 text-caption text-fg-3">Remembering a device preserves instructions and evidence. Each use still checks current access and availability.</p>
          </section>
        </>
      )}
    </main>
  );
}
