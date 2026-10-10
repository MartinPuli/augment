"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { CapabilityHit } from "@/lib/ghost/contracts";
import { ghostFetch } from "@/lib/ghost/client/api";

export function HardwareCatalog() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [revision, setRevision] = useState(0);
  const [hits, setHits] = useState<CapabilityHit[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    ghostFetch<CapabilityHit[]>("/capabilities", { query: { q: query, device_class: kind, limit: 12 }, signal: abort.signal })
      .then(data => { if (!abort.signal.aborted) setHits(data); })
      .catch(() => { if (!abort.signal.aborted) setError("The hardware catalog is temporarily unavailable. Try again."); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [query, kind, revision]);
  function search(e: FormEvent) { e.preventDefault(); setBusy(true); setError(""); setQuery(draft.trim()); setRevision(r => r + 1); }
  return (
    <section id="hardware" className="hardware-section" aria-labelledby="catalog-title">
      <div className="hardware-section-heading"><div><p className="hardware-eyebrow">Explore the network</p><h2 id="catalog-title">Find a physical capability.</h2></div><p>Live catalog entries. Availability depends on the device and its owner.</p></div>
      <form onSubmit={search} className="hardware-search">
        <label className="sr-only" htmlFor="hardware-search">Search hardware</label>
        <input id="hardware-search" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Try Bay Bridge, camera, light…" />
        <label className="sr-only" htmlFor="hardware-kind">Device type</label>
        <select id="hardware-kind" value={kind} onChange={e => { setBusy(true); setError(""); setKind(e.target.value); }}>
          <option value="">All hardware</option><option value="camera">Cameras</option><option value="sensor">Sensors</option><option value="light">Lights</option><option value="phone">Phones</option><option value="printer">Printers</option><option value="robot">Robots</option>
        </select>
        <button className="hardware-button" type="submit">Search</button>
      </form>
      <div aria-live="polite" aria-busy={busy}>
        {busy ? <p className="hardware-empty">Checking the catalog…</p> : error ? <div className="hardware-empty"><p role="alert">{error}</p><button className="hardware-button secondary" onClick={() => { setBusy(true); setError(""); setRevision(r => r + 1); }}>Retry</button></div> : hits.length === 0 ? <p className="hardware-empty">No matching hardware is listed. An owner needs to connect a supported device before an agent can use it.</p> : <>
          <p className="hardware-caption">Showing {hits.length} capabilities. Online means reachable; it does not guarantee access or a successful action.</p>
          <div className="hardware-results">{hits.map(hit => <article className="hardware-result" key={hit.ref}>
            <div className="hardware-result-top"><span className="hardware-eyebrow">{hit.device.device_class}</span><span className={hit.device.online ? "hardware-status online" : "hardware-status"}>{hit.device.online ? "Online" : "Offline"}</span></div>
            <h3>{hit.device.name}</h3><p>{hit.capability.title}</p>
            <div className="hardware-result-meta"><span>{hit.device.access_type === "public_observation" ? "Public observation · free" : hit.device.access_type === "own_device" ? "Your device" : hit.terms.requires_approval ? "Owner approval required" : "Access terms apply"}</span><span>{hit.device.status}</span></div>
            <details><summary>Capability details</summary><p>{hit.capability.description}</p><p>Verification: {hit.capability.verification.replaceAll("_", " ")}</p><code>{hit.ref}</code><pre>{JSON.stringify(hit.capability.input_schema, null, 2)}</pre></details>
          </article>)}</div>
        </>}
      </div>
    </section>
  );
}
